import { put, list, del } from '@vercel/blob';

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

const write = (path, obj) =>
  put(path, JSON.stringify(obj), {
    access: 'public', contentType: 'application/json',
    addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60
  });

const YT = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/;
async function linkThumb(url) {
  const y = String(url).match(YT);
  if (y) return `https://i.ytimg.com/vi/${y[1]}/hqdefault.jpg`;
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
