import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN, board, setup } from './harness.mjs';

const DAY = 24 * 60 * MIN;

async function withOwner() {
  const t = setup();
  const owner = await t.onboard('u-raza', 'Raza Ahmed', '480271', 'owner');
  return { ...t, owner };
}

test('request access: waits for approval, then the same device gets in', async () => {
  const t = await withOwner();
  let res = await t.call('POST', '/api/request', { body: { name: 'Ali Khan', note: 'Video editor', pin: '615283' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.owner, 'Raza');
  const waiting = res.body.token;
  const aliId = res.body.user.id;

  // not on the picker, can't log in, can't touch boards while waiting
  assert.deepEqual((await t.call('GET', '/api/profiles')).body.profiles.map(p => p.name), ['Raza Ahmed']);
  assert.equal((await t.call('POST', '/api/login', { body: { userId: aliId, pin: '615283' } })).status, 401);
  assert.equal((await t.call('GET', '/api/sync', { token: waiting })).status, 401);
  assert.equal((await t.call('GET', '/api/request', { token: waiting })).body.status, 'pending');

  // the owner sees the request (with the note) and a badge count while polling
  const team = (await t.call('GET', '/api/team', { token: t.owner })).body;
  assert.deepEqual(team.requests.map(r => [r.name, r.note]), [['Ali Khan', 'Video editor']]);
  assert.equal((await t.call('GET', '/api/sync', { token: t.owner })).body.teamPending, 1);

  res = await t.call('POST', '/api/team', { token: t.owner, body: { action: 'approve', userId: aliId } });
  assert.equal(res.body.ok, true);

  res = await t.call('GET', '/api/request', { token: waiting });
  assert.equal(res.body.status, 'approved');
  assert.equal(res.body.user.name, 'Ali Khan');
  // the waiting token is now a normal session, with a fresh board
  assert.equal((await t.call('GET', '/api/sync', { token: waiting })).body.found, false);
  assert.equal((await t.call('POST', '/api/sync', { token: waiting, body: { schema: 3, baseRev: null, data: board('Ali task') } })).body.ok, true);
  // and the PIN chosen in the request works on other devices
  assert.equal((await t.call('POST', '/api/login', { body: { userId: aliId, pin: '615283' } })).status, 200);
  assert.equal((await t.call('GET', '/api/sync', { token: t.owner })).body.teamPending, 0);
});

test('request access: reject removes it; checks names, PINs and limits', async () => {
  const t = await withOwner();
  assert.equal((await t.call('POST', '/api/request', { body: { name: 'A', pin: '615283' } })).status, 400, 'name too short');
  assert.equal((await t.call('POST', '/api/request', { ip: '2.2.2.2', body: { name: 'Sara', pin: '123456' } })).status, 400, 'weak PIN');
  assert.equal((await t.call('POST', '/api/request', { ip: '2.2.2.2', body: { name: 'raza ahmed', pin: '615283' } })).status, 409, 'name taken');

  // 3 requests per network per day: the two refused ones above count too.
  const sara = await t.call('POST', '/api/request', { ip: '2.2.2.2', body: { name: 'Sara', pin: '615283' } });
  assert.equal(sara.status, 200);
  const blocked = await t.call('POST', '/api/request', { ip: '2.2.2.2', body: { name: 'Sam', pin: '615283' } });
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /network today/);

  await t.call('POST', '/api/team', { token: t.owner, body: { action: 'reject', userId: sara.body.user.id } });
  assert.equal((await t.call('GET', '/api/request', { token: sara.body.token })).body.status, 'rejected');
  assert.equal((await t.call('GET', '/api/team', { token: t.owner })).body.requests.length, 0);
  assert.equal((await t.call('POST', '/api/team', { token: t.owner, body: { action: 'approve', userId: sara.body.user.id } })).status, 404);
});

test('request access: at most 10 waiting, and requests expire after a week', async () => {
  const t = await withOwner();
  for (let i = 0; i < 10; i++) {
    const res = await t.call('POST', '/api/request', { ip: `10.0.0.${i}`, body: { name: `Person ${i}`, pin: '615283' } });
    assert.equal(res.status, 200);
  }
  const full = await t.call('POST', '/api/request', { ip: '10.0.1.1', body: { name: 'One more', pin: '615283' } });
  assert.equal(full.status, 429);
  assert.match(full.body.error, /message Raza directly/);

  t.advance(8 * DAY);
  assert.equal((await t.call('GET', '/api/team', { token: t.owner })).body.requests.length, 0);
  assert.equal((await t.call('POST', '/api/request', { ip: '10.0.1.1', body: { name: 'One more', pin: '615283' } })).status, 200);
});

test('add member: invite link, setup, shows on the picker', async () => {
  const t = await withOwner();
  const res = await t.call('POST', '/api/team', { token: t.owner, body: { action: 'add', name: 'Zara Malik' } });
  assert.equal(res.body.purpose, 'setup');
  assert.equal(res.body.expiresAt - Date.parse('2026-10-23T08:00:00Z'), 3 * DAY);
  assert.deepEqual((await t.call('GET', '/api/profiles')).body.profiles.map(p => [p.name, p.hasPin]), [['Raza Ahmed', true], ['Zara Malik', false]]);
  assert.equal((await t.call('POST', '/api/team', { token: t.owner, body: { action: 'add', name: 'zara malik' } })).status, 409);

  // a newer link replaces the older one
  const second = await t.call('POST', '/api/team', { token: t.owner, body: { action: 'link', userId: res.body.user.id } });
  assert.equal((await t.call('POST', '/api/setup', { body: { token: res.body.token } })).status, 404);
  const done = await t.call('POST', '/api/setup', { body: { action: 'complete', token: second.body.token, pin: '615283' } });
  assert.equal(done.status, 200);
  assert.equal(done.body.user.name, 'Zara Malik');

  // now a link for her is a PIN reset
  assert.equal((await t.call('POST', '/api/team', { token: t.owner, body: { action: 'link', userId: res.body.user.id } })).body.purpose, 'reset');
});

test('team list never includes boards or PIN data; members can’t use admin', async () => {
  const t = await withOwner();
  const ali = await t.onboard('u-ali', 'Ali', '615283');
  await t.call('POST', '/api/sync', { token: ali, body: { schema: 3, baseRev: null, data: board('Ali secret task') } });

  const team = await t.call('GET', '/api/team', { token: t.owner });
  const text = JSON.stringify(team.body);
  assert.ok(!text.includes('Ali secret task'));
  assert.ok(!/pin_hash|pin_salt|pinHash/.test(text));
  assert.deepEqual(Object.keys(team.body.members[1]).sort(), ['hasPin', 'id', 'joinedAt', 'lastActiveAt', 'locked', 'name', 'role']);

  assert.equal((await t.call('GET', '/api/team', { token: ali })).status, 403);
  assert.equal((await t.call('POST', '/api/team', { token: ali, body: { action: 'add', name: 'Sneaky' } })).status, 403);
  assert.equal((await t.call('GET', '/api/sync', { token: ali })).body.teamPending, undefined);
});

test('rename and remove', async () => {
  const t = await withOwner();
  const ali = await t.onboard('u-ali', 'Ali', '615283');
  await t.call('POST', '/api/sync', { token: ali, body: { schema: 3, baseRev: null, data: board('x') } });

  assert.equal((await t.call('POST', '/api/team', { token: t.owner, body: { action: 'rename', userId: 'u-ali', name: 'Ali Khan' } })).body.ok, true);
  assert.equal((await t.call('POST', '/api/team', { token: t.owner, body: { action: 'rename', userId: 'u-ali', name: 'Raza Ahmed' } })).status, 409);
  assert.equal((await t.call('GET', '/api/me', { token: ali })).body.user.name, 'Ali Khan');

  assert.equal((await t.call('POST', '/api/team', { token: t.owner, body: { action: 'remove', userId: 'u-raza' } })).status, 400, 'owner stays');
  assert.equal((await t.call('POST', '/api/team', { token: t.owner, body: { action: 'remove', userId: 'u-ali' } })).body.ok, true);
  assert.equal((await t.call('GET', '/api/me', { token: ali })).status, 401, 'signed out everywhere');
  const left = await t.env.DB.prepare("SELECT (SELECT COUNT(*) FROM boards WHERE user_id = 'u-ali') AS boards, (SELECT COUNT(*) FROM sessions WHERE user_id = 'u-ali') AS sessions").first();
  assert.deepEqual(left, { boards: 0, sessions: 0 });
});
