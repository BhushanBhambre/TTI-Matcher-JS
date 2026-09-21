/**
 * matcher.js
 * ---------------------------------------------------------------------------
 * Orchestrator – runs entirely on the main thread but does NO heavy work:
 *   1. Delegates master-file parsing to masterWorker.js (off-thread).
 *   2. Streams the lookup file in chunks (main thread, but it's I/O-bound,
 *      not CPU-bound, so it's fine – we yield after each chunk).
 *   3. Once both are ready, splits the lookup array across N workers
 *      and fans out MATCH messages.
 *   4. Aggregates per-worker PROGRESS events and fires onProgress.
 *
 * Performance modes
 * -----------------
 *   "speed"       – more workers, report every 200 rows  (fastest throughput,
 *                   may cause slight UI stutter on low-RAM machines)
 *   "balanced"    – ~half cores, report every 100 rows   (default)
 *   "performance" – 2 workers, report every 50 rows      (smoothest UI, slower)
 * ---------------------------------------------------------------------------
 */

(function (global) {

  const MASTER_COLS = [
    "TTIcode","HotelName","IATA_code",
    "StreetNumber","AddressLine","PostalCode",
    "AddressCityName","CityName",
  ];

  /* ── helpers ──────────────────────────────────────────── */

  function stripQuotes(s) {
    const t = String(s || "").trim();
    return t.length >= 2 && t[0] === '"' && t[t.length-1] === '"'
      ? t.slice(1, -1) : t;
  }

  function normalize(raw) {
    return String(raw || "")
      .toLowerCase()
      .replace(/null/g, "")
      .replace(/[^a-z0-9]/g, "");
  }

  /* ── mode config ─────────────────────────────────────── */

  function modeConfig(mode) {
    const cores = navigator.hardwareConcurrency || 4;
    switch (mode) {
      case "speed":
        return { numWorkers: Math.min(cores, 16),          reportEvery: 200 };
      case "performance":
        return { numWorkers: Math.max(1, Math.min(2, cores)), reportEvery: 25  };
      default: // balanced
        return { numWorkers: Math.max(1, Math.min(Math.ceil(cores / 2), 8)), reportEvery: 75 };
    }
  }

  /* ── step 1: parse master in background worker ───────── */

  function parseMasterInWorker(file, onProgress, onLog) {
    return new Promise((resolve, reject) => {
      if (onLog) onLog(`Reading master file: ${file.name} (${(file.size/1024/1024).toFixed(1)} MB)…`);

      const w = new Worker("masterWorker.js");

      w.onmessage = ev => {
        const { type } = ev.data;

        if (type === "MASTER_PROGRESS") {
          if (onProgress) onProgress({
            phase: "master", pct: ev.data.pct,
            recordCount: ev.data.recordCount,
            bytesRead: ev.data.bytesRead, totalBytes: ev.data.totalBytes,
          });

        } else if (type === "MASTER_PARSE_DONE") {
          if (onLog) onLog(`Master parse done: ${ev.data.recordCount.toLocaleString()} records. Building index…`);

        } else if (type === "INDEX_PROGRESS") {
          if (onProgress) onProgress({
            phase: "index",
            pct: Math.round((ev.data.done / ev.data.total) * 100),
          });

        } else if (type === "MASTER_DONE") {
          w.terminate();
          if (onLog) onLog(
            `Index ready. ${ev.data.ttiCodes.length.toLocaleString()} records, ` +
            `${ev.data.prunedCount.toLocaleString()} stop-word trigrams pruned.`
          );
          resolve({
            ttiCodes:    ev.data.ttiCodes,
            iatas:       ev.data.iatas,
            offsets:     ev.data.offsets,
            allTrigrams: ev.data.allTrigrams,
            index:       ev.data.index,
          });

        } else if (type === "LOG") {
          if (onLog) onLog(ev.data.msg);

        } else if (type === "ERROR") {
          w.terminate();
          reject(new Error(ev.data.msg));
        }
      };

      w.onerror = err => { w.terminate(); reject(err); };
      w.postMessage({ file });
    });
  }

  /* ── step 2: stream lookup file (main thread, I/O-bound) ─ */

  /**
   * Column name aliases for the new multi-column lookup format.
   * Keys are the canonical field names; values are ordered lists of
   * possible header spellings (case-insensitive, trimmed).
   */
  const LOOKUP_ALIASES = {
    iata:     ["iata", "iata_code", "iata code"],
    name:     ["hotel name", "hotelname", "name", "hotel"],
    phone:    ["phone", "telephone", "tel"],
    addr1:    ["address_1", "address1", "address line 1", "addressline1", "streetaddress"],
    addr2:    ["address_2", "address2", "address line 2", "addressline2"],
    addr3:    ["address_3", "address3", "address line 3", "addressline3"],
    addr4:    ["address_4", "address4", "address line 4", "addressline4"],
    city:     ["city_name", "cityname", "city", "addresscityname", "town"],
    postal:   ["postalcode", "postal_code", "postal code", "zip", "zipcode"],
  };

  function detectLookupCols(headerCells) {
    const lc = headerCells.map(h => h.trim().toLowerCase());
    const found = {};
    for (const [key, aliases] of Object.entries(LOOKUP_ALIASES)) {
      for (const alias of aliases) {
        const idx = lc.indexOf(alias);
        if (idx !== -1) { found[key] = idx; break; }
      }
    }
    return found;           // { iata: 0, name: 1, phone: 2, addr1: 3, … }
  }

  async function parseLookupFile(file, onProgress, onLog) {
    if (onLog) onLog(`Reading lookup file: ${file.name} (${(file.size/1024/1024).toFixed(1)} MB)…`);

    let header     = "Hotel Name and address";
    const rows     = [];
    let firstLine  = true;
    let lineIndex  = 0;
    let lookupCols = null;   // populated from header row
    let isNewFormat = false; // true = multi-column TSV; false = legacy pipe-delimited

    await global.streamReader.streamFile(file, {
      onChunk: async (lines, bytesRead, totalBytes) => {
        for (const line of lines) {
          if (!line.trim()) continue;

          // ── Header ─────────────────────────────────────────
          if (firstLine) {
            firstLine = false;
            const headerCells = line.split("\t");
            lookupCols = detectLookupCols(headerCells);

            // New format = header has a recognisable "name" or "hotel name" col
            isNewFormat = "name" in lookupCols;

            if (isNewFormat) {
              // Build a meaningful display header from the lookup file columns
              const presentNames = headerCells.map(h => h.trim()).filter(Boolean);
              header = presentNames.join(" | ");
              if (onLog) onLog(
                `Lookup format: multi-column TSV. Detected cols: ${JSON.stringify(lookupCols)}`
              );
            } else {
              // Legacy: single cell, pipe-delimited ("Hotel Name,Address|IATA")
              header = headerCells[0] || "Hotel Name and address";
              if (onLog) onLog(`Lookup format: legacy pipe-delimited.`);
            }
            continue;
          }

          lineIndex++;
          const cells = line.split("\t");

          if (isNewFormat) {
            // ── New multi-column format ─────────────────────
            // Extract IATA
            const iata = lookupCols.iata !== undefined
              ? (cells[lookupCols.iata] || "").trim().replace(/\s+/g, "").toUpperCase()
              : "";

            // Build the blob from every present column that master also uses:
            // name + phone + addr1 + addr2 + addr3 + addr4 + city + postal
            const parts = [];
            for (const key of ["name","phone","addr1","addr2","addr3","addr4","city","postal"]) {
              if (lookupCols[key] !== undefined) {
                const val = stripQuotes(cells[lookupCols[key]] || "").trim();
                if (val) parts.push(val);
              }
            }
            const bodyText = parts.join(" ");
            if (!bodyText && !iata) continue;

            // original display: all cells joined with tab for the output file
            const original = cells.join("\t");

            rows.push({
              rowIndex: lineIndex,
              original,
              blob: normalize(bodyText),
              iata,
            });

          } else {
            // ── Legacy pipe-delimited format ────────────────
            const rawCell = stripQuotes(cells[0] || "");
            if (!rawCell) continue;

            const pipe   = rawCell.lastIndexOf("|");
            const body   = pipe === -1 ? rawCell : rawCell.slice(0, pipe);
            const iata   = (pipe === -1 ? "" : rawCell.slice(pipe + 1)).trim().toUpperCase();

            rows.push({
              rowIndex: lineIndex,
              original: cells[0],
              blob:     normalize(body),
              iata,
            });
          }
        }

        if (onProgress) onProgress({
          phase: "lookup",
          pct:   Math.round((bytesRead / totalBytes) * 100),
          recordCount: rows.length,
        });
      },
    });

    if (onLog) onLog(`Lookup parse done: ${rows.length.toLocaleString()} rows.`);
    return { header, rows };
  }

  /* ── step 3: fan-out matching across workers ─────────── */

  function matchAll(masterData, lookupRows, thresholdPct, mode, onProgress, onLog) {
    return new Promise((resolve, reject) => {
      const { numWorkers, reportEvery } = modeConfig(mode);
      const total = lookupRows.length;

      if (onLog) onLog(
        `Launching ${numWorkers} workers (mode: ${mode}, reportEvery: ${reportEvery} rows)…`
      );

      const sliceSize = Math.ceil(total / numWorkers);
      const wprog     = []; // per-worker { done, matched, active }
      const wresults  = [];
      let completed   = 0;
      const t0        = performance.now();

      function pushProgress() {
        let done = 0, matched = 0, active = 0;
        for (const p of wprog) { done += p.done; matched += p.matched; if (p.active) active++; }
        const elapsed = (performance.now() - t0) / 1000;
        const rps     = elapsed > 0.5 ? Math.round(done / elapsed) : 0;
        const eta     = rps > 0 ? Math.ceil((total - done) / rps) : 0;
        if (onProgress) onProgress({
          phase:        "matching",
          done,
          total,
          pct:          total > 0 ? Math.round((done / total) * 100) : 0,
          matchedCount: matched,
          recPerSec:    rps,
          elapsedSec:   Math.round(elapsed),
          etaSec:       eta,
          activeWorkers: active,
          totalWorkers:  numWorkers,
        });
      }

      const workers = [];
      let actualWorkers = 0;

      for (let w = 0; w < numWorkers; w++) {
        const start = w * sliceSize;
        const end   = Math.min(start + sliceSize, total);
        const slice = lookupRows.slice(start, end);

        wprog.push({ done: 0, matched: 0, active: slice.length > 0 });
        wresults.push([]);

        if (slice.length === 0) { completed++; continue; }
        actualWorkers++;

        const wk = new Worker("worker.js");
        workers.push({ wk, idx: w });

        const wIdx = w; // capture

        wk.onmessage = ev => {
          const { type } = ev.data;

          if (type === "READY") {
            // worker initialised – send it its slice
            wk.postMessage({ type: "MATCH", workerId: wIdx, slice, thresholdPct, reportEvery });

          } else if (type === "PROGRESS") {
            wprog[wIdx].done    = ev.data.done;
            wprog[wIdx].matched = ev.data.matched;
            pushProgress();

          } else if (type === "DIAG") {
            if (onLog) {
              onLog(`[Diag] Row ${ev.data.rowIndex}: ${ev.data.candidateCount} candidates, best score: ${ev.data.bestScorePct}% (threshold: ${ev.data.thresholdPct}%)`);
            }

          } else if (type === "DONE") {
            wprog[wIdx].done    = ev.data.results.length;
            wprog[wIdx].matched = ev.data.matched;
            wprog[wIdx].active  = false;
            wresults[wIdx]      = ev.data.results;
            wk.terminate();
            completed++;
            pushProgress();

            if (completed === numWorkers) {
              const merged = [];
              for (const r of wresults) merged.push(...r);
              merged.sort((a, b) => a.rowIndex - b.rowIndex);

              const totalMatched = merged.filter(r => r.ttiCode).length;
              const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
              if (onLog) onLog(
                `Done in ${elapsed}s — ${totalMatched.toLocaleString()} / ` +
                `${merged.length.toLocaleString()} rows matched.`
              );
              resolve(merged);
            }
          }
        };

        wk.onerror = err => { workers.forEach(o => o.wk.terminate()); reject(err); };

        // Send master data to worker (shared reference – structured clone happens once per worker)
        wk.postMessage({
          type: "INIT",
          ttiCodes:    masterData.ttiCodes,
          iatas:       masterData.iatas,
          offsets:     masterData.offsets,
          allTrigrams: masterData.allTrigrams,
          index:       masterData.index,
        });
      }

      // Edge case: zero lookup rows
      if (actualWorkers === 0) resolve([]);
      pushProgress();
    });
  }

  /* ── export ─────────────────────────────────────────── */

  function generateTxtBlob(header, results) {
    const lines = [`${header}\tTTI code\tMatch %`];
    for (const r of results) lines.push(`${r.original}\t${r.ttiCode || ""}\t${r.scorePct}`);
    return new Blob([lines.join("\r\n")], { type: "text/plain;charset=utf-8" });
  }

  global.matcherLib = {
    parseMasterInWorker,
    parseLookupFile,
    matchAll,
    generateTxtBlob,
    modeConfig,
  };

})(typeof window !== "undefined" ? window : this);
