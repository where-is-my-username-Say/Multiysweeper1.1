import { put, list, del } from '@vercel/blob';

const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const okUrl = u => typeof u === 'string' && /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//.test(u);
const clean = (s, n = 300) => String(s ?? '').slice(0, n);

const write = (path, obj) =>
  put(path, JSON.stringify(obj), {
    access: 'public', contentType: 'application/json',
    addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60
  });

async function listBlobs(prefix) {
  const out = []; let cursor;
  do {
    const r = await list({ prefix, cursor, limit: 1000 });
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
        if (o) await del(o.url);
        return res.json({ ok: true });
      }
      case 'addLink': {
        if (!/^https?:\/\//i.test(b.url)) return res.status(400).json({ error: 'bad url' });
        const id = rid();
        await write(`items/${id}.json`, {
          type: 'link', url: clean(b.url, 2000), title: clean(b.title || b.url, 200),
          folder: clean(b.folder, 40), by: clean(b.by, 40) || 'زائر', at: Date.now()
        });
        return res.json({ id });
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
      case 'deleteItem': {
        const o = await readOne(`items/${b.id}.json`);
        if (o) await del([o.url, ...(okUrl(o.data.fileUrl) ? [o.data.fileUrl] : [])]);
        return res.json({ ok: true });
      }
      default:
        return res.status(400).json({ error: 'unknown action' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
