import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker from '../worker/index.js';
import { createD1 } from './d1-shim.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN = 60000;
const sha = text => createHash('sha256').update(text).digest('hex');

function setup() {
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

const board = text => ({ version: 3, categories: [{ id: 'c', name: 'C', tasks: [{ id: 't', text, status: 'NTS' }] }] });

test('profiles list shows active people only, without secrets', async () => {
  const t = setup();
  await t.addUser('u-raza', 'Raza', { role: 'owner' });
  await t.addUser('u-ali', 'Ali');
  await t.addUser('u-gone', 'Gone', { status: 'disabled' });
  await t.addUser('u-wait', 'Waiting', { status: 'pending' });
  const res = await t.call('GET', '/api/profiles');
  assert.deepEqual(res.body.profiles, [
    { id: 'u-raza', name: 'Raza', role: 'owner', hasPin: false },
    { id: 'u-ali', name: 'Ali', role: 'member', hasPin: false }
  ]);
});

test('setup link: check, weak PIN, single use, expiry', async () => {
  const t = setup();
  await t.addUser('u-raza', 'Raza', { role: 'owner' });
  await t.addLink('u-raza', 'good');
  await t.addLink('u-raza', 'old', { ttl: MIN });

  assert.equal((await t.call('POST', '/api/setup', { body: { token: 'nope' } })).status, 404);
  const check = await t.call('POST', '/api/setup', { body: { token: 'good' } });
  assert.equal(check.body.user.name, 'Raza');

  for (const pin of ['1234', '111111', '123456', '987654', 'abcdef']) {
    const res = await t.call('POST', '/api/setup', { body: { action: 'complete', token: 'good', pin } });
    assert.equal(res.status, 400, pin);
  }
  const done = await t.call('POST', '/api/setup', { body: { action: 'complete', token: 'good', pin: '480271' } });
  assert.equal(done.status, 200);
  assert.ok(done.body.token);
  assert.equal(done.body.user.role, 'owner');

  assert.equal((await t.call('POST', '/api/setup', { body: { action: 'complete', token: 'good', pin: '480271' } })).status, 404, 'single use');
  t.advance(2 * MIN);
  assert.equal((await t.call('POST', '/api/setup', { body: { token: 'old' } })).status, 404, 'expired');

  // the PIN is stored hashed, never as typed
  const row = await t.env.DB.prepare('SELECT pin_hash, pin_salt FROM users WHERE id = ?').bind('u-raza').first();
  assert.ok(row.pin_hash.length === 64 && !row.pin_hash.includes('480271'));
});

test('login, wrong PINs, lockout and recovery', async () => {
  const t = setup();
  await t.onboard('u-raza', 'Raza', '480271', 'owner');

  let res = await t.call('POST', '/api/login', { body: { userId: 'u-raza', pin: '000001' } });
  assert.equal(res.status, 401);
  assert.equal(res.body.attemptsLeft, 4);
  for (let i = 0; i < 3; i++) await t.call('POST', '/api/login', { body: { userId: 'u-raza', pin: '000001' } });
  res = await t.call('POST', '/api/login', { body: { userId: 'u-raza', pin: '000001' } });
  assert.equal(res.status, 429);
  assert.match(res.body.error, /locked for 15 minutes/);

  // even the right PIN is refused while locked
  assert.equal((await t.call('POST', '/api/login', { body: { userId: 'u-raza', pin: '480271' } })).status, 429);
  t.advance(16 * MIN);
  res = await t.call('POST', '/api/login', { body: { userId: 'u-raza', pin: '480271' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.name, 'Raza');

  // unknown / disabled profiles
  assert.equal((await t.call('POST', '/api/login', { body: { userId: 'nobody', pin: '480271' } })).status, 401);
  await t.addUser('u-nopin', 'No PIN');
  assert.equal((await t.call('POST', '/api/login', { body: { userId: 'u-nopin', pin: '480271' } })).status, 409);
});

test('second lockout doubles', async () => {
  const t = setup();
  await t.onboard('u-a', 'A', '480271');
  for (let i = 0; i < 5; i++) await t.call('POST', '/api/login', { body: { userId: 'u-a', pin: '111112' } });
  t.advance(16 * MIN);
  let res;
  for (let i = 0; i < 5; i++) res = await t.call('POST', '/api/login', { body: { userId: 'u-a', pin: '111112' } });
  assert.match(res.body.error, /locked for 30 minutes/);
});

test('per-network limit stops spraying many profiles', async () => {
  const t = setup();
  for (let i = 0; i < 8; i++) await t.onboard(`u-${i}`, `P${i}`, '480271');
  let last;
  for (let i = 0; i < 40; i++) last = await t.call('POST', '/api/login', { ip: '9.9.9.9', body: { userId: `u-${i % 8}`, pin: '222223' } });
  assert.equal(last.status, 429);
  assert.match(last.body.error, /this network/);
  // a different network is unaffected
  assert.equal((await t.call('POST', '/api/login', { ip: '8.8.8.8', body: { userId: 'u-1', pin: '480271' } })).status, 200);
});

test('sessions: me, logout, expiry of short sessions, disabled users', async () => {
  const t = setup();
  const token = await t.onboard('u-raza', 'Raza', '480271', 'owner');
  assert.equal((await t.call('GET', '/api/me', { token })).body.user.name, 'Raza');
  assert.equal((await t.call('GET', '/api/me', { token: 'forged' })).status, 401);

  const short = (await t.call('POST', '/api/login', { body: { userId: 'u-raza', pin: '480271', remember: false } })).body.token;
  t.advance(13 * 60 * MIN);
  assert.equal((await t.call('GET', '/api/me', { token: short })).status, 401, 'not-remembered session ends after 12h');
  assert.equal((await t.call('GET', '/api/me', { token })).status, 200, 'remembered session still valid');

  await t.call('POST', '/api/logout', { token });
  assert.equal((await t.call('GET', '/api/me', { token })).status, 401);

  const again = (await t.call('POST', '/api/login', { body: { userId: 'u-raza', pin: '480271' } })).body.token;
  await t.env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind('u-raza').run();
  assert.equal((await t.call('GET', '/api/me', { token: again })).status, 401);
});

test('PIN reset link signs out other devices', async () => {
  const t = setup();
  const oldToken = await t.onboard('u-ali', 'Ali', '480271');
  await t.addLink('u-ali', 'reset-1', { purpose: 'reset' });
  const res = await t.call('POST', '/api/setup', { body: { action: 'complete', token: 'reset-1', pin: '615283' } });
  assert.equal(res.status, 200);
  assert.equal((await t.call('GET', '/api/me', { token: oldToken })).status, 401);
  assert.equal((await t.call('GET', '/api/me', { token: res.body.token })).status, 200);
  assert.equal((await t.call('POST', '/api/login', { body: { userId: 'u-ali', pin: '480271' } })).status, 401, 'old PIN no longer works');
});

test('sync: first save, unchanged polling, stale writes conflict', async () => {
  const t = setup();
  const token = await t.onboard('u-raza', 'Raza', '480271', 'owner');
  let res = await t.call('GET', '/api/sync', { token });
  assert.equal(res.body.found, false);

  res = await t.call('POST', '/api/sync', { token, body: { schema: 3, baseRev: null, data: board('one') } });
  assert.equal(res.body.ok, true);
  const rev1 = res.body.rev;

  res = await t.call('GET', `/api/sync?rev=${rev1}`, { token });
  assert.deepEqual(res.body, { ok: true, found: true, unchanged: true, rev: rev1 });

  t.advance(1000);
  res = await t.call('POST', '/api/sync', { token, body: { schema: 3, baseRev: rev1, data: board('two') } });
  const rev2 = res.body.rev;
  assert.ok(rev2 > rev1);

  res = await t.call('POST', '/api/sync', { token, body: { schema: 3, baseRev: rev1, data: board('stale') } });
  assert.equal(res.body.conflict, true);
  assert.equal(res.body.rev, rev2);
  assert.equal(res.body.data.categories[0].tasks[0].text, 'two');

  // a device that never synced gets the cloud board back instead of overwriting it
  res = await t.call('POST', '/api/sync', { token, body: { schema: 3, baseRev: null, data: board('fresh device') } });
  assert.equal(res.body.conflict, true);

  // old pages and bad payloads are refused
  assert.equal((await t.call('POST', '/api/sync', { token, body: { baseRev: rev2, data: board('old page') } })).status, 409);
  assert.equal((await t.call('POST', '/api/sync', { token, body: { schema: 3, baseRev: rev2, data: {} } })).status, 400);

  // sendBeacon-style token in the body
  res = await t.call('POST', '/api/sync', { body: { schema: 3, baseRev: rev2, data: board('beacon'), token } });
  assert.equal(res.body.ok, true);
  assert.equal((await t.call('GET', '/api/sync')).status, 401);
});

test('isolation: nobody can read or overwrite another person’s board', async () => {
  const t = setup();
  const raza = await t.onboard('u-raza', 'Raza', '480271', 'owner');
  const ali = await t.onboard('u-ali', 'Ali', '615283');

  await t.call('POST', '/api/sync', { token: raza, body: { schema: 3, baseRev: null, data: board('Raza private task') } });
  let res = await t.call('GET', '/api/sync', { token: ali });
  assert.equal(res.body.found, false, 'Ali starts with a fresh board');

  res = await t.call('POST', '/api/sync', { token: ali, body: { schema: 3, baseRev: null, data: board('Ali task') } });
  assert.equal(res.body.ok, true);
  const razaBoard = (await t.call('GET', '/api/sync', { token: raza })).body.data;
  const aliBoard = (await t.call('GET', '/api/sync', { token: ali })).body.data;
  assert.equal(razaBoard.categories[0].tasks[0].text, 'Raza private task');
  assert.equal(aliBoard.categories[0].tasks[0].text, 'Ali task');

  // request fields can't redirect a save to someone else
  res = await t.call('POST', '/api/sync', { token: ali, body: { schema: 3, baseRev: null, userId: 'u-raza', data: board('hijack') } });
  assert.equal((await t.call('GET', '/api/sync', { token: raza })).body.data.categories[0].tasks[0].text, 'Raza private task');
});

test('digest: status for everyone, sending is owner-only for now', async () => {
  const t = setup();
  const raza = await t.onboard('u-raza', 'Raza', '480271', 'owner');
  const ali = await t.onboard('u-ali', 'Ali', '615283');
  assert.equal((await t.call('GET', '/api/digest?action=status')).status, 401);
  assert.deepEqual((await t.call('GET', '/api/digest?action=status', { token: ali })).body.channels, { telegram: false, email: false });
  assert.equal((await t.call('POST', '/api/digest', { token: ali, body: { action: 'send' } })).status, 403);
  const res = await t.call('POST', '/api/digest', { token: raza, body: { action: 'send' } });
  assert.equal(res.body.ok, false);
  assert.match(res.body.errors[0], /No delivery channel/);
  assert.match(res.body.preview, /Good morning/);
});

test('unknown routes and errors stay JSON', async () => {
  const t = setup();
  const res = await t.call('GET', '/api/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.ok, false);
});
