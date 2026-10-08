import { put, list, del } from '@vercel/blob';

export default async function handler(req, res) {
  const out = {
    hasToken: !!process.env.BLOB_READ_WRITE_TOKEN,
    hasStoreId: !!process.env.BLOB_STORE_ID,
    steps: {}
  };
  try { await list({ limit: 1 }); out.steps.list = 'ok'; }
  catch (e) { out.steps.list = e.message; }
  try {
    const b = await put('check/a.txt', 'hi', { access: 'public', allowOverwrite: true, addRandomSuffix: false });
    out.steps.putPublic = 'ok'; await del(b.url);
  } catch (e) { out.steps.putPublic = e.message; }
  try {
    const b = await put('check/b.txt', 'hi', { access: 'private', allowOverwrite: true, addRandomSuffix: false });
    out.steps.putPrivate = 'ok'; await del(b.url);
  } catch (e) { out.steps.putPrivate = e.message; }
  res.status(200).json(out);
}
