let B;
const blob = async () => B || (B = await import('@vercel/blob'));

const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const okUrl = u => typeof u === 'string' && /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//.test(u);
const clean = (s, n = 300) => String(s ?? '').slice(0, n);
const GROUPS = ['fire', 'agent', 'material', 'platform', 'condition', 'topic', 'general'];
const cleanTags = a => {
  const seen = new Set(), out = [];
  for (const t of Array.isArray(a) ? a : []) {
    const n = clean(t && t.n, 40).trim(); const k = n.toLowerCase();
    if (!n || seen.has(k)) continue;
    seen.add(k); out.push({ n, g: GROUPS.includes(t.g) ? t.g : 'general' });
    if (out.length >= 12) break;
  }
  return out;
};

const write = async (path, obj) =>
  (await blob()).put(path, JSON.stringify(obj), {
    access: 'public', contentType: 'application/json',
    addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60
  });

function ytId(u) {
  try {
    const x = new URL(u), h = x.hostname.replace(/^www\./, '');
    if (h === 'youtu.be') return x.pathname.slice(1, 12);
    if (h.endsWith('youtube.com')) {
      const v = x.searchParams.get('v'); if (v) return v.slice(0, 11);
      const m = x.pathname.split('/');
      if (['embed', 'shorts', 'live'].includes(m[1])) return (m[2] || '').slice(0, 11);
    }
  } catch {}
  return '';
}
async function linkThumb(url) {
  const y = ytId(url);
  if (y.length === 11) return `https://i.ytimg.com/vi/${y}/hqdefault.jpg`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LibraryBot/1.0)', Accept: 'text/html' }, signal: AbortSignal.timeout(5500), redirect: 'follow' });
    if (!(r.headers.get('content-type') || '').includes('html')) return '';
    const html = (await r.text()).slice(0, 300000);
    for (const tag of html.match(/<meta[^>]*>/gi) || []) {
      if (/(?:property|name)=["'](?:og:image|og:image:secure_url|twitter:image|twitter:image:src)["']/i.test(tag)) {
        const c = tag.match(/content=["']([^"']+)["']/i);
        if (c) { try { const u = new URL(c[1].replace(/&amp;/g, '&'), r.url); if (u.protocol === 'https:') return u.href.slice(0, 1500); } catch {} }
      }
    }
  } catch {}
  return '';
}

async function listBlobs(prefix) {
  const out = []; let cursor;
  do {
    const r = await (await blob()).list({ prefix, cursor, limit: 1000 });
    out.push(...r.blobs); cursor = r.cursor;
  } while (cursor);
  return out;
}
async function readAll(prefix) {
  const blobs = await listBlobs(prefix);
  const rows = await Promise.all(blobs.map(async b => {
    try {
      const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
      return { ...(await r.json()), id: b.pathname.slice(prefix.length, -5) };
    } catch { return null; }
  }));
  return rows.filter(Boolean);
}
async function readOne(path) {
  const b = (await listBlobs(path)).find(x => x.pathname === path);
  if (!b) return null;
  const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
  return { url: b.url, data: await r.json() };
}

export default async function handler(req, res) {
  try {
    const b = req.body || {};
    switch (b.action) {
      case 'list': {
        const [folders, items] = await Promise.all([readAll('folders/'), readAll('items/')]);
        return res.json({ folders, items });
      }
      case 'addFolder': {
        const id = rid();
        await write(`folders/${id}.json`, { name: clean(b.name, 80), at: Date.now() });
        return res.json({ id });
      }
      case 'renameFolder': {
        const o = await readOne(`folders/${b.id}.json`);
        if (o) await write(`folders/${b.id}.json`, { ...o.data, name: clean(b.name, 80) });
        return res.json({ ok: true });
      }
      case 'deleteFolder': {
        const o = await readOne(`folders/${b.id}.json`);
        const items = await readAll('items/');
        for (const i of items.filter(i => i.folder === b.id)) {
          const { id, ...rest } = i;
          await write(`items/${id}.json`, { ...rest, folder: '' });
        }
        if (o) await (await blob()).del(o.url);
        return res.json({ ok: true });
      }
      case 'addLink': {
        if (!/^https?:\/\//i.test(b.url)) return res.status(400).json({ error: 'bad url' });
        const id = rid();
        await write(`items/${id}.json`, {
          type: 'link', url: clean(b.url, 2000), title: clean(b.title || b.url, 200),
          folder: clean(b.folder, 40), by: clean(b.by, 40) || 'زائر', at: Date.now(),
          thumb: await linkThumb(b.url)
        });
        return res.json({ id });
      }
      case 'fixThumb': {
        const o = await readOne(`items/${b.id}.json`);
        if (o && o.data.type === 'link' && o.data.thumb === undefined)
          await write(`items/${b.id}.json`, { ...o.data, thumb: await linkThumb(o.data.url) });
        return res.json({ ok: true });
      }
      case 'setThumb': {
        const o = await readOne(`items/${b.id}.json`);
        if (!o) return res.status(404).json({ error: 'not found' });
        const t = b.thumb === '' ? '' : (okUrl(b.thumb) ? b.thumb : null);
        if (t === null) return res.status(400).json({ error: 'bad thumb url' });
        await write(`items/${b.id}.json`, { ...o.data, thumb: t });
        return res.json({ ok: true });
      }
      case 'addFile': {
        if (!okUrl(b.fileUrl)) return res.status(400).json({ error: 'bad file url' });
        const id = rid();
        await write(`items/${id}.json`, {
          type: 'file', fileUrl: b.fileUrl, title: clean(b.title, 200),
          size: Number(b.size) || 0, contentType: clean(b.contentType, 100),
          folder: clean(b.folder, 40), by: clean(b.by, 40) || 'زائر', at: Date.now()
        });
        return res.json({ id });
      }
      case 'updateItem': {
        const o = await readOne(`items/${b.id}.json`);
        if (!o) return res.status(404).json({ error: 'not found' });
        const next = { ...o.data };
        if (typeof b.title === 'string' && b.title.trim()) next.title = clean(b.title, 200);
        if (typeof b.folder === 'string') next.folder = clean(b.folder, 40);
        await write(`items/${b.id}.json`, next);
        return res.json({ ok: true });
      }
      case 'setTags': {
        const o = await readOne(`items/${b.id}.json`);
        if (!o) return res.status(404).json({ error: 'not found' });
        await write(`items/${b.id}.json`, { ...o.data, tags: cleanTags(b.tags) });
        return res.json({ ok: true });
      }
      case 'deleteItem': {
        const o = await readOne(`items/${b.id}.json`);
        if (o) await (await blob()).del([o.url, ...(okUrl(o.data.fileUrl) ? [o.data.fileUrl] : [])]);
        return res.json({ ok: true });
      }
      default:
        return res.status(400).json({ error: 'unknown action' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
