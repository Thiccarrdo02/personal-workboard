// Serverless Function: cross-device sync for My Workboard.
//
// Every saved board gets a revision number (`rev`). Clients send the revision
// they last synced from (`baseRev`); if the cloud has moved on since then the
// write is rejected and the latest board is returned, so the client can merge
// task-by-task and retry instead of overwriting another device's changes.

const { verifyToken, extractToken } = require('../lib/auth');
const storage = require('../lib/storage');

const SCHEMA = 3;

module.exports = async function handler(req, res) {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-App-Token');
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

  // Verify authentication (body token is used by navigator.sendBeacon on page close)
  const token = extractToken(req) || (body && body.token);
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
      const record = await storage.readBoard();

      if (!record || !record.data) {
        res.status(200).json({
          ok: true,
          found: false,
          storage: storage.backend,
          message: 'No board found yet.'
        });
        return;
      }

      const rev = Number(record.updatedAt) || 0;
      res.status(200).json({
        ok: true,
        found: true,
        storage: storage.backend,
        rev,
        updatedAt: rev,
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

  // POST: Save board state if it was based on the latest revision
  if (req.method === 'POST') {
    if (!body || !body.data || !Array.isArray(body.data.categories)) {
      res.status(400).json({
        ok: false,
        error: 'Invalid board data structure. Expected object with categories array.'
      });
      return;
    }

    try {
      const current = await storage.readBoard({ fresh: true });
      const hasCurrent = Boolean(current && current.data);
      const currentRev = hasCurrent ? Number(current.updatedAt) || 0 : 0;

      // Pages cached from before the v3 data model don't send a schema. They may
      // read the board, but never overwrite it (that would drop due dates, notes, etc.).
      const isCurrentClient = Number(body.schema) >= SCHEMA;
      const isStale = !isCurrentClient || Number(body.baseRev) !== currentRev;

      if (hasCurrent && isStale) {
        res.status(200).json({
          ok: false,
          conflict: true,
          storage: storage.backend,
          rev: currentRev,
          updatedAt: currentRev,
          data: current.data,
          message: isCurrentClient
            ? 'Cloud has newer changes from another device. Merge and retry.'
            : 'This page is out of date. Reload to keep editing.'
        });
        return;
      }

      const rev = Math.max(Date.now(), currentRev + 1);
      await storage.writeBoard({
        updatedAt: rev,
        schema: isCurrentClient ? SCHEMA : 2,
        data: body.data
      });

      res.status(200).json({
        ok: true,
        storage: storage.backend,
        rev,
        updatedAt: rev,
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
