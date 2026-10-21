/* My Workboard — rendering: summary, Today strip, board / kanban / focus views, menus and toasts. */

const viewEl = document.getElementById('view');
const summaryEl = document.getElementById('summary');
const agendaEl = document.getElementById('agenda');
const toastHost = document.getElementById('toastHost');
const popoverEl = document.getElementById('popover');
const popoverBackdrop = document.getElementById('popoverBackdrop');
const syncButton = document.getElementById('syncButton');
const syncLabel = document.getElementById('syncLabel');
const hideDoneButton = document.getElementById('hideDone');

const touchQuery = window.matchMedia('(pointer: coarse)');
const narrowQuery = window.matchMedia('(max-width: 760px)');
const DATE_ORDER = deviceDateOrder();
const STATUS_ICONS = { NTS: '○', WIP: '◐', WAIT: '◌', DONE: '✓' };
const AGENDA_LIMIT = 5;

let filterText = '';
let focusedTaskId = null;
let activeDrag = null;
const expandedAgendaGroups = new Set();

// ---------------------------------------------------------------------------
// DOM helper
// ---------------------------------------------------------------------------

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node && !key.includes('-')) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : String(child));
  }
  return node;
}

// replaceChildren that skips null/false and flattens arrays, like h().
function setChildren(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter(child => child != null && child !== false));
}

function isTextEditingTarget(target) {
  return Boolean(target && target.closest && target.closest('[contenteditable="true"], input, textarea, select, dialog'));
}

function parseInput(text) {
  return Core.parseQuickAdd(text, { today: todayStr(), categories: data.categories, dateOrder: DATE_ORDER });
}

function matchesFilter(task, category) {
  if (task.archivedAt) return false;
  const needle = filterText.toLowerCase();
  if (!needle) return true;
  return category.name.toLowerCase().includes(needle)
    || task.text.toLowerCase().includes(needle)
    || task.notes.toLowerCase().includes(needle)
    || task.checklist.some(item => item.text.toLowerCase().includes(needle));
}

function isVisibleInBoard(task, category) {
  return matchesFilter(task, category) && !(prefs.hideDone && task.status === 'DONE');
}

// ---------------------------------------------------------------------------
// Render scheduling. Re-rendering replaces the DOM, so it waits while a
// pointer is down (so the click lands), a drag is running, or the user is
// typing in the board.
// ---------------------------------------------------------------------------

let renderPending = false;
let pointerIsDown = false;
let renderSafetyTimer = null;

function isEditingInline() {
  const el = document.activeElement;
  if (!el || !(viewEl.contains(el) || agendaEl.contains(el))) return false;
  return el.isContentEditable || el.matches('input, textarea, select');
}

function requestRender() {
  renderPending = true;
  requestAnimationFrame(flushRender);
  clearTimeout(renderSafetyTimer);
  renderSafetyTimer = setTimeout(() => {
    pointerIsDown = false;
    flushRender();
  }, 2500);
}

function flushRender() {
  if (!renderPending || pointerIsDown || activeDrag || isEditingInline()) return;
  renderPending = false;
  render();
}

function renderNow() {
  renderPending = false;
  render();
}

document.addEventListener('pointerdown', () => { pointerIsDown = true; }, true);
const releasePointer = () => {
  pointerIsDown = false;
  setTimeout(flushRender, 0);
};
document.addEventListener('pointerup', releasePointer, true);
document.addEventListener('pointercancel', releasePointer, true);
document.addEventListener('focusout', () => setTimeout(flushRender, 0));

function render() {
  const focusState = captureFocus();
  renderSummary();
  renderAgenda();
  if (prefs.view === 'kanban') renderKanban();
  else if (prefs.view === 'focus') renderFocus();
  else renderBoard();
  renderViewSwitch();
  hideDoneButton.setAttribute('aria-pressed', String(prefs.hideDone));
  hideDoneButton.textContent = prefs.hideDone ? 'Show done' : 'Hide done';
  restoreFocus(focusState);
}

function captureFocus() {
  const el = document.activeElement;
  if (!el || !viewEl.contains(el)) return null;
  const holder = el.closest('[data-task-id]');
  if (!holder) return null;
  return { taskId: holder.dataset.taskId, control: el === holder ? null : el.dataset.control || null };
}

function restoreFocus(state) {
  const items = navigableItems();
  items.forEach(item => { item.tabIndex = -1; });
  const wanted = (state && state.taskId) || focusedTaskId;
  const holder = wanted ? viewEl.querySelector(`[data-task-id="${CSS.escape(wanted)}"]`) : null;
  (holder || items[0] || {}).tabIndex = 0;
  if (!state || !holder) return;
  const target = (state.control && holder.querySelector(`[data-control="${state.control}"]`)) || holder;
  target.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Summary metrics and sync badge
// ---------------------------------------------------------------------------

function renderSummary() {
  const tasks = Core.listTasks(data).map(x => x.task);
  const today = todayStr();
  const open = tasks.filter(t => t.status !== 'DONE');
  const count = status => tasks.filter(t => t.status === status).length;
  const metric = (number, label, variant = '') => h('div', { class: `metric${variant ? ` ${variant}` : ''}` }, h('strong', {}, number), h('span', {}, label));

  const waiting = count('WAIT');
  const urgent = open.filter(t => t.urgent).length;
  const overdue = open.filter(t => t.due && t.due < today).length;
  setChildren(summaryEl,
    metric(tasks.length, 'All'),
    metric(count('NTS'), 'To start'),
    metric(count('WIP'), 'In progress'),
    waiting ? metric(waiting, 'Waiting', 'wait') : null,
    metric(count('DONE'), 'Done'),
    urgent ? metric(urgent, 'Urgent', 'urgent') : null,
    overdue ? metric(overdue, 'Overdue', 'urgent') : null
  );
}

function renderSyncBadge() {
  const labels = { idle: 'Sync', syncing: 'Saving…', synced: 'Synced', offline: 'Offline', error: 'Sync paused' };
  syncButton.dataset.status = sync.status;
  syncLabel.textContent = labels[sync.status] || 'Sync';
  syncButton.title = sync.detail || labels[sync.status] || 'Cloud sync';
}

function setView(view) {
  if (!['board', 'kanban', 'focus'].includes(view)) return;
  prefs.view = view;
  savePrefs();
  closePopover();
  renderNow();
}

function renderViewSwitch() {
  document.querySelectorAll('button[data-view]').forEach(button => {
    button.setAttribute('aria-selected', String(button.dataset.view === prefs.view));
  });
}

// ---------------------------------------------------------------------------
// Chips and task rows
// ---------------------------------------------------------------------------

function buildChips(task, category, { showCategory = false } = {}) {
  const chips = [];
  if (showCategory) chips.push(h('span', { class: 'chip cat', dataset: { color: category.color } }, category.name));

  const due = Core.describeDue(task, todayStr());
  if (due) {
    const title = `Due ${Core.formatDay(task.due, { year: true })}${task.dueTime ? ` at ${Core.formatTime(task.dueTime)}` : ''}`;
    chips.push(h('span', { class: `chip ${due.tone}`, title }, due.label));
  }
  if (task.repeat) chips.push(h('span', { class: 'chip', title: 'Repeats' }, `↻ ${Core.describeRepeat(task.repeat)}`));
  if (task.checklist.length) {
    const done = task.checklist.filter(item => item.done).length;
    chips.push(h('span', { class: 'chip', title: 'Checklist' }, `✓ ${done}/${task.checklist.length}`));
  }
  if (task.notes.trim()) {
    const links = Core.extractLinks(task.notes).length;
    chips.push(h('span', { class: 'chip', title: 'Has notes' }, links ? `↗ ${links} ${links === 1 ? 'link' : 'links'}` : '✎ Notes'));
  }
  if (task.status === 'WAIT') {
    const days = task.statusAt ? Core.ageInDays(task.statusAt) : 0;
    chips.push(h('span', { class: 'chip wait', title: 'Waiting on someone else' }, days ? `Waiting ${days}d` : 'Waiting'));
  }
  if (task.status === 'WIP' && task.statusAt) {
    const days = Core.ageInDays(task.statusAt);
    if (days >= 7) chips.push(h('span', { class: `chip${days >= 14 ? ' stale' : ''}`, title: 'Days in progress' }, `In progress ${days}d`));
  }
  if (task.urgent && task.status !== 'DONE') chips.push(h('span', { class: 'chip urgent' }, 'Urgent'));
  return chips;
}

// Click = primary action; long-press (touch) or right-click = secondary.
function attachPress(el, { onClick, onLongPress }) {
  let timer = null;
  let longPressed = false;
  let start = null;
  const fireLong = event => {
    if (longPressed) return;
    longPressed = true;
    if (navigator.vibrate) navigator.vibrate(8);
    onLongPress(event);
  };
  el.addEventListener('pointerdown', event => {
    longPressed = false;
    if (event.button !== 0) return;
    start = { x: event.clientX, y: event.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => fireLong(event), 480);
  });
  const cancel = () => clearTimeout(timer);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointermove', event => {
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) cancel();
  });
  el.addEventListener('contextmenu', event => {
    event.preventDefault();
    cancel();
    fireLong(event);
  });
  el.addEventListener('click', event => {
    event.stopPropagation();
    if (longPressed) {
      longPressed = false;
      return;
    }
    onClick(event);
  });
}

function buildStatusButton(task) {
  const button = h('button', {
    type: 'button',
    class: 'status',
    dataset: { status: task.status, control: 'status' },
    title: 'Click: next status · Right-click or long-press: choose (incl. Waiting)',
    'aria-label': `Status ${Core.STATUS_LABELS[task.status]}. Click to change.`
  }, task.status);
  attachPress(button, {
    onClick: () => cycleStatus(task.id),
    onLongPress: () => openStatusMenu(button, task.id)
  });
  return button;
}

function buildUrgentToggle(task) {
  return h('button', {
    type: 'button',
    class: `urgent-toggle${task.urgent ? ' active' : ''}`,
    title: task.urgent ? 'Unmark urgent' : 'Mark urgent',
    'aria-pressed': String(task.urgent),
    'aria-label': `${task.urgent ? 'Unmark' : 'Mark'} urgent: ${task.text}`,
    dataset: { control: 'urgent' },
    onClick: event => {
      event.stopPropagation();
      toggleUrgent(task.id);
    }
  }, '!');
}

function buildMoreButton(task) {
  return h('button', {
    type: 'button',
    class: 'task-more',
    title: 'Details: due date, notes, checklist…',
    'aria-label': `Open details: ${task.text}`,
    dataset: { control: 'more' },
    onClick: event => {
      event.stopPropagation();
      openDetails(task.id);
    }
  }, '⋯');
}

function buildTaskText(task, editable) {
  const text = h('div', { class: `task-text${editable ? '' : ' tappable'}`, dataset: { control: 'text' } }, task.text);
  if (!editable) {
    text.addEventListener('click', () => openDetails(task.id));
    return text;
  }
  text.contentEditable = 'true';
  text.spellcheck = true;
  text.setAttribute('role', 'textbox');
  text.setAttribute('aria-label', `Edit task: ${task.text}`);
  text.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      text.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      text.textContent = task.text;
      text.blur();
    }
  });
  text.addEventListener('blur', () => {
    const next = Core.cleanText(text.textContent);
    if (!next) {
      text.textContent = task.text;
      return;
    }
    if (next !== task.text) updateTask(task.id, t => { t.text = next; });
  });
  return text;
}

/**
 * context: 'board' (category card), 'list' (focus view), 'agenda' (Today strip).
 * `visibleIds` are the ids shown in the same card, for the up/down buttons.
 */
function buildTaskRow(task, category, { context = 'board', visibleIds = [] } = {}) {
  const touch = touchQuery.matches;
  const classes = ['task'];
  if (context !== 'board') classes.push(context === 'agenda' ? 'ctx-agenda' : 'ctx-list');
  if (task.status === 'DONE') classes.push('done');
  if (task.urgent) classes.push('urgent');

  const row = h('li', {
    class: classes.join(' '),
    tabIndex: -1,
    dataset: { taskId: task.id, categoryId: category.id },
    'aria-label': `${task.text} — ${Core.STATUS_LABELS[task.status]}`
  });

  const editable = !touch && context !== 'agenda';
  const main = h('div', { class: 'task-main' }, buildTaskText(task, editable));
  const chips = buildChips(task, category, { showCategory: context !== 'board' });
  if (chips.length) {
    main.append(h('div', { class: 'task-chips', onClick: () => openDetails(task.id) }, chips));
  }

  if (context === 'agenda') {
    row.append(buildStatusButton(task), main, buildMoreButton(task));
    return row;
  }

  const deleteButton = h('button', {
    type: 'button',
    class: 'task-delete',
    title: 'Delete task',
    'aria-label': `Delete task: ${task.text}`,
    dataset: { control: 'delete' },
    onClick: event => {
      event.stopPropagation();
      deleteTask(task.id);
    }
  }, '×');

  if (context === 'list') {
    row.append(buildStatusButton(task), buildUrgentToggle(task), main, buildMoreButton(task), deleteButton);
    return row;
  }

  const handle = h('button', {
    type: 'button',
    class: 'drag-handle',
    tabIndex: -1,
    title: 'Drag to reorder or move to another category',
    'aria-label': `Drag to reorder ${task.text}`
  }, '⠿');

  const position = visibleIds.indexOf(task.id);
  const reorder = h('div', { class: 'reorder-group' },
    h('button', {
      type: 'button', class: 'reorder-btn', title: 'Move up', 'aria-label': `Move ${task.text} up`,
      disabled: position <= 0,
      onClick: event => { event.stopPropagation(); moveTaskBy(task.id, -1, visibleIds); }
    }, '▲'),
    h('button', {
      type: 'button', class: 'reorder-btn', title: 'Move down', 'aria-label': `Move ${task.text} down`,
      disabled: position === -1 || position >= visibleIds.length - 1,
      onClick: event => { event.stopPropagation(); moveTaskBy(task.id, 1, visibleIds); }
    }, '▼')
  );

  row.append(handle, buildStatusButton(task), buildUrgentToggle(task), main, reorder, buildMoreButton(task), deleteButton);
  enableTaskDrag(row, task, category);
  enableTouchDrag(handle, row, task, category);
  return row;
}

// ---------------------------------------------------------------------------
// Board view
// ---------------------------------------------------------------------------

function renderBoard() {
  const board = h('div', { class: 'board' });
  data.categories.forEach(category => board.append(buildCategoryCard(category)));
  if (!filterText) {
    board.append(h('button', { type: 'button', class: 'add-category-card', onClick: createCategoryInteractive }, '+ New category'));
  }
  viewEl.replaceChildren(board);

  requestAnimationFrame(() => {
    board.querySelectorAll('.tasks-wrap').forEach(wrap => {
      wrap.classList.toggle('has-overflow', wrap.scrollHeight > wrap.clientHeight + 8);
    });
  });
}

function makePill(text, variant = '') {
  return h('span', { class: `pill${variant ? ` ${variant}` : ''}` }, text);
}

function buildCategoryCard(category) {
  const touch = touchQuery.matches;
  const collapsed = Boolean(prefs.collapsed[category.id]);
  const live = category.tasks.filter(task => !task.archivedAt);
  const visible = category.tasks.filter(task => isVisibleInBoard(task, category));
  const visibleIds = visible.map(task => task.id);

  const card = h('section', {
    class: `category${collapsed ? ' collapsed' : ''}`,
    dataset: { categoryId: category.id, color: category.color }
  });

  const title = h('h2', { class: 'category-title' }, category.name);
  if (!touch) {
    title.contentEditable = 'true';
    title.spellcheck = false;
    title.setAttribute('aria-label', `Edit category name: ${category.name}`);
    title.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        title.blur();
      } else if (event.key === 'Escape') {
        title.textContent = category.name;
        title.blur();
      }
    });
    title.addEventListener('blur', () => {
      if (!renameCategory(category.id, title.textContent)) title.textContent = category.name;
    });
  }

  const counts = { NTS: 0, WIP: 0, WAIT: 0, DONE: 0, urgent: 0 };
  visible.forEach(task => {
    counts[task.status] += 1;
    if (task.urgent && task.status !== 'DONE') counts.urgent += 1;
  });
  const meta = h('div', { class: 'category-meta' },
    makePill(`${counts.NTS} To start`),
    makePill(`${counts.WIP} In progress`, 'wip'),
    counts.WAIT ? makePill(`${counts.WAIT} Waiting`, 'wait') : null,
    makePill(`${counts.DONE} Done`),
    counts.urgent ? makePill(`${counts.urgent} Urgent`, 'urgent') : null
  );

  const collapseButton = h('button', {
    type: 'button',
    class: 'icon-button collapse-toggle',
    title: collapsed ? 'Expand' : 'Collapse',
    'aria-expanded': String(!collapsed),
    'aria-label': `${collapsed ? 'Expand' : 'Collapse'} ${category.name}`,
    onClick: () => toggleCollapsed(category.id)
  }, '▾');

  const grip = h('button', {
    type: 'button',
    class: 'icon-button category-grip',
    title: 'Drag to reorder categories',
    'aria-label': `Drag to reorder ${category.name}`,
    tabIndex: -1
  }, '⠿');
  const menuButton = h('button', {
    type: 'button',
    class: 'icon-button',
    title: 'Category options',
    'aria-label': `Options for ${category.name}`,
    'aria-haspopup': 'menu',
    onClick: event => openCategoryMenu(event.currentTarget, category.id)
  }, '⋯');

  const header = h('header', { class: 'category-header' },
    collapseButton,
    h('div', { class: 'category-title-wrap' },
      h('div', { class: 'category-title-row' },
        title,
        h('span', { class: 'category-count' }, `${live.length} ${live.length === 1 ? 'task' : 'tasks'}`)
      ),
      meta
    ),
    h('div', { class: 'category-actions' }, grip, menuButton)
  );
  if (touch) {
    header.addEventListener('click', event => {
      if (!event.target.closest('button')) toggleCollapsed(category.id);
    });
  }
  enableCategoryDrag(grip, card, category);

  const listWrap = h('div', { class: 'tasks-wrap' });
  if (visible.length) {
    listWrap.append(h('ul', { class: 'tasks' }, visible.map(task => buildTaskRow(task, category, { visibleIds }))));
  } else {
    listWrap.append(h('div', { class: 'empty' }, (filterText || prefs.hideDone) && live.length ? 'No matching tasks in this category.' : 'No tasks yet. Add one below.'));
  }
  enableListDrop(listWrap, category);

  card.append(header, listWrap, buildAddRow(category));
  return card;
}

function buildAddRow(category) {
  const input = h('input', {
    class: 'add-input',
    type: 'text',
    placeholder: 'Add task… try “fri 5pm !”',
    autocomplete: 'off',
    enterKeyHint: 'done',
    'aria-label': `Add task to ${category.name}`
  });
  const preview = h('div', { class: 'parse-preview', 'aria-live': 'polite' });

  const submit = () => {
    const parsed = parseInput(input.value);
    if (!parsed.text) return;
    const targetId = parsed.categoryId || category.id;
    addTask(targetId, {
      text: parsed.text, due: parsed.due, dueTime: parsed.dueTime, urgent: parsed.urgent,
      repeat: parsed.repeat, status: parsed.status || 'NTS'
    });
    input.value = '';
    preview.replaceChildren();
    renderNow();
    const target = findCategory(targetId);
    if (targetId !== category.id && target) showToast(`Added to ${target.name}`);
    const again = viewEl.querySelector(`[data-category-id="${CSS.escape(category.id)}"] .add-input`);
    if (again) again.focus();
  };

  input.addEventListener('input', () => renderParsePreview(preview, input.value ? parseInput(input.value) : null, { hideCategory: true }));
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape') {
      input.value = '';
      preview.replaceChildren();
      input.blur();
    }
  });

  return h('div', { class: 'add-row' },
    input,
    h('button', { type: 'button', class: 'add-task', title: `Add task to ${category.name}`, 'aria-label': `Add task to ${category.name}`, onClick: submit }, '+'),
    preview
  );
}

// Shows what quick-add understood (date, time, repeat, flags).
function renderParsePreview(container, parsed, { hideCategory = false } = {}) {
  if (!parsed) {
    container.replaceChildren();
    return;
  }
  const chips = [];
  if (parsed.categoryName) {
    const target = findCategory(parsed.categoryId);
    chips.push(h('span', { class: 'chip cat', dataset: { color: target ? target.color : 'ink' } }, hideCategory ? `→ ${parsed.categoryName}` : parsed.categoryName));
  }
  if (parsed.unknownCategory) chips.push(h('span', { class: 'chip warn' }, `No category “${parsed.unknownCategory}”`));
  if (parsed.due) {
    const due = Core.describeDue({ due: parsed.due, dueTime: parsed.dueTime, status: 'NTS' }, todayStr());
    chips.push(h('span', { class: `chip ${due.tone}` }, `${Core.formatDay(parsed.due)}${parsed.dueTime ? ` · ${Core.formatTime(parsed.dueTime)}` : ''}`));
  }
  if (parsed.repeat) chips.push(h('span', { class: 'chip' }, `↻ ${Core.describeRepeat(parsed.repeat)}`));
  if (parsed.urgent) chips.push(h('span', { class: 'chip urgent' }, 'Urgent'));
  if (parsed.status) chips.push(h('span', { class: `chip${parsed.status === 'WAIT' ? ' wait' : ''}` }, Core.STATUS_LABELS[parsed.status]));
  container.replaceChildren(...chips);
}

// ---------------------------------------------------------------------------
// Kanban view
// ---------------------------------------------------------------------------

function categoryRank() {
  return new Map(data.categories.map((category, index) => [category.id, index]));
}

function renderKanban() {
  const statuses = Core.STATUSES.filter(status => !(prefs.hideDone && status === 'DONE'));
  const rank = categoryRank();
  const items = Core.listTasks(data).filter(({ task, category }) => matchesFilter(task, category));
  const wrap = h('div', { class: 'kanban', style: `--cols: ${statuses.length}` });

  statuses.forEach(status => {
    const list = items.filter(x => x.task.status === status);
    if (status === 'DONE') list.sort((a, b) => (b.task.doneAt || 0) - (a.task.doneAt || 0));
    else {
      list.sort((a, b) => (Number(b.task.urgent) - Number(a.task.urgent))
        || Core.compareDue(a, b)
        || (rank.get(a.category.id) - rank.get(b.category.id))
        || (a.task.order - b.task.order));
    }

    const column = h('section', { class: 'kanban-col', dataset: { status } },
      h('header', { class: 'kanban-head' },
        h('span', { class: 'dot' }),
        h('h2', {}, Core.STATUS_LABELS[status]),
        h('span', { class: 'count' }, list.length)
      ),
      h('ul', { class: 'kanban-list' },
        list.length ? list.map(({ task, category }) => buildKanbanCard(task, category))
          : h('li', { class: 'empty' }, status === 'WAIT' ? 'Nothing waiting on others.' : 'Nothing here.'))
    );

    column.addEventListener('dragover', event => {
      if (!activeDrag || activeDrag.type !== 'task') return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      column.classList.add('drag-over');
    });
    column.addEventListener('dragleave', event => {
      if (!column.contains(event.relatedTarget)) column.classList.remove('drag-over');
    });
    column.addEventListener('drop', event => {
      if (!activeDrag || activeDrag.type !== 'task') return;
      event.preventDefault();
      column.classList.remove('drag-over');
      const drag = activeDrag;
      endDrag();
      setStatus(drag.taskId, status);
    });
    wrap.append(column);
  });
  viewEl.replaceChildren(wrap);
}

function buildKanbanCard(task, category) {
  const touch = touchQuery.matches;
  const chips = buildChips(task, category, { showCategory: true });
  const card = h('li', {
    class: `kanban-card${task.urgent ? ' urgent' : ''}${task.status === 'DONE' ? ' done' : ''}`,
    tabIndex: -1,
    dataset: { taskId: task.id, categoryId: category.id },
    'aria-label': `${task.text} — ${category.name}`,
    onClick: event => {
      if (!event.target.closest('button')) openDetails(task.id);
    }
  },
  h('div', { class: 'task-chips' }, chips),
  h('div', { class: 'card-text' }, task.text),
  h('div', { class: 'card-foot' },
    buildStatusButton(task),
    touch ? null : buildUrgentToggle(task),
    h('span', { class: 'spacer' }),
    buildMoreButton(task)
  ));

  if (!touch) {
    card.draggable = true;
    card.addEventListener('dragstart', event => {
      activeDrag = { type: 'task', taskId: task.id };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', task.text);
      setTimeout(() => card.classList.add('dragging'), 0);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      viewEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      endDrag();
    });
  }
  return card;
}

// ---------------------------------------------------------------------------
// Focus view: urgent + in progress only
// ---------------------------------------------------------------------------

function renderFocus() {
  const rank = categoryRank();
  const items = Core.listTasks(data).filter(({ task, category }) => task.status !== 'DONE' && matchesFilter(task, category));
  const sort = (a, b) => Core.compareDue(a, b) || (rank.get(a.category.id) - rank.get(b.category.id)) || (a.task.order - b.task.order);
  const urgent = items.filter(x => x.task.urgent).sort(sort);
  const inProgress = items.filter(x => !x.task.urgent && x.task.status === 'WIP').sort(sort);

  const group = (title, list, variant) => h('section', { class: `focus-group${variant ? ` ${variant}` : ''}` },
    h('h2', {}, title, h('span', { class: 'count' }, list.length)),
    h('ul', { class: 'tasks' }, list.map(({ task, category }) => buildTaskRow(task, category, { context: 'list' })))
  );

  const wrap = h('div', { class: 'focus' },
    h('p', { class: 'focus-intro' }, 'Just what needs you now: urgent work and everything in progress, across all clients.')
  );
  if (urgent.length) wrap.append(group('Urgent', urgent, 'urgent'));
  if (inProgress.length) wrap.append(group('In progress', inProgress));
  if (!urgent.length && !inProgress.length) {
    wrap.append(h('div', { class: 'empty' }, filterText ? 'No urgent or in-progress tasks match your search.' : 'Nothing urgent or in progress. Pick something from the board and mark it WIP.'));
  }
  viewEl.replaceChildren(wrap);
}

// ---------------------------------------------------------------------------
// Today / Overdue strip
// ---------------------------------------------------------------------------

function renderAgenda() {
  const today = todayStr();
  const items = Core.listTasks(data).filter(({ task, category }) => task.status !== 'DONE' && task.due && matchesFilter(task, category));
  const overdue = items.filter(x => x.task.due < today).sort(Core.compareDue);
  const dueToday = items.filter(x => x.task.due === today).sort(Core.compareDue);
  const upcoming = items.filter(x => x.task.due > today && x.task.due <= Core.addDays(today, 7)).sort(Core.compareDue);

  const upcomingToggle = upcoming.length ? h('button', {
    type: 'button',
    class: 'button small',
    'aria-expanded': String(prefs.upcomingOpen),
    onClick: () => {
      prefs.upcomingOpen = !prefs.upcomingOpen;
      savePrefs();
      renderNow();
    }
  }, `Next 7 days (${upcoming.length}) ${prefs.upcomingOpen ? '▴' : '▾'}`) : null;

  const head = h('div', { class: 'agenda-head' },
    h('h2', { class: 'agenda-title' }, 'Today'),
    h('span', { class: 'agenda-date' }, Core.formatDay(today)),
    h('span', { class: 'agenda-spacer' }),
    upcomingToggle
  );

  const group = (key, title, list, variant) => {
    const expanded = expandedAgendaGroups.has(key);
    const shown = expanded ? list : list.slice(0, AGENDA_LIMIT);
    return h('div', { class: `agenda-group${variant ? ` ${variant}` : ''}` },
      h('div', { class: 'agenda-group-title' }, `${title} · ${list.length}`),
      h('ul', { class: 'tasks' }, shown.map(({ task, category }) => buildTaskRow(task, category, { context: 'agenda' }))),
      list.length > AGENDA_LIMIT ? h('button', {
        type: 'button',
        class: 'agenda-more',
        onClick: () => {
          if (expanded) expandedAgendaGroups.delete(key);
          else expandedAgendaGroups.add(key);
          renderNow();
        }
      }, expanded ? 'Show less' : `Show ${list.length - AGENDA_LIMIT} more`) : null
    );
  };

  const groups = [];
  if (overdue.length) groups.push(group('overdue', 'Overdue', overdue, 'overdue'));
  if (dueToday.length) groups.push(group('today', 'Due today', dueToday));
  if (prefs.upcomingOpen && upcoming.length) groups.push(group('upcoming', 'Next 7 days', upcoming));

  if (!items.length && filterText) {
    agendaEl.replaceChildren();
    return;
  }

  const children = [head];
  if (!overdue.length && !dueToday.length) {
    const next = upcoming[0] || items.filter(x => x.task.due > today).sort(Core.compareDue)[0];
    children.push(h('div', { class: 'agenda-empty' },
      next
        ? h('span', {}, 'Nothing due today. Next up: ', h('strong', {}, next.task.text), ` · ${Core.describeDue(next.task, today).label}`)
        : h('span', {}, 'Nothing due. Press ', h('kbd', {}, 'N'), ' and type something like “Send invoice fri 5pm” to add a due date.')
    ));
  }
  if (groups.length) children.push(h('div', { class: 'agenda-groups' }, groups));
  agendaEl.replaceChildren(...children);
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

function clearDropMarkers() {
  document.querySelectorAll('.drop-target-above, .drop-target-below, .drag-over-list, .drop-before, .drop-after, .drag-over').forEach(el => {
    el.classList.remove('drop-target-above', 'drop-target-below', 'drag-over-list', 'drop-before', 'drop-after', 'drag-over');
  });
}

function endDrag() {
  activeDrag = null;
  clearDropMarkers();
  setTimeout(flushRender, 0);
}

function enableTaskDrag(row, task, category) {
  if (touchQuery.matches) return;
  row.draggable = true;
  row.addEventListener('dragstart', event => {
    if (isTextEditingTarget(document.activeElement) && row.contains(document.activeElement)) {
      event.preventDefault();
      return;
    }
    activeDrag = { type: 'task', taskId: task.id, categoryId: category.id };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', task.text);
    setTimeout(() => row.classList.add('dragging'), 0);
  });
  row.addEventListener('dragover', event => {
    if (!activeDrag || activeDrag.type !== 'task') return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (activeDrag.taskId === task.id) return;
    const rect = row.getBoundingClientRect();
    const above = event.clientY < rect.top + rect.height / 2;
    row.classList.toggle('drop-target-above', above);
    row.classList.toggle('drop-target-below', !above);
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target-above', 'drop-target-below'));
  row.addEventListener('drop', event => {
    if (!activeDrag || activeDrag.type !== 'task') return;
    event.preventDefault();
    event.stopPropagation();
    const before = row.classList.contains('drop-target-above');
    const drag = activeDrag;
    endDrag();
    if (drag.taskId !== task.id) moveTaskToPosition(drag.taskId, category.id, task.id, before);
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    endDrag();
  });
}

function enableListDrop(listWrap, category) {
  listWrap.addEventListener('dragover', event => {
    if (!activeDrag || activeDrag.type !== 'task') return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    listWrap.classList.add('drag-over-list');
  });
  listWrap.addEventListener('dragleave', event => {
    if (!listWrap.contains(event.relatedTarget)) listWrap.classList.remove('drag-over-list');
  });
  listWrap.addEventListener('drop', event => {
    if (!activeDrag || activeDrag.type !== 'task' || event.target.closest('li.task')) return;
    event.preventDefault();
    const drag = activeDrag;
    endDrag();
    moveTaskToPosition(drag.taskId, category.id, null);
  });
}

// Touch: drag by the ⠿ handle, with auto-scroll near the screen edges.
function enableTouchDrag(handle, row, task, category) {
  handle.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse') return;
    event.preventDefault();
    const pointerId = event.pointerId;
    try { handle.setPointerCapture(pointerId); } catch (e) {}
    activeDrag = { type: 'task', taskId: task.id, categoryId: category.id };
    row.classList.add('dragging');

    let target = null;
    let lastY = event.clientY;
    let frame = null;
    const autoScroll = () => {
      const edge = 90;
      const bottom = window.innerHeight - (narrowQuery.matches ? 64 : 0);
      if (lastY < edge) window.scrollBy(0, -12);
      else if (lastY > bottom - edge) window.scrollBy(0, 12);
      frame = requestAnimationFrame(autoScroll);
    };
    frame = requestAnimationFrame(autoScroll);

    const onMove = moveEvent => {
      lastY = moveEvent.clientY;
      clearDropMarkers();
      const el = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const targetRow = el && el.closest('li.task');
      if (targetRow && targetRow !== row && viewEl.contains(targetRow)) {
        const rect = targetRow.getBoundingClientRect();
        const before = moveEvent.clientY < rect.top + rect.height / 2;
        targetRow.classList.add(before ? 'drop-target-above' : 'drop-target-below');
        target = { taskId: targetRow.dataset.taskId, categoryId: targetRow.dataset.categoryId, before };
        return;
      }
      const card = el && el.closest('.category');
      if (card && card.dataset.categoryId && viewEl.contains(card)) {
        target = { taskId: null, categoryId: card.dataset.categoryId, before: false };
        const wrap = card.querySelector('.tasks-wrap');
        if (wrap) wrap.classList.add('drag-over-list');
      } else {
        target = null;
      }
    };

    const onUp = () => {
      cancelAnimationFrame(frame);
      try { handle.releasePointerCapture(pointerId); } catch (e) {}
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      row.classList.remove('dragging');
      const drag = activeDrag;
      endDrag();
      if (drag && target && target.taskId !== drag.taskId) {
        moveTaskToPosition(drag.taskId, target.categoryId, target.taskId, target.before);
      }
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

// Desktop: drag a category by its grip to reorder the board.
function enableCategoryDrag(grip, card, category) {
  if (touchQuery.matches) return;
  grip.draggable = true;
  grip.addEventListener('dragstart', event => {
    activeDrag = { type: 'category', categoryId: category.id };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', category.name);
    event.dataTransfer.setDragImage(card, 24, 24);
    setTimeout(() => card.classList.add('dragging'), 0);
  });
  grip.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    endDrag();
  });
  card.addEventListener('dragover', event => {
    if (!activeDrag || activeDrag.type !== 'category' || activeDrag.categoryId === category.id) return;
    event.preventDefault();
    const rect = card.getBoundingClientRect();
    const before = event.clientX < rect.left + rect.width / 2;
    card.classList.toggle('drop-before', before);
    card.classList.toggle('drop-after', !before);
  });
  card.addEventListener('dragleave', event => {
    if (!card.contains(event.relatedTarget)) card.classList.remove('drop-before', 'drop-after');
  });
  card.addEventListener('drop', event => {
    if (!activeDrag || activeDrag.type !== 'category') return;
    event.preventDefault();
    const before = card.classList.contains('drop-before');
    const drag = activeDrag;
    endDrag();
    moveCategoryToPosition(drag.categoryId, category.id, before);
  });
}

// ---------------------------------------------------------------------------
// Keyboard focus helpers
// ---------------------------------------------------------------------------

function navigableItems() {
  return [...viewEl.querySelectorAll('.task[data-task-id], .kanban-card[data-task-id]')];
}

function activeTaskElement() {
  const el = document.activeElement;
  return el && el.closest ? el.closest('[data-task-id]') : null;
}

function focusTaskElement(el) {
  if (!el) return;
  navigableItems().forEach(item => { item.tabIndex = -1; });
  el.tabIndex = 0;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  focusedTaskId = el.dataset.taskId;
}

function moveFocus(delta) {
  const items = navigableItems();
  if (!items.length) return;
  const index = items.indexOf(activeTaskElement());
  const next = index === -1 ? (delta > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, index + delta));
  focusTaskElement(items[next]);
}

function moveFocusColumn(delta) {
  const columns = [...viewEl.querySelectorAll('.category, .kanban-col')].filter(col => col.querySelector('[data-task-id]'));
  if (!columns.length) return;
  const current = activeTaskElement();
  const index = columns.indexOf(current && current.closest('.category, .kanban-col'));
  const target = columns[index === -1 ? 0 : Math.min(columns.length - 1, Math.max(0, index + delta))];
  focusTaskElement(target.querySelector('[data-task-id]'));
}

viewEl.addEventListener('focusin', event => {
  const holder = event.target.closest && event.target.closest('[data-task-id]');
  if (holder) focusedTaskId = holder.dataset.taskId;
});

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastTimer = null;

function showToast(message, { actionLabel = null, onAction = null, duration = 8000 } = {}) {
  // Inside an open modal dialog the toast must live in the dialog to be visible.
  const openDialogs = [...document.querySelectorAll('dialog[open]')];
  const parent = openDialogs[openDialogs.length - 1] || document.body;
  if (toastHost.parentElement !== parent) parent.append(toastHost);

  const toast = h('div', { class: 'toast', role: 'status' }, h('span', { class: 'toast-text' }, message));
  if (actionLabel && onAction) {
    toast.append(h('button', {
      type: 'button',
      class: 'toast-action',
      onClick: () => {
        dismissToast(toast);
        onAction();
      }
    }, actionLabel));
  }
  toastHost.replaceChildren(toast);
  const lifetime = actionLabel ? duration : 2400;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dismissToast(toast), lifetime);
  // Hovering keeps the toast (and its Undo) on screen.
  toast.addEventListener('pointerenter', () => clearTimeout(toastTimer));
  toast.addEventListener('pointerleave', () => {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dismissToast(toast), 3000);
  });
}

function dismissToast(toast) {
  toast.classList.add('leaving');
  setTimeout(() => toast.remove(), 200);
}

// ---------------------------------------------------------------------------
// Popover menus (action sheets on phones)
// ---------------------------------------------------------------------------

let popoverCleanup = null;

function openPopover(anchor, content) {
  closePopover();
  popoverEl.replaceChildren(content);
  popoverEl.hidden = false;
  popoverBackdrop.hidden = false;

  if (!narrowQuery.matches && anchor && anchor.getBoundingClientRect) {
    const rect = anchor.getBoundingClientRect();
    popoverEl.style.left = '0px';
    popoverEl.style.top = '0px';
    const width = popoverEl.offsetWidth;
    const height = popoverEl.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    popoverEl.style.left = `${left}px`;
    popoverEl.style.top = `${top}px`;
  }

  const buttons = () => [...popoverEl.querySelectorAll('button:not(:disabled)')];
  const first = popoverEl.querySelector('.menu-item:not(:disabled)') || buttons()[0];
  if (first && !touchQuery.matches) first.focus({ preventScroll: true });

  const onKey = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePopover();
      if (anchor && anchor.focus) anchor.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const list = buttons();
      const index = list.indexOf(document.activeElement);
      const next = list[(index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
      if (next) next.focus();
    }
  };
  document.addEventListener('keydown', onKey, true);
  popoverBackdrop.onclick = () => closePopover();
  popoverCleanup = () => document.removeEventListener('keydown', onKey, true);
}

function closePopover() {
  if (popoverEl.hidden) return;
  popoverEl.hidden = true;
  popoverBackdrop.hidden = true;
  popoverEl.replaceChildren();
  if (popoverCleanup) popoverCleanup();
  popoverCleanup = null;
}

function menuItem(label, onSelect, { icon = null, hint = null, danger = false, active = false, disabled = false } = {}) {
  return h('button', {
    type: 'button',
    class: `menu-item${danger ? ' danger' : ''}${active ? ' active' : ''}`,
    role: 'menuitem',
    disabled,
    onClick: () => {
      closePopover();
      onSelect();
    }
  }, icon ? h('span', { class: 'menu-icon', 'aria-hidden': 'true' }, icon) : null, h('span', {}, label), hint ? h('span', { class: 'menu-hint' }, hint) : null);
}

function openStatusMenu(anchor, taskId) {
  const found = findTask(taskId);
  if (!found) return;
  const hints = { NTS: '', WIP: '', WAIT: 'W', DONE: 'X' };
  openPopover(anchor, h('div', {},
    h('div', { class: 'menu-label' }, 'Set status'),
    Core.STATUSES.map(status => menuItem(Core.STATUS_LABELS[status], () => setStatus(taskId, status), {
      icon: STATUS_ICONS[status], active: found.task.status === status, hint: touchQuery.matches ? null : hints[status]
    }))
  ));
}

function openCategoryMenu(anchor, categoryId) {
  const category = findCategory(categoryId);
  if (!category) return;
  const index = data.categories.indexOf(category);
  const vertical = narrowQuery.matches;
  const doneCount = countDone(categoryId);
  const collapsed = Boolean(prefs.collapsed[categoryId]);

  const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Category colour' },
    Core.CATEGORY_COLORS.map(color => h('button', {
      type: 'button',
      class: 'swatch',
      role: 'radio',
      title: color,
      dataset: { color },
      'aria-label': color,
      'aria-checked': String(category.color === color),
      onClick: () => {
        closePopover();
        setCategoryColor(categoryId, color);
      }
    }))
  );

  openPopover(anchor, h('div', {},
    h('div', { class: 'menu-label' }, category.name),
    menuItem('Rename', () => renameCategoryInteractive(categoryId), { icon: '✎' }),
    menuItem('Add task here', () => openQuickAdd({ categoryId }), { icon: '+' }),
    h('div', { class: 'menu-label' }, 'Colour'),
    swatches,
    h('div', { class: 'menu-sep' }),
    menuItem(vertical ? 'Move up' : 'Move left', () => moveCategory(categoryId, -1), { icon: vertical ? '↑' : '←', disabled: index <= 0 }),
    menuItem(vertical ? 'Move down' : 'Move right', () => moveCategory(categoryId, 1), { icon: vertical ? '↓' : '→', disabled: index >= data.categories.length - 1 }),
    menuItem(collapsed ? 'Expand' : 'Collapse', () => toggleCollapsed(categoryId), { icon: collapsed ? '▾' : '▸' }),
    menuItem(`Archive done tasks (${doneCount})`, () => archiveDone(categoryId), { icon: '⤓', disabled: !doneCount }),
    h('div', { class: 'menu-sep' }),
    menuItem('Delete category', () => {
      const taskLabel = category.tasks.length === 1 ? '1 task' : `${category.tasks.length} tasks`;
      if (confirm(`Delete “${category.name}” and its ${taskLabel}?`)) deleteCategory(categoryId);
    }, { icon: '×', danger: true })
  ));
}

function renameCategoryInteractive(categoryId) {
  const title = viewEl.querySelector(`[data-category-id="${CSS.escape(categoryId)}"] .category-title[contenteditable="true"]`);
  if (title) {
    title.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(title);
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  openRenameDialog(categoryId);
}

function createCategoryInteractive() {
  if (touchQuery.matches) {
    openRenameDialog(null);
    return;
  }
  if (prefs.view !== 'board') setView('board');
  const category = addCategory('New Category');
  renderNow();
  requestAnimationFrame(() => renameCategoryInteractive(category.id));
}
