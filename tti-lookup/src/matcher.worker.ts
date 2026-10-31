type LookupRow = { original: string[]; name: string; city: string; address: string };
type MasterRecord = { code: string; name: string; city: string; address: string };
type WorkerRequest = { file: File; data: LookupRow[]; threshold: number; headers: string[]; workerId: number; start: number; end: number };

const CHUNK = 4 * 1024 * 1024;
const normalize = (s: string) => s.split('|')[0].normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\bhotel\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const tokens = (s: string) => normalize(s).split(' ').filter(t => t.length > 1);

function similarity(a: string, b: string) {
  const aa = tokens(a), bb = tokens(b);
  if (!aa.length || !bb.length) return 0;
  const used = new Set<number>(); let score = 0;
  for (const x of aa) {
    let best = 0, at = -1;
    bb.forEach((y, i) => {
      if (used.has(i)) return;
      const max = Math.max(x.length, y.length); if (!max) return;
      let d = Array.from({ length: y.length + 1 }, (_, j) => j);
      for (let i2 = 1; i2 <= x.length; i2++) { const n = [i2]; for (let j = 1; j <= y.length; j++) n[j] = Math.min(n[j - 1] + 1, d[j] + 1, d[j - 1] + (x[i2 - 1] === y[j - 1] ? 0 : 1)); d = n; }
      const v = 1 - d[y.length] / max; if (v > best) { best = v; at = i; }
    });
    if (best >= .78 && at >= 0) { used.add(at); score += best; }
  }
  return 100 * score / Math.max(aa.length, bb.length);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    const { file, data, threshold, headers, workerId, start, end } = event.data;
    const records: MasterRecord[] = [];
    const nameIndex = new Map<string, number[]>();
    const cols = Object.fromEntries(headers.map((h, i) => [h.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''), i]));
    const get = (cells: string[], ...keys: string[]) => { for (const key of keys) { const i = cols[key.toLowerCase().replace(/[^a-z0-9]/g, '')]; if (i !== undefined) return (cells[i] ?? '').trim(); } return ''; };
    const addLine = (line: string) => {
      if (!line.trim()) return;
      const cells = line.replace(/^\uFEFF/, '').replace(/\r$/, '').split('\t');
      if (cells[cols['tticode']]?.replace(/^\uFEFF/, '').trim().toLowerCase() === 'tticode') return;
      const code = get(cells, 'TTIcode'), name = get(cells, 'HotelName');
      if (!code || !name || code === 'NULL' || name === 'NULL') return;
      const id = records.length;
      records.push({ code, name, city: get(cells, 'CityName') || get(cells, 'AddressCityName'), address: get(cells, 'AddressLine') || get(cells, 'FullAddress') });
      for (const token of new Set(tokens(name))) { const posting = nameIndex.get(token); if (posting) posting.push(id); else nameIndex.set(token, [id]); }
    };

    // Every partition owns the records whose line starts in [start,end). A worker
    // reads ahead to finish the final line; the next worker discards its partial line.
    let offset = start, lineStart = start, carry = '', decoder = new TextDecoder('utf-8');
    if (start > 0) {
      const lead = new Uint8Array(await file.slice(start, Math.min(file.size, start + CHUNK)).arrayBuffer());
      const newline = lead.indexOf(10);
      if (newline < 0 && start + lead.length < file.size) throw new Error('Could not find a line boundary in the master file.');
      offset = start + (newline < 0 ? lead.length : newline + 1);
      lineStart = offset;
    }
    let finished = false;
    while (offset < file.size && !finished) {
      const limit = Math.min(file.size, Math.max(end + CHUNK, offset + CHUNK));
      const next = Math.min(offset + CHUNK, limit);
      const text = decoder.decode(await file.slice(offset, next).arrayBuffer(), { stream: next < file.size });
      const lines = (carry + text).split('\n'); carry = lines.pop() ?? '';
      let cursor = lineStart;
      for (const line of lines) {
        if (cursor >= end) { finished = true; break; }
        addLine(line); cursor += new TextEncoder().encode(line).length + 1;
      }
      lineStart = cursor;
      offset = next;
      self.postMessage({ type: 'progress', phase: 'indexing', workerId, bytes: Math.min(Math.max(offset - start, 0), end - start), totalBytes: end - start, records: records.length });
      if (offset >= end && carry && !finished) {
        // Continue reading until the current boundary-crossing row is complete.
        if (offset >= file.size) { if (lineStart < end) addLine(carry); finished = true; }
        else if (lineStart >= end) finished = true;
      }
    }
    if (carry.trim() && lineStart < end) addLine(carry);

    const partial: { input: string; candidates: [string, number][] }[] = [];
    const progressStride = Math.max(1, Math.ceil(data.length / 100));
    for (let ri = 0; ri < data.length; ri++) {
      const row = data[ri], query = [row.name, row.city, row.address].filter(Boolean).join(' '), ids = new Set<number>();
      for (const token of tokens(row.name || query)) for (const id of nameIndex.get(token) ?? []) ids.add(id);
      const byCode = new Map<string, number>(); let checked = 0;
      for (const id of ids) {
        const record = records[id], nameScore = similarity(row.name || query, record.name);
        if (nameScore >= 35) {
          const cityScore = row.city ? similarity(row.city, record.city) : 0;
          const addressScore = row.address ? similarity(row.address, record.address) : 0;
          const score = Math.round(row.city && row.address ? .68 * nameScore + .18 * cityScore + .14 * addressScore : row.city ? .78 * nameScore + .22 * cityScore : row.address ? .82 * nameScore + .18 * addressScore : .94 * nameScore);
          if (score >= threshold) byCode.set(record.code, Math.max(byCode.get(record.code) ?? 0, score));
        }
        if (++checked % 10000 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      partial.push({ input: row.original.join(' | '), candidates: [...byCode] });
      if ((ri + 1) % progressStride === 0 || ri + 1 === data.length) {
        self.postMessage({ type: 'progress', phase: 'matching', workerId, processed: ri + 1, total: data.length, percent: Math.floor(100 * (ri + 1) / data.length), detail: `Worker ${workerId + 1}: row ${(ri + 1).toLocaleString()} of ${data.length.toLocaleString()}` });
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    self.postMessage({ type: 'done', workerId, rows: records.length, results: partial });
  } catch (error) {
    self.postMessage({ type: 'error', workerId: event.data.workerId, message: error instanceof Error ? error.message : 'Worker failed.' });
  }
};
