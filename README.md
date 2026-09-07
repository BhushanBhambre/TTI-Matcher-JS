# TTI Code Matcher (v2.0 High-Performance Streaming Engine)

A fast, client-side web application that fuzzy-matches hotel records between your **Master file** (contains TTI codes) and your **Lookup file** (needs TTI codes) using **Dice coefficient fuzzy matching, inverted trigram candidate blocking, chunked file streaming, and multi-threaded Web Workers**.

Everything runs **100% locally in your browser** — no data is uploaded to remote servers, no backend is required, and multi-gigabyte files with millions of records are processed without exceeding browser RAM memory limits.

---

## Key Features & Architecture

- **Streaming File Reader (`streamReader.js`)**: Streams input files line-by-line in 4MB byte chunks using `ReadableStream` / `FileReader` so processing datasets with **millions of records** stays memory efficient.
- **Inverted Trigram Candidate Blocking & Pruning (`matcher.js`)**: Converts records to 3-character shingles (trigrams) and builds an in-memory inverted index. Ultra-common stop-word trigrams are automatically pruned to restrict candidate evaluations to high-signal matches.
- **Multi-Threaded Web Workers (`worker.js`)**: Spawns parallel Web Worker threads (auto-detected via `navigator.hardwareConcurrency`) to execute candidate blocking and Dice coefficient similarity scoring concurrently across CPU cores.
- **Real-Time Telemetry & Progress Dashboard (`app.js`)**:
  - **Live Stage Documenter**: Tracks execution through 5 distinct documented stages.
  - **Dynamic ETA**: Live calculation of estimated time remaining (`MM:SS`) based on moving-average records per second.
  - **Speed Counter**: Live records-per-second (`rec/sec`) rate monitor.
  - **Event Console**: Real-time event log terminal detailing exact execution steps with timestamps.
- **Modern Glassmorphic UI**: Sleek dark-mode interface with progress animations, stat telemetry grids, and search/filter table preview.
- **Chunked Data Export**: Export matched results instantly to `.txt`/`.tsv` or `.xlsx` format.

---

## File Structure

| File               | Purpose                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `index.html`       | Page shell, includes fonts, Tailwind CSS CDN, React 18, Babel, SheetJS, and script loaders.       |
| `streamReader.js`  | High-performance chunked file reader (`FileReader` / Web Streams) for multi-gigabyte file inputs. |
| `worker.js`        | Web Worker thread script executing offloaded parallel candidate blocking and fuzzy matching.      |
| `matcher.js`       | Core fuzzy matching engine, index generator, stop-word pruner, and Web Worker cluster manager.    |
| `app.js`           | React UI component with live telemetry dashboard, ETA clock, event console, and table preview.    |
| `netlify.toml`     | Configuration file for static site deployment.                                                    |

---

## How the Matching Algorithm Works

1. **Normalization**: Every record is stripped of non-alphanumeric characters, converted to lowercase, and literal `null` string placeholders are removed.
2. **Trigram Extraction**: Each normalized blob is split into overlapping 3-character shingles.
3. **Inverted Index & Pruning**: An inverted index maps each trigram to master row indices. High-frequency trigrams (stop-words) are pruned to ensure lightning-fast candidate retrieval.
4. **Dice Coefficient Scoring**: Candidate pairs are scored using:
   $$\text{Score} = \frac{2 \times |A \cap B|}{|A| + |B|}$$
   If an IATA code is provided and matches, a small confidence bonus is applied.
5. **Score Filtering**: Matches clearing the user-configured minimum match percentage threshold are returned.

---

## Running Locally

Because browsers enforce security restrictions on Web Workers and file fetches loaded via `file://`, serve the directory using a simple local web server:

```bash
# Option 1: Using npx serve (Node.js)
npx serve tti-matcher-app

# Option 2: Using Python
python3 -m http.server 8080 --directory tti-matcher-app
```

Then navigate to `http://localhost:3000` or `http://localhost:8080` in your web browser.

---

## Deployment (Netlify / Static Hosting)

Simply drag and drop the `tti-matcher-app` folder onto [Netlify Drop](https://app.netlify.com/drop) or connect the repository to any static host. No server configuration, build commands, or environment variables are required.
