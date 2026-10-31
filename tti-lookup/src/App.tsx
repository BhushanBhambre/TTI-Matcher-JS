import { useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';

type Output = { input: string; codes: string; score: number; status: string };
type CandidateRow = { input: string; candidates: [string, number][] };
type SavedRun = { outputs: Output[]; savedAt: number; lookupName: string; masterName: string; threshold: number; workers?: number };
type Progress = { phase: 'lookup' | 'indexing' | 'matching' | 'done'; percent: number; detail: string; elapsed: number };
const DB_NAME = 'tti-hotel-lookup';
const DB_STORE = 'saved-runs';
const DB_KEY = 'latest';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local results storage.'));
  });
}
async function readSaved(): Promise<SavedRun | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => { const req = db.transaction(DB_STORE).objectStore(DB_STORE).get(DB_KEY); req.onsuccess = () => { db.close(); resolve(req.result ?? null); }; req.onerror = () => { db.close(); reject(req.error); }; });
}
async function writeSaved(run: SavedRun): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => { const tx = db.transaction(DB_STORE, 'readwrite'); tx.objectStore(DB_STORE).put(run, DB_KEY); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Could not save results locally.')); }; });
}
async function clearSaved(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => { const tx = db.transaction(DB_STORE, 'readwrite'); tx.objectStore(DB_STORE).delete(DB_KEY); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Could not clear saved results.')); }; });
}

export default function App() {
  const [lookup, setLookup] = useState<File | null>(null);
  const [master, setMaster] = useState<File | null>(null);
  const [threshold, setThreshold] = useState(70);
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [savedRun, setSavedRun] = useState<SavedRun | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeWorkers, setActiveWorkers] = useState(1);
  const [error, setError] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const workers = useRef<Worker[]>([]);
  const rejectActiveRun = useRef<((reason?: Error) => void) | null>(null);
  const startedAt = useRef(0);

  useEffect(() => { readSaved().then(saved => { if (saved) { setSavedRun(saved); setOutputs(saved.outputs); setThreshold(saved.threshold); } }).catch(e => setError(e instanceof Error ? e.message : 'Could not restore saved results.')); }, []);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setProgress(p => p ? { ...p, elapsed: Date.now() - startedAt.current } : p), 500);
    return () => window.clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    if (!exportOpen) return;
    const closeOutside = (event: MouseEvent) => { if (!exportRef.current?.contains(event.target as Node)) setExportOpen(false); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setExportOpen(false); };
    document.addEventListener('mousedown', closeOutside); document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, [exportOpen]);
  useEffect(() => {
    if (!busy) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = 'Processing is in progress. Leave this page?'; return event.returnValue; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [busy]);

  async function run() {
    if (!lookup || !master || busy) return;
    setBusy(true); setError(''); setOutputs([]); setSavedRun(null); startedAt.current = Date.now();
    setProgress({ phase: 'lookup', percent: 0, detail: 'Reading lookup file', elapsed: 0 });
    try {
      const ext = lookup.name.toLowerCase().split('.').pop();
      let rows: string[][];
      if (ext === 'xlsx' || ext === 'xls') {
        const book = XLSX.read(await lookup.arrayBuffer(), { type: 'array', raw: false });
        rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, defval: '', raw: false }) as string[][];
      } else {
        const txt = await lookup.text();
        rows = txt.split(/\r?\n/).filter(Boolean).map(line => line.split(/[\t,]/));
      }
      if (rows.length < 2) throw new Error('Lookup file needs a header row and at least one data row.');
      if (!master.size) throw new Error('Master file is empty.');
      const headers = rows[0].map(String);
      const nameCol = headers.findIndex(h => /hotel|property|name/i.test(h));
      const cityCol = headers.findIndex(h => /city|town/i.test(h));
      const addressCol = headers.findIndex(h => /address|street/i.test(h));
      const data = rows.slice(1).filter(r => r.some(v => String(v).trim())).map(r => ({
        original: r.map(v => String(v ?? '')),
        name: nameCol >= 0 ? String(r[nameCol] ?? '') : String(r.find(v => String(v).trim()) ?? ''),
        city: cityCol >= 0 ? String(r[cityCol] ?? '') : '',
        address: addressCol >= 0 ? String(r[addressCol] ?? '') : '',
      }));
      if (!data.length) throw new Error('No non-empty lookup rows were found.');
      const headerText = await master.slice(0, Math.min(master.size, 256 * 1024)).text();
      const masterHeaders = (headerText.split(/\r?\n/, 1)[0] ?? '').replace(/^\uFEFF/, '').split('\t').map(h => h.trim());
      const normalized = new Set(masterHeaders.map(h => h.toLowerCase().replace(/[^a-z0-9]/g, '')));
      if (!normalized.has('tticode') || !normalized.has('hotelname')) throw new Error('Master file must have TTIcode and HotelName headers in its first row.');

      const cores = Math.max(1, navigator.hardwareConcurrency || 2);
      const workerCount = Math.min(8, cores, Math.max(1, Math.ceil(master.size / (32 * 1024 * 1024))));
      setActiveWorkers(workerCount);
      const jobs = Array.from({ length: workerCount }, (_, workerId) => ({ workerId, start: Math.floor(master.size * workerId / workerCount), end: Math.floor(master.size * (workerId + 1) / workerCount) }));
      const states = new Map<number, { indexBytes: number; indexTotal: number; rows: number; matchPercent: number }>();
      for (const job of jobs) states.set(job.workerId, { indexBytes: 0, indexTotal: job.end - job.start, rows: 0, matchPercent: 0 });
      const done = new Map<number, CandidateRow[]>();
      setProgress({ phase: 'indexing', percent: 0, detail: `Starting ${workerCount} workers across separate master-file ranges`, elapsed: Date.now() - startedAt.current });

      await new Promise<void>((resolve, reject) => {
        let failed = false;
        const stopAll = () => { workers.current.forEach(w => w.terminate()); workers.current = []; };
        rejectActiveRun.current = reject;
        const fail = (message: string) => { if (failed) return; failed = true; rejectActiveRun.current = null; stopAll(); reject(new Error(message)); };
        workers.current = jobs.map(job => {
          const worker = new Worker(new URL('./matcher.worker.ts', import.meta.url), { type: 'module' });
          worker.onmessage = event => {
            const message = event.data, state = states.get(job.workerId)!;
            if (message.type === 'error') { fail(message.message); return; }
            if (message.type === 'progress' && message.phase === 'indexing') {
              state.indexBytes = message.bytes; state.rows = message.records;
              const byteProgress = [...states.values()].reduce((sum, s) => sum + (s.indexTotal ? s.indexBytes / s.indexTotal : 0), 0) / workerCount;
              const rowCount = [...states.values()].reduce((sum, s) => sum + s.rows, 0);
              setProgress({ phase: 'indexing', percent: Math.floor(100 * byteProgress), detail: `${rowCount.toLocaleString()} records indexed · ${workerCount} workers`, elapsed: Date.now() - startedAt.current });
            }
            if (message.type === 'progress' && message.phase === 'matching') {
              state.matchPercent = message.percent;
              const percent = Math.floor([...states.values()].reduce((sum, s) => sum + s.matchPercent, 0) / workerCount);
              setProgress({ phase: 'matching', percent, detail: `Worker ${job.workerId + 1}/${workerCount} · ${message.detail ?? `${message.processed}/${message.total} rows`}`, elapsed: Date.now() - startedAt.current });
            }
            if (message.type === 'done') {
              done.set(job.workerId, message.results as CandidateRow[]);
              if (done.size === workerCount && !failed) { rejectActiveRun.current = null; stopAll(); resolve(); }
            }
          };
          worker.onerror = event => fail(event.message || `Worker ${job.workerId + 1} failed.`);
          worker.postMessage({ file: master, data, threshold, headers: masterHeaders, ...job });
          return worker;
        });
      });

      const merged: Output[] = data.map((row, i) => {
        const candidates = new Map<string, number>();
        for (const partial of done.values()) for (const [code, score] of partial[i]?.candidates ?? []) candidates.set(code, Math.max(candidates.get(code) ?? 0, score));
        const sorted = [...candidates].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const best = sorted[0]?.[1] ?? 0;
        if (sorted.length > 7) return { input: row.original.join(' | '), codes: '', score: best, status: 'Matched — more than 7 codes' };
        if (!sorted.length) return { input: row.original.join(' | '), codes: '', score: 0, status: 'No match' };
        return { input: row.original.join(' | '), codes: sorted.map(([code]) => code).join(', '), score: best, status: sorted.length > 1 ? 'Multiple matches' : 'Matched' };
      });
      const saved: SavedRun = { outputs: merged, savedAt: Date.now(), lookupName: lookup.name, masterName: master.name, threshold, workers: workerCount };
      setOutputs(merged); setSavedRun(saved);
      try { await writeSaved(saved); setProgress({ phase: 'done', percent: 100, detail: `${merged.length.toLocaleString()} results saved on this device`, elapsed: Date.now() - startedAt.current }); }
      catch { setError('Lookup completed, but this browser could not save the results. Export them before closing the page.'); setProgress({ phase: 'done', percent: 100, detail: `${merged.length.toLocaleString()} results ready · local save unavailable`, elapsed: Date.now() - startedAt.current }); }
      setBusy(false);
    } catch (e) { workers.current.forEach(w => w.terminate()); workers.current = []; rejectActiveRun.current = null; if (!(e instanceof Error && e.message === 'Cancelled')) setError(e instanceof Error ? e.message : 'Could not process files.'); setBusy(false); }
  }

  function cancel() { rejectActiveRun.current?.(new Error('Cancelled')); rejectActiveRun.current = null; workers.current.forEach(w => w.terminate()); workers.current = []; setBusy(false); setProgress(null); }
  async function startNewLookup() {
    if (busy) cancel();
    try { await clearSaved(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not clear the saved run.'); return; }
    setOutputs([]); setSavedRun(null); setLookup(null); setMaster(null); setProgress(null); setError('');
    document.querySelectorAll<HTMLInputElement>('input[type=file]').forEach(input => { input.value = ''; });
  }
  function download(format: 'txt' | 'csv' | 'xlsx') {
    const rows = [['Lookup details', 'TTI codes', 'Confidence', 'Status'], ...outputs.map(r => [r.input, r.codes, `${r.score}%`, r.status])];
    const quote = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
    if (format === 'xlsx') {
      const sheet = XLSX.utils.aoa_to_sheet(rows);
      const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'TTI Results');
      XLSX.writeFile(book, 'tti-lookup-results.xlsx');
    } else {
      const delimiter = format === 'csv' ? ',' : '\t';
      const contents = rows.map(row => row.map(quote).join(delimiter)).join('\r\n');
      const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8';
      const url = URL.createObjectURL(new Blob(['\uFEFF', contents], { type: mime }));
      const a = document.createElement('a'); a.href = url; a.download = `tti-lookup-results.${format}`; a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    setExportOpen(false);
  }

  return <main className="shell">
    <header><div className="eyebrow">INTERNAL TOOL · LOCAL FILE PROCESSING</div><h1>TTI Hotel Lookup</h1><p>Match hotel details against the TTI master database.</p></header>
    <section className="card"><h2>Input files</h2><div className="grid">
      <label>Lookup file <span>CSV or XLSX · one or more detail columns</span><input type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" onChange={e => setLookup(e.target.files?.[0] ?? null)} />{lookup && <small>{lookup.name}</small>}</label>
      <label>Master file <span>TXT or TSV · includes TTIcode, HotelName, CityName, AddressLine</span><input type="file" accept=".txt,.tsv" onChange={e => setMaster(e.target.files?.[0] ?? null)} />{master && <small>{master.name} · {(master.size / 1024 / 1024).toFixed(0)} MB</small>}</label>
    </div><label className="threshold">Minimum matching accuracy <b>{threshold}%</b><input type="range" min="0" max="100" value={threshold} onChange={e => setThreshold(Number(e.target.value))} /><span>Lower is more permissive; higher requires stronger evidence. Candidate scores are heuristic confidence estimates.</span></label>
    <button onClick={run} disabled={!lookup || !master || busy}>{busy ? 'Processing…' : 'Run lookup'}</button>{error && <p className="error">{error}</p>}
    {progress && <section className={`terminal terminal-${progress.phase}`} aria-live="polite" aria-label="Lookup processing progress">
      <div className="terminal-top"><span><i /> TTI MATCH ENGINE</span><span>{busy ? `${activeWorkers} PARALLEL WORKERS` : progress.phase === 'done' ? `${savedRun?.workers ?? activeWorkers} WORKERS · COMPLETE` : 'LOCAL RESULTS'}</span></div>
      <div className="terminal-content"><div className="terminal-title">{progress.phase === 'lookup' ? '01 / READ LOOKUP' : progress.phase === 'indexing' ? '02 / INDEX MASTER RANGES' : progress.phase === 'matching' ? '03 / SCORE CANDIDATES' : '04 / COMPLETE'}</div>
      <div className="terminal-detail">{progress.detail}</div><div className="progress-meta"><span>[{progress.percent.toString().padStart(3,' ')}%]</span><span>ELAPSED {Math.floor(progress.elapsed/60000).toString().padStart(2,'0')}:{Math.floor(progress.elapsed/1000%60).toString().padStart(2,'0')}</span></div>
      <div className="progress-track"><div style={{width:`${progress.percent}%`}} /></div><div className="progress-glyphs">{Array.from({length:30},(_,i)=><span key={i} className={i < Math.round(progress.percent/100*30) ? 'lit' : ''}>{i < Math.round(progress.percent/100*30) ? '█' : '·'}</span>)}</div>
      <div className="terminal-foot"><span>{busy ? 'BACKGROUND WORKERS · KEEP THIS PAGE OPEN' : 'RESULTS STORED ON THIS DEVICE'}</span>{busy && <button className="cancel-btn" onClick={cancel}>Cancel</button>}</div></div>
    </section>}</section>
    {outputs.length > 0 && <button className="new-lookup-button" onClick={startNewLookup} disabled={busy}>Start new lookup</button>}
    <section className="card"><h2>How it works</h2><ol><li>Select the lookup and master files.</li><li>Lookup rows may contain one combined detail column or separate name, city, and address columns.</li><li>Text after <code>|</code> is ignored. The word “hotel” is ignored in name comparisons.</li><li>Hotel name is the primary fuzzy evidence; city and address add support when supplied. The slider sets the minimum confidence.</li><li>Review all qualifying TTI codes. More than seven codes are reported without listing codes.</li><li>Export the results as CSV. Completed results are restored after reload.</li></ol></section>
    {outputs.length > 0 && <section className="card"><div className="results-head"><h2>Results <small>{outputs.length.toLocaleString()} rows{savedRun ? ` · saved ${new Date(savedRun.savedAt).toLocaleString()}` : ''}</small></h2><div className="result-actions"><div className="export-menu" ref={exportRef}><button className="secondary-btn export-trigger" aria-haspopup="menu" aria-expanded={exportOpen} onClick={() => setExportOpen(v => !v)}>Export <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2 4 4 4 4-4" /></svg></button>{exportOpen && <div className="export-options" role="menu"><button role="menuitem" onClick={() => download('txt')}>Tab-delimited text (.txt)</button><button role="menuitem" onClick={() => download('csv')}>Comma-separated (.csv)</button><button role="menuitem" onClick={() => download('xlsx')}>Excel workbook (.xlsx)</button></div>}</div></div></div>{savedRun && <p className="saved-meta">Restored from this device · {savedRun.lookupName} · {savedRun.masterName} · threshold {savedRun.threshold}%</p>}<div className="table-wrap"><table><thead><tr><th>Lookup details</th><th>TTI codes</th><th>Confidence</th><th>Status</th></tr></thead><tbody>{outputs.map((r,i)=><tr key={i}><td>{r.input}</td><td>{r.codes || '—'}</td><td>{r.score}%</td><td>{r.status}</td></tr>)}</tbody></table></div></section>}
  </main>;
}
