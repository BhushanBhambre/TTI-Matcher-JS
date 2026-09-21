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

  // Lookup column names for the NEW multi-column format
  // IATA \t Hotel name \t phone \t address_1 \t address_2 \t address_3 \t address_4 \t city_name
  const NEW_LOOKUP_COLS = ["iata", "hotel name", "phone", "address_1", "address_2", "address_3", "address_4", "city_name"];

  function detectLookupFormat(headerCells) {
    // New format: has at least 3 tab-separated columns with known names
    const lower = headerCells.map(c => c.toLowerCase().trim());
    const hasHotelName = lower.some(c => c.includes("hotel") && c.includes("name"));
    const hasIata      = lower.some(c => c === "iata");
    return hasIata && hasHotelName ? "new" : "old";
  }

  async function parseLookupFile(file, onProgress, onLog) {
    if (onLog) onLog(`Reading lookup file: ${file.name} (${(file.size/1024/1024).toFixed(1)} MB)…`);

    let header      = "Hotel Name and address";
    const rows      = [];
    let firstLine   = true;
    let lineIndex   = 0;
    let format      = null;   // "old" | "new"
    let colIdx      = {};     // column name -> index (new format only)

    await global.streamReader.streamFile(file, {
      onChunk: async (lines, bytesRead, totalBytes) => {
        for (const line of lines) {
          if (!line.trim()) continue;

          // ── Header row ──────────────────────────────────────
          if (firstLine) {
            firstLine = false;
            const cells = line.split("\t");
            format = detectLookupFormat(cells);

            if (format === "new") {
              // Map column names to indices (case-insensitive, trimmed)
              const lower = cells.map(c => c.toLowerCase().trim());
              for (const name of NEW_LOOKUP_COLS) {
                const idx = lower.findIndex(c => c === name || c.includes(name.split(" ")[0]));
                colIdx[name] = idx; // -1 if absent, that's fine
              }
              header = "Hotel Name and address"; // output header stays the same
            } else {
              header = cells[0] || "Hotel Name and address";
            }
            continue;
          }

          lineIndex++;
          const cells = line.split("\t");

          // ── New multi-column TSV format ──────────────────────
          if (format === "new") {
            // IATA is always column 0 in this format
            const iata = (cells[0] || "").trim().toUpperCase();

            // Gather all text fields that contribute to identity:
            // Hotel name + all four address fields + city_name
            // (skip phone — not useful for fuzzy hotel matching)
            const textParts = [
              cells[1] || "",   // Hotel name
              cells[3] || "",   // address_1
              cells[4] || "",   // address_2
              cells[5] || "",   // address_3
              cells[6] || "",   // address_4
              cells[7] || "",   // city_name
            ];
            const blobSource = textParts.join(" ");

            // Reconstruct a single "original" display string for the output
            const hotelName = stripQuotes((cells[1] || "").trim());
            const addrParts = [cells[3], cells[4], cells[5], cells[6], cells[7]]
              .map(c => stripQuotes((c || "").trim()))
              .filter(Boolean);
            const original = `"${hotelName}${addrParts.length ? "," + addrParts.join(" ") : ""}|${iata}"`;

            if (!normalize(blobSource)) continue; // skip completely empty rows

            rows.push({
              rowIndex: lineIndex,
              original,
              blob: normalize(blobSource),
              iata,
            });

          // ── Old pipe-delimited single-column format ──────────
          } else {
            const rawCell = stripQuotes(cells[0] || "");
            if (!rawCell) continue;

            const pipe = rawCell.lastIndexOf("|");
            const body = pipe === -1 ? rawCell : rawCell.slice(0, pipe);
            const iata = (pipe === -1 ? "" : rawCell.slice(pipe + 1)).trim().toUpperCase();

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
          pct: Math.round((bytesRead / totalBytes) * 100),
          recordCount: rows.length,
        });
      },
    });

    if (onLog) onLog(`Lookup parse done (format: ${format}): ${rows.length.toLocaleString()} rows.`);
    return { header, rows, format };
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
