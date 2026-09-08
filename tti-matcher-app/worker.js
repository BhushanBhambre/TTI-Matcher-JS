/**
 * worker.js
 * ---------------------------------------------------------------------------
 * Web Worker thread for parallel fuzzy matching of lookup records against the
 * compact master index. Uses integer trigram hashing and candidate blocking.
 * ---------------------------------------------------------------------------
 */

let ttiCodes = [];
let iatas = [];
let blobs = [];
let indexBuckets = [];
const MAX_MATCHES_PER_ROW = 20;

function charToSymbol(code) {
  if (code >= 97 && code <= 122) return code - 97;
  if (code >= 48 && code <= 57) return code - 22;
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

function extractTrigramSet(codes) {
  const set = new Set();
  const len = codes.length;
  if (len < 3) {
    if (len > 0) {
      let h = 0;
      for (let i = 0; i < len; i++) h = h * 36 + codes[i];
      set.add(h);
    }
    return set;
  }
  for (let i = 0; i <= len - 3; i++) {
    const h = codes[i] * 1296 + codes[i + 1] * 36 + codes[i + 2];
    set.add(h);
  }
  return set;
}

function getMasterTrigramSet(blobStr) {
  const codes = [];
  for (let i = 0; i < blobStr.length; i++) {
    const sym = charToSymbol(blobStr.charCodeAt(i));
    if (sym !== -1) codes.push(sym);
  }
  return extractTrigramSet(codes);
}

function diceScore(querySet, masterSet) {
  if (querySet.size === 0 || masterSet.size === 0) return 0;
  const [small, big] = querySet.size <= masterSet.size ? [querySet, masterSet] : [masterSet, querySet];
  let intersection = 0;
  for (const g of small) {
    if (big.has(g)) intersection++;
  }
  return (2 * intersection) / (querySet.size + masterSet.size);
}

function findAllMatches(query, thresholdPct) {
  const queryCodes = normalizeToCodes(query.bodyText || query.original);
  const queryTrigrams = extractTrigramSet(queryCodes);
  const thresholdFrac = thresholdPct / 100;

  // Gather candidates from integer index buckets
  const candidateSet = new Set();
  for (const hash of queryTrigrams) {
    const bucket = indexBuckets[hash];
    if (bucket) {
      for (let i = 0; i < bucket.length; i++) {
        candidateSet.add(bucket[i]);
      }
    }
  }

  const candidateIndices = candidateSet.size > 0 ? candidateSet : null;

  const matches = [];

  if (candidateIndices) {
    for (const i of candidateIndices) {
      const masterBlob = blobs[i];
      const masterTrigrams = getMasterTrigramSet(masterBlob);
      let score = diceScore(queryTrigrams, masterTrigrams);

      const masterIata = iatas[i];
      if (query.iata && masterIata && query.iata === masterIata) {
        score = Math.min(1, score * 0.85 + 0.15);
      }

      if (score >= thresholdFrac) {
        matches.push({ ttiCode: ttiCodes[i], score });
      }
    }
  } else {
    // Fallback if no candidate share trigrams
    for (let i = 0; i < ttiCodes.length; i++) {
      const masterBlob = blobs[i];
      const masterTrigrams = getMasterTrigramSet(masterBlob);
      let score = diceScore(queryTrigrams, masterTrigrams);

      const masterIata = iatas[i];
      if (query.iata && masterIata && query.iata === masterIata) {
        score = Math.min(1, score * 0.85 + 0.15);
      }

      if (score >= thresholdFrac) {
        matches.push({ ttiCode: ttiCodes[i], score });
      }
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, MAX_MATCHES_PER_ROW);
}

self.onmessage = function (e) {
  const { type } = e.data;

  if (type === "INIT") {
    const { masterRecords, indexBuckets: buckets } = e.data;
    ttiCodes = masterRecords.ttiCodes;
    iatas = masterRecords.iatas;
    blobs = masterRecords.blobs;
    indexBuckets = buckets;

    self.postMessage({ type: "INIT_DONE" });
    return;
  }

  if (type === "MATCH_BATCH") {
    const { batchId, rows, thresholdPct } = e.data;
    const results = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rawMatches = findAllMatches(row, thresholdPct);
      const matches = rawMatches.map((m) => ({
        ttiCode: m.ttiCode,
        scorePct: Math.round(m.score * 1000) / 10,
      }));

      const ttiCodeJoined = matches.map((m) => m.ttiCode).join("; ");
      const scoresJoined = matches.map((m) => m.scorePct).join("; ");
      const bestScorePct = matches.length > 0 ? matches[0].scorePct : 0;

      results.push({
        rowIndex: row.rowIndex,
        original: row.original,
        ttiCode: ttiCodeJoined,
        scorePct: bestScorePct,
        scores: scoresJoined,
        matchesCount: matches.length,
      });
    }

    self.postMessage({
      type: "BATCH_RESULTS",
      batchId,
      processedCount: rows.length,
      results,
    });
  }
};
