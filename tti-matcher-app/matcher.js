/**
 * matcher.js
 * ---------------------------------------------------------------------------
 * High-performance streaming & multi-threaded fuzzy matching engine.
 * Supports 12GB+ files, background Web Worker master ingestion,
 * integer trigram candidate index ($36^3 = 46,656$ buckets), and worker clusters.
 * ---------------------------------------------------------------------------
 */

(function (global) {
  function stripQuotes(s) {
    const t = String(s || "").trim();
    if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
      return t.slice(1, -1);
    }
    return t;
  }

  /**
   * Parse Master file in background Web Worker (100% off main thread).
   */
  function parseMasterInWorker(file, onProgress, onLog) {
    return new Promise((resolve, reject) => {
      if (onLog) onLog(`Delegating Master File (${(file.size / 1024 / 1024).toFixed(1)} MB) to Background Ingestion Worker...`);

      const worker = new Worker("masterWorker.js");

      worker.onmessage = (e) => {
        const { type } = e.data;

        if (type === "MASTER_PROGRESS") {
          if (onProgress) {
            onProgress({
              stage: "master_parse",
              bytesRead: e.data.bytesRead,
              totalBytes: e.data.totalBytes,
              recordCount: e.data.recordCount,
              pct: e.data.pct,
            });
          }
        } else if (type === "MASTER_DONE") {
          worker.terminate();
          if (onLog) {
            onLog(
              `Master File parsed & indexed: ${e.data.recordCount.toLocaleString()} records, ${e.data.prunedCount.toLocaleString()} stop-word trigrams pruned.`
            );
          }
          resolve({
            recordCount: e.data.recordCount,
            masterRecords: e.data.masterRecords,
            indexBuckets: e.data.indexBuckets,
          });
        }
      };

      worker.onerror = (err) => {
        worker.terminate();
        reject(err);
      };

      worker.postMessage({ file });
    });
  }

  /**
   * Parse the Lookup file via chunked streaming.
   */
  async function streamParseLookupFile(file, onProgress, onLog) {
    if (onLog) onLog(`Streaming Lookup File (${(file.size / 1024 / 1024).toFixed(1)} MB)...`);

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
            bodyText,
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

    if (onLog) onLog(`Lookup File parsed: ${lookupRows.length.toLocaleString()} target records ready for matching.`);
    return { header, lookupRows };
  }

  /**
   * Run parallel fuzzy matching using Web Workers.
   */
  async function matchAllParallel(master, lookupRows, thresholdPct, onProgress, onLog) {
    const numWorkers = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16));
    if (onLog) onLog(`Initializing ${numWorkers} parallel Web Workers...`);

    const workers = [];
    const initPromises = [];

    for (let w = 0; w < numWorkers; w++) {
      const worker = new Worker("worker.js");
      workers.push(worker);

      const p = new Promise((resolve, reject) => {
        const handler = (e) => {
          if (e.data.type === "INIT_DONE") {
            worker.removeEventListener("message", handler);
            resolve();
          }
        };
        worker.addEventListener("message", handler);
        worker.onerror = reject;
        worker.postMessage({
          type: "INIT",
          masterRecords: master.masterRecords,
          indexBuckets: master.indexBuckets,
        });
      });
      initPromises.push(p);
    }

    await Promise.all(initPromises);
    if (onLog) onLog(`All ${numWorkers} Web Workers loaded with compact Master dataset & integer trigram index.`);

    const BATCH_SIZE = lookupRows.length > 50000 ? 5000 : 2000;
    const totalRows = lookupRows.length;
    const batches = [];
    for (let i = 0; i < totalRows; i += BATCH_SIZE) {
      batches.push(lookupRows.slice(i, i + BATCH_SIZE));
    }

    if (onLog) onLog(`Split ${totalRows.toLocaleString()} lookup records into ${batches.length} worker batches.`);

    let completedBatches = 0;
    let processedCount = 0;
    let matchedCount = 0;
    const allResults = new Array(totalRows);
    const startTime = performance.now();
    let lastProgressReport = 0;

    return new Promise((resolve, reject) => {
      let nextBatchIdx = 0;

      function dispatchWorker(worker, workerId) {
        if (nextBatchIdx >= batches.length) return;

        const currentBatchIdx = nextBatchIdx++;
        const batchRows = batches[currentBatchIdx];

        const onMessage = (e) => {
          if (e.data.type === "BATCH_RESULTS" && e.data.batchId === currentBatchIdx) {
            worker.removeEventListener("message", onMessage);
            const { results } = e.data;

            for (let r = 0; r < results.length; r++) {
              const res = results[r];
              allResults[res.rowIndex - 1] = res;
              if (res.ttiCode) matchedCount++;
            }

            completedBatches++;
            processedCount += results.length;

            const now = performance.now();
            const elapsedSec = (now - startTime) / 1000;
            const recPerSec = elapsedSec > 0 ? Math.round(processedCount / elapsedSec) : 0;
            const remainingRecs = totalRows - processedCount;
            const etaSec = recPerSec > 0 ? Math.ceil(remainingRecs / recPerSec) : 0;

            // Throttle progress updates to main thread (max 4 updates per sec)
            if (now - lastProgressReport > 200 || completedBatches === batches.length) {
              lastProgressReport = now;
              if (onProgress) {
                onProgress({
                  stage: "matching",
                  done: processedCount,
                  total: totalRows,
                  pct: Math.round((processedCount / totalRows) * 100),
                  matchedCount,
                  recPerSec,
                  elapsedSec: Math.round(elapsedSec),
                  etaSec,
                  activeWorkers: numWorkers,
                });
              }
            }

            if (completedBatches === batches.length) {
              workers.forEach((w) => w.terminate());
              const finalElapsedSec = ((performance.now() - startTime) / 1000).toFixed(2);
              if (onLog) {
                onLog(
                  `Matching complete in ${finalElapsedSec}s. Matched ${matchedCount.toLocaleString()} / ${totalRows.toLocaleString()} rows (${(
                    (matchedCount / (totalRows || 1)) *
                    100
                  ).toFixed(1)}%).`
                );
              }
              resolve(allResults.filter(Boolean));
            } else {
              dispatchWorker(worker, workerId);
            }
          }
        };

        worker.addEventListener("message", onMessage);
        worker.onerror = reject;
        worker.postMessage({
          type: "MATCH_BATCH",
          batchId: currentBatchIdx,
          rows: batchRows,
          thresholdPct: Number(thresholdPct),
        });
      }

      for (let w = 0; w < workers.length; w++) {
        dispatchWorker(workers[w], w);
      }
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
    parseMasterInWorker,
    streamParseLookupFile,
    matchAllParallel,
    generateTxtBlob,
  };
})(typeof window !== "undefined" ? window : this);
