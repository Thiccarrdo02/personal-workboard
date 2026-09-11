const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

const APP_PASSWORD = process.env.APP_PASSWORD || '';
const AUTH_SECRET = process.env.AUTH_SECRET || 'workboard-auth-secret-key-2026';

function generateToken() {
  return crypto.createHmac('sha256', AUTH_SECRET).update(APP_PASSWORD).digest('hex');
}

function verifyToken(token) {
  if (!token) return false;
  const expected = generateToken();
  if (typeof token !== 'string' || token.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch (e) {
    return false;
  }
}

function verifyPin(inputPin) {
  if (!inputPin) return false;
  const cleanInput = String(inputPin).trim();
  const cleanPass = String(APP_PASSWORD).trim();
  if (cleanInput.length !== cleanPass.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(cleanInput), Buffer.from(cleanPass));
  } catch (e) {
    return false;
  }
}

function extractToken(req) {
  const authHeader = req.headers && (req.headers['authorization'] || req.headers['Authorization']);
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const customHeader = req.headers && (req.headers['x-app-token'] || req.headers['x-access-token']);
  if (customHeader) return customHeader.trim();
  return null;
}

module.exports = {
  APP_PASSWORD,
  generateToken,
  verifyToken,
  verifyPin,
  extractToken
};
