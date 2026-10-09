let B;
const blob = async () => B || (B = await import('@vercel/blob'));
export const config = { maxDuration: 60 };

const GROUPS = ['fire', 'agent', 'material', 'platform', 'condition', 'topic', 'general'];
const MODELS = [process.env.GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash'].filter(Boolean);
const MAX_LINKS = 20;

/* ---------- storage ---------- */
async function readAll(prefix) {
  const { list } = await blob();
  const blobs = []; let cursor;
  do { const r = await list({ prefix, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const rows = await Promise.all(blobs.map(async b => {
    try { const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' }); return { ...(await r.json()), id: b.pathname.slice(prefix.length, -5) }; }
    catch { return null; }
  }));
  return rows.filter(Boolean);
}

/* ---------- helpers ---------- */
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const normUrl = u => { try { const x = new URL(u); x.hash = ''; return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + x.search).toLowerCase(); } catch { return String(u).toLowerCase(); } };
const words = s => String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1).map(w => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
const alnum = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// Does `name` mean the same as one of the existing folders?
function folderMatch(name, folders) {
  const n = alnum(name); if (!n) return null;
  const exact = folders.find(f => alnum(f.name) === n); if (exact) return exact;
  const a = new Set(words(name)); if (!a.size) return null;
  let best = null, bs = 0;
  for (const f of folders) {
    const b = new Set(words(f.name)); if (!b.size) continue;
    const [s, l] = a.size <= b.size ? [a, b] : [b, a];
    if ([...s].every(w => l.has(w))) return f;            // all words of the shorter name are in the longer one
    let i = 0; a.forEach(w => { if (b.has(w)) i++; });
    const j = i / (a.size + b.size - i); if (j > bs) { bs = j; best = f; }
  }
  return bs >= 0.5 ? best : null;
}

function ytId(u) {
  try {
    const x = new URL(u), h = x.hostname.replace(/^www\./, '');
    if (h === 'youtu.be') return x.pathname.slice(1, 12);
    if (h.endsWith('youtube.com')) {
      const v = x.searchParams.get('v'); if (v) return v.slice(0, 11);
      const m = x.pathname.split('/'); if (['embed', 'shorts', 'live'].includes(m[1])) return (m[2] || '').slice(0, 11);
    }
  } catch {}
  return '';
}
const dec = s => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

async function meta(url) {
  const o = { url, status: 0, title: '', desc: '', img: '', dead: false };
  const y = ytId(url); if (y.length === 11) o.img = `https://i.ytimg.com/vi/${y}/hqdefault.jpg`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LibraryBot/1.0)', Accept: 'text/html,*/*' }, signal: AbortSignal.timeout(5000), redirect: 'follow' });
    o.status = r.status; if (r.status === 404 || r.status === 410) o.dead = true;
    if ((r.headers.get('content-type') || '').includes('html')) {
      const html = (await r.text()).slice(0, 250000);
      o.title = dec((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]).slice(0, 160);
      for (const tag of html.match(/<meta[^>]*>/gi) || []) {
        const key = (tag.match(/(?:property|name)=["']([^"']+)["']/i) || [])[1]; const c = (tag.match(/content=["']([^"']*)["']/i) || [])[1];
        if (!key || !c) continue;
        if (/^(og:description|description)$/i.test(key) && !o.desc) o.desc = dec(c).slice(0, 300);
        if (/^og:title$/i.test(key)) o.title = dec(c).slice(0, 160) || o.title;
        if (!o.img && /^(og:image|og:image:secure_url|twitter:image|twitter:image:src)$/i.test(key)) {
          try { const u = new URL(dec(c), r.url); if (u.protocol === 'https:') o.img = u.href.slice(0, 1500); } catch {}
        }
      }
    }
  } catch (e) { const code = e.cause?.code || ''; if (code === 'ENOTFOUND') o.dead = true; o.err = code || 'fetch'; }
  return o;
}

async function gemini(system, contents, key) {
  const TAG = { type: 'OBJECT', properties: { n: { type: 'STRING' }, g: { type: 'STRING', enum: GROUPS } }, required: ['n', 'g'] };
  const schema = { type: 'OBJECT', required: ['answer', 'ids', 'links', 'moves'], properties: {
    answer: { type: 'STRING' }, ids: { type: 'ARRAY', items: { type: 'STRING' } },
    links: { type: 'ARRAY', items: { type: 'OBJECT', required: ['url', 'title', 'folder', 'tags'], properties: { url: { type: 'STRING' }, title: { type: 'STRING' }, folder: { type: 'STRING' }, tags: { type: 'ARRAY', items: TAG } } } },
    moves: { type: 'ARRAY', items: { type: 'OBJECT', required: ['id', 'folder'], properties: { id: { type: 'STRING' }, folder: { type: 'STRING' } } } }
  } };
  let last = 'no model';
  for (const m of MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents,
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192, responseMimeType: 'application/json', responseSchema: schema } })
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return JSON.parse((j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''));
    last = `${m}: ${j.error?.message || r.status}`;
    if ([401, 403, 429].includes(r.status)) break;
  }
  throw new Error(last.slice(0, 220));
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(503).json({ error: 'GEMINI_API_KEY is not set in Vercel' });
    const { messages = [], lang = 'en' } = req.body || {};
    let contents = messages.slice(-12).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '').slice(0, 6000) }] }));
    while (contents.length && contents[0].role !== 'user') contents.shift();
    if (!contents.length || contents[contents.length - 1].role !== 'user') return res.status(400).json({ error: 'No question' });
    const lastText = messages[messages.length - 1].content || '';

    const [folders, items] = await Promise.all([readAll('folders/'), readAll('items/')]);
    items.sort((a, b) => (b.at || 0) - (a.at || 0));
    const fname = Object.fromEntries(folders.map(f => [f.id, f.name]));
    const count = Object.fromEntries(folders.map(f => [f.id, items.filter(i => i.folder === f.id).length]));

    // links pasted in the last message
    const found = [...new Set((lastText.match(/https?:\/\/[^\s<>"'`\])]+/gi) || []).map(u => u.replace(/[?.,;:!)\]]+$/, '')))];
    const have = new Set(items.filter(i => i.type === 'link').map(i => normUrl(i.url)));
    const skipped = [], fresh = [], seen = new Set();
    for (const u of found) {
      try { new URL(u); } catch { continue; }
      const k = normUrl(u); if (seen.has(k)) continue; seen.add(k);
      if (have.has(k)) skipped.push({ url: u, why: 'exists' }); else fresh.push(u);
    }
    const over = fresh.splice(MAX_LINKS);
    const metas = [];
    for (let i = 0; i < fresh.length; i += 6) metas.push(...await Promise.all(fresh.slice(i, i + 6).map(meta)));
    const live = metas.filter(m => { if (m.dead) { skipped.push({ url: m.url, why: 'dead' }); return false; } return true; });

    const tagMap = new Map();
    for (const i of items) for (const t of i.tags || []) { const k = alnum(t.n); if (!tagMap.has(k)) tagMap.set(k, t); }

    const system = `You are the assistant of a shared project library for a student project called "Flame in Freefall" (AI fire-safety dashboard from microgravity combustion data).
CATALOG (one item per line: id | type | title | folder | tags | added by | date | site):
${items.slice(0, 500).map(i => [i.id, i.type === 'link' ? 'link' : (i.contentType || 'file'), String(i.title || '').slice(0, 100), fname[i.folder] || '(no folder)', (i.tags || []).map(t => t.n).join(', '), i.by || '', new Date(i.at || 0).toISOString().slice(0, 10), i.type === 'link' ? host(i.url) : ''].join(' | ')).join('\n') || '(the library is empty)'}
EXISTING FOLDERS: ${folders.map(f => `${f.name} (${count[f.id]})`).join('; ') || '(none)'}
EXISTING TAGS: ${[...tagMap.values()].slice(0, 200).map(t => `${t.n} [${t.g}]`).join('; ') || '(none)'}
${live.length ? `\nNEW LINKS TO FILE (not in the library yet), one per line: url | page title | description:\n${live.map(m => `${m.url} | ${m.title} | ${m.desc}`).join('\n')}\n` : ''}
Rules:
- Use ONLY the catalog. Never invent items, links or file contents. You know titles, folders, tags, types, authors and dates, not what is inside files.
- "answer": one or two short plain sentences in the user's language (default ${lang === 'ar' ? 'Arabic' : 'English'}). Do NOT list items, ids or links in it; the app shows item cards by itself.
- "ids": only items that DIRECTLY match what was asked, best match first. Never pad with loosely related items. If nothing matches, return [] and say so.
- If NEW LINKS are given: return one entry in "links" for every one of them (url exactly as given). Give a clean title (max 70 chars, no site boilerplate), 3-8 tags and the best folder. FOLDERS: use an EXISTING folder name exactly whenever one covers the topic. Propose a NEW folder name (1-3 words, same language style as the existing folders, English if none) only when no existing folder fits, and reuse that same new name for every link of the same topic. TAGS: reuse EXISTING TAGS names exactly when they fit; create a new tag only if none fits.
- Only when the user asks to organize / move / sort / clean up files: return "moves" ({id, folder}) using the same folder rules, and only for items that are unfiled or clearly in the wrong folder. Otherwise "moves" must be [].
- Otherwise "links" and "moves" must be [].`;

    const out = await gemini(system, contents, key);

    // ----- resolve folders deterministically (reuse existing, create only when nothing matches) -----
    const exF = folders.map(f => ({ id: f.id, name: f.name })), newF = [];
    const resolve = name => {
      name = String(name || '').trim().slice(0, 60);
      if (!name || /^(none|no folder|\(no folder\))$/i.test(name)) return {};
      const ex = folderMatch(name, exF); if (ex) return { folderId: ex.id, folderName: ex.name };
      const nm = folderMatch(name, newF.map(x => ({ id: x.ref, name: x.name })));
      if (nm) return { folderRef: nm.id, folderName: newF.find(x => x.ref === nm.id).name };
      const ref = 'n' + (newF.length + 1); newF.push({ ref, name }); return { folderRef: ref, folderName: name };
    };
    const canon = tags => {
      const seenT = new Set(), r = [];
      for (const t of tags || []) {
        let n = String(t.n || '').trim().slice(0, 40), g = GROUPS.includes(t.g) ? t.g : 'general';
        const ex = tagMap.get(alnum(n)); if (ex) { n = ex.n; if (GROUPS.includes(ex.g)) g = ex.g; }
        const k = n.toLowerCase(); if (!n || seenT.has(k)) continue; seenT.add(k); r.push({ n, g }); if (r.length >= 8) break;
      }
      return r;
    };

    const byUrl = new Map((out.links || []).map(l => [normUrl(l.url), l]));
    const links = live.map(m => {
      const l = byUrl.get(normUrl(m.url)) || {};
      return { url: m.url, title: String(l.title || m.title || host(m.url)).trim().slice(0, 120), ...resolve(l.folder), tags: canon(l.tags), thumb: m.img || '' };
    });
    const valid = new Map(items.map(i => [i.id, i]));
    const moves = [];
    for (const m of out.moves || []) {
      const it = valid.get(m.id); if (!it) continue;
      const f = resolve(m.folder); if (!f.folderId && !f.folderRef) continue;
      if (f.folderId && f.folderId === (it.folder || '')) continue;
      moves.push({ id: m.id, ...f });
    }
    const usedRefs = new Set([...links, ...moves].map(x => x.folderRef).filter(Boolean));
    const plan = { newFolders: newF.filter(f => usedRefs.has(f.ref)), links, moves };

    const wantAll = /\b(all|every|everything|each)\b|كل|جميع|الكل/i.test(lastText);
    const acting = links.length || moves.length;
    const ids = acting ? [] : [...new Set((out.ids || []).filter(x => valid.has(x)))].slice(0, wantAll ? 40 : 8);
    res.status(200).json({ answer: String(out.answer || '').slice(0, 1500), ids, plan, skipped: [...skipped, ...over.map(u => ({ url: u, why: 'over' }))] });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 240) });
  }
}
