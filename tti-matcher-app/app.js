/**
 * app.js  –  TTI Code Matcher UI
 * Full rewrite: proper icons, mode-selection modal, live multi-worker telemetry.
 */

const { useState, useCallback, useRef, useEffect } = React;

/* ─── tiny icon helpers (inline SVG, no external lib) ─────────── */
function Icon({ d, size = 16, cls = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" className={cls}>
      <path d={d} />
    </svg>
  );
}
// named icons
const I = {
  db:       "M4 7c0-1.1 3.6-2 8-2s8 .9 8 2v10c0 1.1-3.6 2-8 2s-8-.9-8-2V7z M4 7c0 1.1 3.6 2 8 2s8-.9 8-2 M4 12c0 1.1 3.6 2 8 2s8-.9 8-2",
  file:     "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8",
  sliders:  "M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6",
  bolt:     "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  upload:   "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12",
  check:    "M20 6L9 17l-5-5",
  shield:   "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  clock:    "M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2z M12 6v6l4 2",
  zap:      "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  cpu:      "M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3",
  search:   "M11 17.25a6.25 6.25 0 1 1 0-12.5 6.25 6.25 0 0 1 0 12.5z M16 16l4.5 4.5",
  terminal: "M4 17l6-6-6-6 M12 19h8",
  x:        "M18 6L6 18 M6 6l12 12",
  workers:  "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",
  gauge:    "M12 2a10 10 0 0 1 7.38 16.75 M12 2a10 10 0 0 0-7.38 16.75 M12 8v4l3 3",
};

/* ─── format helpers ────────────────────────────────────────────── */
function fmtBytes(b) {
  if (!b) return "0 B";
  const k = 1024, s = ["B","KB","MB","GB"];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(1) + " " + s[i];
}
function fmtSec(s) {
  if (!s || isNaN(s) || s < 0) return "--:--";
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h > 0) return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(ss).padStart(2,"0")}`;
  return `${String(m).padStart(2,"0")}:${String(ss).padStart(2,"0")}`;
}
function fmtNum(n) { return (n || 0).toLocaleString(); }

/* ─── MODE CONFIG (display only – matcher.js has the real config) ── */
const MODES = {
  speed: {
    label:    "High Speed",
    sub:      "All CPU cores, may cause UI lag",
    icon:     I.zap,
    iconCls:  "text-amber-400",
    tagCls:   "bg-amber-950 text-amber-400 border-amber-800",
    tag:      "Max Throughput",
  },
  balanced: {
    label:    "Balanced",
    sub:      "Half cores, smooth & fast",
    icon:     I.gauge,
    iconCls:  "text-indigo-400",
    tagCls:   "bg-indigo-950 text-indigo-400 border-indigo-800",
    tag:      "Recommended",
  },
  performance: {
    label:    "Low Impact",
    sub:      "2 workers, UI stays 60 FPS",
    icon:     I.activity,
    iconCls:  "text-emerald-400",
    tagCls:   "bg-emerald-950 text-emerald-400 border-emerald-800",
    tag:      "Smooth UI",
  },
};

/* ─── mode selection modal ─────────────────────────────────────── */
function ModeModal({ onSelect, onClose }) {
  const [chosen, setChosen] = useState("balanced");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        {/* header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Select Processing Mode</h2>
            <p className="text-xs text-slate-400 mt-1">
              Choose how to balance speed vs. UI responsiveness.
            </p>
          </div>
          <button onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors">
            <Icon d={I.x} size={16} />
          </button>
        </div>

        {/* mode cards */}
        <div className="flex flex-col gap-3 mb-6">
          {Object.entries(MODES).map(([key, m]) => (
            <button key={key}
              onClick={() => setChosen(key)}
              className={`mode-card w-full text-left ${chosen === key ? "selected" : ""}`}>
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg bg-slate-900 ${m.iconCls}`}>
                  <Icon d={m.icon} size={18} />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-100">{m.label}</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${m.tagCls}`}>
                      {m.tag}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">{m.sub}</p>
                </div>
                <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center
                  ${chosen === key ? "border-indigo-500" : "border-slate-600"}`}>
                  {chosen === key && <div className="w-2 h-2 rounded-full bg-indigo-500" />}
                </div>
              </div>
            </button>
          ))}
        </div>

        <div className="flex gap-3">
          <button onClick={onClose}
            className="flex-1 py-2.5 rounded-lg border border-slate-700 text-slate-300
              text-sm font-medium hover:bg-slate-800 transition-colors">
            Cancel
          </button>
          <button onClick={() => onSelect(chosen)}
            className="btn-primary flex-1 justify-center py-2.5">
            <Icon d={I.bolt} size={15} />
            Start Matching
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── stat tile ─────────────────────────────────────────────────── */
function Stat({ label, value, sub, iconD, iconCls = "text-slate-400" }) {
  return (
    <div className="card-inner p-4 rounded-lg">
      <div className="flex items-center gap-2 mb-2">
        <span className={iconCls}><Icon d={iconD} size={14} /></span>
        <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-xl font-bold font-mono text-slate-100">{value}</p>
      {sub && <p className="text-[11px] text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

/* ─── file drop zone ────────────────────────────────────────────── */
function DropZone({ label, hint, accept, file, onChange, iconD }) {
  return (
    <label className={`dropzone block ${file ? "filled" : ""}`}>
      <input type="file" accept={accept} className="hidden"
        onChange={e => onChange(e.target.files[0] || null)} />
      <div className="flex flex-col items-center gap-2 py-1">
        <span className={file ? "text-indigo-400" : "text-slate-500"}>
          <Icon d={file ? I.check : iconD} size={22} />
        </span>
        {file ? (
          <>
            <p className="text-xs font-semibold text-indigo-300 truncate max-w-[160px]">{file.name}</p>
            <p className="text-[11px] text-slate-400">{fmtBytes(file.size)}</p>
            <span className="text-[10px] font-bold text-emerald-400 bg-emerald-950 px-2 py-0.5
              rounded border border-emerald-800 uppercase">Selected</span>
          </>
        ) : (
          <>
            <p className="text-xs font-medium text-slate-300">{label}</p>
            <p className="text-[11px] text-slate-500">{hint}</p>
          </>
        )}
      </div>
    </label>
  );
}

/* ─── main app ──────────────────────────────────────────────────── */
function App() {
  const [masterFile, setMasterFile]   = useState(null);
  const [lookupFile, setLookupFile]   = useState(null);
  const [threshold,  setThreshold]    = useState(70);
  const [showModal,  setShowModal]    = useState(false);

  const [processing, setProcessing]   = useState(false);
  const [stageLabel, setStageLabel]   = useState("Ready");
  const [stageNote,  setStageNote]    = useState("");
  const [errorMsg,   setErrorMsg]     = useState("");

  const [tel, setTel] = useState({
    pct: 0, done: 0, total: 0,
    matchedCount: 0, recPerSec: 0,
    elapsedSec: 0, etaSec: 0,
    activeWorkers: 0, totalWorkers: 0,
  });

  const [logs,    setLogs]    = useState([]);
  const [results, setResults] = useState(null);
  const [header,  setHeader]  = useState("Hotel Name and address");
  const [search,  setSearch]  = useState("");
  const [filter,  setFilter]  = useState("all");
  const [mode,    setMode]    = useState("balanced");

  const logEndRef   = useRef(null);
  const timerRef    = useRef(null);
  const t0Ref       = useRef(0);

  const [sysRes, setSysRes] = useState({
    usedHeap: 0,
    totalHeap: 0,
    heapLimit: 0,
    cpuCores: typeof navigator !== "undefined" ? (navigator.hardwareConcurrency || 4) : 4,
    cpuPct: 0,
  });

  // Resource sampler (runs every 800ms)
  useEffect(() => {
    function sample() {
      const mem = typeof window !== "undefined" && window.performance && window.performance.memory;
      const cores = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency || 4) : 4;
      setSysRes({
        usedHeap: mem ? mem.usedJSHeapSize : 0,
        totalHeap: mem ? mem.totalJSHeapSize : 0,
        heapLimit: mem ? mem.jsHeapSizeLimit : 0,
        cpuCores: cores,
        cpuPct: tel.activeWorkers > 0 ? Math.min(100, Math.round((tel.activeWorkers / cores) * 100)) : 0,
      });
    }
    sample();
    const interval = setInterval(sample, 800);
    return () => clearInterval(interval);
  }, [tel.activeWorkers]);

  // auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // cleanup timer
  useEffect(() => () => clearInterval(timerRef.current), []);

  // Warn before reload/close while matching is running
  useEffect(() => {
    if (!processing) return;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = "Matching is still in progress. Leaving now will cancel the job and you will lose all results. Are you sure?";
      return e.returnValue;
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [processing]);

  // Request notification permission once on mount (silently — no prompt if already granted/denied)
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // Fire a browser notification (falls back to nothing if permission denied)
  const sendNotification = useCallback((title, body) => {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
      const n = new Notification(title, {
        body,
        icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%234f46e5'%3E%3Cpath d='M13 2L3 14h9l-1 8 10-12h-9l1-8z'/%3E%3C/svg%3E",
        badge: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%234f46e5'%3E%3Cpath d='M13 2L3 14h9l-1 8 10-12h-9l1-8z'/%3E%3C/svg%3E",
        tag: "tti-match-complete",
        renotify: true,
      });
      // Auto-close after 8 seconds
      setTimeout(() => n.close(), 8000);
    }
  }, []);

  const log = useCallback(msg => {
    const ts = new Date().toLocaleTimeString();
    setLogs(p => [...p, `[${ts}] ${msg}`]);
  }, []);

  const canProcess = masterFile && lookupFile && !processing;

  /* ── run matching ─────────────────────────────────────────────── */
  async function runWithMode(selectedMode) {
    setShowModal(false);
    setMode(selectedMode);
    setProcessing(true);
    setErrorMsg("");
    setResults(null);
    setLogs([]);
    t0Ref.current = performance.now();

    // reset telemetry
    setTel({ pct: 0, done: 0, total: 0, matchedCount: 0,
      recPerSec: 0, elapsedSec: 0, etaSec: 0, activeWorkers: 0, totalWorkers: 0 });

    // live elapsed ticker
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setTel(p => ({ ...p, elapsedSec: Math.round((performance.now() - t0Ref.current) / 1000) }));
    }, 500);

    log("=== TTI Fuzzy Matching Engine started ===");
    log(`Master: ${masterFile.name} (${fmtBytes(masterFile.size)})`);
    log(`Lookup: ${lookupFile.name} (${fmtBytes(lookupFile.size)})`);
    log(`Threshold: ${threshold}%   Mode: ${MODES[selectedMode].label}`);

    try {
      /* 1 – parse master in background */
      setStageLabel("Step 1 / 3 — Reading & indexing master file…");
      setStageNote("Running in background — UI stays responsive");

      const masterData = await matcherLib.parseMasterInWorker(
        masterFile,
        p => {
          if (p.phase === "master") {
            setStageLabel("Step 1 / 3 — Streaming master file…");
            setTel(prev => ({ ...prev, pct: Math.round(p.pct * 0.5), done: p.recordCount }));
          } else if (p.phase === "index") {
            setStageLabel("Step 1 / 3 — Building trigram index…");
            setTel(prev => ({ ...prev, pct: 50 + Math.round(p.pct * 0.1) }));
          }
        },
        log
      );

      /* 2 – parse lookup on main thread (I/O only, no CPU) */
      setStageLabel("Step 2 / 3 — Reading lookup file…");
      setStageNote("Streaming from disk");

      const lookupData = await matcherLib.parseLookupFile(
        lookupFile,
        p => setTel(prev => ({ ...prev, pct: 60 + Math.round(p.pct * 0.1), done: p.recordCount })),
        log
      );
      setHeader(lookupData.header);
      setStageNote(
        lookupData.format === "new"
          ? "New multi-column format detected (IATA · Hotel name · Address · City)"
          : "Classic pipe-delimited format detected"
      );

      /* 3 – fan out matching */
      setStageLabel("Step 3 / 3 — Matching rows across workers…");
      setStageNote(`Mode: ${MODES[selectedMode].label}`);

      const matched = await matcherLib.matchAll(
        masterData,
        lookupData.rows,
        threshold,
        selectedMode,
        p => {
          const elapsed = Math.round((performance.now() - t0Ref.current) / 1000);
          setTel({
            pct:          70 + Math.round(p.pct * 0.3),
            done:         p.done,
            total:        p.total,
            matchedCount: p.matchedCount,
            recPerSec:    p.recPerSec,
            elapsedSec:   elapsed,
            etaSec:       p.etaSec,
            activeWorkers: p.activeWorkers,
            totalWorkers:  p.totalWorkers,
          });
          setStageNote(`${p.activeWorkers} / ${p.totalWorkers} workers active`);
        },
        log
      );

      clearInterval(timerRef.current);
      const finalElapsed = Math.round((performance.now() - t0Ref.current) / 1000);

      setTel(p => ({ ...p, pct: 100, elapsedSec: finalElapsed, etaSec: 0, activeWorkers: 0 }));
      setStageLabel("Complete");
      setStageNote(`Finished in ${fmtSec(finalElapsed)}`);
      setResults(matched);
      log(`Done in ${fmtSec(finalElapsed)}. Results ready for download.`);

      // Browser alert notification — fires even if tab is in the background
      const matchedCount = matched.filter(r => r.ttiCode).length;
      sendNotification(
        "✅ TTI Matching Complete!",
        `${matchedCount.toLocaleString()} of ${matched.length.toLocaleString()} rows matched in ${fmtSec(finalElapsed)}. Results are ready to download.`
      );

    } catch (err) {
      clearInterval(timerRef.current);
      setStageLabel("Error");
      setStageNote("");
      setErrorMsg(err.message || String(err));
      log(`[ERROR] ${err.message || String(err)}`);
    } finally {
      setProcessing(false);
    }
  }

  /* ── downloads ─────────────────────────────────────────────────── */
  function downloadTxt() {
    log("Exporting .txt…");
    const blob = matcherLib.generateTxtBlob(header, results);
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement("a"), { href: url, download: "TTI_matched.txt" });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    log("Downloaded TTI_matched.txt");
  }
  function downloadXlsx() {
    log("Exporting .xlsx…");
    const aoa  = [[header, "TTI code", "Match %"], ...results.map(r => [r.original, r.ttiCode, r.scorePct])];
    const wb   = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "TTI Lookup");
    XLSX.writeFile(wb, "TTI_matched.xlsx");
    log("Downloaded TTI_matched.xlsx");
  }

  /* ── filtered preview ──────────────────────────────────────────── */
  const allRows      = results || [];
  const matchedRows  = allRows.filter(r => r.ttiCode);
  const unmatchedRows= allRows.filter(r => !r.ttiCode);
  const filtered     = (filter === "matched" ? matchedRows : filter === "unmatched" ? unmatchedRows : allRows)
    .filter(r => !search || r.original?.toLowerCase().includes(search.toLowerCase()) ||
                             r.ttiCode?.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 100);

  const isActive = processing || (stageLabel !== "Ready" && stageLabel !== "Complete" && stageLabel !== "Error");
  const isDone   = stageLabel === "Complete";
  const isError  = stageLabel === "Error";

  /* ── render ─────────────────────────────────────────────────────── */
  return (
    <div className="max-w-5xl mx-auto px-4 py-10 space-y-8">

      {/* ── header ─────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4
        pb-6 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">TTI Code Matcher</h1>
          <p className="text-sm text-slate-400 mt-1">
            Fuzzy hotel-record matching using Web Workers &amp; trigram candidate blocking.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-emerald-400 bg-slate-900
          border border-slate-800 px-3 py-2 rounded-lg shrink-0">
          <Icon d={I.shield} size={14} cls="text-emerald-400" />
          <span className="font-medium">100% local — no data leaves your browser</span>
        </div>
      </div>

      {/* ── upload + threshold row ─────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">

        {/* master */}
        <div className="card p-5">
          <div className="flex items-center gap-3 mb-4">
            <span className="p-2 rounded-lg bg-indigo-950 text-indigo-400 border border-indigo-900">
              <Icon d={I.db} size={18} />
            </span>
            <div>
              <p className="text-sm font-semibold text-slate-100">Master File</p>
              <p className="text-[11px] text-slate-400">Contains TTI codes (.txt / .tsv)</p>
            </div>
          </div>
          <DropZone label="Select master file" hint="Supports large datasets"
            accept=".txt,.tsv,.csv" file={masterFile} onChange={setMasterFile}
            iconD={I.upload} />
        </div>

        {/* lookup */}
        <div className="card p-5">
          <div className="flex items-center gap-3 mb-4">
            <span className="p-2 rounded-lg bg-indigo-950 text-indigo-400 border border-indigo-900">
              <Icon d={I.file} size={18} />
            </span>
            <div>
              <p className="text-sm font-semibold text-slate-100">Lookup File</p>
              <p className="text-[11px] text-slate-400">Needs TTI codes mapped</p>
            </div>
          </div>
          <DropZone label="Select lookup file" hint="Supports millions of rows"
            accept=".txt,.tsv,.csv" file={lookupFile} onChange={setLookupFile}
            iconD={I.upload} />
        </div>

        {/* threshold + start */}
        <div className="card p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <span className="p-2 rounded-lg bg-indigo-950 text-indigo-400 border border-indigo-900">
                  <Icon d={I.sliders} size={18} />
                </span>
                <div>
                  <p className="text-sm font-semibold text-slate-100">Threshold</p>
                  <p className="text-[11px] text-slate-400">Match confidence minimum</p>
                </div>
              </div>
              <span className="text-xl font-bold font-mono text-indigo-400">{threshold}%</span>
            </div>
            <input type="range" min="30" max="95" step="1" value={threshold}
              onChange={e => setThreshold(Number(e.target.value))}
              className="w-full h-1.5 bg-slate-800 rounded appearance-none cursor-pointer accent-indigo-500" />
            <div className="flex justify-between text-[10px] text-slate-500 font-medium mt-1.5">
              <span>30% Loose</span><span>70% Standard</span><span>95% Strict</span>
            </div>
          </div>

          <button
            onClick={() => canProcess && setShowModal(true)}
            disabled={!canProcess}
            className="btn-primary w-full justify-center mt-5 py-3">
            {processing
              ? <><svg className="spin" width="15" height="15" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg> Processing…</>
              : <><Icon d={I.bolt} size={15} /> Start Matching</>
            }
          </button>
        </div>
      </div>

      {/* ── progress panel ─────────────────────────────────────────── */}
      {(processing || isDone || isError) && (
        <div className="card p-6 space-y-5">

          {/* stage banner */}
          <div className="flex items-center justify-between bg-slate-900 rounded-lg
            border border-slate-800 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className={`w-2.5 h-2.5 rounded-full shrink-0
                ${processing ? "bg-indigo-400 pulse" : isDone ? "bg-emerald-400" : "bg-red-400"}`} />
              <div>
                <p className="text-sm font-semibold text-slate-100">{stageLabel}</p>
                {stageNote && <p className="text-xs text-slate-400">{stageNote}</p>}
              </div>
            </div>
            <span className="font-mono text-base font-bold text-indigo-400">{tel.pct}%</span>
          </div>

          {/* bar */}
          <div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${tel.pct}%` }} />
            </div>
            <div className="flex justify-between text-[11px] text-slate-500 font-mono mt-1">
              <span>{fmtNum(tel.done)} processed</span>
              <span>{tel.total > 0 ? fmtNum(tel.total) + " total" : ""}</span>
            </div>
          </div>

          {/* stats grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Elapsed" value={fmtSec(tel.elapsedSec)}
              iconD={I.clock} iconCls="text-slate-400" />
            <Stat label="ETA"
              value={processing && tel.etaSec > 0 ? fmtSec(tel.etaSec) : "--:--"}
              iconD={I.gauge} iconCls="text-indigo-400" />
            <Stat label="Speed"
              value={`${fmtNum(tel.recPerSec)}`}
              sub="records / sec"
              iconD={I.activity} iconCls="text-slate-300" />
            <Stat
              label="Workers"
              value={`${tel.activeWorkers} / ${tel.totalWorkers}`}
              sub={tel.activeWorkers > 0 ? "active" : isDone ? "finished" : ""}
              iconD={I.workers} iconCls="text-indigo-400" />
          </div>

          {/* ── System Resources (Memory & CPU) ──────────────────── */}
          <div className="card-inner p-4 rounded-lg space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
                <Icon d={I.cpu} size={15} cls="text-indigo-400" />
                <span className="tracking-wide uppercase text-[11px] text-slate-400">System Resources</span>
              </div>
              <div className="flex items-center gap-2 text-[11px] font-mono">
                <span className="flex items-center gap-1.5 text-emerald-400 bg-emerald-950/60 border border-emerald-800/60 px-2 py-0.5 rounded">
                  <span className={`w-1.5 h-1.5 rounded-full bg-emerald-400 ${tel.activeWorkers > 0 ? "pulse" : ""}`} />
                  {tel.activeWorkers > 0 ? `${tel.activeWorkers} Cores Active` : "Engine Idle"}
                </span>
                <span className="text-slate-400 bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                  {MODES[mode]?.label || "Balanced"}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              {/* RAM Usage */}
              <div className="bg-slate-900/80 p-3 rounded border border-slate-800/80">
                <div className="flex justify-between items-center text-[11px] text-slate-400 mb-1">
                  <span>JS Heap Memory</span>
                  <span className="font-mono text-indigo-300 font-semibold">
                    {sysRes.usedHeap > 0 ? fmtBytes(sysRes.usedHeap) : "Active"}
                  </span>
                </div>
                <div className="progress-track h-1.5 bg-slate-800">
                  <div
                    className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                    style={{
                      width: `${sysRes.heapLimit > 0 ? Math.min(100, Math.max(3, Math.round((sysRes.usedHeap / sysRes.heapLimit) * 100))) : 8}%`
                    }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-slate-500 mt-1 font-mono">
                  <span>{sysRes.totalHeap > 0 ? `Allocated: ${fmtBytes(sysRes.totalHeap)}` : "Dataset optimized"}</span>
                  <span>{sysRes.heapLimit > 0 ? `Limit: ${fmtBytes(sysRes.heapLimit)}` : ""}</span>
                </div>
              </div>

              {/* CPU Core Allocation */}
              <div className="bg-slate-900/80 p-3 rounded border border-slate-800/80">
                <div className="flex justify-between items-center text-[11px] text-slate-400 mb-1">
                  <span>CPU Allocation</span>
                  <span className="font-mono text-emerald-400 font-semibold">
                    {sysRes.cpuPct}% Load
                  </span>
                </div>
                <div className="progress-track h-1.5 bg-slate-800">
                  <div
                    className="h-full bg-emerald-500 rounded-full transition-all duration-300"
                    style={{ width: `${Math.max(2, sysRes.cpuPct)}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-slate-500 mt-1 font-mono">
                  <span>{tel.activeWorkers} / {sysRes.cpuCores} Threads</span>
                  <span>{sysRes.cpuCores} Logical Cores</span>
                </div>
              </div>

              {/* In-Memory Data Buffers */}
              <div className="bg-slate-900/80 p-3 rounded border border-slate-800/80">
                <div className="flex justify-between items-center text-[11px] text-slate-400 mb-1">
                  <span>Data In Memory</span>
                  <span className="font-mono text-slate-200 font-semibold">
                    {fmtBytes((masterFile?.size || 0) + (lookupFile?.size || 0))}
                  </span>
                </div>
                <div className="progress-track h-1.5 bg-slate-800">
                  <div className="h-full bg-cyan-500 rounded-full w-full" />
                </div>
                <div className="flex justify-between text-[10px] text-slate-500 mt-1 font-mono truncate">
                  <span>M: {fmtBytes(masterFile?.size)}</span>
                  <span>L: {fmtBytes(lookupFile?.size)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* matches found strip */}
          {tel.matchedCount > 0 && (
            <div className="card-inner px-4 py-2.5 rounded-lg flex items-center gap-3">
              <Icon d={I.check} size={15} cls="text-emerald-400" />
              <span className="text-sm text-slate-200">
                <span className="font-bold font-mono text-emerald-400">{fmtNum(tel.matchedCount)}</span>
                {" "}matches found so far
                {tel.done > 0 && (
                  <span className="text-slate-400 ml-1">
                    ({((tel.matchedCount / tel.done) * 100).toFixed(1)}%)
                  </span>
                )}
              </span>
            </div>
          )}

          {/* event log */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2 text-[11px] text-slate-400 font-medium">
                <Icon d={I.terminal} size={13} />
                <span>Event Log</span>
              </div>
              <span className="text-[11px] text-slate-500">{logs.length} events</span>
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 font-mono
              text-[11px] text-slate-300 h-32 overflow-y-auto scroll leading-relaxed space-y-0.5">
              {logs.map((l, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-slate-600 select-none">&gt;</span>
                  <span className={l.includes("[ERROR]") ? "text-red-400 font-semibold" : ""}>{l}</span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      )}

      {/* ── error banner ───────────────────────────────────────────── */}
      {errorMsg && (
        <div className="flex items-start gap-3 p-4 rounded-lg bg-red-950 border border-red-800 text-red-300 text-sm">
          <Icon d={I.x} size={16} cls="text-red-400 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Processing Failed</p>
            <p className="text-xs text-red-400 mt-0.5">{errorMsg}</p>
          </div>
        </div>
      )}

      {/* ── results panel ──────────────────────────────────────────── */}
      {results && results.length > 0 && (
        <div className="card p-6 space-y-5">

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4
            pb-5 border-b border-slate-800">
            <div>
              <h2 className="text-base font-semibold text-slate-100">Results</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                {fmtNum(results.length)} rows — {fmtNum(matchedRows.length)} matched,{" "}
                {fmtNum(unmatchedRows.length)} unmatched
              </p>
            </div>
            <div className="flex gap-2.5">
              <button onClick={downloadTxt} className="btn-primary">
                <Icon d={I.download} size={14} />Download .txt
              </button>
              <button onClick={downloadXlsx} className="btn-green">
                <Icon d={I.download} size={14} />Download .xlsx
              </button>
            </div>
          </div>

          {/* search + filter */}
          <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
            <div className="relative w-full sm:w-64">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
                <Icon d={I.search} size={14} />
              </span>
              <input
                type="text" placeholder="Search hotel or TTI code…"
                value={search} onChange={e => setSearch(e.target.value)}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-8 pr-3 py-2
                  text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500" />
            </div>
            <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800 text-xs">
              {[["all","All"],["matched","Matched"],["unmatched","Unmatched"]].map(([k,lbl]) => (
                <button key={k} onClick={() => setFilter(k)}
                  className={`px-3 py-1.5 rounded-md font-medium transition-colors
                    ${filter === k ? (k === "unmatched" ? "bg-amber-700 text-white"
                      : k === "matched" ? "bg-emerald-700 text-white"
                      : "bg-indigo-600 text-white")
                      : "text-slate-400 hover:text-slate-200"}`}>
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          {/* table */}
          <div className="border border-slate-800 rounded-lg overflow-hidden">
            <div className="max-h-96 overflow-y-auto scroll">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="sticky top-0 bg-slate-900 text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-2.5 px-3 w-12 font-semibold">#</th>
                    <th className="py-2.5 px-3 font-semibold">{header}</th>
                    <th className="py-2.5 px-3 w-44 font-semibold">TTI Code</th>
                    <th className="py-2.5 px-3 w-20 text-right font-semibold">Score</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 font-mono">
                  {filtered.map((r, i) => (
                    <tr key={i} className="hover:bg-slate-900/60 transition-colors">
                      <td className="py-2.5 px-3 text-slate-600">{r.rowIndex}</td>
                      <td className="py-2.5 px-3 font-sans text-slate-300 max-w-xs truncate"
                        title={r.original}>{r.original}</td>
                      <td className="py-2.5 px-3">
                        {r.ttiCode
                          ? <span className="text-emerald-400 font-semibold">{r.ttiCode}</span>
                          : <span className="text-slate-600 italic font-sans text-[11px]">—</span>
                        }
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        {r.scorePct > 0
                          ? <span className={`px-1.5 py-0.5 rounded text-[11px] font-bold border
                              ${r.scorePct >= 80
                                ? "bg-emerald-950 text-emerald-400 border-emerald-800"
                                : r.scorePct >= 60
                                ? "bg-indigo-950 text-indigo-400 border-indigo-800"
                                : "bg-amber-950 text-amber-400 border-amber-800"}`}>
                              {r.scorePct}%
                            </span>
                          : <span className="text-slate-600">—</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {allRows.length > 100 && (
              <div className="bg-slate-900 px-4 py-2 text-center text-[11px] text-slate-400
                border-t border-slate-800">
                Showing first 100 of {fmtNum(filtered.length)} rows. Download to see all.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── mode modal ─────────────────────────────────────────────── */}
      {showModal && (
        <ModeModal
          onSelect={runWithMode}
          onClose={() => setShowModal(false)} />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
