/* My Workboard — state, persistence, undo, actions and cloud sync. */

const Core = window.WorkboardCore;

const STORAGE_KEY = 'personal-workboard-v3';
const LEGACY_STORAGE_KEYS = ['personal-workboard-v2', 'personal-workboard-v1'];
const LEGACY_TIMESTAMP_KEY = 'personal-workboard-updated-at';
const LEGACY_DIRTY_KEY = 'personal-workboard-dirty';
const SYNC_META_KEY = 'personal-workboard-sync';
const AUTH_TOKEN_STORAGE = 'personal-workboard-auth-token';
const PREFS_KEY = 'personal-workboard-prefs';
const SYNC_POLL_MS = 8000;

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn(`Could not save ${key}:`, e);
  }
}

// Per-device preferences (not synced).
const prefs = Object.assign(
  { view: 'board', theme: 'auto', hideDone: false, collapsed: {}, lastCategoryId: null, upcomingOpen: false },
  readJSON(PREFS_KEY, {})
);

function savePrefs() {
  writeJSON(PREFS_KEY, prefs);
}

let authToken = localStorage.getItem(AUTH_TOKEN_STORAGE) || '';
const syncMeta = Object.assign({ baseRev: null, dirty: false, lastSyncedAt: 0 }, readJSON(SYNC_META_KEY, {}));

function saveSyncMeta() {
  writeJSON(SYNC_META_KEY, syncMeta);
}

function persistData() {
  writeJSON(STORAGE_KEY, data);
}

function starterData() {
  return Core.normalizeData({
    version: Core.SCHEMA,
    categories: [{ id: 'inbox', name: 'Inbox', color: 'ink', order: 0, updatedAt: 0, tasks: [] }]
  });
}

function loadData() {
  const current = readJSON(STORAGE_KEY, null);
  if (current) return Core.normalizeData(current);

  // First run of v3 on this device: migrate the v2 board. If it had unsynced
  // edits, stamp them with the old save time so they win over the cloud copy.
  for (const key of LEGACY_STORAGE_KEYS) {
    const legacy = readJSON(key, null);
    if (!legacy) continue;
    const dirty = localStorage.getItem(LEGACY_DIRTY_KEY) === 'true';
    const legacyUpdatedAt = dirty ? (parseInt(localStorage.getItem(LEGACY_TIMESTAMP_KEY), 10) || Date.now()) : 0;
    const migrated = Core.normalizeData(legacy, { legacyUpdatedAt });
    syncMeta.dirty = dirty;
    syncMeta.baseRev = null;
    saveSyncMeta();
    writeJSON(STORAGE_KEY, migrated);
    return migrated;
  }
  return starterData();
}

let data = loadData();

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function findTask(taskId, board = data) {
  for (const category of board.categories) {
    const index = category.tasks.findIndex(task => task.id === taskId);
    if (index !== -1) return { task: category.tasks[index], category, index };
  }
  return null;
}

function findCategory(categoryId, board = data) {
  return board.categories.find(category => category.id === categoryId) || null;
}

function todayStr() {
  return Core.localDay();
}

function deviceTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch (e) {
    return null;
  }
}

function deviceDateOrder() {
  try {
    const parts = new Intl.DateTimeFormat().formatToParts(new Date(2020, 11, 31));
    const types = parts.map(part => part.type).filter(type => type === 'day' || type === 'month');
    return types[0] === 'month' ? 'MDY' : 'DMY';
  } catch (e) {
    return 'DMY';
  }
}

function truncate(text, max = 38) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// Commits and undo
// ---------------------------------------------------------------------------

const undoStack = [];
let lastStamp = 0;

function stampNow() {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

/**
 * Applies `mutator` to the board, then works out what changed (for sync),
 * saves locally and schedules an upload. Returns false for no-op edits.
 * `undoLabel` (string or function) shows an Undo toast.
 */
function commit(mutator, { undoLabel = null, render = true } = {}) {
  const before = Core.clone(data);
  if (mutator(data) === false) return false;
  const changed = Core.stampChanges(before, data, stampNow());
  if (!changed) return false;

  persistData();
  markDirty();
  if (undoLabel) {
    undoStack.push({ snapshot: before });
    if (undoStack.length > 30) undoStack.shift();
    const label = typeof undoLabel === 'function' ? undoLabel() : undoLabel;
    showToast(label, { actionLabel: 'Undo', onAction: undo });
  }
  if (render) requestRender();
  return true;
}

function undo() {
  const entry = undoStack.pop();
  if (!entry) {
    showToast('Nothing to undo');
    return;
  }
  commit(board => {
    const snapshot = Core.clone(entry.snapshot);
    board.categories = snapshot.categories;
  });
  refreshOpenDetails();
  showToast('Undone');
}

// ---------------------------------------------------------------------------
// Task actions
// ---------------------------------------------------------------------------

function addTask(categoryId, fields = {}) {
  let created = null;
  commit(board => {
    const category = findCategory(categoryId, board) || board.categories[0];
    if (!category) return false;
    const last = category.tasks[category.tasks.length - 1];
    created = Core.makeTask({ ...fields, order: last ? last.order + 1 : 0 });
    category.tasks.push(created);
    prefs.lastCategoryId = category.id;
    savePrefs();
  });
  return created;
}

function updateTask(taskId, mutator, options = {}) {
  return commit(board => {
    const found = findTask(taskId, board);
    if (!found) return false;
    return mutator(found.task, found.category, board);
  }, options);
}

function setStatus(taskId, status, { toast = true } = {}) {
  const found = findTask(taskId);
  if (!found || found.task.status === status) return;
  let spawned = null;
  const text = found.task.text;
  commit(board => {
    const { task, category, index } = findTask(taskId, board);
    const now = Date.now();
    Core.applyStatus(task, status, now);
    if (status === 'DONE' && task.repeat) {
      spawned = Core.spawnNextOccurrence(task, todayStr(), now);
      const next = category.tasks[index + 1];
      spawned.order = Core.orderBetween(task.order, next && next.order);
      category.tasks.splice(index + 1, 0, spawned);
      task.repeat = null; // the completed copy no longer repeats
    }
  }, {
    undoLabel: toast ? () => (spawned
      ? `Done · next one due ${Core.formatDay(spawned.due)}`
      : `${Core.STATUS_LABELS[status]}: ${truncate(text)}`) : null
  });
}

function cycleStatus(taskId) {
  const found = findTask(taskId);
  if (found) setStatus(taskId, Core.NEXT_STATUS[found.task.status]);
}

function toggleWaiting(taskId) {
  const found = findTask(taskId);
  if (found) setStatus(taskId, found.task.status === 'WAIT' ? 'WIP' : 'WAIT');
}

function toggleUrgent(taskId) {
  const found = findTask(taskId);
  if (!found) return;
  const next = !found.task.urgent;
  updateTask(taskId, task => { task.urgent = next; }, { undoLabel: next ? 'Marked urgent' : 'Urgent removed' });
}

function deleteTask(taskId) {
  const found = findTask(taskId);
  if (!found) return;
  const text = found.task.text;
  commit(board => {
    const { category, index } = findTask(taskId, board);
    category.tasks.splice(index, 1);
  }, { undoLabel: `Deleted “${truncate(text)}”` });
}

// Keeps array order and `order` keys consistent after inserting at `index`.
function placeInList(list, index) {
  const prev = list[index - 1];
  const next = list[index + 1];
  const order = Core.orderBetween(prev && prev.order, next && next.order);
  if (prev && next && !(order > prev.order && order < next.order)) {
    list.forEach((item, i) => { item.order = i; }); // gap exhausted: renumber
  } else {
    list[index].order = order;
  }
}

function moveTaskToPosition(taskId, targetCategoryId, targetTaskId, placeBefore = true) {
  const found = findTask(taskId);
  const target = findCategory(targetCategoryId);
  if (!found || !target || taskId === targetTaskId) return;
  const moved = commit(board => {
    const source = findTask(taskId, board);
    const destination = findCategory(targetCategoryId, board);
    const [task] = source.category.tasks.splice(source.index, 1);
    let index = destination.tasks.length;
    if (targetTaskId) {
      const targetIndex = destination.tasks.findIndex(t => t.id === targetTaskId);
      if (targetIndex !== -1) index = targetIndex + (placeBefore ? 0 : 1);
    }
    destination.tasks.splice(index, 0, task);
    placeInList(destination.tasks, index);
  }, { undoLabel: found.category.id === targetCategoryId ? 'Task moved' : `Moved to ${target.name}` });
  return moved;
}

// Moves a task past its next visible neighbour (hidden done tasks are skipped).
function moveTaskBy(taskId, direction, visibleIds) {
  const found = findTask(taskId);
  if (!found) return;
  const ids = visibleIds || found.category.tasks.map(t => t.id);
  const position = ids.indexOf(taskId);
  const neighbourId = ids[position + direction];
  if (position === -1 || !neighbourId) return;
  moveTaskToPosition(taskId, found.category.id, neighbourId, direction < 0);
}

function moveTaskToCategory(taskId, categoryId) {
  const found = findTask(taskId);
  if (!found || found.category.id === categoryId) return;
  moveTaskToPosition(taskId, categoryId, null);
}

function archiveDone(categoryId = null) {
  let count = 0;
  commit(board => {
    const now = Date.now();
    board.categories.forEach(category => {
      if (categoryId && category.id !== categoryId) return;
      category.tasks.forEach(task => {
        if (task.status === 'DONE' && !task.archivedAt) {
          task.archivedAt = now;
          count += 1;
        }
      });
    });
    if (!count) return false;
  }, { undoLabel: () => `Archived ${count} done ${count === 1 ? 'task' : 'tasks'}` });
  if (!count) showToast('No done tasks to archive');
  return count;
}

function restoreTask(taskId) {
  updateTask(taskId, task => { task.archivedAt = null; }, { undoLabel: 'Restored to the board' });
}

function countDone(categoryId = null) {
  return Core.listTasks(data).filter(({ task, category }) => task.status === 'DONE' && (!categoryId || category.id === categoryId)).length;
}

// ---------------------------------------------------------------------------
// Category actions
// ---------------------------------------------------------------------------

function addCategory(name = 'New Category') {
  let created = null;
  commit(board => {
    const last = board.categories[board.categories.length - 1];
    created = Core.makeCategory({ name, order: last ? last.order + 1 : 0 });
    board.categories.push(created);
  });
  return created;
}

function renameCategory(categoryId, name) {
  const clean = Core.cleanText(name);
  if (!clean) return false;
  return commit(board => {
    const category = findCategory(categoryId, board);
    if (!category) return false;
    category.name = clean;
  });
}

function setCategoryColor(categoryId, color) {
  commit(board => {
    const category = findCategory(categoryId, board);
    if (!category) return false;
    category.color = color;
  });
}

function moveCategory(categoryId, direction) {
  const index = data.categories.findIndex(c => c.id === categoryId);
  const neighbour = data.categories[index + direction];
  if (index === -1 || !neighbour) return;
  moveCategoryToPosition(categoryId, neighbour.id, direction < 0);
}

function moveCategoryToPosition(categoryId, targetId, placeBefore) {
  if (categoryId === targetId) return;
  commit(board => {
    const from = board.categories.findIndex(c => c.id === categoryId);
    if (from === -1) return false;
    const [category] = board.categories.splice(from, 1);
    let index = board.categories.findIndex(c => c.id === targetId);
    if (index === -1) index = board.categories.length;
    else if (!placeBefore) index += 1;
    board.categories.splice(index, 0, category);
    placeInList(board.categories, index);
  }, { undoLabel: 'Category moved' });
}

function deleteCategory(categoryId) {
  const category = findCategory(categoryId);
  if (!category) return;
  commit(board => {
    board.categories = board.categories.filter(c => c.id !== categoryId);
  }, { undoLabel: `Deleted “${truncate(category.name)}” and its ${category.tasks.length} ${category.tasks.length === 1 ? 'task' : 'tasks'}` });
}

function toggleCollapsed(categoryId) {
  if (prefs.collapsed[categoryId]) delete prefs.collapsed[categoryId];
  else prefs.collapsed[categoryId] = true;
  savePrefs();
  requestRender();
}

function replaceBoard(imported) {
  const clean = Core.normalizeData(imported, { legacyUpdatedAt: Date.now() });
  commit(board => {
    board.categories = clean.categories;
  }, { undoLabel: 'Backup imported' });
}

// ---------------------------------------------------------------------------
// Cloud sync
//
// pull: GET the board; if its revision differs from ours, merge it in.
// push: POST our board with the revision it was based on; on conflict the
//       server returns the latest board, we merge and try again.
// ---------------------------------------------------------------------------

const sync = {
  pushing: false,
  pulling: false,
  needsPush: false,
  editSeq: 0,
  conflicts: 0,
  retryDelay: 0,
  retryTimer: null,
  pushTimer: null,
  storage: null,
  status: 'idle',
  detail: ''
};

function setSyncStatus(status, detail = '') {
  sync.status = status;
  sync.detail = detail;
  renderSyncBadge();
}

function markDirty() {
  syncMeta.dirty = true;
  sync.editSeq += 1;
  saveSyncMeta();
  schedulePush();
}

function markSynced() {
  syncMeta.lastSyncedAt = Date.now();
  saveSyncMeta();
  setSyncStatus('synced', 'Up to date');
  // Save the timezone the morning digest should use, once this device is in sync.
  const timezone = deviceTimezone();
  if (timezone && !data.settings.timezone) {
    commit(board => { board.settings.timezone = timezone; }, { render: false });
  }
}

function handleUnauthorized() {
  authToken = '';
  localStorage.removeItem(AUTH_TOKEN_STORAGE);
  setSyncStatus('error', 'Signed out');
  showLockScreen('Session expired. Please enter PIN again.');
}

// Returns true when the merged board still has changes the cloud doesn't.
function applyRemote(remoteRaw, rev) {
  const remote = Core.normalizeData(remoteRaw);
  const before = JSON.stringify(data);
  // First sync on this device with nothing unsaved: the cloud is the source of truth.
  const next = syncMeta.baseRev == null && !syncMeta.dirty ? remote : Core.mergeData(data, remote);
  syncMeta.baseRev = rev;
  if (JSON.stringify(next) !== before) {
    data = next;
    persistData();
    undoStack.length = 0; // undo snapshots predate the incoming changes
    requestRender();
    refreshOpenDetails();
  }
  const needsUpload = JSON.stringify(next) !== JSON.stringify(remote);
  if (needsUpload) syncMeta.dirty = true;
  saveSyncMeta();
  return needsUpload;
}

async function pullRemote({ manual = false } = {}) {
  if (!authToken || sync.pulling) return;
  sync.pulling = true;
  if (manual) setSyncStatus('syncing', 'Checking the cloud…');
  try {
    const res = await fetch('/api/sync', {
      headers: { 'Authorization': `Bearer ${authToken}` },
      cache: 'no-store'
    });
    if (res.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    sync.storage = body.storage || sync.storage;

    if (!body.found) {
      // Empty cloud: upload this board.
      syncMeta.dirty = true;
      saveSyncMeta();
      schedulePush(0);
      return;
    }

    const rev = Number(body.rev != null ? body.rev : body.updatedAt) || 0;
    if (rev === syncMeta.baseRev) {
      if (syncMeta.dirty) schedulePush(0);
      else if (sync.status !== 'synced' || manual) markSynced();
      return;
    }
    if (applyRemote(body.data, rev) || syncMeta.dirty) schedulePush(0);
    else markSynced();
  } catch (err) {
    console.warn('Sync pull failed:', err);
    setSyncStatus(navigator.onLine ? 'error' : 'offline', navigator.onLine ? 'Cloud unavailable — saved on this device' : 'Offline — saved on this device');
  } finally {
    sync.pulling = false;
  }
}

function schedulePush(delay = 400) {
  if (!authToken) return;
  clearTimeout(sync.pushTimer);
  sync.pushTimer = setTimeout(pushRemote, delay);
  if (sync.status !== 'error' && sync.status !== 'offline') setSyncStatus('syncing', 'Saving…');
}

async function pushRemote() {
  if (!authToken) return;
  if (sync.pushing) {
    sync.needsPush = true;
    return;
  }
  if (!syncMeta.dirty) {
    markSynced();
    return;
  }
  clearTimeout(sync.retryTimer);
  sync.retryTimer = null;
  sync.pushing = true;
  sync.needsPush = false;
  const seq = sync.editSeq;
  let failed = false;
  let conflict = false;

  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ schema: Core.SCHEMA, baseRev: syncMeta.baseRev, data })
    });
    if (res.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    sync.storage = body.storage || sync.storage;

    if (body.conflict) {
      // Another device saved first: merge its board into ours and try again.
      conflict = true;
      sync.conflicts += 1;
      applyRemote(body.data, Number(body.rev != null ? body.rev : body.updatedAt) || 0);
      syncMeta.dirty = true;
      saveSyncMeta();
    } else {
      sync.conflicts = 0;
      sync.retryDelay = 0;
      syncMeta.baseRev = Number(body.rev);
      if (sync.editSeq === seq) syncMeta.dirty = false;
      saveSyncMeta();
      if (!syncMeta.dirty) markSynced();
    }
  } catch (err) {
    failed = true;
    console.warn('Sync push failed:', err);
    sync.retryDelay = Math.min(60000, (sync.retryDelay || 1500) * 2);
    setSyncStatus(navigator.onLine ? 'error' : 'offline', navigator.onLine ? 'Sync paused — saved on this device' : 'Offline — saved on this device');
    sync.retryTimer = setTimeout(pushRemote, sync.retryDelay);
  } finally {
    sync.pushing = false;
    if (!failed && (conflict || sync.needsPush || syncMeta.dirty)) {
      schedulePush(conflict ? Math.min(8000, 250 * 2 ** Math.min(sync.conflicts, 5)) : 250);
    }
  }
}

function startSyncLoops() {
  window.addEventListener('focus', () => pullRemote());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pullRemote(); });
  window.addEventListener('online', () => {
    pullRemote();
    if (syncMeta.dirty) schedulePush(0);
  });
  setInterval(() => {
    if (!document.hidden && !sync.pushing) pullRemote();
  }, SYNC_POLL_MS);

  // Last-chance upload when the page is closed or hidden.
  window.addEventListener('pagehide', () => {
    if (!syncMeta.dirty || !authToken || !navigator.sendBeacon) return;
    const payload = JSON.stringify({ schema: Core.SCHEMA, baseRev: syncMeta.baseRev, data, token: authToken });
    navigator.sendBeacon('/api/sync', new Blob([payload], { type: 'application/json' }));
  });
}
