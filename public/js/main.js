/* ZAWISH Workboard — sign-in, keyboard shortcuts, toolbar wiring and startup. */

// ---------------------------------------------------------------------------
// Sign-in screen: pick your profile, enter your 6-digit PIN once per device.
// A one-time setup link (#setup=…) lets someone choose their PIN.
// ---------------------------------------------------------------------------

const PIN_LENGTH = 6;
const appMain = document.getElementById('appMain');
const lockScreen = document.getElementById('lockScreen');
const lockCard = document.getElementById('lockCard');
const lockAvatar = document.getElementById('lockAvatar');
const lockTitle = document.getElementById('lockTitle');
const lockDesc = document.getElementById('lockDesc');
const lockError = document.getElementById('lockError');
const profileList = document.getElementById('profileList');
const pinEntry = document.getElementById('pinEntry');
const pinDots = lockScreen.querySelectorAll('.pin-dot');
const pinHiddenInput = document.getElementById('pinHiddenInput');
const pinDeleteBtn = document.getElementById('pinDeleteBtn');
const rememberDevice = document.getElementById('rememberDevice');
const lockBack = document.getElementById('lockBack');
const lockNote = document.getElementById('lockNote');
const boardTitle = document.getElementById('boardTitle');

let enteredPin = '';
let isVerifying = false;
let profiles = [];
// { kind: 'loading' } | { kind: 'profiles' } | { kind: 'pin', user } | { kind: 'setup', token, user, purpose, firstPin }
let lockMode = { kind: 'loading' };

function initials(name) {
  return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0].toUpperCase()).join('') || '?';
}

// Same rule as the server: no repeats (000000) or straight runs (123456 / 987654).
function isWeakPin(pin) {
  if (/^(\d)\1+$/.test(pin)) return true;
  const digits = [...pin].map(Number);
  const steps = new Set(digits.slice(1).map((d, i) => d - digits[i]));
  return steps.size === 1 && (steps.has(1) || steps.has(-1));
}

async function postJson(path, body, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && json.ok !== false, status: res.status, body: json };
}

function setLockError(message) {
  lockError.textContent = message || '';
  lockError.classList.toggle('visible', Boolean(message));
}

function resetPin() {
  enteredPin = '';
  pinHiddenInput.value = '';
  updatePinDots();
}

// Desktop typing goes to a hidden input; phones use the on-screen keypad
// (focusing the input there would pop the system keyboard over it).
function focusPin() {
  if (!pinEntry.hidden && !touchQuery.matches) setTimeout(() => pinHiddenInput.focus(), 80);
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// The owner's first name, for "Ask Raza …" messages.
function ownerName() {
  const owner = profiles.find(profile => profile.role === 'owner');
  return owner ? firstName(owner.name) : 'your admin';
}

// Board heading and browser tab follow whoever is signed in ("Raza’s Workboard").
function applyIdentity() {
  const name = currentUser ? firstName(currentUser.name) : '';
  boardTitle.textContent = name ? `${name}’s Workboard` : 'Workboard';
  document.title = name ? `${name}’s Workboard · ZAWISH` : 'ZAWISH Workboard';
}

function renderLock() {
  const { kind } = lockMode;
  profileList.hidden = kind !== 'profiles';
  pinEntry.hidden = kind !== 'pin' && kind !== 'setup';
  lockBack.hidden = kind !== 'pin';
  lockNote.hidden = kind !== 'profiles';
  lockAvatar.classList.toggle('initials', kind === 'pin' || kind === 'setup');
  if (kind === 'loading' || kind === 'profiles') {
    lockAvatar.replaceChildren(h('img', { src: 'icons/icon-192.png', alt: '' }));
  }

  if (kind === 'loading') {
    lockTitle.textContent = 'One moment…';
    lockDesc.textContent = '';
  } else if (kind === 'profiles') {
    lockTitle.textContent = 'Who’s working?';
    lockNote.textContent = `Not on the list? Ask ${ownerName()} for an invite link.`;
    lockDesc.textContent = profiles.length ? 'Tap your name to open your board.' : 'No profiles yet.';
    profileList.replaceChildren(...profiles.map(profile => h('button', {
      type: 'button',
      class: 'profile-button',
      onClick: () => selectProfile(profile)
    },
    h('span', { class: 'profile-avatar', 'aria-hidden': 'true' }, initials(profile.name)),
    h('span', { class: 'profile-name' }, profile.name),
    profile.hasPin ? null : h('span', { class: 'profile-note' }, 'Not set up yet'))));
  } else if (kind === 'pin') {
    lockAvatar.textContent = initials(lockMode.user.name);
    lockTitle.textContent = lockMode.user.name;
    lockDesc.textContent = `Enter your ${PIN_LENGTH}-digit PIN`;
  } else if (kind === 'setup') {
    lockAvatar.textContent = initials(lockMode.user.name);
    lockTitle.textContent = lockMode.purpose === 'reset' ? `New PIN for ${lockMode.user.name}` : `Welcome, ${lockMode.user.name}`;
    lockDesc.textContent = lockMode.firstPin
      ? 'Enter the same PIN again to confirm.'
      : `Choose a ${PIN_LENGTH}-digit PIN. You only need it once on each device.`;
  }
}

function openLock() {
  closePopover();
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  lockScreen.classList.remove('hidden');
  appMain.setAttribute('inert', '');
}

async function loadProfiles() {
  const res = await fetch('/api/profiles', { cache: 'no-store' });
  const body = await res.json();
  profiles = body.profiles || [];
}

async function showProfiles(message = '') {
  lockMode = { kind: 'loading' };
  renderLock();
  try {
    await loadProfiles();
  } catch (err) {
    profiles = [];
    lockMode = { kind: 'profiles' };
    renderLock();
    setLockError('Can’t reach the server. Check your connection and reload.');
    return;
  }
  // Always show the list, even with one profile, so a newcomer never lands on someone else's PIN pad.
  lockMode = { kind: 'profiles' };
  renderLock();
  setLockError(message);
}

function selectProfile(profile, message = '') {
  if (!profile.hasPin) {
    setLockError(`${profile.name} isn’t set up yet. Ask ${ownerName()} for a setup link.`);
    return;
  }
  lockMode = { kind: 'pin', user: profile };
  resetPin();
  renderLock();
  setLockError(message);
  focusPin();
}

// Shows the sign-in screen; with `user` it goes straight to that person's PIN.
function showLockScreen(message = '', user = null) {
  openLock();
  if (!user) {
    showProfiles(message);
    return;
  }
  selectProfile({ ...user, hasPin: true }, message);
  loadProfiles().then(renderLock).catch(() => {});
}

function hideLockScreen() {
  lockScreen.classList.add('hidden');
  appMain.removeAttribute('inert');
  resetPin();
  setLockError('');
}

function isLocked() {
  return !lockScreen.classList.contains('hidden');
}

async function signedIn(user, token, remember) {
  saveSession(user, token, remember);
  activateUser(user, token);
  applyIdentity();
  hideLockScreen();
  renderNow();
  await pullRemote({ manual: true });
  if (syncMeta.dirty) schedulePush(0);
}

// Signs this device out. Unsynced edits are uploaded first when possible.
async function lockBoard() {
  if (!currentUser) {
    showLockScreen();
    return;
  }
  if (syncMeta.dirty) await pushRemote();
  if (syncMeta.dirty && !confirm('Some changes haven’t uploaded yet (are you offline?). Sign out anyway and lose them on this device?')) return;
  postJson('/api/logout', {}, authToken).catch(() => {});
  deactivateUser();
  applyIdentity();
  renderNow();
  showLockScreen('Signed out on this device.');
}

function updatePinDots() {
  pinDots.forEach((dot, idx) => dot.classList.toggle('filled', idx < enteredPin.length));
}

async function handlePinDigit(digit) {
  if (isVerifying || pinEntry.hidden || enteredPin.length >= PIN_LENGTH) return;
  enteredPin += digit;
  pinHiddenInput.value = enteredPin;
  updatePinDots();
  if (enteredPin.length === PIN_LENGTH) await submitPin();
}

function handlePinDelete() {
  if (isVerifying || enteredPin.length === 0) return;
  enteredPin = enteredPin.slice(0, -1);
  pinHiddenInput.value = enteredPin;
  updatePinDots();
  setLockError('');
}

async function submitPin() {
  if (isVerifying) return;
  const pin = enteredPin;

  if (lockMode.kind === 'setup' && !lockMode.firstPin) {
    if (isWeakPin(pin)) {
      showPinError('That PIN is too easy to guess. Avoid repeats and runs like 123456.');
      return;
    }
    lockMode.firstPin = pin;
    resetPin();
    renderLock();
    setLockError('');
    return;
  }
  if (lockMode.kind === 'setup' && lockMode.firstPin !== pin) {
    lockMode.firstPin = null;
    renderLock();
    showPinError('Those PINs didn’t match. Choose your PIN again.');
    return;
  }

  isVerifying = true;
  setLockError('');
  try {
    const remember = rememberDevice.checked;
    const res = lockMode.kind === 'setup'
      ? await postJson('/api/setup', { action: 'complete', token: lockMode.token, pin, remember })
      : await postJson('/api/login', { userId: lockMode.user.id, pin, remember });
    if (res.ok && res.body.token) {
      await signedIn(res.body.user, res.body.token, remember);
    } else if (lockMode.kind === 'setup' && res.status === 404) {
      showProfiles(res.body.error);
    } else {
      if (lockMode.kind === 'setup') {
        lockMode.firstPin = null;
        renderLock();
      }
      showPinError(res.body.error || 'Something went wrong. Please try again.');
    }
  } catch (err) {
    showPinError('Network error. Check your connection and retry.');
  } finally {
    isVerifying = false;
  }
}

function showPinError(msg) {
  setLockError(msg);
  lockCard.classList.add('shake');
  setTimeout(() => {
    lockCard.classList.remove('shake');
    resetPin();
    focusPin();
  }, 420);
}

function readSetupToken() {
  const match = /(?:^#|&)setup=([\w-]+)/.exec(location.hash);
  return match ? match[1] : null;
}

async function startSetup(token) {
  // Take the token out of the address bar and history.
  history.replaceState(null, '', location.pathname + location.search);
  openLock();
  lockMode = { kind: 'loading' };
  renderLock();
  try {
    const res = await postJson('/api/setup', { action: 'check', token });
    if (!res.ok) {
      showProfiles(res.body.error || 'This link is invalid or has expired.');
      return;
    }
    lockMode = { kind: 'setup', token, user: res.body.user, purpose: res.body.purpose, firstPin: null };
    resetPin();
    renderLock();
    setLockError('');
    focusPin();
  } catch (err) {
    showProfiles('Network error. Check your connection and open the link again.');
  }
}

window.addEventListener('hashchange', () => {
  const token = readSetupToken();
  if (token) startSetup(token);
});

document.querySelectorAll('.keypad-btn[data-val]').forEach(btn => {
  btn.addEventListener('click', () => handlePinDigit(btn.dataset.val));
});
pinDeleteBtn.addEventListener('click', handlePinDelete);
lockBack.addEventListener('click', () => {
  lockMode = { kind: 'profiles' };
  resetPin();
  renderLock();
  setLockError('');
});
lockCard.addEventListener('click', event => {
  if (!event.target.closest('.keypad-btn, button, input, label')) focusPin();
});
pinHiddenInput.addEventListener('input', () => {
  const val = pinHiddenInput.value.replace(/[^0-9]/g, '').slice(0, PIN_LENGTH);
  enteredPin = val;
  pinHiddenInput.value = val;
  updatePinDots();
  if (enteredPin.length === PIN_LENGTH) submitPin();
});

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const THEME_COLORS = { light: '#f4f4f4', dark: '#0b0b0c' };
const darkSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const root = document.documentElement;
  if (prefs.theme === 'light' || prefs.theme === 'dark') root.dataset.theme = prefs.theme;
  else delete root.dataset.theme;
  // Browser / status bar colour follows the forced theme, or the OS when on Auto.
  document.querySelectorAll('meta[name="theme-color"]').forEach(meta => {
    const media = meta.getAttribute('media') || '';
    const forMode = media.includes('dark') ? 'dark' : 'light';
    meta.setAttribute('content', prefs.theme === 'auto' ? THEME_COLORS[forMode] : THEME_COLORS[prefs.theme]);
  });
}

darkSchemeQuery.addEventListener('change', applyTheme);

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

function visibleIdsForRow(row) {
  const list = row.closest('.category') && row.parentElement;
  return list ? [...list.querySelectorAll(':scope > li.task')].map(li => li.dataset.taskId) : null;
}

function editTaskInline(row) {
  const text = row.querySelector('.task-text[contenteditable="true"]');
  if (!text) {
    openDetails(row.dataset.taskId, { focus: 'title' });
    return;
  }
  text.focus();
  const range = document.createRange();
  range.selectNodeContents(text);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function deleteFocusedTask(row) {
  const items = navigableItems();
  const index = items.indexOf(row);
  const neighbour = items[index + 1] || items[index - 1];
  const nextId = neighbour && neighbour.dataset.taskId;
  deleteTask(row.dataset.taskId);
  renderNow();
  const next = nextId && viewEl.querySelector(`[data-task-id="${CSS.escape(nextId)}"]`);
  if (next) focusTaskElement(next);
}

document.addEventListener('keydown', event => {
  if (isLocked()) {
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      handlePinDigit(event.key);
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      handlePinDelete();
    }
    return;
  }

  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openQuickAdd();
    return;
  }
  if (isTextEditingTarget(event.target) || document.querySelector('dialog[open]') || !popoverEl.hidden) return;
  if (mod && event.key.toLowerCase() === 'z' && !event.shiftKey) {
    event.preventDefault();
    undo();
    return;
  }
  if (mod || event.altKey) return;

  const row = activeTaskElement();
  const onRow = row && event.target === row;
  const taskId = row && row.dataset.taskId;
  const key = event.key;
  let handled = true;

  switch (key) {
    case 'n': case 'N': openQuickAdd(); break;
    case '/': search.focus(); search.select(); break;
    case '?': openShortcutsPanel(); break;
    case '1': setView('board'); break;
    case '2': setView('kanban'); break;
    case '3': setView('focus'); break;
    case 'c': case 'C': createCategoryInteractive(); break;
    case 'z': case 'Z': undo(); break;
    case 'j': case 'ArrowDown':
      if (event.shiftKey && taskId) moveTaskBy(taskId, 1, visibleIdsForRow(row));
      else moveFocus(1);
      break;
    case 'k': case 'ArrowUp':
      if (event.shiftKey && taskId) moveTaskBy(taskId, -1, visibleIdsForRow(row));
      else moveFocus(-1);
      break;
    case 'J': if (taskId) moveTaskBy(taskId, 1, visibleIdsForRow(row)); break;
    case 'K': if (taskId) moveTaskBy(taskId, -1, visibleIdsForRow(row)); break;
    case 'h': case 'ArrowLeft': moveFocusColumn(-1); break;
    case 'l': case 'ArrowRight': moveFocusColumn(1); break;
    default: handled = false;
  }

  if (!handled && taskId) {
    handled = true;
    switch (key) {
      case 'Enter': case 'o':
        if (onRow) openDetails(taskId);
        else handled = false;
        break;
      case ' ': case 's':
        if (onRow || key === 's') cycleStatus(taskId);
        else handled = false;
        break;
      case 'e': editTaskInline(row); break;
      case 'w': toggleWaiting(taskId); break;
      case 'x': {
        const found = findTask(taskId);
        if (found) setStatus(taskId, found.task.status === 'DONE' ? 'NTS' : 'DONE');
        break;
      }
      case 'u': case '!': toggleUrgent(taskId); break;
      case 'd': openDetails(taskId, { focus: 'due' }); break;
      case 'Delete': case 'Backspace': case '#': deleteFocusedTask(row); break;
      default: handled = false;
    }
  }

  if (handled) event.preventDefault();
});

// ---------------------------------------------------------------------------
// Toolbar wiring
// ---------------------------------------------------------------------------

const search = document.getElementById('search');

search.addEventListener('input', () => {
  filterText = search.value.trim();
  renderNow();
});
search.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    search.value = '';
    filterText = '';
    renderNow();
    search.blur();
  } else if (event.key === 'Enter' || event.key === 'ArrowDown') {
    event.preventDefault();
    search.blur();
    moveFocus(1);
  }
});

hideDoneButton.addEventListener('click', () => {
  prefs.hideDone = !prefs.hideDone;
  savePrefs();
  renderNow();
});

document.getElementById('addCategory').addEventListener('click', createCategoryInteractive);
document.getElementById('quickAddButton').addEventListener('click', () => openQuickAdd());
document.getElementById('fabAdd').addEventListener('click', () => openQuickAdd());
document.getElementById('moreButton').addEventListener('click', event => openMoreMenu(event.currentTarget));
document.getElementById('navMore').addEventListener('click', event => openMoreMenu(event.currentTarget));
syncButton.addEventListener('click', openSyncPanel);
document.querySelectorAll('button[data-view]').forEach(button => {
  button.addEventListener('click', () => {
    setView(button.dataset.view);
    if (narrowQuery.matches) window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});

// Re-render when switching between touch/desktop layouts (e.g. rotating a tablet).
touchQuery.addEventListener('change', () => renderNow());
narrowQuery.addEventListener('change', () => renderNow());

// Day rollover: refresh "today" labels when the app is reopened on a new day.
let renderedDay = todayStr();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && todayStr() !== renderedDay) {
    renderedDay = todayStr();
    renderNow();
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Home-screen shortcuts open a specific view (?view=focus).
const requestedView = new URLSearchParams(location.search).get('view');
if (['board', 'kanban', 'focus'].includes(requestedView)) prefs.view = requestedView;

applyTheme();
renderSyncBadge();
renderNow();
startSyncLoops();

// Open straight into the last person's board if this device remembers them.
const setupToken = readSetupToken();
const rememberedId = lastUserId();
const remembered = rememberedId && getSession(rememberedId);
if (setupToken) {
  startSetup(setupToken);
} else if (remembered) {
  activateUser({ id: rememberedId, name: remembered.name, role: remembered.role }, remembered.token);
  applyIdentity();
  renderNow();
  pullRemote({ manual: true });
} else {
  showLockScreen();
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('Service worker registration failed:', err));
  });
}
