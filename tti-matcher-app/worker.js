/**
 * worker.js
 * ---------------------------------------------------------------------------
 * Matching worker.
 * Receives a slice of lookup rows + the compact master index.
 * Runs Dice-coefficient fuzzy matching on its slice and reports progress
 * back to the main thread every N rows (N depends on performance mode).
 * ---------------------------------------------------------------------------
 */

/* ── globals set by INIT ──────────────────────────────────── */
let ttiCodes = null;
let iatas    = null;
let blobs    = null;
let index    = null;   // plain object: trigram -> Uint32Array
let masterGramCache = null; // Array<Set<string>|undefined> — cached lazily per master record

const MAX_MATCHES = 20;

/* ── helpers ──────────────────────────────────────────────── */

function normalize(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/null/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function getTrigramSet(blob) {
  const s   = new Set();
  const len = blob.length;
  if (len === 0) return s;
  if (len < 3) { s.add(blob); return s; }
  for (let i = 0; i <= len - 3; i++) s.add(blob.slice(i, i + 3));
  return s;
}

function getMasterGrams(i) {
  // Build once, reuse forever after
  return masterGramCache[i] || (masterGramCache[i] = getTrigramSet(blobs[i]));
}

function diceScore(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  const [small, big] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let inter = 0;
  for (const g of small) if (big.has(g)) inter++;
  return (2 * inter) / (setA.size + setB.size);
}

function matchRow(queryBlob, queryIata, threshold) {
  const queryGrams = getTrigramSet(queryBlob);
  const sizeA = queryGrams.size;
  if (sizeA === 0) return { bestScore: 0, bestCode: "", candidateCount: 0, matches: [] };

  const candidates = new Set();
  for (const g of queryGrams) {
    const bucket = index[g];
    if (bucket) {
      for (let i = 0; i < bucket.length; i++) candidates.add(bucket[i]);
    }
  }

  // fallback: no candidates – skip
  if (candidates.size === 0) return { bestScore: 0, bestCode: "", candidateCount: 0, matches: [] };

  const matches = [];
  let bestRawScore = 0;
  let bestCode = "";

  for (const i of candidates) {
    const masterGrams = getMasterGrams(i);
    const sizeB = masterGrams.size;
    if (sizeB === 0) continue;

    // Mathematical upper-bound pruning:
    // Max theoretical intersection is min(sizeA, sizeB).
    // If maximum possible score cannot beat bestRawScore AND cannot reach threshold, skip!
    const minSize = sizeA < sizeB ? sizeA : sizeB;
    const maxTheoretical = (2 * minSize) / (sizeA + sizeB);
    const maxPossible = Math.min(1, maxTheoretical * 0.85 + 0.15);
    if (maxPossible <= bestRawScore && maxPossible < threshold) {
      continue;
    }

    let score = diceScore(queryGrams, masterGrams);
    if (queryIata && iatas[i] && queryIata === iatas[i]) {
      score = Math.min(1, score * 0.85 + 0.15);
    }

    if (score > bestRawScore) {
      bestRawScore = score;
      bestCode = ttiCodes[i];
    }

    if (score >= threshold) {
      matches.push({ ttiCode: ttiCodes[i], score });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return {
    bestScore: bestRawScore,
    bestCode,
    candidateCount: candidates.size,
    matches: matches.slice(0, MAX_MATCHES),
  };
}

/* ── message handler ──────────────────────────────────────── */

self.onmessage = function (ev) {
  const { type } = ev.data;

  if (type === "INIT") {
    ttiCodes = ev.data.ttiCodes;
    iatas    = ev.data.iatas;
    blobs    = ev.data.blobs;
    index    = ev.data.index;
    masterGramCache = new Array(blobs.length); // Initialize cache array
    self.postMessage({ type: "READY" });
    return;
  }

  if (type === "MATCH") {
    const { workerId, slice, thresholdPct, reportEvery } = ev.data;
    const threshold = thresholdPct / 100;
    const results   = [];
    let matched     = 0;

    for (let i = 0; i < slice.length; i++) {
      const row = slice[i];
      const { bestScore, bestCode, candidateCount, matches } = matchRow(row.blob, row.iata, threshold);

      // Diagnostic logging for the first 20 rows of worker 0:
      if (workerId === 0 && i < 20) {
        console.log(`[Worker ${workerId} Row ${row.rowIndex}] ${candidateCount} candidates, best score: ${(bestScore * 100).toFixed(1)}% (threshold: ${(threshold * 100).toFixed(0)}%)`);
        self.postMessage({
          type: "DIAG",
          workerId,
          rowIndex: row.rowIndex,
          candidateCount,
          bestRawScore: Math.round(bestScore * 1000) / 1000,
          threshold,
        });
      }

      const matchObjs = matches.map(m => ({
        ttiCode:  m.ttiCode,
        scorePct: Math.round(m.score * 1000) / 10,
      }));

      const isMatched = matchObjs.length > 0;
      if (isMatched) matched++;

      const bestScorePct = Math.round(bestScore * 1000) / 10;

      results.push({
        rowIndex:  row.rowIndex,
        original:  row.original,
        ttiCode:   isMatched ? matchObjs.map(m => m.ttiCode).join("; ") : "",
        scorePct:  isMatched ? matchObjs[0].scorePct : bestScorePct,
        scores:    isMatched ? matchObjs.map(m => m.scorePct).join("; ") : (bestScorePct > 0 ? String(bestScorePct) : ""),
      });

      // live progress update
      if ((i + 1) % reportEvery === 0 || i === slice.length - 1) {
        self.postMessage({
          type:     "PROGRESS",
          workerId,
          done:     i + 1,
          total:    slice.length,
          matched,
        });
      }
    }

    self.postMessage({ type: "DONE", workerId, results, matched });
  }
};
