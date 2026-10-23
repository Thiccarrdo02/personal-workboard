// Admin tasks for ZAWISH Workboard, run against the local or the live D1 database.
//
//   node scripts/admin.mjs setup-link --name Raza --role owner [--remote]
//       Creates the person if needed and a one-time link (24h) to choose their PIN.
//       The link is written to .data/setup-link.txt (and printed for --local).
//
//   node scripts/admin.mjs import-gist --name Raza --gist <gistId> [--remote]
//       Copies a board from the old GitHub Gist storage into that person's board.
//
// Local runs need `npm run db:local` first; --remote needs `npx wrangler login`.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, '.data');
const wranglerBin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const DATABASE = 'zawish-workboard';

const [command, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith('--')) continue;
  const key = rest[i].slice(2);
  flags[key] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
}
const remote = Boolean(flags.remote);
const baseUrl = flags.url || (remote ? 'https://board.zawish.si' : 'http://localhost:8787');

const sql = value => (value == null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replace(/'/g, "''")}'`);

function wrangler(args) {
  const result = spawnSync(process.execPath, [wranglerBin, 'd1', 'execute', DATABASE, remote ? '--remote' : '--local', '--json', ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(`wrangler failed:\n${result.stderr || result.stdout}`);
  // Progress lines come first; the JSON array starts on its own line.
  const json = JSON.parse(result.stdout.slice(result.stdout.search(/^\[/m)));
  return json.flatMap(entry => entry.results || []);
}

// Reads go through --command: against the live database a --file run only
// returns summary stats, not rows.
function query(statement) {
  return wrangler(['--command', statement]);
}

// Writes go through a temporary file (board JSON is too long for a command line).
function runSql(statements) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, `admin-${process.pid}.sql`);
  writeFileSync(file, statements.join(';\n') + ';\n');
  try {
    wrangler(['--file', file]);
  } finally {
    rmSync(file, { force: true });
  }
}

function findUser(name) {
  return query(`SELECT id, name, role, pin_hash IS NOT NULL AS has_pin FROM users WHERE name = ${sql(name)} COLLATE NOCASE`)[0] || null;
}

function setupLink() {
  const name = String(flags.name || '').trim();
  const role = flags.role === 'owner' ? 'owner' : 'member';
  if (!name) throw new Error('Pass --name');
  const now = Date.now();
  let user = findUser(name);
  if (!user) {
    const id = `u_${randomUUID()}`;
    runSql([`INSERT INTO users (id, name, role, status, created_at, approved_at) VALUES (${sql(id)}, ${sql(name)}, ${sql(role)}, 'active', ${now}, ${now})`]);
    user = { id, name, role, has_pin: 0 };
    console.log(`Created ${role} “${name}” (${id}).`);
  }
  const token = randomBytes(32).toString('base64url');
  const purpose = user.has_pin ? 'reset' : 'setup';
  runSql([`INSERT INTO invites (token_hash, purpose, user_id, created_at, expires_at) VALUES (${sql(createHash('sha256').update(token).digest('hex'))}, ${sql(purpose)}, ${sql(user.id)}, ${now}, ${now + 24 * 3600 * 1000})`]);
  const link = `${baseUrl}/#setup=${token}`;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'setup-link.txt'), `${link}\n`);
  console.log(`One-time ${purpose === 'reset' ? 'PIN reset' : 'setup'} link for ${user.name} (valid 24h) saved to .data/setup-link.txt`);
  if (!remote) console.log(link);
}

async function importGist() {
  const name = String(flags.name || '').trim();
  const gistId = String(flags.gist || '').trim();
  if (!name || !gistId) throw new Error('Pass --name and --gist');
  const user = findUser(name);
  if (!user) throw new Error(`No person called ${name}. Run setup-link first.`);

  const res = await fetch(`https://api.github.com/gists/${gistId}`, { headers: { 'User-Agent': 'zawish-workboard-import', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const gist = await res.json();
  const file = gist.files && gist.files['workboard.json'];
  if (!file) throw new Error('No workboard.json in that gist');
  const content = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  const record = JSON.parse(content);
  if (!record.data || !Array.isArray(record.data.categories)) throw new Error('Gist has no board data');

  const now = Date.now();
  const text = JSON.stringify(record.data);
  runSql([
    `INSERT INTO boards (user_id, rev, data, updated_at) VALUES (${sql(user.id)}, ${now}, ${sql(text)}, ${now})
       ON CONFLICT(user_id) DO UPDATE SET rev = excluded.rev, data = excluded.data, updated_at = excluded.updated_at`
  ]);
  const tasks = record.data.categories.reduce((n, c) => n + (Array.isArray(c.tasks) ? c.tasks.length : 0), 0);
  console.log(`Imported ${record.data.categories.length} categories / ${tasks} tasks into ${user.name}'s board (gist saved ${new Date(Number(record.updatedAt)).toISOString()}).`);
}

try {
  if (command === 'setup-link') setupLink();
  else if (command === 'import-gist') await importGist();
  else {
    console.log('Usage: node scripts/admin.mjs setup-link|import-gist --name <Name> [--role owner] [--gist <id>] [--remote]');
    process.exit(1);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
