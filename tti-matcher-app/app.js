/**
 * app.js
 * ---------------------------------------------------------------------------
 * Professional React UI for TTI Code Matcher.
 * Handles 12GB+ datasets locally using background Web Worker master ingestion,
 * integer trigram hashing ($36^3 = 46,656$ buckets), and worker clusters.
 * ---------------------------------------------------------------------------
 */

const { useState, useCallback, useRef, useEffect } = React;

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatSeconds(sec) {
  if (!sec || isNaN(sec) || sec < 0) return "00:00";
  const totalSec = Math.floor(sec);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function App() {
  const [masterFile, setMasterFile] = useState(null);
  const [lookupFile, setLookupFile] = useState(null);
  const [threshold, setThreshold] = useState(70);

  const [processing, setProcessing] = useState(false);
  const [stage, setStage] = useState("idle"); // idle, master_parse, indexing, lookup_parse, matching, done, error
  const [stageText, setStageText] = useState("Ready");

  const [telemetry, setTelemetry] = useState({
    done: 0,
    total: 0,
    pct: 0,
    matchedCount: 0,
    recPerSec: 0,
    elapsedSec: 0,
    etaSec: 0,
    activeWorkers: 0,
  });

  const [logs, setLogs] = useState([]);
  const [results, setResults] = useState(null);
  const [lookupHeader, setLookupHeader] = useState("Hotel Name and address");
  const [errorMsg, setErrorMsg] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [filterMode, setFilterMode] = useState("all");

  const logEndRef = useRef(null);
  const timerRef = useRef(null);
  const startTimeRef = useRef(0);

  const addLog = useCallback((msg) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, `[${timestamp}] ${msg}`]);
  }, []);

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const canProcess = masterFile && lookupFile && !processing;

  const handleProcess = useCallback(async () => {
    if (!masterFile || !lookupFile) return;

    setProcessing(true);
    setErrorMsg("");
    setResults(null);
    setLogs([]);
    setStage("master_parse");
    setStageText("Stage 1/5: Background Streaming & Indexing Master File...");

    startTimeRef.current = performance.now();
    setTelemetry({
      done: 0,
      total: 0,
      pct: 0,
      matchedCount: 0,
      recPerSec: 0,
      elapsedSec: 0,
      etaSec: 0,
      activeWorkers: 0,
    });

    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      const currentElapsed = Math.round((performance.now() - startTimeRef.current) / 1000);
      setTelemetry((prev) => ({ ...prev, elapsedSec: currentElapsed }));
    }, 500);

    addLog("=== Starting High-Performance Fuzzy Matching Engine ===");
    addLog(`Master File: ${masterFile.name} (${formatBytes(masterFile.size)})`);
    addLog(`Lookup File: ${lookupFile.name} (${formatBytes(lookupFile.size)})`);
    addLog(`Match Threshold: ${threshold}%`);

    try {
      // Step 1 & 2: Stream & Index Master File in Background Worker
      const masterData = await matcherLib.parseMasterInWorker(
        masterFile,
        (progress) => {
          setTelemetry((prev) => ({
            ...prev,
            done: progress.recordCount,
            total: progress.recordCount,
            pct: progress.pct,
          }));
        },
        addLog
      );

      // Step 3: Stream Lookup File
      setStage("lookup_parse");
      setStageText("Stage 3/5: Streaming & Parsing Lookup File...");

      const lookupData = await matcherLib.streamParseLookupFile(
        lookupFile,
        (progress) => {
          setTelemetry((prev) => ({
            ...prev,
            done: progress.recordCount,
            total: progress.recordCount,
            pct: progress.pct,
          }));
        },
        addLog
      );

      setLookupHeader(lookupData.header);

      // Step 4: Parallel Web Worker Matching
      setStage("matching");
      setStageText("Stage 4/5: High-Speed Web Worker Fuzzy Matching...");

      const matchedResults = await matcherLib.matchAllParallel(
        masterData,
        lookupData.lookupRows,
        threshold,
        (progress) => {
          const currentElapsed = Math.round((performance.now() - startTimeRef.current) / 1000);
          setTelemetry({
            done: progress.done,
            total: progress.total,
            pct: progress.pct,
            matchedCount: progress.matchedCount,
            recPerSec: progress.recPerSec,
            elapsedSec: currentElapsed,
            etaSec: progress.etaSec,
            activeWorkers: progress.activeWorkers,
          });
        },
        addLog
      );

      if (timerRef.current) clearInterval(timerRef.current);
      const finalTotalElapsed = Math.round((performance.now() - startTimeRef.current) / 1000);

      // Step 5: Complete
      setStage("done");
      setStageText("Stage 5/5: Matching Complete!");
      setTelemetry((prev) => ({
        ...prev,
        pct: 100,
        elapsedSec: finalTotalElapsed,
        etaSec: 0,
      }));
      setResults(matchedResults);
      addLog(`Matching completed successfully in ${formatSeconds(finalTotalElapsed)}. Output ready for export.`);
    } catch (err) {
      console.error(err);
      if (timerRef.current) clearInterval(timerRef.current);
      setStage("error");
      setStageText("Error Occurred");
      setErrorMsg(err.message || String(err));
      addLog(`[ERROR] ${err.message || String(err)}`);
    } finally {
      setProcessing(false);
    }
  }, [masterFile, lookupFile, threshold, addLog]);

  const handleDownloadTxt = useCallback(() => {
    if (!results) return;
    addLog("Generating .txt export file...");
    const blob = matcherLib.generateTxtBlob(lookupHeader, results);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `TTI_file_for_lookup_matched.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    addLog("Downloaded .txt file successfully.");
  }, [results, lookupHeader, addLog]);

  const handleDownloadXlsx = useCallback(() => {
    if (!results) return;
    addLog("Generating .xlsx workbook...");
    const aoa = [[lookupHeader, "TTI code", "Match %"]];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      aoa.push([r.original, r.ttiCode, r.scorePct]);
    }
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "TTI Lookup");
    XLSX.writeFile(workbook, "TTI_file_for_lookup_matched.xlsx");
    addLog("Downloaded .xlsx file successfully.");
  }, [results, lookupHeader, addLog]);

  const filteredResults = (results || []).filter((r) => {
    if (filterMode === "matched" && !r.ttiCode) return false;
    if (filterMode === "unmatched" && r.ttiCode) return false;
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      return (
        (r.original && r.original.toLowerCase().includes(term)) ||
        (r.ttiCode && r.ttiCode.toLowerCase().includes(term))
      );
    }
    return true;
  });

  const previewRows = filteredResults.slice(0, 100);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">
            TTI Code Matcher
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Fuzzy string matching for hotel datasets using Web Workers & Integer Trigram Candidate Blocking.
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs text-emerald-400 bg-slate-900 border border-slate-800 px-3.5 py-2 rounded-lg">
          <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
          </svg>
          <span className="font-medium">100% Local Browser Processing (Up to 12GB+ Files)</span>
        </div>
      </header>

      {/* Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Master File Dropzone */}
        <div className="glass-card rounded-xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 rounded-lg bg-indigo-950 text-indigo-400 border border-indigo-900">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7e0 2.21 3.582-4 8-4s8 1.79 8 4"/>
              </svg>
            </div>
            <div>
              <h2 className="font-semibold text-slate-200 text-sm">1. Master File</h2>
              <p className="text-xs text-slate-400">Master TTI codes (.txt / .tsv / .csv)</p>
            </div>
          </div>

          <label className="block border border-dashed border-slate-700 hover:border-slate-500 rounded-lg p-5 text-center cursor-pointer transition-colors bg-slate-900/50">
            <input
              type="file"
              accept=".txt,.tsv,.csv"
              className="hidden"
              onChange={(e) => setMasterFile(e.target.files[0] || null)}
            />
            {masterFile ? (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-indigo-300 truncate">{masterFile.name}</p>
                <p className="text-[11px] text-slate-400">{formatBytes(masterFile.size)}</p>
                <span className="inline-block mt-2 text-[10px] uppercase font-bold text-emerald-400 bg-emerald-950 px-2 py-0.5 rounded border border-emerald-800">Selected</span>
              </div>
            ) : (
              <div className="space-y-2 py-2">
                <svg className="w-7 h-7 mx-auto text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
                </svg>
                <p className="text-xs text-slate-300 font-medium">Select Master File</p>
                <p className="text-[11px] text-slate-500">Supports files up to 12GB+</p>
              </div>
            )}
          </label>
        </div>

        {/* Lookup File Dropzone */}
        <div className="glass-card rounded-xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 rounded-lg bg-indigo-950 text-indigo-400 border border-indigo-900">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
              </svg>
            </div>
            <div>
              <h2 className="font-semibold text-slate-200 text-sm">2. Lookup File</h2>
              <p className="text-xs text-slate-400">Target records to match (.txt / .csv)</p>
            </div>
          </div>

          <label className="block border border-dashed border-slate-700 hover:border-slate-500 rounded-lg p-5 text-center cursor-pointer transition-colors bg-slate-900/50">
            <input
              type="file"
              accept=".txt,.tsv,.csv"
              className="hidden"
              onChange={(e) => setLookupFile(e.target.files[0] || null)}
            />
            {lookupFile ? (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-indigo-300 truncate">{lookupFile.name}</p>
                <p className="text-[11px] text-slate-400">{formatBytes(lookupFile.size)}</p>
                <span className="inline-block mt-2 text-[10px] uppercase font-bold text-emerald-400 bg-emerald-950 px-2 py-0.5 rounded border border-emerald-800">Selected</span>
              </div>
            ) : (
              <div className="space-y-2 py-2">
                <svg className="w-7 h-7 mx-auto text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
                </svg>
                <p className="text-xs text-slate-300 font-medium">Select Lookup File</p>
                <p className="text-[11px] text-slate-500">Supports millions of rows</p>
              </div>
            )}
          </label>
        </div>

        {/* Threshold Card */}
        <div className="glass-card rounded-xl p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-lg bg-indigo-950 text-indigo-400 border border-indigo-900">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"/>
                  </svg>
                </div>
                <div>
                  <h2 className="font-semibold text-slate-200 text-sm">3. Threshold</h2>
                  <p className="text-xs text-slate-400">Match confidence minimum</p>
                </div>
              </div>
              <span className="text-xl font-bold text-indigo-400 font-mono">{threshold}%</span>
            </div>

            <div className="space-y-3">
              <input
                type="range"
                min="30"
                max="95"
                step="1"
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
              />
              <div className="flex justify-between text-[11px] text-slate-400 font-medium">
                <span>30% (Loose)</span>
                <span>70% (Standard)</span>
                <span>95% (Strict)</span>
              </div>
            </div>
          </div>

          <button
            onClick={handleProcess}
            disabled={!canProcess}
            className={`w-full py-3 px-5 rounded-lg font-medium text-sm transition-colors flex items-center justify-center gap-2 mt-4 ${
              canProcess
                ? "bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer shadow-sm"
                : "bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/50"
            }`}
          >
            {processing ? (
              <>
                <svg className="animate-spin w-4 h-4 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span>Processing Stream...</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
                </svg>
                <span>Start Matching</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Progress & Telemetry Section */}
      {(processing || stage === "done" || stage === "error") && (
        <div className="glass-card rounded-xl p-6 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900 p-4 rounded-lg border border-slate-800">
            <div className="flex items-center gap-3">
              <span className={`w-2.5 h-2.5 rounded-full ${processing ? "bg-indigo-400 animate-pulse" : stage === "done" ? "bg-emerald-400" : "bg-red-400"}`}></span>
              <div>
                <h3 className="font-semibold text-slate-100 text-sm">{stageText}</h3>
                <p className="text-xs text-slate-400">
                  {stage === "master_parse"
                    ? "Offloaded 100% to background ingestion Web Worker"
                    : stage === "matching"
                    ? `Running on ${telemetry.activeWorkers} parallel Web Workers`
                    : stage === "done"
                    ? "Execution completed."
                    : "Processing stream..."}
                </p>
              </div>
            </div>
            <span className="font-mono text-lg font-bold text-indigo-400">{telemetry.pct}%</span>
          </div>

          <div className="space-y-1.5">
            <div className="w-full bg-slate-900 rounded-full h-2.5 overflow-hidden border border-slate-800">
              <div
                className="bg-indigo-600 h-full rounded-full transition-all duration-200"
                style={{ width: `${Math.min(100, Math.max(0, telemetry.pct))}%` }}
              ></div>
            </div>
            <div className="flex justify-between text-xs text-slate-400 font-mono">
              <span>{telemetry.done.toLocaleString()} processed</span>
              <span>{telemetry.total.toLocaleString()} total rows</span>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="glass-card-sm p-4 rounded-lg space-y-1">
              <p className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Elapsed Time</p>
              <p className="text-xl font-bold font-mono text-slate-100">{formatSeconds(telemetry.elapsedSec)}</p>
            </div>

            <div className="glass-card-sm p-4 rounded-lg space-y-1">
              <p className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Estimated Time (ETA)</p>
              <p className="text-xl font-bold font-mono text-indigo-400">
                {processing && stage === "matching" ? formatSeconds(telemetry.etaSec) : "--:--"}
              </p>
            </div>

            <div className="glass-card-sm p-4 rounded-lg space-y-1">
              <p className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Speed</p>
              <p className="text-xl font-bold font-mono text-slate-200">
                {telemetry.recPerSec > 0 ? `${telemetry.recPerSec.toLocaleString()}` : "0"}{" "}
                <span className="text-xs font-normal text-slate-400">rec/s</span>
              </p>
            </div>

            <div className="glass-card-sm p-4 rounded-lg space-y-1">
              <p className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Matches Found</p>
              <p className="text-xl font-bold font-mono text-emerald-400">
                {telemetry.matchedCount.toLocaleString()}{" "}
                <span className="text-xs font-normal text-slate-400">
                  ({telemetry.done > 0 ? ((telemetry.matchedCount / telemetry.done) * 100).toFixed(1) : 0}%)
                </span>
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-medium text-slate-400">
              <span className="flex items-center gap-2">
                <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                </svg>
                Event Log
              </span>
              <span>{logs.length} events</span>
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-3.5 font-mono text-xs text-slate-300 h-36 overflow-y-auto custom-scrollbar space-y-1 leading-relaxed">
              {logs.map((log, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-slate-500 select-none">&gt;</span>
                  <span className={log.includes("[ERROR]") ? "text-red-400 font-semibold" : ""}>{log}</span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      )}

      {/* Error Banner */}
      {errorMsg && (
        <div className="p-4 rounded-lg bg-red-950/60 border border-red-800 text-red-300 text-sm flex items-center gap-3">
          <svg className="w-5 h-5 text-red-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
          <div>
            <p className="font-semibold">Processing Failed</p>
            <p className="text-xs text-red-400/90">{errorMsg}</p>
          </div>
        </div>
      )}

      {/* Export & Results Section */}
      {results && results.length > 0 && (
        <div className="glass-card rounded-xl p-6 space-y-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pb-6 border-b border-slate-800">
            <div>
              <h2 className="text-lg font-bold text-slate-100">Matching Results</h2>
              <p className="text-xs text-slate-400">
                {results.length.toLocaleString()} rows processed. Download full dataset or preview below.
              </p>
            </div>

            <div className="flex items-center gap-3 w-full sm:w-auto">
              <button
                onClick={handleDownloadTxt}
                className="flex-1 sm:flex-initial py-2 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs transition-colors flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                </svg>
                <span>Download .txt / .tsv</span>
              </button>

              <button
                onClick={handleDownloadXlsx}
                className="flex-1 sm:flex-initial py-2 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs transition-colors flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                </svg>
                <span>Download .xlsx</span>
              </button>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="relative w-full sm:w-72">
              <input
                type="text"
                placeholder="Search hotel or TTI code..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3.5 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800 text-xs w-full sm:w-auto">
              <button
                onClick={() => setFilterMode("all")}
                className={`px-3 py-1.5 rounded-md transition-colors font-medium ${
                  filterMode === "all" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                All ({results.length.toLocaleString()})
              </button>
              <button
                onClick={() => setFilterMode("matched")}
                className={`px-3 py-1.5 rounded-md transition-colors font-medium ${
                  filterMode === "matched" ? "bg-emerald-600 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Matched ({results.filter((r) => r.ttiCode).length.toLocaleString()})
              </button>
              <button
                onClick={() => setFilterMode("unmatched")}
                className={`px-3 py-1.5 rounded-md transition-colors font-medium ${
                  filterMode === "unmatched" ? "bg-amber-600 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Unmatched ({results.filter((r) => !r.ttiCode).length.toLocaleString()})
              </button>
            </div>
          </div>

          <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-950">
            <div className="max-h-96 overflow-y-auto custom-scrollbar">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="bg-slate-900 sticky top-0 text-slate-400 border-b border-slate-800 font-semibold">
                  <tr>
                    <th className="py-2.5 px-4 w-12">#</th>
                    <th className="py-2.5 px-4">{lookupHeader}</th>
                    <th className="py-2.5 px-4 w-48">Matched TTI Code</th>
                    <th className="py-2.5 px-4 w-24 text-right">Score %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 text-slate-300 font-mono">
                  {previewRows.map((r, i) => (
                    <tr key={i} className="hover:bg-slate-900/50 transition-colors">
                      <td className="py-2.5 px-4 text-slate-500">{r.rowIndex}</td>
                      <td className="py-2.5 px-4 font-sans max-w-md truncate" title={r.original}>
                        {r.original}
                      </td>
                      <td className="py-2.5 px-4">
                        {r.ttiCode ? (
                          <span className="text-emerald-400 font-semibold">{r.ttiCode}</span>
                        ) : (
                          <span className="text-slate-600 italic font-sans">No match</span>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        {r.scorePct > 0 ? (
                          <span
                            className={`px-2 py-0.5 rounded font-bold ${
                              r.scorePct >= 80
                                ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
                                : r.scorePct >= 60
                                ? "bg-indigo-950 text-indigo-400 border border-indigo-800"
                                : "bg-amber-950 text-amber-400 border border-amber-800"
                            }`}
                          >
                            {r.scorePct}%
                          </span>
                        ) : (
                          <span className="text-slate-600">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {filteredResults.length > 100 && (
              <div className="bg-slate-900 px-4 py-2 text-center text-xs text-slate-400 border-t border-slate-800">
                Showing first 100 preview rows of {filteredResults.length.toLocaleString()} records.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
