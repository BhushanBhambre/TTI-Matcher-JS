/**
 * matcher.js
 * ---------------------------------------------------------------------------
 * Fuzzy-matching engine for pulling TTI codes from a master hotel list into
 * a lookup list, based on hotel name + address text (the "composite blob").
 *
 * Algorithm summary
 * ------------------
 * 1. Every master row and every lookup row is reduced to a single normalized
 *    "blob" string: lowercase, alphanumeric only, with the literal word
 *    "null" stripped out (the source files use NULL as a placeholder).
 * 2. Each blob is broken into overlapping 3-character shingles (trigrams).
 * 3. Similarity between two blobs = Dice coefficient of their trigram sets:
 *        score = 2 * |A ∩ B| / (|A| + |B|)
 *    This is a standard, cheap, and robust way to score fuzzy text
 *    similarity without pulling in a heavy NLP library.
 * 4. To avoid comparing every lookup row against all ~59k master rows
 *    (O(N*M)), an inverted index (trigram -> [master row indices]) is built
 *    once. For a given lookup blob, only master rows that share at least one
 *    trigram are ever scored ("candidate blocking"). This is the standard
 *    technique used by real-world search engines / record-linkage tools and
 *    keeps the whole match run to a handful of seconds even for large files.
 * 5. If the lookup row also carries an IATA airport code (text after the
 *    final "|"), an exact IATA match on a candidate gives it a small score
 *    bonus - it's a strong hint but not authoritative on its own (many
 *    lookup rows have no IATA at all).
 * 6. UPDATED: instead of keeping only the single best-scoring master record
 *    per lookup row, every candidate whose score clears the threshold is
 *    returned (sorted best-first). This matters for cases like hotel chains
 *    or multi-property addresses where more than one TTI code legitimately
 *    matches the same lookup text.
 * ---------------------------------------------------------------------------
 */

/** Master file columns we actually need, by header name. */
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

/** Cap on how many matches we'll return per lookup row, to keep output sane. */
const MAX_MATCHES_PER_ROW = 20;

/** Delimiter used to join multiple TTI codes / scores in the flat output columns. */
const MULTI_DELIMITER = "; ";

/**
 * Strip surrounding double quotes some exports wrap fields in.
 * @param {string} s
 * @returns {string}
 */
function stripQuotes(s) {
  const t = s.trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Normalize free text into a comparable "blob": lowercase, drop the literal
 * placeholder "null", and keep only letters/digits (no spaces or
 * punctuation). Dropping separators is intentional - the source data itself
 * often concatenates fields with no delimiter (e.g. "17055Toirano"), so
 * comparing on raw characters is more reliable than trying to re-split it.
 * @param {string} raw
 * @returns {string}
 */
function normalize(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/null/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Build the set of overlapping 3-character shingles for a blob.
 * Short blobs (<3 chars) fall back to the whole string as a single token
 * so they still participate in matching instead of producing an empty set.
 * @param {string} blob
 * @returns {Set<string>}
 */
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

/** Dice coefficient of two trigram sets. Returns a value in [0, 1]. */
function diceScore(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  const [small, big] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let intersection = 0;
  for (const g of small) {
    if (big.has(g)) intersection++;
  }
  return (2 * intersection) / (setA.size + setB.size);
}

/**
 * Split a raw tab/CRLF delimited text blob into an array of rows (array of
 * cell strings). Handles both \r\n and \n line endings and drops blank
 * trailing lines.
 * @param {string} text
 * @returns {string[][]}
 */
function splitRows(text) {
  return text
    .split(/\r\n|\n|\r/)
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"));
}

/**
 * Parse the master file into row records + a pre-built fuzzy-match index.
 * @param {string} text Raw contents of the master TSV file.
 * @returns {{rows: object[], index: Map<string, number[]>}}
 */
function parseMasterFile(text) {
  const rows = splitRows(text);
  if (rows.length === 0) throw new Error("Master file is empty.");

  const header = rows[0].map((h) => h.trim());
  const colIndex = {};
  for (const name of MASTER_COLUMNS) {
    const idx = header.indexOf(name);
    if (idx === -1) throw new Error(`Master file is missing column "${name}".`);
    colIndex[name] = idx;
  }

  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length < 2) continue; // skip stray blank/short lines

    const ttiCode = (cells[colIndex.TTIcode] || "").trim();
    if (!ttiCode) continue;

    const blobSource =
      (cells[colIndex.HotelName] || "") +
      (cells[colIndex.StreetNumber] || "") +
      (cells[colIndex.AddressLine] || "") +
      (cells[colIndex.PostalCode] || "") +
      (cells[colIndex.AddressCityName] || "") +
      (cells[colIndex.CityName] || "");

    records.push({
      ttiCode,
      iata: (cells[colIndex.IATA_code] || "").trim().toUpperCase(),
      blob: normalize(blobSource),
    });
  }

  // Build the inverted trigram index: trigram -> list of record indices.
  const index = new Map();
  for (let i = 0; i < records.length; i++) {
    records[i].grams = trigrams(records[i].blob);
    for (const g of records[i].grams) {
      let bucket = index.get(g);
      if (!bucket) {
        bucket = [];
        index.set(g, bucket);
      }
      bucket.push(i);
    }
  }

  // Prune trigrams that are too common to be useful for narrowing candidates
  // (e.g. "ote"/"tel" from "hotel" appear in a huge fraction of rows). This
  // is the classic search-engine "stop word" trick applied to shingles: it
  // keeps candidate lists small and fast without hurting match quality,
  // because the *distinctive* trigrams (from postal codes, city/street
  // names) are what actually identify the right record.
  const MAX_POSTING_LIST = Math.max(200, Math.round(records.length * 0.005));
  for (const [gram, bucket] of index) {
    if (bucket.length > MAX_POSTING_LIST) index.delete(gram);
  }

  return { records, index };
}

/**
 * Parse the lookup file into row records.
 * Each data line looks like:  "Hotel Name,Address bits concatenated|IATA"
 * @param {string} text Raw contents of the lookup file.
 * @returns {{header: string, rows: {original: string, blob: string, iata: string}[]}}
 */
function parseLookupFile(text) {
  const rows = splitRows(text);
  if (rows.length === 0) throw new Error("Lookup file is empty.");

  const header = rows[0][0] || "Hotel Name and address";
  const records = [];

  for (let r = 1; r < rows.length; r++) {
    const rawCell = stripQuotes(rows[r][0] || "");
    if (!rawCell) continue;

    const lastPipe = rawCell.lastIndexOf("|");
    const bodyText = lastPipe === -1 ? rawCell : rawCell.slice(0, lastPipe);
    const iata = (lastPipe === -1 ? "" : rawCell.slice(lastPipe + 1)).trim().toUpperCase();

    records.push({
      original: rows[r][0], // keep exactly as-is (with quotes) for output
      blob: normalize(bodyText),
      iata,
    });
  }

  return { header, rows: records };
}

/**
 * Find every master record whose score against the lookup blob clears the
 * threshold, using the trigram inverted index for candidate blocking.
 * Replaces the old "single best match" behavior: multiple master rows can
 * legitimately correspond to the same lookup text (e.g. chain properties,
 * multiple buildings at one address), so we surface all of them.
 *
 * @param {{blob: string, iata: string}} query
 * @param {{records: object[], index: Map<string, number[]>}} master
 * @param {number} thresholdPct Minimum match % (0-100) to accept a match.
 * @returns {{ttiCode: string, score: number}[]} sorted best-first, score in [0, 1]
 */
function findAllMatches(query, master, thresholdPct) {
  const queryGrams = trigrams(query.blob);
  const thresholdFrac = thresholdPct / 100;

  // Gather candidate record indices: anything sharing >=1 trigram.
  const candidateSet = new Set();
  for (const g of queryGrams) {
    const bucket = master.index.get(g);
    if (bucket) for (const i of bucket) candidateSet.add(i);
  }

  // Fallback: if nothing shares a trigram (e.g. very short/odd text),
  // scan everything so we still return the closest possible matches.
  const candidates = candidateSet.size > 0 ? candidateSet : master.records.keys();

  const matches = [];
  for (const i of candidates) {
    const rec = master.records[i];
    let score = diceScore(queryGrams, rec.grams);
    if (query.iata && rec.iata && query.iata === rec.iata) {
      score = Math.min(1, score * 0.85 + 0.15); // small, capped IATA bonus
    }
    if (score >= thresholdFrac) {
      matches.push({ ttiCode: rec.ttiCode, score });
    }
  }

  // Best-first, and cap so a degenerate blob (e.g. an almost-empty string)
  // can't blow up the output with hundreds of low-quality matches.
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, MAX_MATCHES_PER_ROW);
}

/**
 * Run matching for every lookup row against the master index, yielding
 * control back to the browser periodically so a progress bar can update
 * and the UI never freezes.
 *
 * Each result row now carries ALL matching TTI codes (above threshold),
 * not just the single best one:
 *   - ttiCode:   all matched codes joined with "; " (best-first) - handy
 *                for a simple flat spreadsheet column, kept for
 *                backwards-compatibility with existing UI code.
 *   - scorePct:  the best (highest) match % among the row's matches.
 *   - scores:    all match %s, same order as ttiCode, joined with "; ".
 *   - matches:   the full structured list [{ttiCode, scorePct}, ...] in
 *                case the UI wants to render them separately (e.g. one
 *                row per match, or a dropdown of candidates).
 *
 * @param {object} master  Result of parseMasterFile().
 * @param {object} lookup  Result of parseLookupFile().
 * @param {number} thresholdPct Minimum match % (0-100) to accept a match.
 * @param {(done: number, total: number) => void} onProgress
 * @returns {Promise<{original: string, ttiCode: string, scorePct: number, scores: string, matches: {ttiCode: string, scorePct: number}[]}[]>}
 */
async function matchAll(master, lookup, thresholdPct, onProgress) {
  const results = [];
  const total = lookup.rows.length;
  const YIELD_EVERY = 5; // rows processed between UI yields

  for (let i = 0; i < total; i++) {
    const row = lookup.rows[i];
    const rawMatches = findAllMatches(row, master, thresholdPct);

    const matches = rawMatches.map((m) => ({
      ttiCode: m.ttiCode,
      scorePct: Math.round(m.score * 1000) / 10, // one decimal place
    }));

    results.push({
      original: row.original,
      ttiCode: matches.map((m) => m.ttiCode).join(MULTI_DELIMITER),
      scorePct: matches.length > 0 ? matches[0].scorePct : 0,
      scores: matches.map((m) => m.scorePct).join(MULTI_DELIMITER),
      matches,
    });

    if (i % YIELD_EVERY === 0 || i === total - 1) {
      onProgress(i + 1, total);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return results;
}

// Expose a small public surface to the UI layer (app.js).
window.matcherLib = { parseMasterFile, parseLookupFile, matchAll };
