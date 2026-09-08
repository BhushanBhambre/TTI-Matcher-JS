/**
 * masterWorker.js
 * ---------------------------------------------------------------------------
 * Web Worker dedicated to background Master File streaming, line parsing,
 * text normalization, 24-bit integer trigram hashing (36^3 = 46,656 buckets),
 * and inverted index construction.
 * Runs 100% off the main thread so browser UI stays 60 FPS even on 12GB+ files.
 * ---------------------------------------------------------------------------
 */

const MASTER_COLUMNS = [
  "TTIcode",
  "HotelName",
  "IATA_code",
  "StreetNumber",
  "AddressLine",
  "PostalCode",
  "AddressCityName",
  "CityName",
];

const NUM_BUCKETS = 46656; // 36^3

// Symbol encoding: a-z -> 0..25, 0-9 -> 26..35
function charToSymbol(code) {
  if (code >= 97 && code <= 122) return code - 97; // a-z
  if (code >= 48 && code <= 57) return code - 22; // 0-9
  return -1;
}

function normalizeToCodes(raw) {
  const str = String(raw || "")
    .toLowerCase()
    .replace(/null/g, "");
  const codes = [];
  for (let i = 0; i < str.length; i++) {
    const sym = charToSymbol(str.charCodeAt(i));
    if (sym !== -1) codes.push(sym);
  }
  return codes;
}

function codesToBlob(codes) {
  const chars = new Array(codes.length);
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    chars[i] = c < 26 ? String.fromCharCode(97 + c) : String.fromCharCode(22 + c);
  }
  return chars.join("");
}

function extractIntegerTrigrams(codes) {
  const hashes = new Set();
  const len = codes.length;
  if (len < 3) {
    if (len > 0) {
      let h = 0;
      for (let i = 0; i < len; i++) {
        h = h * 36 + codes[i];
      }
      hashes.add(h);
    }
    return Array.from(hashes);
  }
  for (let i = 0; i <= len - 3; i++) {
    const h = codes[i] * 1296 + codes[i + 1] * 36 + codes[i + 2];
    hashes.add(h);
  }
  return Array.from(hashes);
}

self.onmessage = async function (e) {
  const { file } = e.data;
  if (!file) return;

  const totalBytes = file.size;
  let offset = 0;
  const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB chunks

  const ttiCodes = [];
  const iatas = [];
  const blobs = [];

  let header = null;
  let colIndex = {};
  let isFirstLine = true;
  let remainder = "";
  const decoder = new TextDecoder("utf-8");

  // Inverted index buckets: 46,656 buckets
  const indexBuckets = new Array(NUM_BUCKETS);

  let lastReportTime = performance.now();

  function processLine(line) {
    if (!line || !line.trim()) return;

    if (isFirstLine) {
      isFirstLine = false;
      header = line.split("\t").map((h) => h.trim());
      for (let c = 0; c < MASTER_COLUMNS.length; c++) {
        const col = MASTER_COLUMNS[c];
        const idx = header.indexOf(col);
        if (idx === -1) {
          throw new Error(`Master file missing column: "${col}"`);
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
      (cells[colIndex.HotelName] || "") +
      (cells[colIndex.StreetNumber] || "") +
      (cells[colIndex.AddressLine] || "") +
      (cells[colIndex.PostalCode] || "") +
      (cells[colIndex.AddressCityName] || "") +
      (cells[colIndex.CityName] || "");

    const codes = normalizeToCodes(blobSource);
    const recIdx = ttiCodes.length;

    ttiCodes.push(ttiCode);
    iatas.push((cells[colIndex.IATA_code] || "").trim().toUpperCase());
    blobs.push(codesToBlob(codes));

    // Integer trigram hashing into index buckets
    const trigramHashes = extractIntegerTrigrams(codes);
    for (let t = 0; t < trigramHashes.length; t++) {
      const h = trigramHashes[t];
      let bucket = indexBuckets[h];
      if (!bucket) {
        bucket = [];
        indexBuckets[h] = bucket;
      }
      bucket.push(recIdx);
    }
  }

  // Stream reading loop
  while (offset < totalBytes) {
    const end = Math.min(offset + CHUNK_SIZE, totalBytes);
    const slice = file.slice(offset, end);

    // Read buffer synchronously in worker using FileReaderSync or async Promise
    const buffer = await readSliceAsBuffer(slice);
    offset = end;
    const isLast = offset >= totalBytes;

    const text = decoder.decode(buffer, { stream: !isLast });
    const combined = remainder + text;
    const lines = combined.split(/\r\n|\n|\r/);
    remainder = lines.pop() || "";

    for (let i = 0; i < lines.length; i++) {
      processLine(lines[i]);
    }

    const now = performance.now();
    if (now - lastReportTime > 200 || isLast) {
      lastReportTime = now;
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

  // Convert buckets to TypedArrays (Uint32Array) & prune stop-words
  const MAX_POSTING_LIST = Math.max(300, Math.round(ttiCodes.length * 0.005));
  let prunedCount = 0;

  for (let h = 0; h < NUM_BUCKETS; h++) {
    const bucket = indexBuckets[h];
    if (bucket) {
      if (bucket.length > MAX_POSTING_LIST) {
        indexBuckets[h] = null; // Prune ultra-common stop-words
        prunedCount++;
      } else {
        indexBuckets[h] = new Uint32Array(bucket);
      }
    }
  }

  self.postMessage({
    type: "MASTER_DONE",
    recordCount: ttiCodes.length,
    prunedCount,
    masterRecords: {
      ttiCodes,
      iatas,
      blobs,
    },
    indexBuckets,
  });
};

function readSliceAsBuffer(slice) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(slice);
  });
}
