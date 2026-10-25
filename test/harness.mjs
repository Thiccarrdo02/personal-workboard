// Runs the real Worker against an in-memory SQLite D1 stand-in with a controllable clock.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker from '../worker/index.js';
import { createD1 } from './d1-shim.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MIN = 60000;
export const sha = text => createHash('sha256').update(text).digest('hex');
export const board = text => ({ version: 3, categories: [{ id: 'c', name: 'C', tasks: [{ id: 't', text, status: 'NTS' }] }] });

export function setup() {
  let now = Date.parse('2026-10-23T08:00:00Z');
  const env = { DB: createD1(join(root, 'migrations')), PIN_PEPPER: 'test-pepper-'.padEnd(40, 'x'), NOW: () => now };
  const advance = ms => { now += ms; };

  async function call(method, path, { body, token, ip = '1.1.1.1' } = {}) {
    const headers = { 'CF-Connecting-IP': ip };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await worker.fetch(new Request(`https://board.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, {});
    return { status: res.status, body: await res.json() };
  }

  async function addUser(id, name, { role = 'member', status = 'active' } = {}) {
    await env.DB.prepare('INSERT INTO users (id, name, role, status, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, name, role, status, now).run();
  }

  async function addLink(userId, token, { purpose = 'setup', ttl = 24 * 60 * MIN } = {}) {
    await env.DB.prepare('INSERT INTO invites (token_hash, purpose, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(sha(token), purpose, userId, now, now + ttl).run();
  }

  // Creates a user, sets their PIN through a setup link, returns a session token.
  async function onboard(id, name, pin, role = 'member') {
    await addUser(id, name, { role });
    await addLink(id, `link-${id}`);
    const res = await call('POST', '/api/setup', { body: { action: 'complete', token: `link-${id}`, pin } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.token;
  }

  return { env, call, addUser, addLink, onboard, advance };
}
