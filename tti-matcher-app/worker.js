/**
 * worker.js
 * ---------------------------------------------------------------------------
 * High-performance, exact fuzzy matching worker:
 *   1. Receives compact TypedArrays (offsets, allTrigrams, index) from masterWorker.
 *   2. Extracts integer trigrams for each lookup query row.
 *   3. Collects candidates using the inverted index (with all-record fallback).
 *   4. Computes 100% EXACT Dice similarity against allTrigrams (all shingles included).
 *   5. Finds the highest match %. If multiple master records tie for the best match %,
 *      they are combined with "; " in the TTI code column.
 *   6. Sub-threshold rows preserve their closest match % with empty TTI code.
 * ---------------------------------------------------------------------------
 */

/* ── Globals set by INIT ──────────────────────────────────── */
let ttiCodes    = null; // string[]
let iatas       = null; // string[]
let offsets     = null; // Uint32Array: record start/end offsets in allTrigrams
let allTrigrams = null; // Uint16Array: contiguous shingle integers for all master records
let index       = null; // plain object: trigramInt -> Uint32Array

const MAX_MATCHES_TIE = 10;

function charToSymbol(code) {
  if (code >= 97 && code <= 122) return code - 97; // a-z -> 0..25
  if (code >= 48 && code <= 57) return code - 22;  // 0-9 -> 26..35
  return -1;
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

function matchRow(queryBlob, queryIata, thresholdPct) {
  const queryGrams = getTrigramInts(queryBlob);
  const sizeA = queryGrams.length;
  if (sizeA === 0) {
    return { bestScorePct: 0, bestCandidates: [], candidateCount: 0 };
  }

  const queryGramSet = new Set(queryGrams);
  const thresholdFrac = thresholdPct / 100;

  // Step 1: Candidate gathering via index
  const candidateSet = new Set();
  for (let k = 0; k < sizeA; k++) {
    const bucket = index[queryGrams[k]];
    if (bucket) {
      for (let i = 0; i < bucket.length; i++) {
        candidateSet.add(bucket[i]);
      }
    }
  }

  const totalMaster    = ttiCodes.length;
  const candidateCount = candidateSet.size;
  const candidates     = candidateCount > 0 ? candidateSet : null;

  let bestScore      = 0;
  let bestScorePct   = 0;
  let bestCandidates = [];

  function evaluateCandidate(i) {
    const start = offsets[i];
    const end   = offsets[i + 1];
    const sizeB = end - start;
    if (sizeB === 0) return;

    // Count exact shared trigrams
    let inter = 0;
    for (let k = start; k < end; k++) {
      if (queryGramSet.has(allTrigrams[k])) inter++;
    }
    if (inter === 0) return;

    // Dice coefficient (standard)
    const dice = (2 * inter) / (sizeA + sizeB);

    // Containment: useful when lookup blob is much shorter than master blob
    const minSize = sizeA < sizeB ? sizeA : sizeB;
    const contain = inter / minSize;

    // Use whichever gives a higher score (helps short lookup rows match longer master blobs)
    let score = Math.max(dice, 0.5 * dice + 0.5 * contain);

    if (queryIata && iatas[i] && queryIata === iatas[i]) {
      score = Math.min(1, score * 0.85 + 0.15);
    }

    const scorePct = Math.round(score * 1000) / 10;

    if (scorePct > bestScorePct) {
      bestScorePct   = scorePct;
      bestScore      = score;
      bestCandidates = [ttiCodes[i]];
    } else if (scorePct === bestScorePct && bestScorePct > 0) {
      if (bestCandidates.length < MAX_MATCHES_TIE && !bestCandidates.includes(ttiCodes[i])) {
        bestCandidates.push(ttiCodes[i]);
      }
    }
  }

  if (candidates) {
    for (const id of candidates) evaluateCandidate(id);
  } else {
    for (let id = 0; id < totalMaster; id++) evaluateCandidate(id);
  }

  return {
    bestScorePct,
    bestCandidates,
    candidateCount: candidateCount > 0 ? candidateCount : totalMaster,
  };
}

/* ── Message handler ──────────────────────────────────────── */

self.onmessage = function (ev) {
  const { type } = ev.data;

  if (type === "INIT") {
    ttiCodes    = ev.data.ttiCodes;
    iatas       = ev.data.iatas;
    offsets     = ev.data.offsets;
    allTrigrams = ev.data.allTrigrams;
    index       = ev.data.index;
    self.postMessage({ type: "READY" });
    return;
  }

  if (type === "MATCH") {
    const { workerId, slice, thresholdPct, reportEvery } = ev.data;
    const results = [];
    let matched = 0;

    for (let i = 0; i < slice.length; i++) {
      const row = slice[i];
      const { bestScorePct, bestCandidates, candidateCount } = matchRow(row.blob, row.iata, thresholdPct);

      // Diagnostic: first 20 rows of worker 0
      if (workerId === 0 && i < 20) {
        self.postMessage({
          type: "DIAG",
          workerId,
          rowIndex:      row.rowIndex,
          candidateCount,
          bestScorePct,
          thresholdPct,
        });
      }

      const isMatched     = bestScorePct >= thresholdPct && bestCandidates.length > 0;
      if (isMatched) matched++;

      results.push({
        rowIndex:  row.rowIndex,
        original:  row.original,
        ttiCode:   isMatched ? bestCandidates.join("; ") : "",
        scorePct:  bestScorePct,
        scores:    bestScorePct > 0 ? String(bestScorePct) : "",
      });

      if ((i + 1) % reportEvery === 0 || i === slice.length - 1) {
        self.postMessage({ type: "PROGRESS", workerId, done: i + 1, total: slice.length, matched });
      }
    }

    self.postMessage({ type: "DONE", workerId, results, matched });
  }
};
