import { put } from '@vercel/blob';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    const name = String(req.query.name || 'file').slice(0, 150);
    const type = String(req.query.type || 'application/octet-stream');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    if (!body.length) return res.status(400).json({ error: 'empty file' });
    const b = await put('files/' + Date.now().toString(36) + '/' + name, body, {
      access: 'public', addRandomSuffix: true, contentType: type
    });
    res.status(200).json({ url: b.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
