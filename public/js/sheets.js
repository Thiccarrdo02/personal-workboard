/* ZAWISH Workboard — sheets: task details, quick add, and panels (archive, report, digest, backup, sync, shortcuts). */

const detailsDialog = document.getElementById('detailsDialog');
const panelDialog = document.getElementById('panelDialog');
const quickAddDialog = document.getElementById('quickAddDialog');
const quickAddForm = document.getElementById('quickAddForm');
const quickAddInput = document.getElementById('quickAddInput');
const quickAddPreview = document.getElementById('quickAddPreview');
const quickAddCategory = document.getElementById('quickAddCategory');

const REPEAT_OPTIONS = [
  ['', 'Does not repeat'],
  ['daily:1', 'Daily'],
  ['weekdays:1', 'Every weekday'],
  ['weekly:1', 'Weekly'],
  ['weekly:2', 'Every 2 weeks'],
  ['monthly:1', 'Monthly'],
  ['monthly:3', 'Every 3 months'],
  ['yearly:1', 'Yearly']
];

// Dialog niceties: click outside to close, [data-close] buttons.
[detailsDialog, panelDialog, quickAddDialog].forEach(dialog => {
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
    else if (event.target.closest('[data-close]')) dialog.close();
  });
});

function autosize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

function isTextField(el) {
  return Boolean(el && el.matches && el.matches('input[type="text"], input:not([type]), textarea, [contenteditable="true"]'));
}

function sheetHead(title, extra = null) {
  return h('div', { class: 'sheet-head' },
    h('h3', {}, title),
    extra,
    h('button', { type: 'button', class: 'icon-button sheet-close', 'data-close': '', 'aria-label': 'Close' }, '×')
  );
}

function formatStamp(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function prettyUrl(url) {
  const short = url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
  return short.length > 42 ? `${short.slice(0, 41)}…` : short;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const area = h('textarea', { style: 'position:fixed;opacity:0' });
    area.value = text;
    (document.querySelector('dialog[open]') || document.body).append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  showToast('Copied to clipboard');
}

// ---------------------------------------------------------------------------
// Task details
// ---------------------------------------------------------------------------

let detailsTaskId = null;
let detailsFlush = null;

function openDetails(taskId, { focus = null } = {}) {
  if (!findTask(taskId)) return;
  closePopover();
  if (detailsDialog.open && detailsTaskId !== taskId && detailsFlush) detailsFlush();
  detailsTaskId = taskId;
  buildDetails();
  if (!detailsDialog.open) detailsDialog.showModal();

  if (focus === 'due') {
    const dateInput = detailsDialog.querySelector('input[type="date"]');
    if (dateInput) {
      dateInput.focus();
      try { dateInput.showPicker(); } catch (e) {}
    }
  } else if (focus === 'title') {
    const title = detailsDialog.querySelector('.details-title');
    if (title) title.focus();
  } else {
    detailsDialog.querySelector('.sheet-close').focus();
  }
}

detailsDialog.addEventListener('close', () => {
  if (detailsFlush) detailsFlush();
  detailsFlush = null;
  const id = detailsTaskId;
  detailsTaskId = null;
  renderNow();
  // Return keyboard focus to the task in the board.
  const row = id && viewEl.querySelector(`[data-task-id="${CSS.escape(id)}"]`);
  if (row && !touchQuery.matches) focusTaskElement(row);
});

// Called after remote merges and undo: rebuild unless the user is typing in the sheet.
function refreshOpenDetails() {
  if (!detailsDialog.open || !detailsTaskId) return;
  if (!findTask(detailsTaskId)) {
    detailsDialog.close();
    return;
  }
  if (detailsDialog.contains(document.activeElement) && isTextField(document.activeElement)) return;
  buildDetails();
}

function buildDetails() {
  const found = findTask(detailsTaskId);
  if (!found) return;
  const { task, category } = found;
  const id = task.id;
  const previousScroll = detailsDialog.querySelector('.sheet-inner');
  const scrollTop = previousScroll ? previousScroll.scrollTop : 0;

  const refresh = () => {
    if (findTask(id)) buildDetails();
    else detailsDialog.close();
  };
  const update = (mutator, options) => {
    updateTask(id, mutator, options);
    refresh();
  };

  // Title
  const title = h('textarea', { class: 'details-title', rows: 1, spellcheck: true, 'aria-label': 'Task name' });
  title.value = task.text;
  const saveTitle = () => {
    const next = Core.cleanText(title.value);
    const current = findTask(id);
    if (!current) return;
    if (!next) {
      title.value = current.task.text;
      return;
    }
    if (next !== current.task.text) updateTask(id, t => { t.text = next; });
  };
  title.addEventListener('input', () => autosize(title));
  title.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      title.blur();
    }
  });
  title.addEventListener('blur', saveTitle);

  // Status + urgent
  const statusControl = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Status' },
    Core.STATUSES.map(status => h('button', {
      type: 'button',
      dataset: { status },
      'aria-pressed': String(task.status === status),
      onClick: () => {
        setStatus(id, status);
        refresh();
      }
    }, Core.STATUS_LABELS[status]))
  );
  const urgentButton = h('button', {
    type: 'button',
    class: `button small${task.urgent ? ' danger' : ''}`,
    'aria-pressed': String(task.urgent),
    onClick: () => {
      toggleUrgent(id);
      refresh();
    }
  }, task.urgent ? '! Urgent' : '! Mark urgent');

  // Due date & time
  const today = todayStr();
  const dateInput = h('input', { type: 'date', value: task.due || '', 'aria-label': 'Due date' });
  dateInput.addEventListener('change', () => update(t => {
    t.due = Core.isValidDay(dateInput.value) ? dateInput.value : null;
    if (!t.due) t.dueTime = null;
  }));
  const timeInput = h('input', { type: 'time', value: task.dueTime || '', 'aria-label': 'Due time', disabled: !task.due });
  timeInput.addEventListener('change', () => update(t => { t.dueTime = Core.isValidTime(timeInput.value) ? timeInput.value : null; }));
  const quickDate = (label, day) => h('button', {
    type: 'button',
    class: `chip${task.due === day ? ' today' : ''}`,
    onClick: () => update(t => { t.due = day; })
  }, label);
  const dueChips = h('div', { class: 'task-chips', style: 'padding:0' },
    quickDate('Today', today),
    quickDate('Tomorrow', Core.addDays(today, 1)),
    quickDate('Next Mon', Core.addDays(Core.startOfWeek(today), 7)),
    quickDate('In a week', Core.addDays(today, 7)),
    task.due ? h('button', { type: 'button', class: 'chip', onClick: () => update(t => { t.due = null; t.dueTime = null; }) }, 'Clear') : null
  );

  // Repeat
  const repeatKey = task.repeat ? `${task.repeat.freq}:${task.repeat.interval}` : '';
  const options = REPEAT_OPTIONS.some(([key]) => key === repeatKey) ? REPEAT_OPTIONS : [...REPEAT_OPTIONS, [repeatKey, Core.describeRepeat(task.repeat)]];
  const repeatSelect = h('select', { 'aria-label': 'Repeat' },
    options.map(([key, label]) => h('option', { value: key, selected: key === repeatKey }, label))
  );
  repeatSelect.addEventListener('change', () => update(t => {
    if (!repeatSelect.value) {
      t.repeat = null;
      return;
    }
    const [freq, interval] = repeatSelect.value.split(':');
    if (!t.due) t.due = todayStr();
    const anchor = freq === 'monthly' || freq === 'yearly' ? Number(t.due.slice(8, 10)) : undefined;
    t.repeat = Core.normalizeRepeat({ freq, interval: Number(interval), anchor });
  }));

  // Category
  const categorySelect = h('select', { 'aria-label': 'Category' },
    data.categories.map(c => h('option', { value: c.id, selected: c.id === category.id }, c.name))
  );
  categorySelect.addEventListener('change', () => {
    moveTaskToCategory(id, categorySelect.value);
    refresh();
  });

  // Checklist
  const doneItems = task.checklist.filter(item => item.done).length;
  const checklist = h('ul', { class: 'checklist' }, task.checklist.map(item => {
    const box = h('input', { type: 'checkbox', checked: item.done, 'aria-label': `Done: ${item.text}` });
    box.addEventListener('change', () => update(t => {
      const it = t.checklist.find(x => x.id === item.id);
      if (it) it.done = box.checked;
    }));
    const text = h('input', { type: 'text', value: item.text, 'aria-label': 'Checklist item' });
    const saveItem = () => {
      const next = Core.cleanText(text.value);
      updateTask(id, t => {
        const it = t.checklist.find(x => x.id === item.id);
        if (!it || it.text === next) return false;
        if (!next) t.checklist = t.checklist.filter(x => x.id !== item.id);
        else it.text = next;
      });
    };
    text.addEventListener('blur', saveItem);
    text.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        text.blur();
      }
    });
    const remove = h('button', {
      type: 'button', class: 'icon-button', 'aria-label': `Remove ${item.text}`,
      onClick: () => update(t => { t.checklist = t.checklist.filter(x => x.id !== item.id); })
    }, '×');
    return h('li', { class: item.done ? 'done' : '' }, box, text, remove);
  }));
  const newItem = h('input', { type: 'text', placeholder: '+ Add a checklist item', 'aria-label': 'New checklist item', enterKeyHint: 'enter' });
  newItem.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const text = Core.cleanText(newItem.value);
    if (!text) return;
    update(t => { t.checklist.push({ id: Core.makeId('item'), text, done: false }); });
    const again = detailsDialog.querySelector('.checklist-new');
    if (again) again.focus();
  });
  newItem.classList.add('checklist-new');

  // Notes + links
  const notes = h('textarea', { rows: 4, placeholder: 'Notes, links, details…', 'aria-label': 'Notes' });
  notes.value = task.notes;
  const links = h('div', { class: 'link-list' });
  const renderLinks = () => links.replaceChildren(...Core.extractLinks(notes.value).map(url => h('a', {
    class: 'link-chip', href: url, target: '_blank', rel: 'noopener noreferrer', title: url
  }, `↗ ${prettyUrl(url)}`)));
  renderLinks();
  let notesTimer = null;
  const saveNotes = () => {
    clearTimeout(notesTimer);
    const value = notes.value.replace(/\s+$/, '');
    updateTask(id, t => {
      if (t.notes === value) return false;
      t.notes = value;
    });
  };
  notes.addEventListener('input', () => {
    renderLinks();
    autosize(notes);
    clearTimeout(notesTimer);
    notesTimer = setTimeout(saveNotes, 800);
  });
  notes.addEventListener('blur', saveNotes);

  detailsFlush = () => {
    saveTitle();
    saveNotes();
  };

  // History
  const sinceStatus = task.statusAt && task.status !== 'DONE' ? ` · ${Core.STATUS_LABELS[task.status].toLowerCase()} for ${Core.ageInDays(task.statusAt)}d` : '';
  const meta = h('div', { class: 'meta-line' },
    `Created ${formatStamp(task.createdAt)} · Started ${formatStamp(task.startedAt)} · Done ${formatStamp(task.doneAt)}${sinceStatus}`,
    h('br'),
    `Last changed ${formatStamp(task.updatedAt)}${task.archivedAt ? ` · Archived ${formatStamp(task.archivedAt)}` : ''}`
  );

  // Actions
  const actions = h('div', { class: 'sheet-actions' },
    h('button', {
      type: 'button', class: 'button small danger',
      onClick: () => {
        detailsDialog.close();
        deleteTask(id);
      }
    }, 'Delete'),
    task.archivedAt
      ? h('button', { type: 'button', class: 'button small', onClick: () => { restoreTask(id); refresh(); } }, 'Restore to board')
      : task.status === 'DONE'
        ? h('button', {
          type: 'button', class: 'button small',
          onClick: () => {
            detailsDialog.close();
            updateTask(id, t => { t.archivedAt = Date.now(); }, { undoLabel: 'Task archived' });
          }
        }, 'Archive')
        : null,
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'button primary', 'data-close': '' }, 'Done')
  );

  const inner = h('div', { class: 'sheet-inner' },
    h('div', { class: 'sheet-head' },
      h('span', { class: 'chip cat', dataset: { color: category.color } }, category.name),
      h('span', { class: 'agenda-spacer' }),
      h('button', { type: 'button', class: 'icon-button sheet-close', 'data-close': '', 'aria-label': 'Close' }, '×')
    ),
    title,
    h('div', { class: 'sheet-actions' }, statusControl, urgentButton),
    h('div', { class: 'details-grid' },
      h('span', { class: 'label' }, 'Due'),
      h('div', { class: 'value' }, dateInput, timeInput),
      h('span', { class: 'label' }),
      h('div', { class: 'value' }, dueChips),
      h('span', { class: 'label' }, 'Repeat'),
      h('div', { class: 'value' }, repeatSelect, task.repeat ? h('span', { class: 'hint' }, 'Marking it done creates the next one.') : null),
      h('span', { class: 'label' }, 'Category'),
      h('div', { class: 'value' }, categorySelect)
    ),
    h('div', { class: 'sheet-section' },
      h('h4', {}, task.checklist.length ? `Checklist · ${doneItems}/${task.checklist.length}` : 'Checklist'),
      task.checklist.length ? h('div', { class: 'checklist-progress' }, h('span', { style: `width:${Math.round(doneItems / task.checklist.length * 100)}%` })) : null,
      checklist,
      newItem
    ),
    h('div', { class: 'sheet-section' }, h('h4', {}, 'Notes & links'), notes, links),
    meta,
    actions
  );

  detailsDialog.replaceChildren(inner);
  autosize(title);
  requestAnimationFrame(() => {
    autosize(title);
    if (notes.value) autosize(notes);
  });
  inner.scrollTop = scrollTop;
}

// ---------------------------------------------------------------------------
// Quick add
// ---------------------------------------------------------------------------

function openQuickAdd({ categoryId = null, text = '' } = {}) {
  closePopover();
  if (!data.categories.length) addCategory('Inbox');
  const selected = categoryId || (findCategory(prefs.lastCategoryId) ? prefs.lastCategoryId : data.categories[0].id);
  quickAddCategory.replaceChildren(...data.categories.map(c => h('option', { value: c.id, selected: c.id === selected }, c.name)));
  quickAddInput.value = text;
  updateQuickAddPreview();
  if (!quickAddDialog.open) quickAddDialog.showModal();
  quickAddInput.focus();
}

function updateQuickAddPreview() {
  const value = quickAddInput.value.trim();
  renderParsePreview(quickAddPreview, value ? parseInput(value) : null, { hideCategory: true });
}

function submitQuickAdd(keepOpen) {
  const parsed = parseInput(quickAddInput.value);
  if (!parsed.text) {
    quickAddInput.focus();
    return;
  }
  const categoryId = parsed.categoryId || quickAddCategory.value;
  const task = addTask(categoryId, {
    text: parsed.text, due: parsed.due, dueTime: parsed.dueTime, urgent: parsed.urgent,
    repeat: parsed.repeat, status: parsed.status || 'NTS'
  });
  if (!task) return;
  const category = findCategory(categoryId);
  const due = task.due ? ` · ${Core.describeDue(task, todayStr()).label}` : '';
  if (keepOpen) {
    quickAddInput.value = '';
    updateQuickAddPreview();
    quickAddInput.focus();
  } else {
    quickAddDialog.close();
  }
  showToast(`Added to ${category ? category.name : 'board'}${due}`, {
    actionLabel: 'Open',
    onAction: () => openDetails(task.id)
  });
}

quickAddInput.addEventListener('input', updateQuickAddPreview);
quickAddInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    submitQuickAdd(true);
  }
});
quickAddForm.addEventListener('submit', event => {
  event.preventDefault();
  submitQuickAdd(false);
});

// ---------------------------------------------------------------------------
// Generic panel dialog
// ---------------------------------------------------------------------------

function openPanel(...children) {
  closePopover();
  panelDialog.replaceChildren(h('div', { class: 'sheet-inner' }, children));
  if (!panelDialog.open) panelDialog.showModal();
}

function openRenameDialog(categoryId) {
  const category = categoryId ? findCategory(categoryId) : null;
  const input = h('input', { type: 'text', value: category ? category.name : '', placeholder: 'e.g. Acme Co', 'aria-label': 'Category name', enterKeyHint: 'done' });
  const save = () => {
    const name = Core.cleanText(input.value);
    if (!name) {
      input.focus();
      return;
    }
    if (category) renameCategory(category.id, name);
    else {
      if (prefs.view !== 'board') setView('board');
      addCategory(name);
    }
    panelDialog.close();
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    }
  });
  openPanel(
    sheetHead(category ? 'Rename category' : 'New category'),
    input,
    h('div', { class: 'sheet-actions' }, h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'button', 'data-close': '' }, 'Cancel'),
      h('button', { type: 'button', class: 'button primary', onClick: save }, category ? 'Save' : 'Create'))
  );
  input.focus();
  input.select();
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

function openArchivePanel() {
  let query = '';
  const body = h('div', { class: 'sheet-section' });
  const search = h('input', { type: 'search', placeholder: 'Search archive', 'aria-label': 'Search archive' });
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    draw();
  });

  const draw = () => {
    const archived = Core.listTasks(data, { includeArchived: true }).filter(x => x.task.archivedAt);
    const doneCount = countDone();
    const matching = archived.filter(x => !query || x.task.text.toLowerCase().includes(query) || x.category.name.toLowerCase().includes(query));
    const groups = data.categories.map(category => ({
      category,
      items: matching.filter(x => x.category.id === category.id).sort((a, b) => b.task.archivedAt - a.task.archivedAt)
    })).filter(g => g.items.length);

    setChildren(body,
      h('div', { class: 'sheet-actions' },
        h('button', {
          type: 'button', class: 'button small', disabled: !doneCount,
          onClick: () => { archiveDone(); draw(); }
        }, `Archive done tasks now (${doneCount})`),
        h('span', { class: 'spacer' }),
        archived.length ? h('button', {
          type: 'button', class: 'button small danger',
          onClick: () => {
            if (!confirm(`Permanently delete all ${archived.length} archived tasks? Weekly reports will no longer include them.`)) return;
            commit(board => {
              board.categories.forEach(c => { c.tasks = c.tasks.filter(t => !t.archivedAt); });
            }, { undoLabel: 'Archive emptied' });
            draw();
          }
        }, 'Delete all') : null
      ),
      archived.length > 6 ? search : null,
      groups.length ? groups.map(g => [
        h('div', { class: 'archive-group-title' }, `${g.category.name} · ${g.items.length}`),
        h('ul', { class: 'archive-list' }, g.items.map(({ task }) => h('li', { class: 'archive-item' },
          h('div', {},
            h('div', { class: 'text' }, task.text),
            h('div', { class: 'when' }, `${task.doneAt ? `Done ${formatStamp(task.doneAt)} · ` : ''}archived ${formatStamp(task.archivedAt)}`)
          ),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'button small', onClick: () => { restoreTask(task.id); draw(); } }, 'Restore'),
            h('button', {
              type: 'button', class: 'icon-button', title: 'Delete permanently', 'aria-label': `Delete ${task.text} permanently`,
              onClick: () => { deleteTask(task.id); draw(); }
            }, '×')
          )
        )))
      ]) : h('div', { class: 'empty' }, query ? 'No archived tasks match.' : 'Nothing archived yet. Archiving done tasks keeps the board clean; they still count in weekly reports.')
    );
  };

  draw();
  openPanel(sheetHead('Archive'), h('p', {}, 'Done tasks you have cleared off the board. Restore one to bring it back.'), body);
}

// ---------------------------------------------------------------------------
// Weekly report
// ---------------------------------------------------------------------------

function openReportPanel() {
  const today = todayStr();
  const thisWeek = Core.startOfWeek(today);
  const state = { range: 'this', categoryId: '', start: Core.addDays(today, -6), end: today };
  const output = h('pre', { class: 'report-output' });
  const totals = h('p', {});
  const custom = h('div', { class: 'sheet-actions' });
  let report = null;

  const ranges = [['this', 'This week'], ['last', 'Last week'], ['7', 'Last 7 days'], ['custom', 'Custom']];
  const rangeControl = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Period' });
  const categorySelect = h('select', { 'aria-label': 'Client' },
    h('option', { value: '' }, 'All clients'),
    data.categories.map(c => h('option', { value: c.id }, c.name))
  );
  categorySelect.addEventListener('change', () => {
    state.categoryId = categorySelect.value;
    draw();
  });

  const startInput = h('input', { type: 'date', value: state.start, 'aria-label': 'From' });
  const endInput = h('input', { type: 'date', value: state.end, 'aria-label': 'To' });
  startInput.addEventListener('change', () => { state.start = startInput.value || state.start; draw(); });
  endInput.addEventListener('change', () => { state.end = endInput.value || state.end; draw(); });
  custom.append(h('span', { class: 'field-inline' }, 'From'), startInput, h('span', { class: 'field-inline' }, 'to'), endInput);

  const draw = () => {
    let start;
    let end;
    if (state.range === 'this') [start, end] = [thisWeek, Core.addDays(thisWeek, 6)];
    else if (state.range === 'last') [start, end] = [Core.addDays(thisWeek, -7), Core.addDays(thisWeek, -1)];
    else if (state.range === '7') [start, end] = [Core.addDays(today, -6), today];
    else [start, end] = state.start <= state.end ? [state.start, state.end] : [state.end, state.start];

    rangeControl.replaceChildren(...ranges.map(([key, label]) => h('button', {
      type: 'button', 'aria-pressed': String(state.range === key),
      onClick: () => { state.range = key; draw(); }
    }, label)));
    custom.hidden = state.range !== 'custom';

    report = Core.buildReport(data, { start, end, today, categoryId: state.categoryId || null });
    output.textContent = report.text;
    totals.textContent = `${report.totals.completed} completed · ${report.totals.inProgress} in progress · ${report.totals.waiting} waiting`;
  };
  draw();

  openPanel(
    sheetHead('Weekly report'),
    h('p', {}, 'What you finished per client, plus what is in progress, waiting and coming up. Copy it into WhatsApp, email or Slack as a status update.'),
    h('div', { class: 'sheet-actions' }, rangeControl, categorySelect),
    custom,
    totals,
    output,
    h('div', { class: 'sheet-actions' },
      h('span', { class: 'spacer' }),
      navigator.share ? h('button', {
        type: 'button', class: 'button',
        onClick: () => navigator.share({ text: report.text }).catch(() => {})
      }, 'Share…') : null,
      h('button', { type: 'button', class: 'button primary', onClick: () => copyText(report.text) }, 'Copy text')
    )
  );
}

// ---------------------------------------------------------------------------
// Notifications: connect Telegram and choose the morning digest
// ---------------------------------------------------------------------------

async function meApi(path, body = null) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }, body: JSON.stringify(body) }
    : { headers: { Authorization: `Bearer ${authToken}` }, cache: 'no-store' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const DIGEST_TIMES = ['06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '12:00'];

function openNotificationsPanel() {
  let state = null;
  let linkUrl = null;
  let linkRequested = false;
  let poll = null;
  const status = h('div', { class: 'sheet-section' }, h('p', {}, 'Loading…'));
  const result = h('p', { role: 'status' });
  const settingsBox = h('div', { class: 'sheet-section' });
  const previewBox = h('pre', { class: 'report-output' });

  const stopWatching = () => {
    clearInterval(poll);
    poll = null;
  };

  const load = async () => {
    state = await meApi('/api/notifications');
    draw();
  };

  const save = async patch => {
    try {
      state = await meApi('/api/notifications', { action: 'save', ...state.settings, ...patch, timezone: deviceTimezone() });
      draw();
      showToast('Saved');
    } catch (err) {
      showToast(err.message);
    }
  };

  // After tapping Connect, wait for the "Start" tap in Telegram.
  const startWatching = () => {
    stopWatching();
    let tries = 0;
    poll = setInterval(async () => {
      tries += 1;
      if (tries > 60 || !panelDialog.open) {
        stopWatching();
        return;
      }
      try {
        const next = await meApi('/api/notifications');
        if (next.connected) {
          stopWatching();
          state = next;
          draw();
          showToast('Telegram connected');
        }
      } catch (e) {}
    }, 3000);
  };

  // The link is fetched ahead of time so the Connect tap opens Telegram directly.
  const getLink = async () => {
    linkRequested = true;
    try {
      linkUrl = (await meApi('/api/notifications', { action: 'link', timezone: deviceTimezone() })).url;
    } catch (err) {
      result.textContent = err.message;
    }
    draw();
  };

  const drawStatus = () => {
    if (!state.botReady) {
      if (!isOwner()) {
        status.replaceChildren(h('p', {}, `Telegram isn’t set up yet. Ask ${state.owner} to activate the bot.`));
        return;
      }
      const activate = h('button', { type: 'button', class: 'button primary' }, 'Activate bot');
      activate.addEventListener('click', async () => {
        activate.disabled = true;
        result.textContent = 'Activating…';
        try {
          await meApi('/api/notifications', { action: 'activate' });
          result.textContent = '';
          showToast('Bot activated');
          await load();
        } catch (err) {
          result.textContent = err.message;
          activate.disabled = false;
        }
      });
      status.replaceChildren(
        h('h4', {}, 'Set up the Telegram bot (once)'),
        h('ol', { class: 'steps' },
          h('li', {}, 'In Telegram, open ', h('strong', {}, '@BotFather'), ', send ', h('code', {}, '/newbot'), ', name it “ZAWISH Workboard” and pick a username ending in “bot”.'),
          h('li', {}, 'Add the token it gives you as the secret ', h('code', {}, 'TELEGRAM_BOT_TOKEN'), ' in Cloudflare.'),
          h('li', {}, 'Come back here and tap Activate.')),
        h('div', { class: 'sheet-actions' }, activate)
      );
      return;
    }

    if (!state.connected) {
      if (!linkUrl && !linkRequested) getLink();
      status.replaceChildren(
        h('p', {}, `Link your Telegram to get your morning digest${isOwner() ? ' and join requests' : ''}. Only you receive your messages.`),
        h('div', { class: 'sheet-actions' },
          linkUrl
            ? h('a', { class: 'button primary', href: linkUrl, target: '_blank', rel: 'noopener noreferrer', onClick: startWatching }, 'Connect Telegram')
            : h('button', { type: 'button', class: 'button primary', onClick: getLink }, 'Connect Telegram'),
          linkUrl ? h('span', { class: 'meta-line' }, 'Telegram opens: tap Start, then come back here.') : null)
      );
      return;
    }

    const test = h('button', { type: 'button', class: 'button' }, 'Send me a test');
    test.addEventListener('click', async () => {
      test.disabled = true;
      try {
        await meApi('/api/notifications', { action: 'test' });
        showToast('Sent. Check Telegram.');
      } catch (err) {
        showToast(err.message);
      } finally {
        test.disabled = false;
      }
    });
    const unlink = h('button', { type: 'button', class: 'button danger' }, 'Disconnect');
    unlink.addEventListener('click', async () => {
      if (!confirm('Disconnect Telegram? You’ll stop getting messages.')) return;
      state = await meApi('/api/notifications', { action: 'disconnect' });
      linkUrl = null;
      linkRequested = false;
      draw();
    });
    status.replaceChildren(
      h('div', { class: 'connected-row' }, h('span', { class: 'ok-dot', 'aria-hidden': 'true' }), `Connected to Telegram as ${state.telegramName || 'you'}`),
      h('div', { class: 'sheet-actions' }, test, unlink)
    );
  };

  const drawSettings = () => {
    if (!state.botReady) {
      settingsBox.replaceChildren();
      return;
    }
    const s = state.settings;
    const times = DIGEST_TIMES.includes(s.time) ? DIGEST_TIMES : [...DIGEST_TIMES, s.time].sort();
    const timeSelect = h('select', { 'aria-label': 'Digest time' }, times.map(time => h('option', { value: time, selected: time === s.time }, Core.formatTime(time))));
    timeSelect.addEventListener('change', () => save({ time: timeSelect.value }));
    const choice = (label, key, options) => h('div', { class: 'segmented', role: 'group', 'aria-label': label },
      options.map(([value, text]) => h('button', { type: 'button', 'aria-pressed': String(s[key] === value), onClick: () => save({ [key]: value }) }, text)));
    const enabled = h('input', { type: 'checkbox', checked: s.enabled });
    enabled.addEventListener('change', () => save({ enabled: enabled.checked }));
    const skip = h('input', { type: 'checkbox', checked: s.skipEmpty });
    skip.addEventListener('change', () => save({ skipEmpty: skip.checked }));

    setChildren(settingsBox,
      h('h4', {}, 'Morning digest'),
      h('label', { class: 'check-row' }, enabled, h('span', {}, 'Send me a morning digest on Telegram')),
      h('div', { class: 'details-grid' },
        h('span', { class: 'label' }, 'Time'),
        h('div', { class: 'value' }, timeSelect, h('span', { class: 'meta-line' }, (s.timezone || deviceTimezone() || '').replace(/_/g, ' '))),
        h('span', { class: 'label' }, 'Days'),
        h('div', { class: 'value' }, choice('Days', 'days', [['mon-sat', 'Mon–Sat'], ['daily', 'Every day'], ['mon-fri', 'Mon–Fri']])),
        h('span', { class: 'label' }, 'Detail'),
        h('div', { class: 'value' }, choice('Detail', 'mode', [['full', 'Task names'], ['counts', 'Counts only']]))),
      h('label', { class: 'check-row' }, skip, h('span', {}, 'Skip days when nothing is overdue or due')),
      isOwner() ? h('p', {}, 'As the owner you also get join requests here with Approve / Reject buttons, plus a note when someone joins or deletes their account.') : null,
      h('h4', {}, 'Preview'),
      previewBox
    );
    previewBox.textContent = Core.buildDigest(data, { today: todayStr(), name: currentUser ? currentUser.name : '', mode: s.mode }).text;
  };

  const draw = () => {
    if (!state) return;
    drawStatus();
    drawSettings();
  };

  openPanel(
    sheetHead('Notifications'),
    h('p', {}, 'Your morning digest on Telegram: what’s overdue, due today, urgent and waiting. Only you receive your digest.'),
    status,
    result,
    settingsBox
  );
  panelDialog.addEventListener('close', stopWatching, { once: true });
  load().catch(err => status.replaceChildren(h('p', {}, `Couldn’t load your settings: ${err.message}`)));
}

// ---------------------------------------------------------------------------
// Your data: download, devices, delete account
// ---------------------------------------------------------------------------

function openDataPanel() {
  const devicesBox = h('div', { class: 'sheet-section' }, h('p', {}, 'Loading your devices…'));
  const deleteBox = h('div', { class: 'sheet-section' });

  const drawDevices = async () => {
    try {
      const { devices } = await meApi('/api/me/devices');
      const others = devices.filter(device => !device.current).length;
      setChildren(devicesBox,
        h('h4', {}, `Signed-in devices · ${devices.length}`),
        h('ul', { class: 'member-list' }, devices.map(device => h('li', { class: 'device-row' },
          h('div', { class: 'member-name' }, device.device, device.current ? h('span', { class: 'member-meta' }, ' · this device') : null),
          h('div', { class: 'member-meta' }, `Last used ${relativeTime(device.lastUsedAt)} · signed in ${formatStamp(device.signedInAt)}`)))),
        others ? h('div', { class: 'sheet-actions' }, h('button', {
          type: 'button', class: 'button',
          onClick: async () => {
            if (!confirm(`Sign out ${others} other ${others === 1 ? 'device' : 'devices'}? They’ll need your PIN again.`)) return;
            await meApi('/api/me/devices', {});
            showToast('Other devices signed out');
            drawDevices();
          }
        }, 'Sign out all other devices')) : null
      );
    } catch (err) {
      devicesBox.replaceChildren(h('p', {}, `Couldn’t load your devices: ${err.message}`));
    }
  };

  const download = async () => {
    const exported = await meApi('/api/me/export');
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const name = (currentUser ? currentUser.name : 'me').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const link = h('a', { href: url, download: `zawish-workboard-${name}-data-${todayStr()}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  if (isOwner()) {
    setChildren(deleteBox, h('h4', {}, 'Delete account'), h('p', {}, 'You’re the owner, so this account can’t be deleted. The team always needs an admin.'));
  } else {
    const pin = h('input', { type: 'password', class: 'pin-field', inputMode: 'numeric', maxLength: 6, autocomplete: 'off', placeholder: 'Your 6-digit PIN', 'aria-label': 'Your PIN' });
    const go = h('button', { type: 'button', class: 'button danger' }, 'Delete my account forever');
    go.addEventListener('click', async () => {
      if (!/^\d{6}$/.test(pin.value)) {
        pin.focus();
        showToast('Enter your 6-digit PIN to confirm.');
        return;
      }
      if (!confirm('Delete your account and board permanently? This can’t be undone.')) return;
      go.disabled = true;
      try {
        await meApi('/api/me/delete', { pin: pin.value });
        panelDialog.close();
        deactivateUser();
        applyIdentity();
        renderNow();
        showLockScreen('Your account and board were deleted. Thanks for being on the team.');
      } catch (err) {
        pin.value = '';
        showToast(err.message);
        go.disabled = false;
      }
    });
    setChildren(deleteBox,
      h('h4', {}, 'Delete account'),
      h('p', {}, 'Permanently deletes your board, your devices and your Telegram link. This can’t be undone, so download your data first if you want a copy.'),
      h('div', { class: 'sheet-actions' }, pin, go));
  }

  openPanel(
    sheetHead('Your data'),
    h('p', {}, 'Everything ZAWISH Workboard keeps about you: your profile, your board, your devices and your notification settings. Nobody else can see your board.'),
    h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'button primary', onClick: () => download().catch(err => showToast(err.message)) }, 'Download my data')),
    devicesBox,
    deleteBox
  );
  drawDevices();
}

// ---------------------------------------------------------------------------
// Backup, sync, shortcuts
// ---------------------------------------------------------------------------

function openBackupPanel() {
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const [file] = fileInput.files;
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      if (!imported || !Array.isArray(imported.categories)) throw new Error('bad file');
      if (!confirm('Replace the whole board with this backup? You can undo right after.')) return;
      replaceBoard(imported);
      panelDialog.close();
    } catch (error) {
      alert('That file does not look like a valid Workboard backup.');
    } finally {
      fileInput.value = '';
    }
  });

  openPanel(
    sheetHead('Backup your workboard'),
    h('p', {}, 'Your board saves on this device instantly and syncs to the cloud. Export a backup file now and then for safekeeping.'),
    fileInput,
    h('div', { class: 'sheet-actions' },
      h('button', { type: 'button', class: 'button', onClick: () => fileInput.click() }, 'Import backup'),
      h('span', { class: 'spacer' }),
      h('button', {
        type: 'button', class: 'button primary',
        onClick: () => {
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = h('a', { href: url, download: `zawish-workboard-${(currentUser ? currentUser.name : 'board').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${todayStr()}.json` });
          document.body.append(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(url);
        }
      }, 'Export backup')
    )
  );
}

function openSyncPanel() {
  const detail = h('p', {});
  const draw = () => {
    const last = syncMeta.lastSyncedAt ? formatStamp(syncMeta.lastSyncedAt) : 'not yet';
    const who = currentUser ? `Signed in as ${currentUser.name}. ` : '';
    detail.textContent = `${who}${sync.detail || 'Status: ' + sync.status}. Last synced ${last}. ${syncMeta.dirty ? 'This device has changes waiting to upload.' : 'No pending changes on this device.'}`;
  };
  draw();
  openPanel(
    sheetHead('Cloud sync'),
    h('p', {}, 'Your board syncs automatically across your phone, PC and laptop. Edits made on different devices are merged task by task, so nothing gets overwritten. Signing out removes your board from this device until you sign in again.'),
    detail,
    h('div', { class: 'sheet-actions' },
      h('button', { type: 'button', class: 'button', onClick: () => { panelDialog.close(); lockBoard(); } }, 'Sign out of this device'),
      h('span', { class: 'spacer' }),
      h('button', {
        type: 'button', class: 'button primary',
        onClick: async () => {
          await pullRemote({ manual: true });
          if (syncMeta.dirty) await pushRemote();
          draw();
        }
      }, 'Sync now')
    )
  );
}

function openShortcutsPanel() {
  const rows = [
    [['N'], ['Ctrl', 'K']], 'Quick add a task',
    [['/']], 'Search',
    [['1'], ['2'], ['3']], 'Board · Kanban · Focus view',
    [['J'], ['K']], 'Next / previous task (or ↓ ↑)',
    [['H'], ['L']], 'Previous / next column (or ← →)',
    [['Enter']], 'Open task details',
    [['E']], 'Edit task name',
    [['Space']], 'Next status (To start → In progress → Done)',
    [['W']], 'Toggle Waiting',
    [['X']], 'Toggle Done',
    [['U']], 'Toggle urgent',
    [['D']], 'Set due date',
    [['Shift', '↑'], ['Shift', '↓']], 'Move task up / down',
    [['Del']], 'Delete task',
    [['Z'], ['Ctrl', 'Z']], 'Undo',
    [['C']], 'New category',
    [['Esc']], 'Close / stop editing'
  ];
  const list = h('dl', { class: 'shortcut-list' });
  for (let i = 0; i < rows.length; i += 2) {
    const combos = rows[i].map(combo => h('span', {}, combo.map((key, k) => [k ? '+' : '', h('kbd', {}, key)])));
    list.append(h('dt', {}, combos.map((combo, c) => [c ? ' ' : '', combo])), h('dd', {}, rows[i + 1]));
  }
  openPanel(sheetHead('Keyboard shortcuts'), list);
}

// ---------------------------------------------------------------------------
// Team (owner only): add members, approve requests, rename / reset / remove.
// Shows names and last activity only, never anyone's tasks.
// ---------------------------------------------------------------------------

let teamPending = null;

function isOwner() {
  return Boolean(currentUser && currentUser.role === 'owner');
}

// Badge on the More buttons; a toast when a new request arrives.
function updateTeamBadge(count) {
  if (!isOwner()) count = 0;
  const previous = teamPending;
  teamPending = count;
  for (const button of [document.getElementById('moreButton'), document.getElementById('navMore')]) {
    button.classList.toggle('has-badge', count > 0);
    button.dataset.badge = count > 0 ? String(count) : '';
  }
  if (previous !== null && count > previous) {
    showToast(count === 1 ? 'Someone is waiting to join your team' : `${count} people are waiting to join`, {
      actionLabel: 'Review',
      onAction: () => openTeamPanel()
    });
  }
}

// Called whenever the signed-in person changes, so nobody sees the owner's badge.
function resetTeamBadge() {
  updateTeamBadge(0);
  teamPending = null;
}

async function teamApi(body = null) {
  const res = await fetch('/api/team', body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }, body: JSON.stringify(body) }
    : { headers: { Authorization: `Bearer ${authToken}` }, cache: 'no-store' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function relativeTime(ts) {
  if (!ts) return 'never';
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} ${days === 1 ? 'day' : 'days'} ago` : formatStamp(ts);
}

// The link to send someone, with Copy / WhatsApp / Share.
function shareLinkBox(result) {
  const first = result.user.name.split(/\s+/)[0];
  const link = `${location.origin}/#setup=${result.token}`;
  const message = result.purpose === 'reset'
    ? `Hi ${first}, here’s a link to set a new PIN for ZAWISH Workboard: ${link}\nIt works once and expires in 3 days.`
    : `Hi ${first}, you’re invited to ZAWISH Workboard: ${link}\nOpen it, choose a 6-digit PIN, and you’ll get your own private board. The link works once and expires in 3 days.`;
  const field = h('input', { type: 'text', readOnly: true, value: link, 'aria-label': 'Link', onFocus: event => event.target.select() });
  return h('div', { class: 'share-box' },
    h('p', {}, h('strong', {}, result.purpose === 'reset' ? `New PIN link for ${result.user.name}` : `Invite link for ${result.user.name}`),
      ' · works once, expires in 3 days. Send it only to them.'),
    field,
    h('div', { class: 'sheet-actions' },
      h('a', { class: 'button primary', href: `https://wa.me/?text=${encodeURIComponent(message)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Send on WhatsApp'),
      h('button', { type: 'button', class: 'button', onClick: () => copyText(message) }, 'Copy message'),
      navigator.share ? h('button', { type: 'button', class: 'button', onClick: () => navigator.share({ text: message }).catch(() => {}) }, 'Share…') : null
    )
  );
}

function openTeamPanel({ focusAdd = false } = {}) {
  if (!isOwner()) return;
  const shareArea = h('div');
  const list = h('div', { class: 'sheet-section' }, h('p', {}, 'Loading the team…'));
  const nameInput = h('input', { type: 'text', placeholder: 'Their name, e.g. Ali Khan', maxLength: 40, 'aria-label': 'New member name', enterKeyHint: 'done' });
  const addButton = h('button', { type: 'button', class: 'button primary' }, 'Create invite link');

  const act = async (body, button) => {
    if (button) button.disabled = true;
    try {
      const result = await teamApi(body);
      await draw();
      return result;
    } catch (err) {
      showToast(err.message);
      if (button) button.disabled = false;
      return null;
    }
  };

  const add = async () => {
    const name = nameInput.value.replace(/\s+/g, ' ').trim();
    if (name.length < 2) {
      nameInput.focus();
      return;
    }
    const result = await act({ action: 'add', name }, addButton);
    addButton.disabled = false;
    if (result) {
      nameInput.value = '';
      shareArea.replaceChildren(shareLinkBox(result));
    }
  };
  addButton.addEventListener('click', add);
  nameInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      add();
    }
  });

  const showLink = async (member, button) => {
    const result = await act({ action: 'link', userId: member.id }, button);
    if (result) shareArea.replaceChildren(shareLinkBox(result));
    shareArea.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const draw = async () => {
    let team;
    try {
      team = await teamApi();
    } catch (err) {
      list.replaceChildren(h('p', {}, `Couldn’t load the team: ${err.message}`));
      return;
    }
    updateTeamBadge(team.requests.length);

    const requests = team.requests.map(request => h('li', { class: 'member-row' },
      h('span', { class: 'profile-avatar', 'aria-hidden': 'true' }, initials(request.name)),
      h('div', { class: 'member-info' },
        h('div', { class: 'member-name' }, request.name),
        h('div', { class: 'member-meta' }, `${request.note ? `“${request.note}” · ` : ''}asked ${relativeTime(request.requestedAt)}`)),
      h('div', { class: 'member-actions' },
        h('button', { type: 'button', class: 'button small primary', onClick: event => act({ action: 'approve', userId: request.id }, event.currentTarget) }, 'Approve'),
        h('button', {
          type: 'button', class: 'button small danger',
          onClick: event => {
            if (confirm(`Reject ${request.name}’s request?`)) act({ action: 'reject', userId: request.id }, event.currentTarget);
          }
        }, 'Reject'))));

    const members = team.members.map(member => {
      const you = currentUser && member.id === currentUser.id;
      const status = member.role === 'owner' && you ? 'Owner · you'
        : !member.hasPin ? 'Hasn’t set a PIN yet'
          : member.lastActiveAt ? `Active ${relativeTime(member.lastActiveAt)}` : 'Not opened yet';
      return h('li', { class: 'member-row' },
        h('span', { class: 'profile-avatar', 'aria-hidden': 'true' }, initials(member.name)),
        h('div', { class: 'member-info' },
          h('div', { class: 'member-name' }, member.name),
          h('div', { class: 'member-meta' }, status, member.locked ? ' · locked after wrong PINs' : '')),
        h('div', { class: 'member-actions' },
          h('button', { type: 'button', class: 'button small', onClick: event => showLink(member, event.currentTarget) }, member.hasPin ? 'Reset PIN' : 'Invite link'),
          h('button', {
            type: 'button', class: 'button small',
            onClick: event => {
              const name = prompt(`Rename ${member.name} to:`, member.name);
              if (name && name.trim() && name.trim() !== member.name) act({ action: 'rename', userId: member.id, name: name.trim() }, event.currentTarget);
            }
          }, 'Rename'),
          member.role === 'owner' ? null : h('button', {
            type: 'button', class: 'button small danger',
            onClick: event => {
              if (confirm(`Remove ${member.name}? Their board is deleted permanently and they’re signed out everywhere.`)) {
                act({ action: 'remove', userId: member.id }, event.currentTarget);
              }
            }
          }, 'Remove')));
    });

    setChildren(list,
      team.requests.length ? h('h4', {}, `Waiting for approval · ${team.requests.length}`) : null,
      team.requests.length ? h('ul', { class: 'member-list' }, requests) : null,
      h('h4', {}, `Members · ${team.members.length}`),
      h('ul', { class: 'member-list' }, members)
    );
  };

  openPanel(
    sheetHead('Team'),
    h('p', {}, 'Everyone gets their own private board. Here you see who’s on the team and when they were last active, never their tasks.'),
    h('div', { class: 'sheet-section' },
      h('h4', {}, 'Add member'),
      h('div', { class: 'sheet-actions add-member-row' }, nameInput, addButton),
      shareArea),
    list
  );
  draw();
  if (focusAdd) nameInput.focus();
}

// ---------------------------------------------------------------------------
// Install as an app
// ---------------------------------------------------------------------------

// Chrome, Edge and Android offer a native install dialog; iPhone needs steps.
let installPrompt = null;

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  showToast('Workboard installed on this device');
});

function isInstalledApp() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function devicePlatform() {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) return /CriOS|EdgiOS|FxiOS/.test(ua) ? 'ios-other' : 'ios-safari';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

async function installApp() {
  const prompt = installPrompt;
  if (prompt) {
    installPrompt = null;
    try {
      await prompt.prompt();
      await prompt.userChoice;
      return;
    } catch (err) {
      // The browser refused the dialog; show the manual steps instead.
    }
  }
  openInstallPanel();
}

function openInstallPanel() {
  const steps = {
    'ios-safari': ['iPhone / iPad (Safari)', [
      'Tap the Share button: a square with an arrow pointing up. It’s in the bottom toolbar, or inside the ⋯ button next to the address bar on newer iPhones.',
      'Scroll down and tap “Add to Home Screen”.',
      'Tap “Add”. Workboard now opens like an app.'
    ]],
    'ios-other': ['iPhone / iPad (Chrome or Edge)', [
      'Tap the Share button in the address bar (a square with an arrow pointing up).',
      'Tap “Add to Home Screen”, then “Add”.',
      'Don’t see it? Open board.zawish.si in Safari and follow the Safari steps.'
    ]],
    android: ['Android (Chrome)', [
      'Tap ⋮ (three dots, top right).',
      'Tap “Install app” or “Add to Home screen”.',
      'Confirm with “Install”.'
    ]],
    desktop: ['Computer (Chrome or Edge)', [
      'Chrome: click the install icon at the right end of the address bar (a screen with a down arrow), or ⋮ → Cast, save and share → Install page as app.',
      'Edge: ⋯ → Apps → Install this site as an app.',
      'Workboard then opens in its own window, from your Start menu or Dock.'
    ]]
  };
  const mine = devicePlatform();
  const order = [mine, ...Object.keys(steps).filter(key => key !== mine)];
  openPanel(
    sheetHead('Install Workboard'),
    h('p', {}, isInstalledApp()
      ? 'You’re already using the installed app on this device.'
      : 'Put Workboard on your home screen so it opens full-screen like a normal app, even offline.'),
    order.map((key, index) => h('details', { class: 'setup', open: index === 0 },
      h('summary', {}, `${steps[key][0]}${key === mine ? ' · this device' : ''}`),
      h('ol', {}, steps[key][1].map(text => h('li', {}, text)))))
  );
}

// ---------------------------------------------------------------------------
// More menu
// ---------------------------------------------------------------------------

function openMoreMenu(anchor) {
  const doneCount = countDone();
  const archivedCount = Core.listTasks(data, { includeArchived: true }).filter(x => x.task.archivedAt).length;
  const themeControl = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Theme' });
  const drawTheme = () => themeControl.replaceChildren(...[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([key, label]) => h('button', {
    type: 'button', 'aria-pressed': String(prefs.theme === key),
    onClick: () => {
      prefs.theme = key;
      savePrefs();
      applyTheme();
      drawTheme();
    }
  }, label)));
  drawTheme();

  openPopover(anchor, h('div', {},
    currentUser ? h('div', { class: 'menu-label' }, `Signed in as ${currentUser.name}`) : null,
    isOwner() ? menuItem(teamPending ? `Team · ${teamPending} waiting` : 'Team', () => openTeamPanel(), { icon: '◍', hint: teamPending ? '●' : null }) : null,
    isOwner() ? menuItem('Add member', () => openTeamPanel({ focusAdd: true }), { icon: '+' }) : null,
    isOwner() ? h('div', { class: 'menu-sep' }) : null,
    isInstalledApp() ? null : menuItem('Install app on this device', installApp, { icon: '⇩' }),
    menuItem('Weekly report', openReportPanel, { icon: '▤' }),
    menuItem(`Archive done tasks (${doneCount})`, () => archiveDone(), { icon: '⤓', disabled: !doneCount }),
    menuItem(`Archived tasks (${archivedCount})`, openArchivePanel, { icon: '▣' }),
    menuItem('Notifications', openNotificationsPanel, { icon: '✉' }),
    narrowQuery.matches ? menuItem('New category', createCategoryInteractive, { icon: '+' }) : null,
    h('div', { class: 'menu-sep' }),
    h('div', { class: 'menu-label' }, 'Theme'),
    h('div', { class: 'menu-segmented' }, themeControl),
    h('div', { class: 'menu-sep' }),
    menuItem('Your data', openDataPanel, { icon: '⇣' }),
    menuItem('Backup & restore', openBackupPanel, { icon: '⇅' }),
    menuItem('Sync status', openSyncPanel, { icon: '⟳' }),
    touchQuery.matches ? null : menuItem('Keyboard shortcuts', openShortcutsPanel, { icon: '⌘', hint: '?' }),
    menuItem('Switch profile', switchProfile, { icon: '⇄' }),
    menuItem('Sign out of this device', lockBoard, { icon: '🔒' })
  ));
}
