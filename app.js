/**
 * app.js
 * ---------------------------------------------------------------------------
 * React UI for the TTI Code Matcher.
 * Everything runs client-side in the browser (no server/Python needed):
 *   1. User picks the Master file and the Lookup file.
 *   2. User sets a minimum match % threshold.
 *   3. matcher.js does the fuzzy matching, reporting progress as it goes.
 *   4. Results can be downloaded as .txt (tab-separated) or .xlsx.
 * ---------------------------------------------------------------------------
 */

const { useState, useCallback } = React;

/** Wrap FileReader in a Promise so it can be awaited. */
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** Trigger a browser download for the given Blob. */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function App() {
  const [masterFile, setMasterFile] = useState(null);
  const [lookupFile, setLookupFile] = useState(null);
  const [threshold, setThreshold] = useState(70);
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState(null); // [{original, ttiCode, scorePct}]
  const [lookupHeader, setLookupHeader] = useState("Hotel Nama and address");

  const canProcess = masterFile && lookupFile && !processing;

  const handleProcess = useCallback(async () => {
    setError("");
    setResults(null);
    setProcessing(true);
    try {
      setStatus("Reading files...");
      const [masterText, lookupText] = await Promise.all([
        readFileAsText(masterFile),
        readFileAsText(lookupFile),
      ]);

      setStatus("Indexing master file (this covers every row once)...");
      await new Promise((r) => setTimeout(r, 0)); // let status render first
      const master = matcherLib.parseMasterFile(masterText);

      setStatus("Parsing lookup file...");
      const lookup = matcherLib.parseLookupFile(lookupText);
      setLookupHeader(lookup.header);

      setProgress({ done: 0, total: lookup.rows.length });
      setStatus("Matching rows...");
      const matched = await matcherLib.matchAll(
        master,
        lookup,
        Number(threshold),
        (done, total) => setProgress({ done, total })
      );

      const matchedCount = matched.filter((r) => r.ttiCode).length;
      setResults(matched);
      setStatus(
        `Done. ${matchedCount} of ${matched.length} rows matched at >= ${threshold}%.`
      );
    } catch (e) {
      setError(e.message || String(e));
      setStatus("");
    } finally {
      setProcessing(false);
    }
  }, [masterFile, lookupFile, threshold]);

  const handleDownloadTxt = useCallback(() => {
    const lines = [`${lookupHeader}\tTTI code\tMatch %`];
    for (const r of results) {
      lines.push(`${r.original}\t${r.ttiCode}\t${r.scorePct}`);
    }
    const blob = new Blob([lines.join("\r\n")], {
      type: "text/plain;charset=utf-8",
    });
    downloadBlob(blob, "TTI_file_for_lookup_matched.txt");
  }, [results, lookupHeader]);

  const handleDownloadXlsx = useCallback(() => {
    const aoa = [[lookupHeader, "TTI code", "Match %"]];
    for (const r of results) {
      aoa.push([r.original, r.ttiCode, r.scorePct]);
    }
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "TTI Lookup");
    XLSX.writeFile(workbook, "TTI_file_for_lookup_matched.xlsx");
  }, [results, lookupHeader]);

  const progressPct =
    progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div>
      <h2>TTI Code Matcher</h2>
      <p>
        Upload the master file (has TTI codes) and the lookup file (needs TTI
        codes). Everything runs locally in your browser.
      </p>

      <div>
        <label>
          Master file (TTI Master file, .txt/.tsv):{" "}
          <input
            type="file"
            accept=".txt,.tsv,.csv"
            onChange={(e) => setMasterFile(e.target.files[0] || null)}
          />
        </label>
      </div>
      <br />
      <div>
        <label>
          Lookup file (TTI file for lookup, .txt/.csv):{" "}
          <input
            type="file"
            accept=".txt,.tsv,.csv"
            onChange={(e) => setLookupFile(e.target.files[0] || null)}
          />
        </label>
      </div>
      <br />
      <div>
        <label>
          Minimum match % to accept a code:{" "}
          <input
            type="number"
            min="0"
            max="100"
            step="1"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </label>
      </div>
      <br />

      <button onClick={handleProcess} disabled={!canProcess}>
        {processing ? "Processing..." : "Process"}
      </button>

      {progress.total > 0 && (
        <div>
          <br />
          <progress value={progress.done} max={progress.total}></progress>{" "}
          {progressPct}% ({progress.done}/{progress.total})
        </div>
      )}

      {status && (
        <p>
          <strong>{status}</strong>
        </p>
      )}
      {error && (
        <p>
          <strong>Error:</strong> {error}
        </p>
      )}

      {results && results.length > 0 && (
        <div>
          <button onClick={handleDownloadTxt}>Download .txt</button>{" "}
          <button onClick={handleDownloadXlsx}>Download .xlsx</button>
        </div>
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
