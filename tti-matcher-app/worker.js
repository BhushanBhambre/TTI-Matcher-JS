/**
 * worker.js
 * ---------------------------------------------------------------------------
 * Simple Web Worker thread.
 * Receives a slice of the lookup array and the master index, runs fuzzy
 * matching on the slice, and emits live progress updates back to the main thread.
 * ---------------------------------------------------------------------------
 */

const MAX_MATCHES_PER_ROW = 20;

function stripQuotes(s) {
  const t = String(s || "").trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    return t.slice(1, -1);
  }
  return t;
}

function normalize(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/null/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function trigrams(blob) {
  const grams = new Set();
  if (blob.length < 3) {
    if (blob.length > 0) grams.add(blob);
    return grams;
  }
  for (let i = 0; i <= blob.length - 3; i++) {
    grams.add(blob.slice(i, i + 3));
  }
  return grams;
}

function diceScore(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  const [small, big] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let intersection = 0;
  for (const g of small) {
    if (big.has(g)) intersection++;
  }
  return (2 * intersection) / (setA.size + setB.size);
}

function findAllMatches(query, masterRecords, trigramIndex, thresholdPct) {
  const queryGrams = trigrams(query.blob);
  const thresholdFrac = thresholdPct / 100;

  // Candidate blocking using inverted index
  const candidateSet = new Set();
  for (const g of queryGrams) {
    const bucket = trigramIndex.get(g);
    if (bucket) {
      for (let i = 0; i < bucket.length; i++) {
        candidateSet.add(bucket[i]);
      }
    }
  }

  const candidates = candidateSet.size > 0 ? candidateSet : masterRecords.keys();

  const matches = [];
  for (const i of candidates) {
    const rec = masterRecords[i];
    let score = diceScore(queryGrams, rec.grams);
    if (query.iata && rec.iata && query.iata === rec.iata) {
      score = Math.min(1, score * 0.85 + 0.15);
    }
    if (score >= thresholdFrac) {
      matches.push({ ttiCode: rec.ttiCode, score });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, MAX_MATCHES_PER_ROW);
}

self.onmessage = function (e) {
  const { type } = e.data;

  if (type === "START") {
    const { workerId, masterRecordsData, indexEntries, lookupSlice, thresholdPct } = e.data;

    // Reconstruct master records with trigram sets
    const masterRecords = masterRecordsData.map((r) => ({
      ttiCode: r.ttiCode,
      iata: r.iata,
      blob: r.blob,
      grams: trigrams(r.blob),
    }));

    // Reconstruct trigram index Map
    const trigramIndex = new Map(indexEntries);

    const totalInSlice = lookupSlice.length;
    const results = [];
    let matchedCountInSlice = 0;

    const YIELD_EVERY = 50; // Report progress to UI every 50 rows matched

    for (let i = 0; i < totalInSlice; i++) {
      const row = lookupSlice[i];
      const rawMatches = findAllMatches(row, masterRecords, trigramIndex, thresholdPct);

      const matches = rawMatches.map((m) => ({
        ttiCode: m.ttiCode,
        scorePct: Math.round(m.score * 1000) / 10,
      }));

      const ttiCodeJoined = matches.map((m) => m.ttiCode).join("; ");
      const scoresJoined = matches.map((m) => m.scorePct).join("; ");
      const bestScorePct = matches.length > 0 ? matches[0].scorePct : 0;

      if (matches.length > 0) {
        matchedCountInSlice++;
      }

      results.push({
        rowIndex: row.rowIndex,
        original: row.original,
        ttiCode: ttiCodeJoined,
        scorePct: bestScorePct,
        scores: scoresJoined,
        matchesCount: matches.length,
      });

      if ((i + 1) % YIELD_EVERY === 0 || i === totalInSlice - 1) {
        self.postMessage({
          type: "PROGRESS",
          workerId,
          doneInSlice: i + 1,
          totalInSlice,
          matchedCountInSlice,
        });
      }
    }

    self.postMessage({
      type: "DONE",
      workerId,
      results,
      matchedCountInSlice,
    });
  }
};
