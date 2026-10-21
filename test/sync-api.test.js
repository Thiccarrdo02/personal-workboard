const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-test-'));
process.env.WORKBOARD_SKIP_ENV_FILE = '1';
process.env.STORAGE_BACKEND = 'file';
process.env.STORAGE_FILE = path.join(tmp, 'board.json');
process.env.APP_PASSWORD = '1357';
process.env.AUTH_SECRET = 'test-secret';

const { generateToken } = require('../lib/auth');
const syncHandler = require('../api/sync');
const digestHandler = require('../api/digest');

async function call(handler, { method = 'GET', body, token = generateToken(), query = {} } = {}) {
  const req = { method, body, query, headers: token ? { authorization: `Bearer ${token}` } : {} };
  return new Promise(resolve => {
    const res = {
      statusCode: 200,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); }
    };
    handler(req, res);
  });
}

const board = text => ({ version: 3, categories: [{ id: 'c', name: 'C', tasks: [{ id: 't', text, status: 'NTS' }] }] });

test('sync API: auth, CAS writes and legacy clients', async () => {
  assert.equal((await call(syncHandler, { token: 'nope' })).status, 401);

  let res = await call(syncHandler);
  assert.equal(res.body.found, false);

  // first write on an empty store
  res = await call(syncHandler, { method: 'POST', body: { schema: 3, baseRev: null, data: board('one') } });
  assert.equal(res.body.ok, true);
  const rev1 = res.body.rev;

  // write based on the latest revision succeeds
  res = await call(syncHandler, { method: 'POST', body: { schema: 3, baseRev: rev1, data: board('two') } });
  assert.equal(res.body.ok, true);
  const rev2 = res.body.rev;
  assert.ok(rev2 > rev1);

  // stale write is rejected with the latest board
  res = await call(syncHandler, { method: 'POST', body: { schema: 3, baseRev: rev1, data: board('stale') } });
  assert.equal(res.body.conflict, true);
  assert.equal(res.body.rev, rev2);
  assert.equal(res.body.data.categories[0].tasks[0].text, 'two');

  // old cached pages (no schema) can never overwrite
  res = await call(syncHandler, { method: 'POST', body: { updatedAt: Date.now() + 1e9, data: board('legacy') } });
  assert.equal(res.body.conflict, true);

  // beacon-style token in the body works; query-string tokens do not
  res = await call(syncHandler, { method: 'POST', token: null, body: { schema: 3, baseRev: rev2, data: board('beacon'), token: generateToken() } });
  assert.equal(res.body.ok, true);
  assert.equal((await call(syncHandler, { token: null, query: { token: generateToken() } })).status, 401);

  res = await call(syncHandler);
  assert.equal(res.body.data.categories[0].tasks[0].text, 'beacon');
});

test('digest API: status and unconfigured send', async () => {
  assert.equal((await call(digestHandler, { token: 'nope' })).status, 401);
  let res = await call(digestHandler, { query: { action: 'status' } });
  assert.deepEqual(res.body.channels, { telegram: false, email: false });
  res = await call(digestHandler, { method: 'POST', body: { action: 'send' } });
  assert.equal(res.body.ok, false);
  assert.match(res.body.errors[0], /No delivery channel/);
  assert.match(res.body.preview, /Good morning/);
});
