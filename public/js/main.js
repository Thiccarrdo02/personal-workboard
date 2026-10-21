/* My Workboard — lock screen, keyboard shortcuts, toolbar wiring and startup. */

// ---------------------------------------------------------------------------
// Lock screen
// ---------------------------------------------------------------------------

const appMain = document.getElementById('appMain');
const lockScreen = document.getElementById('lockScreen');
const lockCard = document.getElementById('lockCard');
const lockError = document.getElementById('lockError');
const pinDots = lockScreen.querySelectorAll('.pin-dot');
const pinHiddenInput = document.getElementById('pinHiddenInput');
const pinDeleteBtn = document.getElementById('pinDeleteBtn');

let enteredPin = '';
let isVerifying = false;

function showLockScreen(msg = '') {
  closePopover();
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  lockScreen.classList.remove('hidden');
  appMain.setAttribute('inert', '');
  enteredPin = '';
  pinHiddenInput.value = '';
  updatePinDots();
  lockError.textContent = msg;
  lockError.classList.toggle('visible', Boolean(msg));
  setTimeout(() => pinHiddenInput.focus(), 80);
}

function hideLockScreen() {
  lockScreen.classList.add('hidden');
  appMain.removeAttribute('inert');
  enteredPin = '';
  pinHiddenInput.value = '';
  updatePinDots();
  lockError.textContent = '';
  lockError.classList.remove('visible');
}

function isLocked() {
  return !lockScreen.classList.contains('hidden');
}

function lockBoard() {
  authToken = '';
  localStorage.removeItem(AUTH_TOKEN_STORAGE);
  showLockScreen('Workboard locked');
}

function updatePinDots() {
  pinDots.forEach((dot, idx) => dot.classList.toggle('filled', idx < enteredPin.length));
}

async function handlePinDigit(digit) {
  if (isVerifying || enteredPin.length >= 4) return;
  enteredPin += digit;
  pinHiddenInput.value = enteredPin;
  updatePinDots();
  if (enteredPin.length === 4) await submitPin();
}

function handlePinDelete() {
  if (isVerifying || enteredPin.length === 0) return;
  enteredPin = enteredPin.slice(0, -1);
  pinHiddenInput.value = enteredPin;
  updatePinDots();
  lockError.textContent = '';
  lockError.classList.remove('visible');
}

async function submitPin() {
  if (isVerifying) return;
  isVerifying = true;
  lockError.textContent = '';
  lockError.classList.remove('visible');

  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: enteredPin })
    });
    const body = await res.json();
    if (res.ok && body.token) {
      authToken = body.token;
      localStorage.setItem(AUTH_TOKEN_STORAGE, authToken);
      hideLockScreen();
      await pullRemote({ manual: true });
      if (syncMeta.dirty) schedulePush(0);
    } else {
      showPinError(body.error || 'Incorrect PIN. Please try again.');
    }
  } catch (err) {
    showPinError('Network error. Check connection and retry.');
  } finally {
    isVerifying = false;
  }
}

function showPinError(msg) {
  lockError.textContent = msg;
  lockError.classList.add('visible');
  lockCard.classList.add('shake');
  setTimeout(() => {
    lockCard.classList.remove('shake');
    enteredPin = '';
    pinHiddenInput.value = '';
    updatePinDots();
    pinHiddenInput.focus();
  }, 420);
}

document.querySelectorAll('.keypad-btn[data-val]').forEach(btn => {
  btn.addEventListener('click', () => handlePinDigit(btn.dataset.val));
});
pinDeleteBtn.addEventListener('click', handlePinDelete);
lockCard.addEventListener('click', event => {
  if (!event.target.closest('.keypad-btn')) pinHiddenInput.focus();
});
pinHiddenInput.addEventListener('input', () => {
  const val = pinHiddenInput.value.replace(/[^0-9]/g, '').slice(0, 4);
  enteredPin = val;
  pinHiddenInput.value = val;
  updatePinDots();
  if (enteredPin.length === 4) submitPin();
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

if (!authToken) showLockScreen();
else pullRemote({ manual: true });

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('Service worker registration failed:', err));
  });
}
