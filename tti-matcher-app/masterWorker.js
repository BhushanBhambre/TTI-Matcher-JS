/**
 * masterWorker.js
 * ---------------------------------------------------------------------------
 * Background worker for Master File streaming and inverted index construction:
 *   1. Streams file in 8 MB slices using FileReader in worker thread.
 *   2. Extracts trigrams and builds inverted index in a SINGLE streaming pass.
 *   3. DOES NOT store a giant `blobs[]` array in memory (saves >90% RAM).
 *   4. Prunes ultra-common stop-word trigrams.
 *   5. Emits compact ttiCodes, iatas, masterGramCounts (Uint16Array), and index.
 * ---------------------------------------------------------------------------
 */

const MASTER_COLUMNS = [
  "TTIcode", "HotelName", "IATA_code",
  "StreetNumber", "AddressLine", "PostalCode",
  "AddressCityName", "CityName",
];

const CHUNK = 8 * 1024 * 1024; // 8 MB chunks

function normalize(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/null/g, "")
    .replace(/[^a-z0-9]/g, "");
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

  // Compact storage: parallel arrays
  const ttiCodes = [];
  const iatas    = [];
  const masterGramCounts = []; // number of unique trigrams per record
  const tempBuckets = Object.create(null); // trigram -> number[]

  let colIndex   = null;
  let remainder  = "";
  let offset     = 0;
  let lastReport = 0;

  function processRecord(line) {
    if (!line) return;

    if (colIndex === null) {
      const header = line.split("\t").map(h => h.trim());
      colIndex = {};
      for (const col of MASTER_COLUMNS) {
        const idx = header.indexOf(col);
        if (idx === -1) {
          self.postMessage({ type: "ERROR", msg: `Master file missing column: "${col}"` });
          return;
        }
        colIndex[col] = idx;
      }
      return;
    }

    const cells = line.split("\t");
    if (cells.length < 2) return;

    const ttiCode = (cells[colIndex.TTIcode] || "").trim();
    if (!ttiCode) return;

    const blobSource =
      (cells[colIndex.HotelName]       || "") +
      (cells[colIndex.StreetNumber]    || "") +
      (cells[colIndex.AddressLine]     || "") +
      (cells[colIndex.PostalCode]      || "") +
      (cells[colIndex.AddressCityName] || "") +
      (cells[colIndex.CityName]        || "");

    const blob = normalize(blobSource);
    const recIdx = ttiCodes.length;

    ttiCodes.push(ttiCode);
    iatas.push((cells[colIndex.IATA_code] || "").trim().toUpperCase());

    // Extract unique trigrams for this record immediately
    const len = blob.length;
    const seen = new Set();
    if (len < 3) {
      if (len > 0) seen.add(blob);
    } else {
      for (let k = 0; k <= len - 3; k++) {
        seen.add(blob.slice(k, k + 3));
      }
    }

    masterGramCounts.push(seen.size);

    // Populate index buckets immediately
    for (const g of seen) {
      let b = tempBuckets[g];
      if (!b) {
        b = [];
        tempBuckets[g] = b;
      }
      b.push(recIdx);
    }
  }

  /* ── Streaming file read loop ───────────────────── */
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
      processRecord(lines[i]);
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
    processRecord(remainder);
  }

  self.postMessage({ type: "MASTER_PARSE_DONE", recordCount: ttiCodes.length });

  /* ── Prune stop-word trigrams & convert to Uint32Array ── */
  const N = ttiCodes.length;
  const MAX_BUCKET = Math.max(300, Math.round(N * 0.005));
  const index = Object.create(null); // trigram -> Uint32Array
  let pruned  = 0;

  for (const g in tempBuckets) {
    const arr = tempBuckets[g];
    if (arr.length > MAX_BUCKET) {
      pruned++;
      continue;
    }
    index[g] = new Uint32Array(arr);
  }

  // Done! Send compact structures to main thread
  self.postMessage({
    type: "MASTER_DONE",
    ttiCodes,
    iatas,
    masterGramCounts: new Uint16Array(masterGramCounts),
    index,
    prunedCount: pruned,
  });
};
