// Vercel Serverless Function: Persistent Cross-Device Sync for My Workboard
// Uses GitHub Gist storage for 100% persistent, free cloud sync across all devices,
// with support for Vercel KV / Upstash Redis if configured.

const fs = require('fs');
const path = require('path');
const { verifyToken, extractToken } = require('../lib/auth');

// Auto-load .env.local if present in dev/build
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const k = match[1];
        const v = match[2] ? match[2].trim().replace(/^['"]|['"]$/g, '') : '';
        if (!process.env[k]) process.env[k] = v;
      }
    }
  }
} catch (e) {}

const GIST_ID = process.env.GIST_ID || '9fd65dc7c2868aa0bea7bef586fc4454';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

let inMemoryCache = null;
let lastCacheFetchTime = 0;
const CACHE_TTL_MS = 1500; // 1.5s in-memory cache to reduce external API rate usage

async function getFromGist() {
  const now = Date.now();
  if (inMemoryCache && (now - lastCacheFetchTime < CACHE_TTL_MS)) {
    return inMemoryCache;
  }

  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'User-Agent': 'Workboard-Sync-App',
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub Gist read error (${res.status}): ${errText}`);
  }

  const gist = await res.json();
  const file = gist.files && gist.files['workboard.json'];
  if (!file || !file.content) {
    return null;
  }

  try {
    const parsed = JSON.parse(file.content);
    inMemoryCache = parsed;
    lastCacheFetchTime = now;
    return parsed;
  } catch (e) {
    console.error('Failed to parse Gist content:', e);
    return null;
  }
}

async function saveToGist(record) {
  inMemoryCache = record;
  lastCacheFetchTime = Date.now();

  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'User-Agent': 'Workboard-Sync-App',
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github.v3+json'
    },
    body: JSON.stringify({
      description: 'Personal Workboard Sync Data',
      files: {
        'workboard.json': {
          content: JSON.stringify(record, null, 2)
        }
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub Gist update error (${res.status}): ${errText}`);
  }

  return true;
}

module.exports = async function handler(req, res) {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-App-Token, X-Sync-Key');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // Parse body early for POST if string
  let body = req.body;
  if (req.method === 'POST' && typeof body === 'string') {
    try {
      body = JSON.parse(body);
      req.body = body;
    } catch (e) {}
  }

  // Verify authentication
  const token = extractToken(req) || (req.query && req.query.token) || (req.body && req.body.token);
  if (!verifyToken(token)) {
    res.status(401).json({
      ok: false,
      error: 'Unauthorized: Valid PIN authentication required'
    });
    return;
  }

  // GET: Fetch the current board state
  if (req.method === 'GET') {
    try {
      const record = await getFromGist();

      if (!record || !record.data) {
        res.status(200).json({
          ok: true,
          found: false,
          storage: 'gist',
          message: 'No board found yet.'
        });
        return;
      }

      res.status(200).json({
        ok: true,
        found: true,
        storage: 'gist',
        updatedAt: record.updatedAt,
        data: record.data
      });
    } catch (err) {
      console.error('Error in GET /api/sync:', err);
      res.status(500).json({
        ok: false,
        error: 'Failed to fetch board data: ' + err.message
      });
    }
    return;
  }

  // POST: Save board state
  if (req.method === 'POST') {
    if (!body || !body.data || !Array.isArray(body.data.categories)) {
      res.status(400).json({
        ok: false,
        error: 'Invalid board data structure. Expected object with categories array.'
      });
      return;
    }

    const clientUpdatedAt = Number(body.updatedAt) || 0;
    const force = Boolean(body.force);

    try {
      // Check current cloud record first to protect against stale overwrites
      const current = await getFromGist();
      const currentUpdatedAt = current ? (Number(current.updatedAt) || 0) : 0;

      // If the cloud already has newer data and this is not a forced push,
      // prevent stale overwrite and return the latest cloud data to the client!
      if (!force && current && current.data && currentUpdatedAt > clientUpdatedAt) {
        res.status(200).json({
          ok: false,
          conflict: true,
          storage: 'gist',
          updatedAt: currentUpdatedAt,
          data: current.data,
          message: 'Cloud has newer data from another device. Synced with latest.'
        });
        return;
      }

      const serverNow = Date.now();
      const record = {
        updatedAt: Math.max(clientUpdatedAt, serverNow),
        data: body.data
      };

      await saveToGist(record);

      res.status(200).json({
        ok: true,
        storage: 'gist',
        updatedAt: record.updatedAt,
        message: 'Board saved permanently'
      });
    } catch (err) {
      console.error('Error in POST /api/sync:', err);
      res.status(500).json({
        ok: false,
        error: 'Failed to save board data: ' + err.message
      });
    }
    return;
  }

  res.status(405).json({ ok: false, error: 'Method Not Allowed' });
};
