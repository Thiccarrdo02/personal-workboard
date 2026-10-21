// Board storage: a GitHub Gist in production, a local JSON file for development
// (STORAGE_BACKEND=file, or whenever no GITHUB_TOKEN is configured).

require('./env');
const fs = require('fs');
const path = require('path');

const GIST_ID = process.env.GIST_ID || '9fd65dc7c2868aa0bea7bef586fc4454';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const BACKEND = process.env.STORAGE_BACKEND === 'file' || !GITHUB_TOKEN ? 'file' : 'gist';
const DATA_FILE = process.env.STORAGE_FILE || path.join(__dirname, '..', '.data', 'workboard.json');

let inMemoryCache = null;
let lastCacheFetchTime = 0;
const CACHE_TTL_MS = 1500; // short cache for polling reads; writes always read fresh

function githubHeaders(extra = {}) {
  return {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'User-Agent': 'Workboard-Sync-App',
    'Accept': 'application/vnd.github.v3+json',
    ...extra
  };
}

async function readGist() {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: githubHeaders() });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub Gist read error (${res.status}): ${errText}`);
  }

  const gist = await res.json();
  const file = gist.files && gist.files['workboard.json'];
  if (!file) return null;

  // The Gist API truncates large files; fetch the raw file in that case.
  let content = file.content;
  if (file.truncated && file.raw_url) {
    const raw = await fetch(file.raw_url, { headers: { 'Authorization': `token ${GITHUB_TOKEN}` } });
    if (!raw.ok) throw new Error(`GitHub Gist raw read error (${raw.status})`);
    content = await raw.text();
  }
  if (!content) return null;

  try {
    return JSON.parse(content);
  } catch (e) {
    console.error('Failed to parse Gist content:', e);
    return null;
  }
}

async function writeGist(record) {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: githubHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      description: 'Personal Workboard Sync Data',
      files: {
        'workboard.json': {
          content: JSON.stringify(record, null, 2)
        }
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub Gist update error (${res.status}): ${errText}`);
  }
}

async function readFile() {
  try {
    return JSON.parse(await fs.promises.readFile(DATA_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeFile(record) {
  await fs.promises.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(record, null, 2));
  await fs.promises.rename(tmp, DATA_FILE);
}

async function readBoard({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && inMemoryCache && now - lastCacheFetchTime < CACHE_TTL_MS) {
    return inMemoryCache;
  }
  const record = BACKEND === 'gist' ? await readGist() : await readFile();
  inMemoryCache = record;
  lastCacheFetchTime = now;
  return record;
}

async function writeBoard(record) {
  if (BACKEND === 'gist') await writeGist(record);
  else await writeFile(record);
  inMemoryCache = record;
  lastCacheFetchTime = Date.now();
}

module.exports = {
  backend: BACKEND,
  readBoard,
  writeBoard
};
