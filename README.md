# TTI Hotel Lookup

A static, browser-only tool for matching hotel rows to TTI codes. It accepts a lookup CSV/XLSX and a tab-delimited master TXT/TSV. Files are read locally in the browser and are not uploaded.

## Run locally

Requirements: Node.js 20 or later.

```sh
cd tti-lookup
npm install
npm run dev
```

Create a production bundle with `npm run build`; serve the generated `tti-lookup/dist/` directory from any static host. The app requires no API server. For a preview of the production build, run `npm run preview` from `tti-lookup/`.

## GitHub Pages

The workflow in `.github/workflows/pages.yml` runs on every push to `master` and can also be started manually from the Actions tab. It installs dependencies in `tti-lookup/`, runs `npm run build`, and deploys `tti-lookup/dist/` to GitHub Pages. The Vite base path is configured for this repository.

For the first deployment, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**. The site will be available at <https://bhushanbhambre.github.io/TTI-Matcher-JS/> after the workflow succeeds.

## Use

1. Select the lookup workbook/CSV and master file.
2. The app reads the first sheet in an XLSX workbook. It auto-detects columns whose headers resemble hotel/property/name, city/town, or address/street. If no name-like header is found, it uses the first non-empty cell in each row as the name text.
3. Set the minimum heuristic match score (default 70).
4. Run lookup. A capped worker pool divides the master file into byte ranges, then each worker indexes and scores its own range.
5. Review TTI codes, confidence scores, and statuses. Results are saved locally and restored after reload. Use **Start new lookup** to clear the previous saved results and select new files.

The lookup parser supports one combined details field or mapped name/city/address columns. If a hotel-name value contains `|`, text after the first pipe is ignored. The standalone word “hotel” and punctuation are removed during normalization.

## Matching flow

`tti-lookup/src/App.tsx` reads the lookup file. XLSX parsing uses SheetJS; delimited files are currently read as text and split into rows. Header-name heuristics select the hotel-name, city, and address columns. The original cell values are retained for output.

`tti-lookup/src/matcher.worker.ts` receives the master `File`, parsed lookup rows, and score threshold. A pool of up to eight workers divides the file into evenly sized byte ranges. Each worker aligns its start to a line boundary, reads in 4 MiB slices, strips BOM from header interpretation, and extracts `TTIcode`, `HotelName`, `CityName`, and `AddressLine` (falling back to `FullAddress`). Each worker builds a local inverted index from normalized hotel-name tokens and scores candidates in its range. The main thread merges all partial results by distinct TTI code, then applies the seven-code cap globally.

The score is a heuristic ranking value, **not a calibrated probability or measured accuracy**. A score of 70 means the candidate passed the selected cutoff; it does not mean a 70% chance of correctness. No labelled training/validation set is currently used. Check candidate results against known-good data before relying on them for decisions.

Result rules:

- One qualifying TTI code: `Matched`.
- Two to seven codes: `Multiple matches`; all codes are comma-separated.
- More than seven distinct codes: `Matched — more than 7 codes`; the code list is omitted.
- No qualifying candidates: `No match`.

## Progress and background behavior

The processing panel aggregates byte-range indexing and lookup-row matching progress across workers, reports elapsed time, and supports cancellation. Work runs in Web Workers so it does not block the interface. Browsers generally allow workers to continue when a tab is in the background or a window is minimized, but may throttle them; closing the page or putting the computer to sleep stops or suspends processing. While processing, the page requests the browser’s standard leave-page confirmation to prevent accidental reload/navigation.

Completed results and run metadata are stored in IndexedDB on the current device. Reloading the page restores the last completed run. **Start new lookup** clears that saved run and resets the file inputs. Clearing browser site data or using a different browser/profile removes access to the saved results.

## Project structure

- `tti-lookup/src/main.tsx` — React entry point.
- `tti-lookup/src/App.tsx` — file selection, lookup parsing, progress UI, and TXT/CSV/XLSX exports.
- `tti-lookup/src/matcher.worker.ts` — chunked master parsing, name-token index, candidate scoring, and result statuses.
- `tti-lookup/src/index.css` — dark internal-tool interface and terminal-style progress panel.
- `tti-lookup/index.html`, `vite.config.ts`, `tailwind.config.js`, `tsconfig*.json` — static build configuration.

## Current limits

- The worker pool is capped at eight workers and selected using available CPU cores and master file size. Each worker retains only its assigned range’s rows and token index, though memory use can still be substantial.
- Persisting a very large result set can hit the browser’s IndexedDB quota. If saving fails, the app still shows the completed results and advises exporting them before closing.
- Candidate retrieval is based on shared hotel-name tokens, so heavy spelling changes may not be retrieved even if their fuzzy score could otherwise be high.
- CSV parsing is intentionally lightweight and does not fully implement every quoted/multiline CSV edge case.
- XLSX import reads the workbook into browser memory; very large lookup workbooks may be slow.
- Deployment should use a modern browser with Web Worker and File API support.
