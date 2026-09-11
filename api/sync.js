// Vercel Serverless Function: Cross-Device Sync for My Workboard
// Supports Vercel KV, Upstash Redis, or in-memory fallback.

let memoryStorage = new Map();

function getStorageCredentials() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    return { url, token, type: 'upstash' };
  }
  return null;
}

async function redisCommand(credentials, commandArgs) {
  const res = await fetch(credentials.url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${credentials.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commandArgs)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Redis error (${res.status}): ${errText}`);
  }

  const json = await res.json();
  return json.result;
}

function sanitizeKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return null;
  const clean = rawKey.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (clean.length < 3 || clean.length > 64) return null;
  return `workboard:${clean}`;
}

module.exports = async function handler(req, res) {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Sync-Key');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const storage = getStorageCredentials();

  // GET: Fetch board state
  if (req.method === 'GET') {
    const rawKey = req.query.key || req.headers['x-sync-key'];
    const key = sanitizeKey(rawKey);

    if (!key) {
      res.status(400).json({
        ok: false,
        error: 'Invalid or missing sync key. Provide a key with 3-64 alphanumeric characters.'
      });
      return;
    }

    try {
      let storedRecord = null;

      if (storage) {
        const raw = await redisCommand(storage, ['GET', key]);
        if (raw) {
          storedRecord = typeof raw === 'string' ? JSON.parse(raw) : raw;
        }
      } else {
        storedRecord = memoryStorage.get(key) || null;
      }

      if (!storedRecord) {
        res.status(200).json({
          ok: true,
          found: false,
          storage: storage ? 'cloud' : 'memory',
          message: 'No remote board found for this key yet.'
        });
        return;
      }

      res.status(200).json({
        ok: true,
        found: true,
        storage: storage ? 'cloud' : 'memory',
        updatedAt: storedRecord.updatedAt,
        data: storedRecord.data
      });
    } catch (err) {
      console.error('Error fetching board:', err);
      res.status(500).json({
        ok: false,
        error: 'Failed to fetch board data: ' + err.message
      });
    }
    return;
  }

  // POST: Save board state
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        res.status(400).json({ ok: false, error: 'Invalid JSON body' });
        return;
      }
    }

    const rawKey = (body && body.key) || req.query.key || req.headers['x-sync-key'];
    const key = sanitizeKey(rawKey);

    if (!key) {
      res.status(400).json({
        ok: false,
        error: 'Invalid or missing sync key. Provide a key with 3-64 alphanumeric characters.'
      });
      return;
    }

    if (!body || !body.data || !Array.isArray(body.data.categories)) {
      res.status(400).json({
        ok: false,
        error: 'Invalid board data structure. Expected object with categories array.'
      });
      return;
    }

    const record = {
      updatedAt: body.updatedAt || Date.now(),
      data: body.data
    };

    try {
      if (storage) {
        await redisCommand(storage, ['SET', key, JSON.stringify(record)]);
      } else {
        memoryStorage.set(key, record);
      }

      res.status(200).json({
        ok: true,
        storage: storage ? 'cloud' : 'memory',
        updatedAt: record.updatedAt,
        message: 'Board synced successfully'
      });
    } catch (err) {
      console.error('Error saving board:', err);
      res.status(500).json({
        ok: false,
        error: 'Failed to save board data: ' + err.message
      });
    }
    return;
  }

  res.status(405).json({ ok: false, error: 'Method Not Allowed' });
};
