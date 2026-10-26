import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN, board, fakeTelegram, setup } from './harness.mjs';

const HOOK = { 'X-Telegram-Bot-Api-Secret-Token': 'test-hook-secret' };

// A team with an activated bot. Owner Raza, member Ali.
async function ready(t, options = {}) {
  const tg = fakeTelegram();
  t.after(() => tg.restore());
  const env = setup({ telegram: true, ...options });
  const owner = await env.onboard('u-raza', 'Raza Ahmed', '480271', 'owner');
  const ali = await env.onboard('u-ali', 'Ali Khan', '615283');
  const activated = await env.call('POST', '/api/notifications', { token: owner, body: { action: 'activate' } });
  assert.equal(activated.body.username, 'ZawishWorkboardBot');
  tg.clear();
  return { ...env, tg, owner, ali };
}

const update = (env, payload, headers = HOOK) => env.call('POST', '/api/telegram', { body: payload, headers });
const startMessage = (chatId, text, username = 'someone') => ({
  update_id: 1,
  message: { message_id: 1, text, chat: { id: chatId, type: 'private' }, from: { id: chatId, username } }
});

// Links `token`'s person to Telegram chat `chatId` the way a real tap on "Start" does.
async function link(env, token, chatId, username) {
  const res = await env.call('POST', '/api/notifications', { token, body: { action: 'link', timezone: 'Asia/Kolkata' } });
  const code = res.body.url.split('start=')[1];
  await update(env, startMessage(chatId, `/start ${code}`, username));
  return res.body.url;
}

test('activating the bot points Telegram at the webhook with the secret', async t => {
  const tg = fakeTelegram();
  t.after(() => tg.restore());
  const env = setup({ telegram: true });
  const owner = await env.onboard('u-raza', 'Raza', '480271', 'owner');
  await env.call('POST', '/api/notifications', { token: owner, body: { action: 'activate' } });
  const hook = tg.calls.find(c => c.method === 'setWebhook').payload;
  assert.equal(hook.url, 'https://board.test/api/telegram');
  assert.equal(hook.secret_token, 'test-hook-secret');
  assert.deepEqual(hook.allowed_updates, ['message', 'callback_query']);
  assert.equal((await env.call('GET', '/api/notifications', { token: owner })).body.botReady, true);
});

test('webhook refuses requests without the secret', async t => {
  const env = await ready(t);
  assert.equal((await update(env, startMessage(5, '/help'), {})).status, 401);
  assert.equal((await update(env, startMessage(5, '/help'), { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' })).status, 401);
  assert.equal(env.tg.sent().length, 0);
  assert.equal((await update(env, startMessage(5, '/help'))).status, 200);
  assert.match(env.tg.sent()[0].text, /ZAWISH Workboard bot/);
});

test('connecting: one-time link, confirmation, single use, expiry, one chat per person', async t => {
  const env = await ready(t);
  const url = await link(env, env.ali, 777, 'alikhan');
  assert.match(url, /^https:\/\/t\.me\/ZawishWorkboardBot\?start=[\w-]{32}$/);
  assert.match(env.tg.sent().at(-1).text, /Connected to ZAWISH Workboard as Ali Khan/);
  let status = (await env.call('GET', '/api/notifications', { token: env.ali })).body;
  assert.equal(status.connected, true);
  assert.equal(status.telegramName, '@alikhan');
  assert.equal(status.settings.timezone, 'Asia/Kolkata');

  // the same code can't be used again
  const code = url.split('start=')[1];
  await update(env, startMessage(888, `/start ${code}`));
  assert.match(env.tg.sent().at(-1).text, /expired/);

  // links expire after 15 minutes
  const fresh = await env.call('POST', '/api/notifications', { token: env.owner, body: { action: 'link' } });
  env.advance(16 * MIN);
  await update(env, startMessage(500, `/start ${fresh.body.url.split('start=')[1]}`));
  assert.equal((await env.call('GET', '/api/notifications', { token: env.owner })).body.connected, false);

  // if the same Telegram chat links another profile, it moves there
  await link(env, env.owner, 777, 'alikhan');
  assert.equal((await env.call('GET', '/api/notifications', { token: env.ali })).body.connected, false);
  assert.equal((await env.call('GET', '/api/notifications', { token: env.owner })).body.connected, true);

  // /stop disconnects
  await update(env, startMessage(777, '/stop'));
  assert.equal((await env.call('GET', '/api/notifications', { token: env.owner })).body.connected, false);
});

test('join request pings the owner with buttons; only the owner can press them', async t => {
  const env = await ready(t);
  await link(env, env.owner, 500, 'raza');
  env.tg.clear();

  const req = await env.call('POST', '/api/request', { body: { name: 'Priya Shah', note: 'Motion designer', pin: '615283' } });
  const ping = env.tg.sent()[0];
  assert.equal(ping.chat_id, '500');
  assert.match(ping.text, /Priya Shah wants to join ZAWISH Workboard\n“Motion designer”/);
  const [approve, reject] = ping.reply_markup.inline_keyboard[0];
  assert.equal(approve.callback_data, `ap:${req.body.user.id}`);
  assert.equal(reject.callback_data, `rj:${req.body.user.id}`);
  assert.ok(Buffer.byteLength(approve.callback_data) <= 64);

  const press = (fromId, data) => update(env, {
    update_id: 2,
    callback_query: { id: 'cb1', data, from: { id: fromId }, message: { message_id: 101, text: ping.text, chat: { id: 500 } } }
  });

  // someone else (e.g. a forwarded message) can't approve
  await press(999, approve.callback_data);
  assert.match(env.tg.calls.at(-1).payload.text, /Only the owner/);
  assert.equal((await env.call('GET', '/api/request', { token: req.body.token })).body.status, 'pending');

  await press(500, approve.callback_data);
  assert.equal((await env.call('GET', '/api/request', { token: req.body.token })).body.status, 'approved');
  const edit = env.tg.calls.find(c => c.method === 'editMessageText').payload;
  assert.match(edit.text, /✅ You approved Priya Shah/);
  assert.equal(edit.reply_markup, undefined, 'buttons removed');

  // pressing again: already handled
  await press(500, reject.callback_data);
  assert.match(env.tg.calls.filter(c => c.method === 'editMessageText').at(-1).payload.text, /already handled/);
});

test('reject from Telegram, and pings for invites used and accounts deleted', async t => {
  const env = await ready(t);
  await link(env, env.owner, 500, 'raza');
  const req = await env.call('POST', '/api/request', { body: { name: 'Sam', pin: '615283' } });
  await update(env, { update_id: 3, callback_query: { id: 'cb', data: `rj:${req.body.user.id}`, from: { id: 500 }, message: { message_id: 1, text: 'x', chat: { id: 500 } } } });
  assert.equal((await env.call('GET', '/api/request', { token: req.body.token })).body.status, 'rejected');

  env.tg.clear();
  const invite = await env.call('POST', '/api/team', { token: env.owner, body: { action: 'add', name: 'Omar Farooq' } });
  await env.call('POST', '/api/setup', { body: { action: 'complete', token: invite.body.token, pin: '729184' } });
  assert.match(env.tg.sent().at(-1).text, /Omar Farooq joined ZAWISH Workboard using your invite/);

  await env.call('POST', '/api/me/delete', { token: env.ali, body: { pin: '615283' } });
  assert.match(env.tg.sent().at(-1).text, /Ali Khan deleted their ZAWISH Workboard account/);
});

test('morning digest: local time, once a day, chosen days, counts-only, skip empty, blocked bot', async t => {
  const env = await ready(t, { start: '2026-10-25T08:00:00Z' });
  await link(env, env.ali, 777, 'alikhan');
  await env.call('POST', '/api/sync', { token: env.ali, body: { schema: 3, baseRev: null, data: { version: 3, categories: [{ id: 'c', name: 'Hudood', tasks: [{ id: 't', text: 'Send invoice', status: 'NTS', due: '2026-10-20' }] }] } } });
  const digestsTo = chat => env.tg.sent().filter(m => m.chat_id === chat && /Good morning/.test(m.text));

  // Monday 26 Oct: 07:50 IST is too early, 08:00 IST sends, 08:15 doesn't repeat
  env.setNow('2026-10-26T02:20:00Z');
  await env.runSchedule();
  assert.equal(digestsTo('777').length, 0);
  env.setNow('2026-10-26T02:30:00Z');
  await env.runSchedule();
  const [first] = digestsTo('777');
  assert.match(first.text, /Good morning, Ali! Mon 26 Oct/);
  assert.match(first.text, /Send invoice — Hudood \(6d overdue\)/);
  assert.equal(first.reply_markup.inline_keyboard[0][0].url, 'https://board.zawish.si');
  env.setNow('2026-10-26T02:45:00Z');
  await env.runSchedule();
  assert.equal(digestsTo('777').length, 1);

  // counts only: no task names
  await env.call('POST', '/api/notifications', { token: env.ali, body: { action: 'save', enabled: true, time: '08:00', days: 'mon-sat', mode: 'counts', skipEmpty: false } });
  env.setNow('2026-10-27T02:30:00Z');
  await env.runSchedule();
  const counts = digestsTo('777').at(-1);
  assert.match(counts.text, /🔴 1 overdue/);
  assert.doesNotMatch(counts.text, /Send invoice/);

  // Sunday is off with Mon–Sat
  env.setNow('2026-11-01T02:30:00Z');
  await env.runSchedule();
  assert.equal(digestsTo('777').length, 2);

  // more than two hours late: skipped for the day (e.g. turned on in the evening)
  await env.call('POST', '/api/notifications', { token: env.ali, body: { action: 'save', enabled: true, time: '08:00', days: 'daily', mode: 'full', skipEmpty: false } });
  env.setNow('2026-11-01T08:30:00Z'); // 14:00 IST
  await env.runSchedule();
  assert.equal(digestsTo('777').length, 2);

  // skip-empty: Raza has nothing due, so no message
  await link(env, env.owner, 500, 'raza');
  await env.call('POST', '/api/notifications', { token: env.owner, body: { action: 'save', enabled: true, time: '08:00', days: 'daily', mode: 'full', skipEmpty: true, timezone: 'Asia/Kolkata' } });
  env.setNow('2026-11-02T02:30:00Z');
  await env.runSchedule();
  assert.equal(digestsTo('500').length, 0);
  assert.equal(digestsTo('777').length, 3);

  // blocked the bot: Telegram answers 403, the link is removed
  env.tg.failNext('sendMessage', 403);
  env.setNow('2026-11-03T02:30:00Z');
  await env.runSchedule();
  assert.equal((await env.call('GET', '/api/notifications', { token: env.ali })).body.connected, false);
});

test('send a test digest now', async t => {
  const env = await ready(t);
  assert.equal((await env.call('POST', '/api/notifications', { token: env.ali, body: { action: 'test' } })).status, 400, 'not connected yet');
  await link(env, env.ali, 777, 'alikhan');
  env.tg.clear();
  assert.equal((await env.call('POST', '/api/notifications', { token: env.ali, body: { action: 'test' } })).body.ok, true);
  assert.match(env.tg.sent()[0].text, /Good morning, Ali!/);
});

test('your data: export, devices, sign out others, delete with PIN', async t => {
  const env = await ready(t);
  await env.call('POST', '/api/sync', { token: env.ali, body: { schema: 3, baseRev: null, data: board('Ali task') } });
  const second = (await env.call('POST', '/api/login', { body: { userId: 'u-ali', pin: '615283' } })).body.token;

  const exported = (await env.call('GET', '/api/me/export', { token: env.ali })).body;
  assert.equal(exported.profile.name, 'Ali Khan');
  assert.equal(exported.board.data.categories[0].tasks[0].text, 'Ali task');
  assert.equal(exported.devices.length, 2);
  assert.doesNotMatch(JSON.stringify(exported), /pin_hash|pin_salt|token_hash|test-pepper/);

  const devices = (await env.call('GET', '/api/me/devices', { token: env.ali })).body.devices;
  assert.equal(devices.filter(d => d.current).length, 1);
  assert.equal((await env.call('POST', '/api/me/devices', { token: env.ali })).body.signedOut, 1);
  assert.equal((await env.call('GET', '/api/me', { token: second })).status, 401);
  assert.equal((await env.call('GET', '/api/me', { token: env.ali })).status, 200);

  // wrong PIN: nothing deleted; owner can't delete
  assert.equal((await env.call('POST', '/api/me/delete', { token: env.ali, body: { pin: '111112' } })).status, 401);
  assert.equal((await env.call('GET', '/api/me', { token: env.ali })).status, 200);
  assert.equal((await env.call('POST', '/api/me/delete', { token: env.owner, body: { pin: '480271' } })).status, 400);

  assert.equal((await env.call('POST', '/api/me/delete', { token: env.ali, body: { pin: '615283' } })).body.ok, true);
  assert.equal((await env.call('GET', '/api/me', { token: env.ali })).status, 401);
  const left = await env.env.DB.prepare("SELECT (SELECT COUNT(*) FROM users WHERE id = 'u-ali') AS users, (SELECT COUNT(*) FROM boards WHERE user_id = 'u-ali') AS boards").first();
  assert.deepEqual(left, { users: 0, boards: 0 });
});
