/**
 * masterWorker.js
 * ---------------------------------------------------------------------------
 * Background worker for Master File streaming and inverted index construction.
 *
 * Supports the expanded master file format:
 *   TTIcode, HotelName, IATA_code, StreetNumber, AddressLine, PostalCode,
 *   AddressCityName, CityName, Phone, CountryName, FullAddress
 *
 * ALL available address/name/phone columns are used for the match blob so
 * lookup rows with any subset of those fields can still score well.
 *
 * Blob field priority (concatenated in order):
 *   HotelName + StreetNumber + AddressLine + PostalCode +
 *   AddressCityName + CityName + Phone + CountryName
 * ---------------------------------------------------------------------------
 */

// Required columns — the worker will error if any is absent from the header.
const REQUIRED_MASTER_COLS = ["TTIcode", "HotelName", "IATA_code"];

// Optional columns — used when present, ignored when missing.
const OPTIONAL_BLOB_COLS = [
  "StreetNumber", "AddressLine", "PostalCode",
  "AddressCityName", "CityName", "Phone", "CountryName",
];

const CHUNK = 8 * 1024 * 1024; // 8 MB chunks

function charToSymbol(code) {
  if (code >= 97 && code <= 122) return code - 97; // a-z -> 0..25
  if (code >= 48 && code <= 57) return code - 22;  // 0-9 -> 26..35
  return -1;
}

function normalize(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/null/gi, "")
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

  const ttiCodes      = [];
  const iatas         = [];
  const recordTrigrams = [];
  let totalTrigramCount = 0;

  let colIndex  = null;   // map of colName -> colPosition
  let blobCols  = null;   // list of present optional cols (determined from header)
  let remainder = "";
  let offset    = 0;
  let lastReport = 0;

  function processLine(line) {
    if (!line.trim()) return;

    // ── Header ──────────────────────────────────────────────
    if (colIndex === null) {
      const header = line.split("\t").map(h => h.trim());
      colIndex = {};

      // Validate required columns
      for (const col of REQUIRED_MASTER_COLS) {
        const idx = header.indexOf(col);
        if (idx === -1) {
          self.postMessage({ type: "ERROR", msg: `Master file missing required column: "${col}"` });
          return;
        }
        colIndex[col] = idx;
      }

      // Collect present optional columns
      blobCols = [];
      for (const col of OPTIONAL_BLOB_COLS) {
        const idx = header.indexOf(col);
        if (idx !== -1) {
          colIndex[col] = idx;
          blobCols.push(col);
        }
      }

      self.postMessage({ type: "LOG", msg: `Master columns detected: ${header.join(", ")}` });
      self.postMessage({ type: "LOG", msg: `Blob fields used: HotelName + ${blobCols.join(" + ")}` });
      return;
    }

    // ── Data row ─────────────────────────────────────────────
    const cells   = line.split("\t");
    if (cells.length < 2) return;

    const ttiCode = (cells[colIndex.TTIcode] || "").trim();
    if (!ttiCode) return;

    // Build blob: HotelName always first, then whatever optional cols exist
    let blobSource = (cells[colIndex.HotelName] || "");
    for (const col of blobCols) {
      blobSource += " " + (cells[colIndex[col]] || "");
    }

    const blob        = normalize(blobSource);
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

  if (remainder) processLine(remainder);

  self.postMessage({ type: "MASTER_PARSE_DONE", recordCount: ttiCodes.length });

  /* ── Pack trigrams into compact contiguous TypedArrays ── */
  const N          = ttiCodes.length;
  const offsets    = new Uint32Array(N + 1);
  const allTrigrams = new Uint16Array(totalTrigramCount);
  const tempBuckets = Object.create(null);

  let writePtr = 0;
  for (let i = 0; i < N; i++) {
    offsets[i] = writePtr;
    const grams = recordTrigrams[i];
    for (let k = 0; k < grams.length; k++) {
      const g = grams[k];
      allTrigrams[writePtr++] = g;
      let b = tempBuckets[g];
      if (!b) { b = []; tempBuckets[g] = b; }
      b.push(i);
    }
    recordTrigrams[i] = null; // free per-record array
  }
  offsets[N] = writePtr;

  /* ── Build inverted index (candidate blocking only, stop-words pruned) ── */
  const MAX_BUCKET = Math.max(300, Math.round(N * 0.005));
  const index      = Object.create(null);
  let   pruned     = 0;

  for (const g in tempBuckets) {
    const arr = tempBuckets[g];
    if (arr.length > MAX_BUCKET) { pruned++; continue; }
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
