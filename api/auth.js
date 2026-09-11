const { verifyPin, generateToken, verifyToken, extractToken } = require('../lib/auth');

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

  // GET: Check if existing session token is still valid
  if (req.method === 'GET') {
    const token = extractToken(req);
    if (token && verifyToken(token)) {
      res.status(200).json({ ok: true, valid: true });
    } else {
      res.status(401).json({ ok: false, valid: false, error: 'Session expired or invalid' });
    }
    return;
  }

  // POST: Verify PIN and issue token
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

    const pin = body && (body.pin || body.password);
    if (!pin) {
      res.status(400).json({ ok: false, error: 'PIN is required' });
      return;
    }

    if (verifyPin(pin)) {
      const token = generateToken();
      res.status(200).json({
        ok: true,
        token: token,
        message: 'PIN verified successfully'
      });
    } else {
      res.status(401).json({
        ok: false,
        error: 'Incorrect PIN'
      });
    }
    return;
  }

  res.status(405).json({ ok: false, error: 'Method Not Allowed' });
};
