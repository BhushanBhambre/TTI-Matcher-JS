# TTI Code Matcher

A tiny, static, client-side web app that fuzzy-matches hotels between your
**master file** (has TTI codes) and your **lookup file** (needs TTI codes),
and lets you download the result as `.txt` or `.xlsx`.

Everything runs in the browser. There is no backend, no Python, and no build
step — just 3 files.

## Files

| File           | Purpose                                                        |
|----------------|-----------------------------------------------------------------|
| `index.html`   | Page shell, loads React/Babel/SheetJS from CDN                 |
| `matcher.js`   | Parsing + fuzzy-matching engine (plain JS, documented)          |
| `app.js`       | React UI (file pickers, progress bar, download buttons)         |

## How the matching works

1. Each row (master and lookup) is reduced to a normalized text "blob"
   (hotel name + address fields, lowercased, punctuation/`NULL` stripped).
2. Blobs are compared with a **Dice coefficient over 3-character shingles**
   (a standard, fast fuzzy string-similarity technique).
3. An **inverted trigram index** over the master file means each lookup row
   is only compared against master rows that actually share text with it,
   instead of scanning all ~59,000 rows every time — this is what keeps
   matching fast on large master files.
4. If the lookup row has an IATA code (text after the final `|`) and it
   exactly matches a candidate's IATA, that candidate gets a small score
   boost — a helpful hint, not an absolute filter (many rows have no IATA).
5. You set a **minimum match %**. Only matches at or above that score get a
   TTI code written; everything else is left blank so you can review it.

Tested against the real ~59k-row master file: indexing takes a couple of
seconds, and matching ~100 lookup rows takes well under a second.

## Run it locally

Browsers block `fetch`/XHR of local files loaded via `file://`, and Babel's
in-browser JSX compiler needs to fetch `app.js`, so open this with a tiny
local server rather than double-clicking `index.html`:

```bash
# any of these work
npx serve .
# or
python3 -m http.server 8080
```

Then open the printed `http://localhost:...` URL.

## Deploy to Netlify

**Option A — drag and drop (fastest):**
1. Go to https://app.netlify.com/drop
2. Drag this whole folder (`index.html`, `matcher.js`, `app.js`,
   `netlify.toml`) onto the page.
3. Netlify gives you a live URL immediately. Done.

**Option B — Git-based deploy:**
1. Push this folder to a GitHub/GitLab repo.
2. In Netlify: "Add new site" → "Import an existing project" → pick the repo.
3. Build command: leave as-is (or blank) — it's a static site.
   Publish directory: `.` (already set in `netlify.toml`).
4. Deploy.

No environment variables, API keys, or build tooling are needed.

## Using the app

1. Open the deployed page.
2. Choose the **Master file** (the TTI Master file, tab-separated, first row
   is headers, must include a `TTIcode` column).
3. Choose the **Lookup file** (the TTI file for lookup — one quoted
   name+address string per row, optionally ending in `|IATA`).
4. Set the **minimum match %** (default 70 — raise it to be stricter, lower
   it to catch more possible matches for manual review).
5. Click **Process** and watch the progress bar.
6. Click **Download .txt** or **Download .xlsx** to get the lookup file
   back with a `TTI code` column (and a `Match %` column) filled in.

Rows that don't reach the threshold are left with a blank TTI code rather
than a guessed one — lower the threshold and re-run if you want to see what
the closest (but low-confidence) candidate would have been.
