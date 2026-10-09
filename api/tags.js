import { put, list } from '@vercel/blob';

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

async function findItem(id) {
  const path = `items/${id}.json`;
  const r = await list({ prefix: path, limit: 5 });
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

async function gemini(parts, key) {
  let lastErr = 'no model';
  for (const m of MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
