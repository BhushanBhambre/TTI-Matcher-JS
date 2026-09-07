/**
 * matcher.js
 * ---------------------------------------------------------------------------
 * High-performance streaming & multi-threaded fuzzy matching engine.
 * Supports streaming large master and lookup datasets (millions of records),
 * inverted trigram candidate indexing, stop-word pruning, and multi-worker execution.
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

  const MULTI_DELIMITER = "; ";

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
   * Parse the Master file via chunked streaming.
   */
  async function streamParseMasterFile(file, onProgress, onLog) {
    if (onLog) onLog(`Starting stream parse for Master File: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)...`);

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
            for (const col of MASTER_COLUMNS) {
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

          const normalizedBlob = normalize(blobSource);
          const iata = (cells[colIndex.IATA_code] || "").trim().toUpperCase();

          records.push({
            ttiCode,
            iata,
            blob: normalizedBlob,
            grams: trigrams(normalizedBlob),
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

    if (onLog) onLog(`Master File parsed successfully: ${records.length.toLocaleString()} valid records extracted.`);
    if (onLog) onLog(`Building inverted trigram candidate index across ${records.length.toLocaleString()} master records...`);

    // Build Inverted Index
    const indexMap = new Map();
    for (let i = 0; i < records.length; i++) {
      const grams = records[i].grams;
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

    // Stop-word frequency pruning (removes high-frequency trigrams)
    const MAX_POSTING_LIST = Math.max(300, Math.round(records.length * 0.005));
    let prunedCount = 0;
    for (const [gram, bucket] of indexMap) {
      if (bucket.length > MAX_POSTING_LIST) {
        indexMap.delete(gram);
        prunedCount++;
      }
    }

    if (onLog) {
      onLog(
        `Inverted Index built: ${indexMap.size.toLocaleString()} unique trigrams. Pruned ${prunedCount} ultra-common stop-words.`
      );
    }

    return { records, indexMap };
  }

  /**
   * Parse the Lookup file via chunked streaming.
   */
  async function streamParseLookupFile(file, onProgress, onLog) {
    if (onLog) onLog(`Starting stream parse for Lookup File: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)...`);

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
            original: cells[0], // preserves raw string
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

    if (onLog) onLog(`Lookup File parsed: ${lookupRows.length.toLocaleString()} rows ready for processing.`);
    return { header, lookupRows };
  }

  /**
   * Run parallel fuzzy matching using Web Workers.
   */
  async function matchAllParallel(master, lookupRows, thresholdPct, onProgress, onLog) {
    const numWorkers = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16));
    if (onLog) onLog(`Initializing ${numWorkers} parallel Web Workers...`);

    const indexEntries = Array.from(master.indexMap.entries());
    const workers = [];
    const initPromises = [];

    for (let w = 0; w < numWorkers; w++) {
      const worker = new Worker("worker.js");
      workers.push(worker);

      const p = new Promise((resolve) => {
        const handler = (e) => {
          if (e.data.type === "INIT_DONE") {
            worker.removeEventListener("message", handler);
            resolve();
          }
        };
        worker.addEventListener("message", handler);
        worker.postMessage({
          type: "INIT",
          records: master.records,
          indexEntries,
        });
      });
      initPromises.push(p);
    }

    await Promise.all(initPromises);
    if (onLog) onLog(`All ${numWorkers} Web Workers initialized with Master Index.`);

    const BATCH_SIZE = lookupRows.length > 50000 ? 5000 : 2000;
    const totalRows = lookupRows.length;
    const batches = [];
    for (let i = 0; i < totalRows; i += BATCH_SIZE) {
      batches.push(lookupRows.slice(i, i + BATCH_SIZE));
    }

    if (onLog) onLog(`Divided ${totalRows.toLocaleString()} lookup rows into ${batches.length} batches.`);

    let completedBatches = 0;
    let processedCount = 0;
    let matchedCount = 0;
    const allResults = new Array(totalRows);
    const startTime = performance.now();

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

            const elapsedSec = (performance.now() - startTime) / 1000;
            const recPerSec = elapsedSec > 0 ? Math.round(processedCount / elapsedSec) : 0;
            const remainingRecs = totalRows - processedCount;
            const etaSec = recPerSec > 0 ? Math.ceil(remainingRecs / recPerSec) : 0;

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

            if (completedBatches === batches.length) {
              // Terminate workers
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
        worker.postMessage({
          type: "MATCH_BATCH",
          batchId: currentBatchIdx,
          rows: batchRows,
          thresholdPct: Number(thresholdPct),
        });
      }

      // Launch initial worker batch allocations
      for (let w = 0; w < workers.length; w++) {
        dispatchWorker(workers[w], w);
      }
    });
  }

  /**
   * Format results into a Blob for instant download.
   */
  function generateTxtBlob(header, results) {
    const lines = [`${header}\tTTI code\tMatch %`];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`${r.original}\t${r.ttiCode}\t${r.scorePct}`);
    }
    return new Blob([lines.join("\r\n")], { type: "text/plain;charset=utf-8" });
  }

  global.matcherLib = {
    normalize,
    trigrams,
    streamParseMasterFile,
    streamParseLookupFile,
    matchAllParallel,
    generateTxtBlob,
  };
})(typeof window !== "undefined" ? window : this);
