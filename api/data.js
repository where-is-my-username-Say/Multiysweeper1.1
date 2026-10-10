let ST;
const store = async () => ST || (ST = await import('./_store.js'));
export const config = { maxDuration: 30 };

const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const okUrl = u => typeof u === 'string' && /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//.test(u);
const clean = (s, n = 300) => String(s ?? '').slice(0, n);
const alnum = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
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

const KNOWN = new Set(['addFolder', 'renameFolder', 'deleteFolder', 'addLink', 'addFile', 'updateItem', 'setTags', 'setThumb', 'deleteItem']);
const thumbOk = t => t === '' || (typeof t === 'string' && /^https:\/\//.test(t)) ? String(t).slice(0, 1500) : '';

// one operation on the in-memory index
function apply(idx, op, refs, dels) {
  const folderId = () => (op.folderRef ? refs[op.folderRef] : op.folder) ?? '';
  switch (op.a) {
    case 'addFolder': {
      if (op.reuse) { const ex = idx.folders.find(f => alnum(f.name) === alnum(op.name)); if (ex) { if (op.ref) refs[op.ref] = ex.id; return { id: ex.id, existed: true }; } }
      const id = rid(); idx.folders.push({ id, name: clean(op.name, 80), at: Date.now() });
      if (op.ref) refs[op.ref] = id; return { id };
    }
    case 'renameFolder': { const f = idx.folders.find(x => x.id === op.id); if (f) f.name = clean(op.name, 80); return { ok: true }; }
    case 'deleteFolder': {
      for (const i of idx.items) if (i.folder === op.id) i.folder = '';
      idx.folders = idx.folders.filter(f => f.id !== op.id); return { ok: true };
    }
    case 'addLink': {
      if (!/^https?:\/\//i.test(op.url)) throw new Error('bad url');
      const id = rid();
      idx.items.push({ id, type: 'link', url: clean(op.url, 2000), title: clean(op.title || op.url, 200), folder: clean(folderId(), 40),
        by: clean(op.by, 40) || 'Guest', at: Date.now(), thumb: thumbOk(op.thumb), tags: cleanTags(op.tags) });
      return { id };
    }
    case 'addFile': {
      if (!okUrl(op.fileUrl)) throw new Error('bad file url');
      const id = rid();
      const it = { id, type: 'file', fileUrl: op.fileUrl, title: clean(op.title, 200), size: Number(op.size) || 0, contentType: clean(op.contentType, 100),
        folder: clean(folderId(), 40), by: clean(op.by, 40) || 'Guest', at: Date.now() };
      if (op.thumb !== undefined) it.thumb = okUrl(op.thumb) ? op.thumb : '';
      if (op.tags) it.tags = cleanTags(op.tags);
      idx.items.push(it); return { id };
    }
    case 'updateItem': {
      const it = idx.items.find(x => x.id === op.id); if (!it) throw new Error('not found');
      if (typeof op.title === 'string' && op.title.trim()) it.title = clean(op.title, 200);
      const f = op.folderRef ? refs[op.folderRef] : op.folder;
      if (typeof f === 'string') it.folder = clean(f, 40);
      return { ok: true };
    }
    case 'setTags': { const it = idx.items.find(x => x.id === op.id); if (!it) throw new Error('not found'); it.tags = cleanTags(op.tags); return { ok: true }; }
    case 'setThumb': {
      const it = idx.items.find(x => x.id === op.id); if (!it) throw new Error('not found');
      it.thumb = op.thumb === '' ? '' : (okUrl(op.thumb) || /^https:\/\//.test(op.thumb || '') ? String(op.thumb).slice(0, 1500) : ''); return { ok: true };
    }
    case 'deleteItem': {
      const it = idx.items.find(x => x.id === op.id); if (!it) return { ok: true };
      for (const u of [it.fileUrl, it.type === 'file' ? it.thumb : null]) if (okUrl(u)) dels.push(u);
      idx.items = idx.items.filter(x => x.id !== op.id); return { ok: true };
    }
  }
  throw new Error('unknown action');
}

export default async function handler(req, res) {
  try {
    const S = await store(); const b = req.body || {};
    if (b.action === 'list') { const i = await S.readIndex(); return res.json({ folders: i.folders, items: i.items }); }

    let ops = b.action === 'batch' ? (Array.isArray(b.ops) ? b.ops.slice(0, 200) : []) : [{ ...b, a: b.action }];

    // fill in missing link thumbnails (network work happens before the single write)
    if (ops.some(o => o && o.a === 'fixThumbs')) {
      const ids = new Set(ops.filter(o => o.a === 'fixThumbs').flatMap(o => o.ids || []).slice(0, 8));
      const cur = await S.readIndex();
      const need = cur.items.filter(i => ids.has(i.id) && i.type === 'link' && i.thumb === undefined);
      ops = await Promise.all(need.map(async i => ({ a: 'setThumb', id: i.id, thumb: await linkThumb(i.url) })));
      if (!ops.length) return res.json({ ok: true, folders: cur.folders, items: cur.items });
    }
    if (!ops.length || ops.some(o => !o || !KNOWN.has(o.a))) return res.status(400).json({ error: 'unknown action' });
    await Promise.all(ops.filter(o => o.a === 'addLink' && o.thumb === undefined).map(async o => { o.thumb = await linkThumb(o.url); }));

    const refs = {}, dels = [];
    const { idx, out } = await S.mutate(i => ops.map(o => { try { return apply(i, o, refs, dels); } catch (e) { return { error: e.message }; } }));
    if (dels.length) { try { const { del } = await import('@vercel/blob'); const { pickTokenExport } = await import('./_store.js'); await del(dels, { token: pickTokenExport() }); } catch {} }   // del() is free

    const idxOut = { folders: idx.folders, items: idx.items };
    if (b.action === 'batch') return res.json({ results: out, ...idxOut });
    if (out[0] && out[0].error) return res.status(400).json({ error: out[0].error });
    res.json({ ...out[0], ...idxOut });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 240) });
  }
}
