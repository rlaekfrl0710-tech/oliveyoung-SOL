import { get, put, BlobPreconditionFailedError } from '@vercel/blob';

const path = process.env.VERCEL_ENV === 'production' ? 'checklist-v1.json' : 'preview-checklist-v1.json';
const entryKey = /^item_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const checkKey = /^(?:o|t90|tpe|(?:p|r|s|tr|u_r|u_s|u_tr)(?:[1-9]|1[0-2])|u_o)$/;
const dateKey = /^e_(?:o|tpopen|(?:r|s|tr|d_tr)(?:[1-9]|1[0-2]))$/;
const valid = (key, value) => {
  if (entryKey.test(key)) return typeof value === 'string' && value.trim() && value.length <= 160;
  if (checkKey.test(key)) return typeof value === 'boolean';
  return dateKey.test(key) && (value === null || value === '' ||
    (typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) &&
     !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value));
};

async function read() {
  const blob = await get(path, { access: 'private', useCache: false });
  if (!blob) return { data: {}, etag: null };
  if (blob.statusCode !== 200) throw new Error('Unable to read checklist');
  return { data: await new Response(blob.stream).json(), etag: blob.blob.etag };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') return res.json((await read()).data);
    if (req.method !== 'PATCH') {
      res.setHeader('Allow', 'GET, PATCH');
      return res.status(405).end();
    }
    if (!req.headers['content-type']?.startsWith('application/json') ||
        req.headers['sec-fetch-site'] === 'cross-site') return res.status(415).end();
    const changes = req.body;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) ||
        Object.keys(changes).length > 100 || !Object.entries(changes).every(([k, v]) => valid(k, v))) {
      return res.status(400).json({ error: 'Invalid checklist changes' });
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, etag } = await read();
      Object.assign(data, changes);
      if (Object.keys(data).filter(k => entryKey.test(k)).length > 200) return res.status(409).end();
      try {
        await put(path, JSON.stringify(data), {
          access: 'private', addRandomSuffix: false, contentType: 'application/json',
          ...(etag ? { allowOverwrite: true, ifMatch: etag } : { allowOverwrite: false })
        });
        return res.json(data);
      } catch (error) {
        if (!(error instanceof BlobPreconditionFailedError) &&
            (etag || !error.message?.includes('already exists'))) throw error;
      }
    }
    return res.status(409).json({ error: 'Concurrent update' });
  } catch (error) {
    console.error('Checklist storage request failed', error.name);
    return res.status(503).json({ error: 'Storage unavailable' });
  }
}
