// Team management: invite links, access requests that wait for the owner's
// approval, and the owner's admin actions. The owner sees names, status and
// last activity only — never anyone's board.

import { HttpError, clientIp } from './http.js';
import { createSession, hashPin, hitRateLimit, isValidPin, isWeakPin, ownerName, PIN_LENGTH, randomToken, sha256Hex } from './auth.js';

const DAY_MS = 86400000;
const LINK_TTL_MS = 3 * DAY_MS;
const PENDING_TTL_MS = 7 * DAY_MS;
const MAX_PENDING = 10;
const REQUESTS_PER_NETWORK_PER_DAY = 3;

function cleanName(value) {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 40) throw new HttpError(400, 'Please enter a name between 2 and 40 characters.');
  return name;
}

function checkNewPin(pin) {
  if (!isValidPin(pin)) throw new HttpError(400, `Your PIN must be exactly ${PIN_LENGTH} digits.`);
  if (isWeakPin(pin)) throw new HttpError(400, 'That PIN is too easy to guess. Avoid repeats and runs like 123456.');
}

async function assertNameFree(env, name, exceptId = '') {
  const taken = await env.DB.prepare("SELECT id FROM users WHERE name = ? COLLATE NOCASE AND status != 'disabled' AND id != ?")
    .bind(name, exceptId).first();
  if (taken) throw new HttpError(409, `Someone called “${name}” is already on the team. Add a surname or initial.`);
}

// Unanswered requests disappear after a week.
async function expireRequests(env, now) {
  const cutoff = now - PENDING_TTL_MS;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE status = 'pending' AND created_at < ?)").bind(cutoff),
    env.DB.prepare("DELETE FROM users WHERE status = 'pending' AND created_at < ?").bind(cutoff)
  ]);
}

export function requireOwner(session) {
  if (session.user.role !== 'owner') throw new HttpError(403, 'Only the owner can manage the team.');
}

export async function pendingCount(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").first();
  return row ? row.n : 0;
}

// ---------------------------------------------------------------------------
// Request access (anyone, from the sign-in screen)
// ---------------------------------------------------------------------------

export async function requestAccess(env, request, body, now) {
  const limit = await hitRateLimit(env, `request:${clientIp(request)}`, REQUESTS_PER_NETWORK_PER_DAY, DAY_MS, now);
  if (!limit.allowed) throw new HttpError(429, 'Too many requests from this network today. Please try again tomorrow.');

  const name = cleanName(body.name);
  const note = String(body.note || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const pin = String(body.pin || '');
  checkNewPin(pin);

  await expireRequests(env, now);
  if (await pendingCount(env) >= MAX_PENDING) {
    throw new HttpError(429, `There are too many open requests right now. Please message ${await ownerName(env)} directly.`);
  }
  await assertNameFree(env, name);

  const id = `u_${crypto.randomUUID()}`;
  const salt = randomToken(16);
  await env.DB.prepare(
    "INSERT INTO users (id, name, role, status, pin_hash, pin_salt, created_at, request_note) VALUES (?, ?, 'member', 'pending', ?, ?, ?, ?)"
  ).bind(id, name, await hashPin(env, pin, salt), salt, now, note || null).run();

  // A waiting session: it can only check the request's status until the owner approves.
  const session = await createSession(env, id, { remember: body.remember !== false, device: request.headers.get('User-Agent') || '', status: 'pending' }, now);
  return { ok: true, status: 'pending', token: session.token, user: { id, name, role: 'member' }, owner: await ownerName(env) };
}

export async function requestStatus(env, token, now) {
  if (!token || token.length > 200) throw new HttpError(401, 'No request found on this device.');
  const row = await env.DB.prepare(
    `SELECT s.status AS session_status, s.expires_at, u.id, u.name, u.role, u.status AS user_status
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  ).bind(await sha256Hex(token)).first();
  if (!row || row.expires_at <= now) return { ok: true, status: 'rejected' };
  const user = { id: row.id, name: row.name, role: row.role };
  if (row.user_status === 'active' && row.session_status === 'active') {
    // They're at the device right now, about to open their board.
    await env.DB.prepare('UPDATE users SET last_active_at = ? WHERE id = ?').bind(now, row.id).run();
    return { ok: true, status: 'approved', user };
  }
  if (row.user_status === 'pending') return { ok: true, status: 'pending', user, owner: await ownerName(env) };
  return { ok: true, status: 'rejected' };
}

// ---------------------------------------------------------------------------
// Owner: team list and actions
// ---------------------------------------------------------------------------

export async function listTeam(env, now) {
  await expireRequests(env, now);
  const { results } = await env.DB.prepare(
    `SELECT id, name, role, status, pin_hash IS NOT NULL AS has_pin, created_at, last_active_at, locked_until, request_note
       FROM users WHERE status IN ('active', 'pending')
      ORDER BY role = 'owner' DESC, created_at`
  ).all();
  return {
    ok: true,
    members: results.filter(u => u.status === 'active').map(u => ({
      id: u.id, name: u.name, role: u.role, hasPin: Boolean(u.has_pin),
      joinedAt: u.created_at, lastActiveAt: u.last_active_at || null, locked: u.locked_until > now
    })),
    requests: results.filter(u => u.status === 'pending').map(u => ({
      id: u.id, name: u.name, note: u.request_note || '', requestedAt: u.created_at
    }))
  };
}

// A one-time link to choose a PIN (new person) or set a new one (forgot PIN).
// Only the newest link for a person works.
async function issueLink(env, userId, ownerId, now) {
  const user = await env.DB.prepare('SELECT id, name, status, pin_hash IS NOT NULL AS has_pin FROM users WHERE id = ?').bind(userId).first();
  if (!user || user.status !== 'active') throw new HttpError(404, 'That person is not on the team.');
  const token = randomToken();
  const purpose = user.has_pin ? 'reset' : 'setup';
  await env.DB.batch([
    env.DB.prepare('DELETE FROM invites WHERE user_id = ? AND used_at IS NULL').bind(user.id),
    env.DB.prepare('INSERT INTO invites (token_hash, purpose, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(await sha256Hex(token), purpose, user.id, ownerId, now, now + LINK_TTL_MS)
  ]);
  return { ok: true, token, purpose, expiresAt: now + LINK_TTL_MS, user: { id: user.id, name: user.name } };
}

async function findMember(env, userId) {
  const user = await env.DB.prepare('SELECT id, name, role, status FROM users WHERE id = ?').bind(String(userId || '')).first();
  if (!user) throw new HttpError(404, 'That person is not on the team.');
  return user;
}

export async function teamAction(env, session, body, now) {
  const ownerId = session.user.id;
  switch (body.action) {
    case 'add': {
      const name = cleanName(body.name);
      await assertNameFree(env, name);
      const id = `u_${crypto.randomUUID()}`;
      await env.DB.prepare("INSERT INTO users (id, name, role, status, created_at, approved_at) VALUES (?, ?, 'member', 'active', ?, ?)")
        .bind(id, name, now, now).run();
      return issueLink(env, id, ownerId, now);
    }
    case 'link':
      return issueLink(env, String(body.userId || ''), ownerId, now);
    case 'approve': {
      const [updated] = await env.DB.batch([
        env.DB.prepare("UPDATE users SET status = 'active', approved_at = ? WHERE id = ? AND status = 'pending'").bind(now, String(body.userId || '')),
        env.DB.prepare("UPDATE sessions SET status = 'active' WHERE user_id = ? AND status = 'pending'").bind(String(body.userId || ''))
      ]);
      if (updated.meta.changes !== 1) throw new HttpError(404, 'That request is no longer waiting.');
      return { ok: true };
    }
    case 'reject': {
      const [, removed] = await env.DB.batch([
        env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND user_id IN (SELECT id FROM users WHERE status = 'pending')").bind(String(body.userId || '')),
        env.DB.prepare("DELETE FROM users WHERE id = ? AND status = 'pending'").bind(String(body.userId || ''))
      ]);
      if (removed.meta.changes !== 1) throw new HttpError(404, 'That request is no longer waiting.');
      return { ok: true };
    }
    case 'rename': {
      const user = await findMember(env, body.userId);
      const name = cleanName(body.name);
      await assertNameFree(env, name, user.id);
      await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, user.id).run();
      return { ok: true };
    }
    case 'remove': {
      const user = await findMember(env, body.userId);
      if (user.role === 'owner') throw new HttpError(400, 'The owner can’t be removed.');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
        env.DB.prepare('DELETE FROM invites WHERE user_id = ?').bind(user.id),
        env.DB.prepare('DELETE FROM boards WHERE user_id = ?').bind(user.id),
        env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id)
      ]);
      return { ok: true };
    }
    default:
      throw new HttpError(400, 'Unknown team action.');
  }
}
