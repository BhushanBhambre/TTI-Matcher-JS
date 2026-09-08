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
                              // candidates it.

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
  if (!blob) return s;
  const len = blob.length;
  if (len < 3) {
    if (len > 0) s.add(blob);
    return s;
  }
  for (let i = 0; i <= len - 3; i++) s.add(blob.slice(i, i + 3));
  return s;
}

function getMasterGrams(i) {
  if (!masterGramCache) return new Set();
  const cached = masterGramCache[i];
  if (cached !== undefined) return cached;
  const set = getTrigramSet(blobs[i]);
  masterGramCache[i] = set;
  return set;
}

function matchRow(queryBlob, queryIata, threshold) {
  const queryGrams = getTrigramSet(queryBlob);
  const sizeA = queryGrams.size;
  if (sizeA === 0) {
    return { bestCode: "", bestScore: 0, matches: [] };
  }

  const candidates = new Set();
  for (const g of queryGrams) {
    const bucket = index[g];
    if (bucket) {
      for (let k = 0; k < bucket.length; k++) {
        candidates.add(bucket[k]);
      }
    }
  }

  if (candidates.size === 0) {
    return { bestCode: "", bestScore: 0, matches: [] };
  }

  let bestRawScore = 0;
  let bestCode = "";
  const matches = [];

  for (const i of candidates) {
    const masterGrams = getMasterGrams(i);
    const sizeB = masterGrams.size;
    if (sizeB === 0) continue;

    // Prune candidates that mathematically cannot beat bestRawScore or threshold
    const minSize = sizeA < sizeB ? sizeA : sizeB;
    const maxTheoretical = (2 * minSize) / (sizeA + sizeB);
    const maxPossible = Math.min(1, maxTheoretical * 0.85 + 0.15);
    if (maxPossible <= bestRawScore && maxPossible < threshold) {
      continue;
    }

    let inter = 0;
    if (sizeA <= sizeB) {
      for (const g of queryGrams) {
        if (masterGrams.has(g)) inter++;
      }
    } else {
      for (const g of masterGrams) {
        if (queryGrams.has(g)) inter++;
      }
    }

    if (inter === 0) continue;

    let score = (2 * inter) / (sizeA + sizeB);
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

  // Diagnostic logging for the first 20 rows
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
  return {
    bestCode,
    bestScore: bestRawScore,
    matches: matches.slice(0, MAX_MATCHES),
  };
}

/* ── message handler ──────────────────────────────────────── */

self.onmessage = function (ev) {
  const { type } = ev.data;

  if (type === "INIT") {
    ttiCodes = ev.data.ttiCodes || [];
    iatas    = ev.data.iatas || [];
    blobs    = ev.data.blobs || [];
    index    = ev.data.index || {};
    masterGramCache = new Array(blobs.length);
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
      const { bestCode, bestScore, matches } = matchRow(row.blob, row.iata, threshold);

      const scorePct = Math.round(bestScore * 1000) / 10;
      const isMatched = scorePct >= thresholdPct && bestCode !== "";

      if (isMatched) matched++;

      results.push({
        rowIndex:  row.rowIndex,
        original:  row.original,
        ttiCode:   isMatched ? (matches.length > 1 ? matches.map(m => m.ttiCode).join("; ") : bestCode) : "",
        scorePct:  scorePct,
        scores:    matches.map(m => Math.round(m.score * 1000) / 10).join("; "),
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