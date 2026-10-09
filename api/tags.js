let B;
const blob = async () => B || (B = await import('@vercel/blob'));
export const config = { maxDuration: 30 };

const GROUPS = ['fire', 'agent', 'material', 'platform', 'condition', 'topic', 'general'];
const MODELS = [process.env.GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash'].filter(Boolean);
const okUrl = u => typeof u === 'string' && /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//.test(u);

const PROMPT = `You tag items in a shared library for a NASA-inspired student project called "Flame in Freefall": an AI dashboard about fire safety and combustion experiments in microgravity (ISS, Saffire, FLEX, SoFIE, drop towers, Moon/Mars gravity).
Return 4 to 10 precise tags describing what the item is REALLY about. Groups:
- fire: each specific kind of fire/flame/phenomenon (e.g. Diffusion flame, Premixed flame, Smoldering, Flame spread, Droplet combustion, Spherical flame, Opposed-flow flame, Flame extinction).
- agent: each specific extinguishing agent or gas (e.g. CO2, CO2 extinguisher, Water mist, Nitrogen, Foam, Oxygen concentration).
- material: each specific burned material (e.g. Acrylic (PMMA), Cotton fabric, Paper, Wire coating, Nomex, Silicone).
- platform: experiment platform or mission (e.g. ISS, Saffire, FLEX, SoFIE, Drop tower, Parabolic flight).
- condition: test conditions (e.g. Microgravity, Lunar gravity, Mars gravity, High oxygen, Low pressure, Airflow).
- topic: project work topics (e.g. Dashboard, AI, Dataset, Report, Presentation, Design, NASA challenge).
- general: anything else.
Rules: FIRST choose every suitable tag from the EXISTING list and copy its name exactly. Create a NEW tag ONLY when no existing tag fits that aspect of the content. New tags: short English technical names (max 3 words), specific, no duplicates or near-duplicates of existing ones. Never invent facts not supported by the content; if the content is unclear, return fewer tags.`;

const geminiKeys = () => [...new Set(Object.keys(process.env).filter(k => /^GEMINI_API_KEY(_\d+)?$/.test(k)).sort().map(k => process.env[k]).filter(Boolean))];

async function findItem(id) {
  const path = `items/${id}.json`;
  const r = await (await blob()).list({ prefix: path, limit: 5 });
  const b = r.blobs.find(x => x.pathname === path);
  if (!b) return null;
  return { data: await (await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' })).json(), path };
}

async function pageText(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LibraryTagger/1.0)' }, signal: AbortSignal.timeout(7000) });
    if (!(r.headers.get('content-type') || '').includes('text')) return '';
    return (await r.text()).replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
  } catch { return ''; }
}

async function gemini(parts, keys) {
  let lastErr = 'no model';
  const start = Math.floor(Math.random() * keys.length);
  for (let n = 0; n < keys.length; n++) {
   const key = keys[(start + n) % keys.length];
   for (const m of MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0.2, maxOutputTokens: 2048, responseMimeType: 'application/json',
          responseSchema: { type: 'OBJECT', properties: { tags: { type: 'ARRAY', items: { type: 'OBJECT',
            properties: { n: { type: 'STRING' }, g: { type: 'STRING', enum: GROUPS } }, required: ['n', 'g'] } } }, required: ['tags'] }
        }
      })
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const txt = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
      return JSON.parse(txt).tags || [];
    }
    lastErr = `${m}: ${j.error?.message || r.status}`;
    if (r.status === 429 || r.status === 401 || r.status === 403) break;   // this key is limited or invalid: try the next key
   }
  }
  throw new Error(lastErr.slice(0, 220));
}

export default async function handler(req, res) {
  try {
    const keys = geminiKeys();
    if (!keys.length) return res.status(503).json({ error: 'GEMINI_API_KEY is not set in Vercel' });
    const { id, vocab = [], save = true } = req.body || {};
    const norm = x => String(x).toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]/g, '');
    const known = new Map();
    for (const v of vocab.slice(0, 400)) { const o = typeof v === 'string' ? { n: v } : v; if (o && o.n) known.set(norm(o.n), o); }
    const it = await findItem(String(id));
    if (!it) return res.status(404).json({ error: 'Item not found' });
    const d = it.data;
    const parts = [{ text: PROMPT + '\n\nEXISTING tags: ' + [...known.values()].map(v => v.g ? `${v.n} [${v.g}]` : v.n).join('; ') + '\n\nItem title: ' + d.title + '\nType: ' + d.type }];
    if (d.type === 'link') {
      parts.push({ text: 'URL: ' + d.url + '\nPage text:\n' + (await pageText(d.url)) });
    } else if (okUrl(d.fileUrl)) {
      const ct = (d.contentType || '').toLowerCase();
      if ((ct.includes('pdf') || ct.startsWith('image/')) && (d.size || 0) < 4.5e6) {
        const buf = Buffer.from(await (await fetch(d.fileUrl)).arrayBuffer());
        parts.push({ inline_data: { mime_type: ct.split(';')[0], data: buf.toString('base64') } });
      } else if (ct.startsWith('text/') || /\.(txt|md|csv|json)$/i.test(d.title)) {
        parts.push({ text: (await (await fetch(d.fileUrl)).text()).slice(0, 8000) });
      }
    }
    const raw = await gemini(parts, keys);
    const tags = []; const seen = new Set();
    for (const t of raw) {
      let n = String(t.n || '').trim().slice(0, 40), g = GROUPS.includes(t.g) ? t.g : 'general';
      const ex = known.get(norm(n));
      if (ex) { n = ex.n; if (GROUPS.includes(ex.g)) g = ex.g; }
      const k = n.toLowerCase();
      if (!n || seen.has(k)) continue; seen.add(k);
      tags.push({ n, g });
      if (tags.length >= 10) break;
    }
    if (save) {
      const merged = [...(d.tags || [])];
      for (const t of tags) if (!merged.some(x => x.n.toLowerCase() === t.n.toLowerCase())) merged.push(t);
      await (await blob()).put(it.path, JSON.stringify({ ...d, tags: merged.slice(0, 12) }), {
        access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60
      });
    }
    res.status(200).json({ tags });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 240) });
  }
}
