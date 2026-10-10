// Single-file library index: reads are plain URL fetches (cheap), writes are one put() per action.
// Avoids list() calls, which count as "Advanced Operations" on the Vercel Blob free tier (2,000 / month).
let B, CACHED;
const blob = async () => B || (B = await import('@vercel/blob'));
const pickToken = () => {
  const names = Object.keys(process.env).filter(k => /^BLOB_READ_WRITE_TOKEN(_\d+)?$/.test(k) && process.env[k]);
  const num = k => (k.match(/_(\d+)$/) || [0, -1])[1] * 1;
  names.sort((a, b) => num(b) - num(a));          // numbered variables first (newest store), plain name last
  return names.length ? process.env[names[0]] : undefined;
};
const PATH = 'library/index.json';
const empty = () => ({ v: 1, rev: 0, folders: [], items: [] });

async function indexUrl() {
  if (CACHED) return CACHED;
  const { head } = await blob();
  try { CACHED = (await head(PATH, { token: pickToken() })).url; return CACHED; }
  catch (e) { if (e && (e.name === 'BlobNotFoundError' || /not.?found/i.test(e.message || ''))) return null; throw e; }
}
const fetchIdx = async (url, fresh) => {
  const r = await fetch(fresh ? url + '?t=' + Date.now() : url, { cache: fresh ? 'no-store' : 'default' });
  if (!r.ok) throw new Error('index fetch ' + r.status);
  const j = await r.json();
  return { ...empty(), ...j, folders: j.folders || [], items: j.items || [] };
};

export const pickTokenExport = pickToken;

export async function writeIndex(idx) {
  const { put } = await blob();
  const r = await put(PATH, JSON.stringify(idx), { access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60, token: pickToken() });
  CACHED = r.url;
}

// One-time import of the old layout (items/*.json and folders/*.json). Runs once, then index.json exists.
async function migrate() {
  const { list } = await blob();
  const grab = async prefix => {
    const blobs = []; let cursor;
    do { const r = await list({ prefix, cursor, limit: 1000, token: pickToken() }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
    const rows = await Promise.all(blobs.map(async b => {
      try { const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' }); return { ...(await r.json()), id: b.pathname.slice(prefix.length, -5) }; }
      catch { return null; }
    }));
    return rows.filter(Boolean);
  };
  const idx = empty();
  idx.folders = await grab('folders/'); idx.items = await grab('items/');
  await writeIndex(idx);
  return idx;
}

export async function readIndex(fresh = false) {
  let url = await indexUrl();
  if (!url) return migrate();
  try { return await fetchIdx(url, fresh); }
  catch (e) { CACHED = null; url = await indexUrl(); if (!url) return migrate(); return fetchIdx(url, fresh); }
}

// read the freshest copy, let fn change it, write it back once
export async function mutate(fn) {
  const idx = await readIndex(true);
  idx.rev = (idx.rev || 0) + 1;
  const out = await fn(idx);
  await writeIndex(idx);
  return { idx, out };
}
