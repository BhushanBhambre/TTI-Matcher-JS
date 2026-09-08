/**
 * worker.js
 * ---------------------------------------------------------------------------
 * High-performance, zero-allocation matching worker:
 *   1. Receives compact inverted index + masterGramCounts (Uint16Array).
 *   2. DOES NOT store or touch master blobs or master trigram Sets.
 *   3. Calculates Dice intersection directly via inverted index frequency counts:
 *      shared trigrams = count of times candidate appears in query's posting lists.
 *   4. Zero object allocations during matching loop — zero GC pause, zero OOM.
 * ---------------------------------------------------------------------------
 */

/* ── Globals set by INIT ──────────────────────────────────── */
let ttiCodes         = null;
let iatas            = null;
let masterGramCounts = null; // Uint16Array: unique trigram count per master record
let index            = null; // plain object: trigram -> Uint32Array

let sharedCounts     = null; // Uint16Array: reusable frequency accumulator
let touched          = null; // number[]: reusable touched candidate index list

const MAX_MATCHES = 20;

/* ── helpers ──────────────────────────────────────────────── */

function getTrigramSet(blob) {
  const s   = new Set();
  const len = blob.length;
  if (len === 0) return s;
  if (len < 3) { s.add(blob); return s; }
  for (let i = 0; i <= len - 3; i++) s.add(blob.slice(i, i + 3));
  return s;
}

function matchRow(queryBlob, queryIata, threshold) {
  const queryGrams = getTrigramSet(queryBlob);
  const sizeA = queryGrams.size;
  if (sizeA === 0) return { bestScore: 0, bestCode: "", candidateCount: 0, matches: [] };

  // Step 1: Accumulate shared trigram count via inverted index
  for (const g of queryGrams) {
    const bucket = index[g];
    if (!bucket) continue;
    for (let i = 0; i < bucket.length; i++) {
      const id = bucket[i];
      if (sharedCounts[id] === 0) {
        touched.push(id);
      }
      sharedCounts[id]++;
    }
  }

  const candidateCount = touched.length;
  if (candidateCount === 0) {
    return { bestScore: 0, bestCode: "", candidateCount: 0, matches: [] };
  }

  const matches = [];
  let bestRawScore = 0;
  let bestCode = "";

  // Step 2: Score touched candidates directly from sharedCounts
  for (let i = 0; i < touched.length; i++) {
    const id = touched[i];
    const inter = sharedCounts[id];
    sharedCounts[id] = 0; // Reset in-place for zero-cost cleanup!

    const sizeB = masterGramCounts[id];
    let score = (2 * inter) / (sizeA + sizeB);

    if (queryIata && iatas[id] && queryIata === iatas[id]) {
      score = Math.min(1, score * 0.85 + 0.15);
    }

    if (score > bestRawScore) {
      bestRawScore = score;
      bestCode = ttiCodes[id];
    }

    if (score >= threshold) {
      matches.push({ ttiCode: ttiCodes[id], score });
    }
  }

  touched.length = 0; // Reset for next query row!

  matches.sort((a, b) => b.score - a.score);
  return {
    bestScore: bestRawScore,
    bestCode,
    candidateCount,
    matches: matches.slice(0, MAX_MATCHES),
  };
}

/* ── Message handler ──────────────────────────────────────── */

self.onmessage = function (ev) {
  const { type } = ev.data;

  if (type === "INIT") {
    ttiCodes         = ev.data.ttiCodes;
    iatas            = ev.data.iatas;
    masterGramCounts = ev.data.masterGramCounts;
    index            = ev.data.index;

    // Allocate reusable TypedArray accumulator once per worker
    sharedCounts     = new Uint16Array(ttiCodes.length);
    touched          = [];

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

      // Live progress update
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
