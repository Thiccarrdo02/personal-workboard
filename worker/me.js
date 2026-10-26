// "Your data": everyone can download what's stored about them, see and sign
// out their devices, and delete their own account (the owner's stays).

import { HttpError } from './http.js';
import { verifyPin } from './auth.js';

// "iPhone · Safari" from a User-Agent string; good enough to recognise a device.
export function describeDevice(userAgent) {
  const ua = String(userAgent || '');
  const device = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet')
        : /Windows/.test(ua) ? 'Windows PC'
          : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
            : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
      : /CriOS|Chrome\//.test(ua) ? 'Chrome'
        : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
          : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${device} · ${browser}` : device;
}

async function devices(env, session) {
  const { results } = await env.DB.prepare(
    "SELECT token_hash, device, created_at, last_seen_at FROM sessions WHERE user_id = ? AND status = 'active' ORDER BY last_seen_at DESC"
  ).bind(session.user.id).all();
  return results.map(row => ({
    device: describeDevice(row.device),
    signedInAt: row.created_at,
    lastUsedAt: row.last_seen_at,
    current: row.token_hash === session.tokenHash
  }));
}

export async function listDevices(env, session) {
  return { ok: true, devices: await devices(env, session) };
}

export async function signOutOtherDevices(env, session) {
  const result = await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(session.user.id, session.tokenHash).run();
  return { ok: true, signedOut: result.meta.changes };
}

export async function exportData(env, session, now) {
  const user = await env.DB.prepare(
    `SELECT id, name, role, created_at, approved_at, last_active_at, telegram_username, telegram_linked_at,
            digest_enabled, digest_time, digest_days, digest_mode, digest_skip_empty, timezone
       FROM users WHERE id = ?`
  ).bind(session.user.id).first();
  const board = await env.DB.prepare('SELECT data, updated_at FROM boards WHERE user_id = ?').bind(session.user.id).first();
  return {
    ok: true,
    app: 'ZAWISH Workboard',
    exportedAt: new Date(now).toISOString(),
    profile: {
      id: user.id,
      name: user.name,
      role: user.role,
      joinedAt: new Date(user.created_at).toISOString(),
      approvedAt: user.approved_at ? new Date(user.approved_at).toISOString() : null,
      lastActiveAt: user.last_active_at ? new Date(user.last_active_at).toISOString() : null
    },
    notifications: {
      telegram: user.telegram_username ? { linkedAs: user.telegram_username, linkedAt: new Date(user.telegram_linked_at).toISOString() } : null,
      digest: {
        enabled: Boolean(user.digest_enabled), time: user.digest_time, days: user.digest_days,
        mode: user.digest_mode, skipEmpty: Boolean(user.digest_skip_empty), timezone: user.timezone
      }
    },
    devices: (await devices(env, session)).map(({ device, signedInAt, lastUsedAt }) => ({
      device, signedInAt: new Date(signedInAt).toISOString(), lastUsedAt: new Date(lastUsedAt).toISOString()
    })),
    board: board ? { savedAt: new Date(board.updated_at).toISOString(), data: JSON.parse(board.data) } : null
  };
}

// Permanently removes the person, their board, devices, links and Telegram link.
export async function deleteAccount(env, request, session, body, now) {
  if (session.user.role === 'owner') throw new HttpError(400, 'The owner account can’t be deleted, so the team always has an admin.');
  const user = await verifyPin(env, request, session.user.id, body.pin, now);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM invites WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM boards WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id)
  ]);
  return { ok: true, name: user.name };
}
