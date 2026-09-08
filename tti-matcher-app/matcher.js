/**
 * matcher.js
 * ---------------------------------------------------------------------------
 * Simple, fast, multi-threaded fuzzy matching engine.
 * Streams Master and Lookup files cleanly, builds trigram candidate index,
 * and splits the lookup dataset evenly across background Web Workers.
 * Reports live progress, active worker counts, speed, and ETA to the UI.
 * ---------------------------------------------------------------------------
 */

(function (global) {
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
    return Array.from(grams);
  }

  /**
   * Stream parse Master File cleanly.
   */
  async function streamParseMasterFile(file, onProgress, onLog) {
    if (onLog) onLog(`Reading Master File: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)...`);

    const records = [];
    let header = null;
    let colIndex = {};
    let isFirstLine = true;

    await global.streamReader.streamFile(file, {
      onChunk: async (lines, bytesRead, totalBytes) => {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line || !line.trim()) continue;

          if (isFirstLine) {
            isFirstLine = false;
            header = line.split("\t").map((h) => h.trim());
            for (let c = 0; c < MASTER_COLUMNS.length; c++) {
              const col = MASTER_COLUMNS[c];
              const idx = header.indexOf(col);
              if (idx === -1) {
                throw new Error(`Master file missing required column: "${col}"`);
              }
              colIndex[col] = idx;
            }
            continue;
          }

          const cells = line.split("\t");
          if (cells.length < 2) continue;

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

        if (onProgress) {
          onProgress({
            stage: "master_parse",
            bytesRead,
            totalBytes,
            recordCount: records.length,
            pct: Math.round((bytesRead / totalBytes) * 100),
          });
        }
      },
    });

    if (onLog) onLog(`Master File parsed: ${records.length.toLocaleString()} valid hotel records.`);
    if (onLog) onLog("Building inverted trigram index...");

    // Build Inverted Index Map: trigram -> list of record indices
    const indexMap = new Map();
    for (let i = 0; i < records.length; i++) {
      const grams = trigrams(records[i].blob);
      for (let j = 0; j < grams.length; j++) {
        const g = grams[j];
        let bucket = indexMap.get(g);
        if (!bucket) {
          bucket = [];
          indexMap.set(g, bucket);
        }
        bucket.push(i);
      }
    }

    // Prune ultra-common stop-word trigrams (>0.5% of records)
    const MAX_POSTING_LIST = Math.max(300, Math.round(records.length * 0.005));
    let prunedCount = 0;
    for (const [gram, bucket] of indexMap) {
      if (bucket.length > MAX_POSTING_LIST) {
        indexMap.delete(gram);
        prunedCount++;
      }
    }

    if (onLog) {
      onLog(`Index built: ${indexMap.size.toLocaleString()} trigrams (${prunedCount.toLocaleString()} stop-words pruned).`);
    }

    return { records, indexMap };
  }

  /**
   * Stream parse Lookup File cleanly.
   */
  async function streamParseLookupFile(file, onProgress, onLog) {
    if (onLog) onLog(`Reading Lookup File: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)...`);

    let header = "Hotel Name and address";
    const lookupRows = [];
    let isFirstLine = true;
    let totalLineIndex = 0;

    await global.streamReader.streamFile(file, {
      onChunk: async (lines, bytesRead, totalBytes) => {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line || !line.trim()) continue;

          if (isFirstLine) {
            isFirstLine = false;
            header = line.split("\t")[0] || line;
            continue;
          }

          totalLineIndex++;
          const cells = line.split("\t");
          const rawCell = stripQuotes(cells[0] || "");
          if (!rawCell) continue;

          const lastPipe = rawCell.lastIndexOf("|");
          const bodyText = lastPipe === -1 ? rawCell : rawCell.slice(0, lastPipe);
          const iata = (lastPipe === -1 ? "" : rawCell.slice(lastPipe + 1)).trim().toUpperCase();

          lookupRows.push({
            rowIndex: totalLineIndex,
            original: cells[0],
            blob: normalize(bodyText),
            iata,
          });
        }

        if (onProgress) {
          onProgress({
            stage: "lookup_parse",
            bytesRead,
            totalBytes,
            recordCount: lookupRows.length,
            pct: Math.round((bytesRead / totalBytes) * 100),
          });
        }
      },
    });

    if (onLog) onLog(`Lookup File parsed: ${lookupRows.length.toLocaleString()} rows to process.`);
    return { header, lookupRows };
  }

  /**
   * Split lookup array across N background Web Workers and report live progress.
   */
  async function matchAllParallel(master, lookupRows, thresholdPct, onProgress, onLog) {
    const totalRows = lookupRows.length;
    const numWorkers = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16));

    if (onLog) onLog(`Splitting ${totalRows.toLocaleString()} rows across ${numWorkers} Web Workers...`);

    const sliceSize = Math.ceil(totalRows / numWorkers);
    const indexEntries = Array.from(master.indexMap.entries());

    const workers = [];
    const workerProgress = new Array(numWorkers);
    const workerResults = new Array(numWorkers);
    let completedWorkers = 0;

    for (let w = 0; w < numWorkers; w++) {
      workerProgress[w] = { done: 0, total: 0, matched: 0, active: true };
    }

    const startTime = performance.now();

    return new Promise((resolve, reject) => {
      function checkGlobalProgress() {
        let totalDone = 0;
        let totalMatched = 0;
        let activeCount = 0;

        for (let w = 0; w < numWorkers; w++) {
          totalDone += workerProgress[w].done;
          totalMatched += workerProgress[w].matched;
          if (workerProgress[w].active) activeCount++;
        }

        const elapsedSec = (performance.now() - startTime) / 1000;
        const recPerSec = elapsedSec > 0 ? Math.round(totalDone / elapsedSec) : 0;
        const remainingRecs = totalRows - totalDone;
        const etaSec = recPerSec > 0 ? Math.ceil(remainingRecs / recPerSec) : 0;
        const pct = totalRows > 0 ? Math.round((totalDone / totalRows) * 100) : 0;

        if (onProgress) {
          onProgress({
            stage: "matching",
            done: totalDone,
            total: totalRows,
            pct,
            matchedCount: totalMatched,
            recPerSec,
            elapsedSec: Math.round(elapsedSec),
            etaSec,
            activeWorkers: activeCount,
          });
        }
      }

      for (let w = 0; w < numWorkers; w++) {
        const sliceStart = w * sliceSize;
        const sliceEnd = Math.min((w + 1) * sliceSize, totalRows);
        const lookupSlice = lookupRows.slice(sliceStart, sliceEnd);

        workerProgress[w].total = lookupSlice.length;

        if (lookupSlice.length === 0) {
          workerProgress[w].active = false;
          workerResults[w] = [];
          completedWorkers++;
          continue;
        }

        const worker = new Worker("worker.js");
        workers.push(worker);

        worker.onmessage = (e) => {
          const { type, workerId } = e.data;

          if (type === "PROGRESS") {
            workerProgress[workerId].done = e.data.doneInSlice;
            workerProgress[workerId].matched = e.data.matchedCountInSlice;
            checkGlobalProgress();
          } else if (type === "DONE") {
            workerProgress[workerId].done = e.data.results.length;
            workerProgress[workerId].matched = e.data.matchedCountInSlice;
            workerProgress[workerId].active = false;
            workerResults[workerId] = e.data.results;
            completedWorkers++;

            checkGlobalProgress();

            if (completedWorkers === numWorkers) {
              workers.forEach((wrk) => wrk.terminate());
              const finalElapsedSec = ((performance.now() - startTime) / 1000).toFixed(2);

              // Flatten and sort results by original row order
              const mergedResults = [];
              for (let i = 0; i < numWorkers; i++) {
                if (workerResults[i]) {
                  mergedResults.push(...workerResults[i]);
                }
              }
              mergedResults.sort((a, b) => a.rowIndex - b.rowIndex);

              let totalMatchedCount = 0;
              for (let r = 0; r < mergedResults.length; r++) {
                if (mergedResults[r].ttiCode) totalMatchedCount++;
              }

              if (onLog) {
                onLog(
                  `Matching finished in ${finalElapsedSec}s. ${totalMatchedCount.toLocaleString()} / ${mergedResults.length.toLocaleString()} rows matched.`
                );
              }

              resolve(mergedResults);
            }
          }
        };

        worker.onerror = (err) => {
          workers.forEach((wrk) => wrk.terminate());
          reject(err);
        };

        worker.postMessage({
          type: "START",
          workerId: w,
          masterRecordsData: master.records,
          indexEntries,
          lookupSlice,
          thresholdPct: Number(thresholdPct),
        });
      }

      checkGlobalProgress();
    });
  }

  function generateTxtBlob(header, results) {
    const lines = [`${header}\tTTI code\tMatch %`];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`${r.original}\t${r.ttiCode}\t${r.scorePct}`);
    }
    return new Blob([lines.join("\r\n")], { type: "text/plain;charset=utf-8" });
  }

  global.matcherLib = {
    streamParseMasterFile,
    streamParseLookupFile,
    matchAllParallel,
    generateTxtBlob,
  };
})(typeof window !== "undefined" ? window : this);
