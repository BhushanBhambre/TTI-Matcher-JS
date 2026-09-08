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
let masterGramCache = null;  // Array<Set<string>|undefined> — lazily filled,
                              // one Set per master record, computed ONCE
                              // total instead of once per query row that
                              // candidates it. This was the actual cause of
                              // the ~15 rec/sec slowdown: getTrigramSet was
                              // being called on the same master blob
                              // thousands of times across different rows.

const MAX_MATCHES = 20;
let diagLogged = 0; // caps the diagnostic score logging to first few rows

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
  // build once, reuse forever after — this is the fix
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
  const candidates = new Set();

  for (const g of queryGrams) {
    const bucket = index[g];
    if (bucket) for (let i = 0; i < bucket.length; i++) candidates.add(bucket[i]);
  }

  // fallback: no candidates – skip (avoid O(N) scan)
  if (candidates.size === 0) return [];

  const matches = [];
  let bestRawScore = 0; // diagnostic only — best score seen, pre-threshold

  for (const i of candidates) {
    const masterGrams = getMasterGrams(i); // ← was getTrigramSet(blobs[i]) every time
    let score = diceScore(queryGrams, masterGrams);
    if (queryIata && iatas[i] && queryIata === iatas[i]) {
      score = Math.min(1, score * 0.85 + 0.15);
    }
    if (score > bestRawScore) bestRawScore = score;
    if (score >= threshold) matches.push({ ttiCode: ttiCodes[i], score });
  }

  // One-time diagnostic: shows whether low match count is a threshold
  // problem (bestRawScore consistently just under threshold) or a data/
  // normalization problem (bestRawScore near 0 despite many candidates).
  // Remove this block once you've confirmed which it is.
  if (diagLogged < 20) {
    diagLogged++;
    self.postMessage({
      type: "DIAG",
      candidateCount: candidates.size,
      bestRawScore: Math.round(bestRawScore * 1000) / 1000,
      threshold,
    });
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, MAX_MATCHES);
}

/* ── message handler ──────────────────────────────────────── */

self.onmessage = function (ev) {
  const { type } = ev.data;

  if (type === "INIT") {
    ttiCodes = ev.data.ttiCodes;
    iatas    = ev.data.iatas;
    blobs    = ev.data.blobs;
    index    = ev.data.index;
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
      const raw = matchRow(row.blob, row.iata, threshold);

      const matchObjs = raw.map(m => ({
        ttiCode:  m.ttiCode,
        scorePct: Math.round(m.score * 1000) / 10,
      }));

      matched += matchObjs.length > 0 ? 1 : 0;

      results.push({
        rowIndex:  row.rowIndex,
        original:  row.original,
        ttiCode:   matchObjs.map(m => m.ttiCode).join("; "),
        scorePct:  matchObjs.length > 0 ? matchObjs[0].scorePct : 0,
        scores:    matchObjs.map(m => m.scorePct).join("; "),
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