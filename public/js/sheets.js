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
// Morning digest
// ---------------------------------------------------------------------------

async function digestApi(action, method = 'GET') {
  const res = await fetch(`/api/digest?action=${encodeURIComponent(action)}`, {
    method,
    headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify({ action }) : undefined
  });
  if (res.status === 401) throw new Error('Please unlock the board first.');
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !body.errors) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function openDigestPanel() {
  const deviceTz = deviceTimezone();
  const statusList = h('ul', { class: 'status-list' }, h('li', {}, 'Checking server settings…'));
  const result = h('p', { role: 'status' });
  const preview = h('pre', { class: 'report-output' }, Core.buildDigest(data, { today: todayStr() }).text);

  const tzLine = h('div', { class: 'sheet-actions' });
  const drawTz = () => {
    const saved = data.settings.timezone;
    setChildren(tzLine,
      h('span', { class: 'meta-line' }, `Timezone for “today”: ${saved || 'not set yet (UTC)'}`),
      deviceTz && deviceTz !== saved ? h('button', {
        type: 'button', class: 'button small',
        onClick: () => {
          commit(board => { board.settings.timezone = deviceTz; }, { render: false });
          drawTz();
        }
      }, `Use ${deviceTz}`) : null
    );
  };
  drawTz();

  const line = (ok, label) => h('li', {}, h('span', { class: ok ? 'ok' : 'no' }, ok ? '✓' : '○'), label);
  digestApi('status').then(status => {
    setChildren(statusList,
      line(status.channels.telegram, status.channels.telegram ? 'Telegram connected' : status.telegramTokenSet ? 'Telegram bot set — add TELEGRAM_CHAT_ID' : 'Telegram not set up'),
      line(status.channels.email, status.channels.email ? 'Email connected' : 'Email not set up (optional)'),
      line(true, 'Daily schedule is active (8:00 AM IST)'),
      status.ownerOnly ? h('li', {}, 'Personal digests for each team member are coming soon.') : null
    );
  }).catch(err => {
    statusList.replaceChildren(h('li', {}, `Could not reach the server: ${err.message}`));
  });

  const sendButton = h('button', { type: 'button', class: 'button primary' }, 'Send test now');
  sendButton.addEventListener('click', async () => {
    sendButton.disabled = true;
    result.textContent = 'Sending…';
    try {
      const body = await digestApi('send', 'POST');
      result.textContent = body.ok ? `Sent via ${body.sent.join(' and ')}.` : (body.errors || ['Not sent']).join(' ');
    } catch (err) {
      result.textContent = err.message;
    } finally {
      sendButton.disabled = false;
    }
  });

  const chatsButton = h('button', { type: 'button', class: 'button' }, 'Find my Telegram chat ID');
  chatsButton.addEventListener('click', async () => {
    result.textContent = 'Looking up chats…';
    try {
      const body = await digestApi('telegram-chats');
      if (body.error) throw new Error(body.error);
      result.textContent = body.chats.length
        ? `Chats that messaged your bot: ${body.chats.map(c => `${c.name || c.type} → ${c.id}`).join(', ')}. Put the number in TELEGRAM_CHAT_ID.`
        : 'No chats yet. Open your bot in Telegram, press Start, send it any message, then try again.';
    } catch (err) {
      result.textContent = err.message;
    }
  });

  openPanel(
    sheetHead('Morning digest'),
    h('p', {}, 'Every morning (about 8:00 AM India time) you get a message with what is overdue, due today, urgent and waiting. Free plans can deliver it up to an hour late.'),
    statusList,
    tzLine,
    h('div', { class: 'sheet-section' }, h('h4', {}, 'Preview'), preview),
    h('div', { class: 'sheet-actions' }, chatsButton, h('span', { class: 'spacer' }), sendButton),
    result,
    h('details', { class: 'setup' },
      h('summary', {}, 'How to set it up (5 minutes)'),
      h('ol', {},
        h('li', {}, 'In Telegram, message ', h('code', {}, '@BotFather'), ', send ', h('code', {}, '/newbot'), ' and copy the token it gives you.'),
        h('li', {}, 'In Cloudflare → Workers & Pages → zawish-workboard → Settings → Variables and Secrets, add a secret ', h('code', {}, 'TELEGRAM_BOT_TOKEN'), '.'),
        h('li', {}, 'Open your new bot in Telegram and send it “hi”.'),
        h('li', {}, 'Click “Find my Telegram chat ID” here, then add it as the secret ', h('code', {}, 'TELEGRAM_CHAT_ID'), '.'),
        h('li', {}, 'Optional email: add ', h('code', {}, 'RESEND_API_KEY'), ' and ', h('code', {}, 'DIGEST_EMAIL_TO'), ' (free account at resend.com).')
      )
    )
  );
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
    isInstalledApp() ? null : menuItem('Install app on this device', installApp, { icon: '⇩' }),
    menuItem('Weekly report', openReportPanel, { icon: '▤' }),
    menuItem(`Archive done tasks (${doneCount})`, () => archiveDone(), { icon: '⤓', disabled: !doneCount }),
    menuItem(`Archived tasks (${archivedCount})`, openArchivePanel, { icon: '▣' }),
    menuItem('Morning digest', openDigestPanel, { icon: '☼' }),
    narrowQuery.matches ? menuItem('New category', createCategoryInteractive, { icon: '+' }) : null,
    h('div', { class: 'menu-sep' }),
    h('div', { class: 'menu-label' }, 'Theme'),
    h('div', { class: 'menu-segmented' }, themeControl),
    h('div', { class: 'menu-sep' }),
    menuItem('Backup & restore', openBackupPanel, { icon: '⇅' }),
    menuItem('Sync status', openSyncPanel, { icon: '⟳' }),
    touchQuery.matches ? null : menuItem('Keyboard shortcuts', openShortcutsPanel, { icon: '⌘', hint: '?' }),
    menuItem('Sign out of this device', lockBoard, { icon: '🔒' })
  ));
}
