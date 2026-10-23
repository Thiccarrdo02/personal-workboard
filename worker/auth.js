// PINs, sessions, one-time links and rate limits.
//
// PINs are never stored: we keep HMAC-SHA256(PIN_PEPPER, salt:pin). The pepper is
// a Worker secret that is not in the database, so a leaked database can't be
// brute-forced offline. Online guessing is stopped by per-profile lockouts and a
// per-network limit.

import { HttpError, clientIp, minutes } from './http.js';

export const PIN_LENGTH = 6;
const DAY_MS = 86400000;
const SESSION_REMEMBER_MS = 180 * DAY_MS;
const SESSION_SHORT_MS = 12 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 60 * 1000;
const MAX_FAILED_PINS = 5;
const LOCK_BASE_MS = 15 * 60 * 1000;
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX_ATTEMPTS = 30;

const encoder = new TextEncoder();

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let text = '';
  for (const b of raw) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function pepper(env) {
  if (!env.PIN_PEPPER || env.PIN_PEPPER.length < 32) throw new HttpError(500, 'Server is missing its PIN_PEPPER secret.');
  return env.PIN_PEPPER;
}

export function hashPin(env, pin, salt) {
  return hmacHex(pepper(env), `${salt}:${pin}`);
}

export function isValidPin(pin) {
  return typeof pin === 'string' && new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

// Rejects 000000-style repeats and straight runs like 123456 / 987654.
export function isWeakPin(pin) {
  if (/^(\d)\1+$/.test(pin)) return true;
  const digits = [...pin].map(Number);
  const steps = new Set(digits.slice(1).map((d, i) => d - digits[i]));
  return steps.size === 1 && (steps.has(1) || steps.has(-1));
}

export function publicUser(user) {
  return { id: user.id, name: user.name, role: user.role };
}

// Fixed-window counter. Returns { allowed, retryAfterMs }.
export async function hitRateLimit(env, key, max, windowMs, now) {
  const row = await env.DB.prepare('SELECT count, reset_at FROM rate_limits WHERE key = ?').bind(key).first();
  if (!row || row.reset_at <= now) {
    await env.DB.prepare(
      'INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at'
    ).bind(key, now + windowMs).run();
    return { allowed: true, retryAfterMs: 0 };
  }
  if (row.count >= max) return { allowed: false, retryAfterMs: row.reset_at - now };
  await env.DB.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').bind(key).run();
  return { allowed: true, retryAfterMs: 0 };
}

async function limitNetwork(env, request, now) {
  const limit = await hitRateLimit(env, `pin:${clientIp(request)}`, IP_MAX_ATTEMPTS, IP_WINDOW_MS, now);
  if (!limit.allowed) throw new HttpError(429, `Too many attempts from this network. Try again in ${minutes(limit.retryAfterMs)}.`);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

export async function createSession(env, userId, { remember = true, device = '', status = 'active' }, now) {
  const token = randomToken();
  const expiresAt = now + (remember ? SESSION_REMEMBER_MS : SESSION_SHORT_MS);
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, status, device, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(await sha256Hex(token), userId, status, String(device).slice(0, 160), now, now, expiresAt).run();
  return { token, expiresAt };
}

/** Returns { tokenHash, user } for a valid, active session, else null. */
export async function authenticate(env, token, now) {
  if (!token || token.length > 200) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.status AS session_status, s.created_at, s.last_seen_at, s.expires_at,
            u.name, u.role, u.status AS user_status
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  ).bind(tokenHash).first();
  if (!row || row.expires_at <= now || row.user_status !== 'active' || row.session_status !== 'active') return null;

  // Sliding expiry for remembered devices; write at most once an hour to save D1 writes.
  if (now - row.last_seen_at > TOUCH_EVERY_MS) {
    const remembered = row.expires_at - row.created_at > SESSION_SHORT_MS;
    await env.DB.batch([
      env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
        .bind(now, remembered ? now + SESSION_REMEMBER_MS : row.expires_at, tokenHash),
      env.DB.prepare('UPDATE users SET last_active_at = ? WHERE id = ?').bind(now, row.user_id)
    ]);
  }
  return { tokenHash, user: { id: row.user_id, name: row.name, role: row.role } };
}

export async function revokeSession(env, tokenHash) {
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

// ---------------------------------------------------------------------------
// Profiles and PIN login
// ---------------------------------------------------------------------------

export async function listProfiles(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, role, pin_hash IS NOT NULL AS has_pin FROM users
      WHERE status = 'active' ORDER BY role = 'owner' DESC, name COLLATE NOCASE`
  ).all();
  return results.map(row => ({ id: row.id, name: row.name, role: row.role, hasPin: Boolean(row.has_pin) }));
}

export async function login(env, request, body, now) {
  await limitNetwork(env, request, now);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(String(body.userId || '')).first();
  if (!user || user.status !== 'active') throw new HttpError(401, 'That profile is not available.');
  if (!user.pin_hash) throw new HttpError(409, 'This profile has no PIN yet. Ask Raza for your setup link.');
  if (user.locked_until > now) {
    throw new HttpError(429, `Too many wrong PINs. Try again in ${minutes(user.locked_until - now)}.`, { lockedUntil: user.locked_until });
  }

  const pin = String(body.pin || '');
  const ok = isValidPin(pin) && timingSafeEqual(await hashPin(env, pin, user.pin_salt), user.pin_hash);
  if (!ok) {
    const failed = user.failed_attempts + 1;
    if (failed >= MAX_FAILED_PINS) {
      const lockMs = LOCK_BASE_MS * 2 ** Math.min(user.lockouts, 6);
      await env.DB.prepare('UPDATE users SET failed_attempts = 0, lockouts = lockouts + 1, locked_until = ? WHERE id = ?')
        .bind(now + lockMs, user.id).run();
      throw new HttpError(429, `Too many wrong PINs. This profile is locked for ${minutes(lockMs)}.`, { lockedUntil: now + lockMs });
    }
    await env.DB.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').bind(failed, user.id).run();
    const left = MAX_FAILED_PINS - failed;
    throw new HttpError(401, `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left before a short lock.`, { attemptsLeft: left });
  }

  await env.DB.prepare('UPDATE users SET failed_attempts = 0, lockouts = 0, locked_until = 0, last_active_at = ? WHERE id = ?')
    .bind(now, user.id).run();
  const session = await createSession(env, user.id, { remember: body.remember !== false, device: request.headers.get('User-Agent') || '' }, now);
  return { ok: true, token: session.token, expiresAt: session.expiresAt, user: publicUser(user) };
}

// ---------------------------------------------------------------------------
// One-time links (first PIN setup, PIN reset)
// ---------------------------------------------------------------------------

async function findLink(env, token, now) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT i.token_hash, i.purpose, i.expires_at, i.used_at, u.id AS user_id, u.name, u.role, u.status
       FROM invites i JOIN users u ON u.id = i.user_id
      WHERE i.token_hash = ? AND i.purpose IN ('setup', 'reset')`
  ).bind(tokenHash).first();
  if (!row || row.used_at || row.expires_at <= now || row.status !== 'active') return null;
  return row;
}

export async function checkSetupLink(env, request, body, now) {
  await limitNetwork(env, request, now);
  const link = await findLink(env, body.token, now);
  if (!link) throw new HttpError(404, 'This link is invalid, already used or expired. Ask Raza for a new one.');
  return { ok: true, purpose: link.purpose, user: { id: link.user_id, name: link.name, role: link.role } };
}

export async function completeSetup(env, request, body, now) {
  await limitNetwork(env, request, now);
  const link = await findLink(env, body.token, now);
  if (!link) throw new HttpError(404, 'This link is invalid, already used or expired. Ask Raza for a new one.');
  const pin = String(body.pin || '');
  if (!isValidPin(pin)) throw new HttpError(400, `Your PIN must be exactly ${PIN_LENGTH} digits.`);
  if (isWeakPin(pin)) throw new HttpError(400, 'That PIN is too easy to guess. Avoid repeats and runs like 123456.');

  const salt = randomToken(16);
  const statements = [
    env.DB.prepare(
      'UPDATE users SET pin_hash = ?, pin_salt = ?, failed_attempts = 0, lockouts = 0, locked_until = 0, last_active_at = ? WHERE id = ?'
    ).bind(await hashPin(env, pin, salt), salt, now, link.user_id),
    env.DB.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ?').bind(now, link.token_hash)
  ];
  // A reset signs the person out everywhere else.
  if (link.purpose === 'reset') statements.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(link.user_id));
  await env.DB.batch(statements);

  const session = await createSession(env, link.user_id, { remember: body.remember !== false, device: request.headers.get('User-Agent') || '' }, now);
  return { ok: true, token: session.token, expiresAt: session.expiresAt, user: { id: link.user_id, name: link.name, role: link.role } };
}
