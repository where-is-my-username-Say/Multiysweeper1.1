let B;
const blob = async () => B || (B = await import('@vercel/blob'));
export const config = { maxDuration: 30 };

const MODELS = [process.env.GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash'].filter(Boolean);

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

const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

async function gemini(system, contents, key) {
  let last = 'no model';
  for (const m of MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: {
          temperature: 0.3, maxOutputTokens: 2048, responseMimeType: 'application/json',
          responseSchema: { type: 'OBJECT', properties: { answer: { type: 'STRING' }, ids: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['answer', 'ids'] }
        }
      })
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const txt = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
      return JSON.parse(txt);
    }
    last = `${m}: ${j.error?.message || r.status}`;
    if ([401, 403, 429].includes(r.status)) break;
  }
  throw new Error(last.slice(0, 220));
}

export default async function handler(req, res) {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(503).json({ error: 'GEMINI_API_KEY is not set in Vercel' });
    const { messages = [], lang = 'en' } = req.body || {};
    const [folders, items] = await Promise.all([readAll('folders/'), readAll('items/')]);
    const fname = Object.fromEntries(folders.map(f => [f.id, f.name]));
    items.sort((a, b) => (b.at || 0) - (a.at || 0));
    const lines = items.slice(0, 500).map(i => [
      i.id, i.type === 'link' ? 'link' : (i.contentType || 'file'), String(i.title || '').slice(0, 100),
      fname[i.folder] || '(no folder)', (i.tags || []).map(t => t.n).join(', '), i.by || '',
      new Date(i.at || 0).toISOString().slice(0, 10), i.type === 'link' ? host(i.url) : ''
    ].join(' | '));
    const system = `You are the assistant of a shared project library for a student project called "Flame in Freefall" (AI fire-safety dashboard from microgravity combustion data).
You see the full catalog below, one item per line: id | type | title | folder | tags | added by | date | site.
FOLDERS: ${folders.map(f => f.name).join(', ') || '(none)'}
CATALOG:
${lines.join('\n') || '(the library is empty)'}

Rules:
- Answer ONLY from this catalog. Never invent items, links, folders or file contents. You know titles, folders, tags, types, authors and dates, not what is inside the files; say so if asked about contents.
- When asked where something is, name the folder and the item title.
- When asked to gather / list / collect all files or links about a topic, include every matching item id (up to 40) and summarize briefly.
- Put the ids of every item you mention or return in "ids". Use ids exactly as written.
- If nothing matches, say so plainly and suggest what could be searched instead.
- Reply in the user's language (default: ${lang === 'ar' ? 'Arabic' : 'English'}), short and plain text.`;
    let contents = messages.slice(-12).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '').slice(0, 2000) }] }));
    while (contents.length && contents[0].role !== 'user') contents.shift();
    if (!contents.length || contents[contents.length - 1].role !== 'user') return res.status(400).json({ error: 'No question' });
    const out = await gemini(system, contents, key);
    const valid = new Set(items.map(i => i.id));
    const ids = [...new Set((out.ids || []).filter(x => valid.has(x)))].slice(0, 40);
    res.status(200).json({ answer: String(out.answer || '').slice(0, 4000), ids });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 240) });
  }
}
