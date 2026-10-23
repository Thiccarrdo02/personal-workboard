// Per-person board storage with safe multi-device saves.
//
// Each board has a revision (`rev`). A save names the revision it was based on
// (`baseRev`); the UPDATE only succeeds if that is still the current revision.
// Otherwise the latest board is returned so the client can merge task by task
// and try again. Every query is scoped to the signed-in user's id.

import { HttpError } from './http.js';

const SCHEMA = 3;
const MAX_BOARD_BYTES = 1_500_000;

export async function getBoard(env, userId, knownRev) {
  const row = await env.DB.prepare('SELECT rev, data FROM boards WHERE user_id = ?').bind(userId).first();
  if (!row) return { ok: true, found: false };
  if (knownRev && Number(knownRev) === row.rev) return { ok: true, found: true, unchanged: true, rev: row.rev };
  return { ok: true, found: true, rev: row.rev, data: JSON.parse(row.data) };
}

async function conflict(env, userId) {
  const current = await getBoard(env, userId, null);
  return { ok: false, conflict: true, rev: current.rev, data: current.data, message: 'Another device saved first. Merge and retry.' };
}

export async function saveBoard(env, userId, body, now) {
  if (!(Number(body.schema) >= SCHEMA)) throw new HttpError(409, 'This page is out of date. Reload to keep editing.');
  if (!body.data || !Array.isArray(body.data.categories)) throw new HttpError(400, 'Invalid board data.');
  const text = JSON.stringify(body.data);
  if (text.length > MAX_BOARD_BYTES) throw new HttpError(413, 'Board is too large. Archive or delete some done tasks.');

  const baseRev = body.baseRev == null ? null : Number(body.baseRev);
  const rev = Math.max(now, (baseRev || 0) + 1);

  if (baseRev) {
    const updated = await env.DB.prepare('UPDATE boards SET rev = ?, data = ?, updated_at = ? WHERE user_id = ? AND rev = ?')
      .bind(rev, text, now, userId, baseRev).run();
    if (updated.meta.changes === 1) return { ok: true, rev };
  }

  // First save for this person (or the board was removed): insert only if nothing is there.
  const inserted = await env.DB.prepare('INSERT INTO boards (user_id, rev, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING')
    .bind(userId, rev, text, now).run();
  if (inserted.meta.changes === 1) return { ok: true, rev };
  return conflict(env, userId);
}
