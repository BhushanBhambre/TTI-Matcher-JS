/**
 * masterWorker.js
 * ---------------------------------------------------------------------------
 * Background worker for Master File streaming and inverted index construction:
 *   1. Streams master file in 8 MB chunks in worker thread (zero main thread lag).
 *   2. Extracts 16-bit integer trigrams (0..46655).
 *   3. Stores all record trigrams in a single contiguous Uint16Array + Uint32Array offsets (ultra-compact, ~50MB for 1M records).
 *   4. Builds inverted index for fast candidate blocking.
 *   5. Prunes ultra-common stop-word trigrams from candidate blocking only —
 *      while preserving ALL trigrams in allTrigrams for 100% exact Dice scoring!
 * ---------------------------------------------------------------------------
 */

const MASTER_COLUMNS = [
  "TTIcode", "HotelName", "IATA_code",
  "StreetNumber", "AddressLine", "PostalCode",
  "AddressCityName", "CityName",
];

// Optional columns — used when present, silently skipped when absent
const MASTER_OPTIONAL_COLUMNS = ["Phone", "FullAddress"];

const CHUNK = 8 * 1024 * 1024; // 8 MB chunks

function charToSymbol(code) {
  if (code >= 97 && code <= 122) return code - 97; // a-z -> 0..25
  if (code >= 48 && code <= 57) return code - 22;  // 0-9 -> 26..35
  return -1;
}

function normalize(raw) {
  return String(raw || "")
    .replace(/\bnull\b/gi, "")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getTrigramInts(blob) {
  const set = new Set();
  const len = blob.length;
  if (len === 0) return [];
  if (len < 3) {
    let h = 0;
    for (let i = 0; i < len; i++) {
      const sym = charToSymbol(blob.charCodeAt(i));
      if (sym === -1) return [];
      h = h * 36 + sym;
    }
    set.add(h);
    return Array.from(set);
  }
  for (let i = 0; i <= len - 3; i++) {
    const c0 = charToSymbol(blob.charCodeAt(i));
    const c1 = charToSymbol(blob.charCodeAt(i + 1));
    const c2 = charToSymbol(blob.charCodeAt(i + 2));
    if (c0 === -1 || c1 === -1 || c2 === -1) continue;
    set.add(c0 * 1296 + c1 * 36 + c2);
  }
  return Array.from(set);
}

function readSlice(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsArrayBuffer(blob);
  });
}

self.onmessage = async (ev) => {
  const { file } = ev.data;
  const totalBytes = file.size;
  const decoder = new TextDecoder("utf-8");

  const ttiCodes = [];
  const iatas    = [];
  const recordTrigrams = []; // array of number[] per record
  let totalTrigramCount = 0;

  let colIndex   = null;
  let remainder  = "";
  let offset     = 0;
  let lastReport = 0;

  function processLine(line) {
    if (!line) return;

    if (colIndex === null) {
      const header = line.split("\t").map(h => h.trim());
      colIndex = {};
      for (const col of MASTER_COLUMNS) {
        const idx = header.findIndex(h => h.toLowerCase() === col.toLowerCase());
        if (idx === -1) {
          self.postMessage({ type: "ERROR", msg: `Master file missing column: "${col}"` });
          return;
        }
        colIndex[col] = idx;
      }
      // Resolve optional columns — case-insensitive
      for (const col of MASTER_OPTIONAL_COLUMNS) {
        colIndex[col] = header.findIndex(h => h.toLowerCase() === col.toLowerCase());
      }
      return;
    }

    const cells = line.split("\t");
    if (cells.length < 2) return;

    const ttiCode = (cells[colIndex.TTIcode] || "").trim();
    if (!ttiCode) return;

    const phoneVal = colIndex["Phone"] >= 0 ? (cells[colIndex["Phone"]] || "") : "";
    const fullAddrVal = colIndex["FullAddress"] >= 0 ? (cells[colIndex["FullAddress"]] || "") : "";

    const blobSource =
      (cells[colIndex.HotelName]       || "") + " " +
      (cells[colIndex.StreetNumber]    || "") + " " +
      (cells[colIndex.AddressLine]     || "") + " " +
      (cells[colIndex.PostalCode]      || "") + " " +
      (cells[colIndex.AddressCityName] || "") + " " +
      (cells[colIndex.CityName]        || "") + " " +
      fullAddrVal + " " +
      phoneVal;

    const blob = normalize(blobSource);
    const trigramInts = getTrigramInts(blob);

    ttiCodes.push(ttiCode);
    iatas.push((cells[colIndex.IATA_code] || "").trim().toUpperCase());
    recordTrigrams.push(trigramInts);
    totalTrigramCount += trigramInts.length;
  }

  /* ── Streaming file read ────────────────────────── */
  while (offset < totalBytes) {
    const end    = Math.min(offset + CHUNK, totalBytes);
    const buf    = await readSlice(file.slice(offset, end));
    offset       = end;
    const isLast = offset >= totalBytes;

    const text     = decoder.decode(buf, { stream: !isLast });
    const combined = remainder + text;
    const lines    = combined.split(/\r\n|\n|\r/);
    remainder      = lines.pop() ?? "";

    for (let i = 0; i < lines.length; i++) {
      processLine(lines[i]);
    }

    const now = Date.now();
    if (now - lastReport > 150 || isLast) {
      lastReport = now;
      self.postMessage({
        type: "MASTER_PROGRESS",
        bytesRead: offset,
        totalBytes,
        recordCount: ttiCodes.length,
        pct: Math.round((offset / totalBytes) * 100),
      });
    }
  }

  if (remainder) {
    processLine(remainder);
  }

  self.postMessage({ type: "MASTER_PARSE_DONE", recordCount: ttiCodes.length });

  /* ── Pack trigrams into compact contiguous TypedArrays ── */
  const N = ttiCodes.length;
  const offsets = new Uint32Array(N + 1);
  const allTrigrams = new Uint16Array(totalTrigramCount);
  const tempBuckets = Object.create(null); // trigramInt -> number[]

  let writePtr = 0;
  for (let i = 0; i < N; i++) {
    offsets[i] = writePtr;
    const grams = recordTrigrams[i];
    for (let k = 0; k < grams.length; k++) {
      const g = grams[k];
      allTrigrams[writePtr++] = g;

      let b = tempBuckets[g];
      if (!b) {
        b = [];
        tempBuckets[g] = b;
      }
      b.push(i);
    }
    // Free per-record array to reduce memory
    recordTrigrams[i] = null;
  }
  offsets[N] = writePtr;

  /* ── Build index for candidate blocking (pruning stop-words) ── */
  const MAX_BUCKET = Math.max(300, Math.round(N * 0.005));
  const index = Object.create(null); // trigramInt -> Uint32Array
  let pruned = 0;

  for (const g in tempBuckets) {
    const arr = tempBuckets[g];
    if (arr.length > MAX_BUCKET) {
      pruned++;
      continue; // Stop-word pruning for candidate gathering only
    }
    index[g] = new Uint32Array(arr);
  }

  self.postMessage({
    type: "MASTER_DONE",
    ttiCodes,
    iatas,
    offsets,
    allTrigrams,
    index,
    prunedCount: pruned,
  });
};
