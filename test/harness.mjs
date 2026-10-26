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

export function setup({ telegram = false, start = '2026-10-23T08:00:00Z' } = {}) {
  let now = Date.parse(start);
  const env = { DB: createD1(join(root, 'migrations')), PIN_PEPPER: 'test-pepper-'.padEnd(40, 'x'), NOW: () => now };
  if (telegram) {
    env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
    env.TELEGRAM_WEBHOOK_SECRET = 'test-hook-secret';
  }
  const advance = ms => { now += ms; };
  const setNow = iso => { now = Date.parse(iso); };

  // Background work (ctx.waitUntil) is awaited so tests can check its effects.
  async function call(method, path, { body, token, ip = '1.1.1.1', headers: extra = {} } = {}) {
    const headers = { 'CF-Connecting-IP': ip, ...extra };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const pending = [];
    const res = await worker.fetch(new Request(`https://board.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: p => pending.push(p) });
    const json = await res.json();
    await Promise.all(pending);
    return { status: res.status, body: json };
  }

  async function runSchedule() {
    const pending = [];
    await worker.scheduled({}, env, { waitUntil: p => pending.push(p) });
    await Promise.all(pending);
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

  return { env, call, runSchedule, addUser, addLink, onboard, advance, setNow };
}

/**
 * Replaces fetch for api.telegram.org with a recorder. `calls` lists
 * { method, payload }; `failNext(method, status)` makes the next such call fail.
 */
export function fakeTelegram() {
  const realFetch = globalThis.fetch;
  const calls = [];
  const failures = [];
  let messageId = 100;
  globalThis.fetch = async (url, init = {}) => {
    const match = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/.exec(String(url));
    if (!match) return realFetch(url, init);
    const method = match[1];
    const payload = init.body ? JSON.parse(init.body) : {};
    calls.push({ method, payload });
    const failure = failures.findIndex(f => f.method === method);
    if (failure !== -1) {
      const [{ status }] = failures.splice(failure, 1);
      return new Response(JSON.stringify({ ok: false, error_code: status, description: 'Forbidden: bot was blocked by the user' }), { status });
    }
    const result = method === 'getMe' ? { id: 1, is_bot: true, username: 'ZawishWorkboardBot' }
      : method === 'sendMessage' ? { message_id: ++messageId, chat: { id: payload.chat_id }, text: payload.text }
        : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };
  return {
    calls,
    sent: () => calls.filter(c => c.method === 'sendMessage').map(c => c.payload),
    failNext: (method, status) => failures.push({ method, status }),
    clear: () => { calls.length = 0; },
    restore: () => { globalThis.fetch = realFetch; }
  };
}
