/**
 * masterWorker.js
 * ---------------------------------------------------------------------------
 * Background worker that owns ALL master-file work:
 *   1. Receives raw File object via postMessage (no main-thread parsing).
 *   2. Reads the file in 8 MB slices using FileReader (async, inside worker).
 *   3. Parses TSV lines, normalises text, builds trigram strings.
 *   4. Builds the inverted index (trigram → record-index array).
 *   5. Prunes ultra-common "stop-word" trigrams.
 *   6. Returns compact plain arrays – no Sets, no Maps, no large objects –
 *      so structured-clone is fast.
 *
 * The main thread never touches a single master record.  No lag.
 * ---------------------------------------------------------------------------
 */

const MASTER_COLUMNS = [
  "TTIcode", "HotelName", "IATA_code",
  "StreetNumber", "AddressLine", "PostalCode",
  "AddressCityName", "CityName",
];

const CHUNK = 8 * 1024 * 1024; // 8 MB slices

/* ── helpers ──────────────────────────────────────────────── */

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

/* ── main handler ─────────────────────────────────────────── */

self.onmessage = async (ev) => {
  const { file } = ev.data;
  const totalBytes = file.size;
  const decoder = new TextDecoder("utf-8");

  // Compact storage – parallel arrays instead of object arrays
  const ttiCodes = [];   // string[]
  const iatas    = [];   // string[]
  const blobs    = [];   // string[]  (normalised blob per record)

  let colIndex  = null;
  let remainder = "";
  let offset    = 0;
  let lastReport = 0;

  /* ── streaming parse ────────────────────────────── */
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
      const line = lines[i];
      if (!line) continue;

      if (colIndex === null) {
        // first non-empty line = header
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
        continue;
      }

      const cells   = line.split("\t");
      if (cells.length < 2) continue;

      const ttiCode = (cells[colIndex.TTIcode] || "").trim();
      if (!ttiCode) continue;

      const blobSource =
        (cells[colIndex.HotelName]      || "") +
        (cells[colIndex.StreetNumber]   || "") +
        (cells[colIndex.AddressLine]    || "") +
        (cells[colIndex.PostalCode]     || "") +
        (cells[colIndex.AddressCityName]|| "") +
        (cells[colIndex.CityName]       || "");

      ttiCodes.push(ttiCode);
      iatas.push((cells[colIndex.IATA_code] || "").trim().toUpperCase());
      blobs.push(normalize(blobSource));
    }

    // progress every ~200 ms worth of data (report at chunk boundaries)
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

  // flush remainder
  if (remainder) {
    const cells   = remainder.split("\t");
    const ttiCode = colIndex ? (cells[colIndex.TTIcode] || "").trim() : "";
    if (ttiCode) {
      const blobSource =
        (cells[colIndex.HotelName]      || "") +
        (cells[colIndex.StreetNumber]   || "") +
        (cells[colIndex.AddressLine]    || "") +
        (cells[colIndex.PostalCode]     || "") +
        (cells[colIndex.AddressCityName]|| "") +
        (cells[colIndex.CityName]       || "");
      ttiCodes.push(ttiCode);
      iatas.push((cells[colIndex.IATA_code] || "").trim().toUpperCase());
      blobs.push(normalize(blobSource));
    }
  }

  self.postMessage({ type: "MASTER_PARSE_DONE", recordCount: ttiCodes.length });

  /* ── build inverted index ───────────────────────── */
  // index: plain object  trigram -> Uint32Array of record indices
  // We use a plain object keyed by 3-char string – very fast to build,
  // and JSON-free structured-clone (Uint32Array is transferable).
  const tempBuckets = Object.create(null); // trigram -> number[]

  const N = ttiCodes.length;
  for (let i = 0; i < N; i++) {
    const b = blobs[i];
    const len = b.length;
    if (len === 0) continue;
    const seen = new Set();
    if (len < 3) {
      seen.add(b);
    } else {
      for (let k = 0; k <= len - 3; k++) seen.add(b.slice(k, k + 3));
    }
    for (const g of seen) {
      if (!tempBuckets[g]) tempBuckets[g] = [];
      tempBuckets[g].push(i);
    }

    if (i % 200000 === 0) {
      self.postMessage({ type: "INDEX_PROGRESS", done: i, total: N });
    }
  }

  /* ── prune stop-word trigrams ───────────────────── */
  const MAX_BUCKET = Math.max(300, Math.round(N * 0.005));
  const index = Object.create(null); // trigram -> Uint32Array
  let pruned  = 0;
  for (const g in tempBuckets) {
    const arr = tempBuckets[g];
    if (arr.length > MAX_BUCKET) { pruned++; continue; }
    index[g] = new Uint32Array(arr);
  }

  self.postMessage({
    type: "MASTER_DONE",
    ttiCodes,
    iatas,
    blobs,
    index,       // transferable values inside will be cloned (Uint32Array)
    prunedCount: pruned,
  });
};
