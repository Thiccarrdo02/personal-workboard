const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../public/js/core.js');

// Wednesday, 21 Oct 2026
const TODAY = '2026-10-21';
const categories = [
  { id: 'acme', name: 'Acme' },
  { id: 'studio', name: 'Studio' },
  { id: 'studio-apps-work', name: 'Studio Apps work' },
  { id: 'north', name: 'North Works' }
];
const parse = (text, extra = {}) => Core.parseQuickAdd(text, { today: TODAY, categories, ...extra });

test('date helpers', () => {
  assert.equal(Core.weekdayOf(TODAY), 3);
  assert.equal(Core.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(Core.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(Core.addMonths('2026-02-28', 1, 31), '2026-03-31');
  assert.equal(Core.startOfWeek(TODAY), '2026-10-19');
  assert.equal(Core.daysBetween('2026-10-21', '2026-10-24'), 3);
  assert.equal(Core.formatDay('2026-10-23'), 'Fri 23 Oct');
  assert.equal(Core.formatTime('17:30'), '5:30pm');
  assert.equal(Core.formatTime('00:00'), '12am');
  assert.equal(Core.isValidDay('2026-02-30'), false);
  assert.equal(Core.dayInTimeZone(new Date('2026-10-21T20:00:00Z'), 'Asia/Kolkata'), '2026-10-22');
  assert.equal(Core.formatRange('2026-10-19', '2026-10-25'), '19–25 Oct 2026');
});

test('describeDue', () => {
  const due = (d, extra = {}) => Core.describeDue({ due: d, status: 'NTS', ...extra }, TODAY);
  assert.deepEqual(due('2026-10-19'), { label: '2d overdue', tone: 'overdue', diff: -2 });
  assert.equal(due('2026-10-20').label, 'Yesterday');
  assert.equal(due(TODAY, { dueTime: '17:00' }).label, 'Today 5pm');
  assert.equal(due('2026-10-22').label, 'Tomorrow');
  assert.equal(due('2026-10-23').label, 'Fri');
  assert.equal(due('2026-11-05').label, '5 Nov');
  assert.equal(due('2027-01-05').label, '5 Jan 2027');
  assert.equal(due('2026-10-19', { status: 'DONE' }).tone, 'done');
  assert.equal(Core.describeDue({ due: null }, TODAY), null);
});

test('quick add: the example from the roadmap', () => {
  const r = parse('Invoice Sam fri !');
  assert.equal(r.text, 'Invoice Sam');
  assert.equal(r.due, '2026-10-23');
  assert.equal(r.urgent, true);
});

test('quick add: categories, status, times', () => {
  let r = parse('Fix SEO #acme tmr 5pm');
  assert.equal(r.text, 'Fix SEO');
  assert.equal(r.categoryId, 'acme');
  assert.equal(r.due, '2026-10-22');
  assert.equal(r.dueTime, '17:00');

  assert.equal(parse('x #studio').categoryId, 'studio');
  assert.equal(parse('x #studioa').categoryId, 'studio-apps-work');
  assert.equal(parse('x #north').categoryId, 'north');

  r = parse('Call #nobody');
  assert.equal(r.categoryId, null);
  assert.equal(r.unknownCategory, 'nobody');
  assert.equal(r.text, 'Call #nobody');

  r = parse('Review contract @waiting');
  assert.equal(r.status, 'WAIT');
  assert.equal(r.text, 'Review contract');

  r = parse('Standup at 9:30am');
  assert.equal(r.dueTime, '09:30');
  assert.equal(r.due, TODAY);
  assert.equal(r.text, 'Standup');

  assert.equal(parse('Lunch 1 pm').dueTime, '13:00');
  assert.equal(parse('Ship by 12am').dueTime, '00:00');
});

test('quick add: date forms', () => {
  assert.equal(parse('a today').due, TODAY);
  assert.equal(parse('a tomorrow').due, '2026-10-22');
  assert.equal(parse('a wed').due, TODAY);
  assert.equal(parse('a next fri').due, '2026-10-30');
  assert.equal(parse('a next mon').due, '2026-10-26');
  assert.equal(parse('a next week').due, '2026-10-26');
  assert.equal(parse('a next month').due, '2026-11-01');
  assert.equal(parse('a in 3 days').due, '2026-10-24');
  assert.equal(parse('a in 2w').due, '2026-11-04');
  assert.equal(parse('a 25 oct').due, '2026-10-25');
  assert.equal(parse('a oct 25th').due, '2026-10-25');
  assert.equal(parse('a 5 jan').due, '2027-01-05');
  assert.equal(parse('a 25/10').due, '2026-10-25');
  assert.equal(parse('a 10/25', { dateOrder: 'MDY' }).due, '2026-10-25');
  assert.equal(parse('a 2026-12-01').due, '2026-12-01');
  assert.equal(parse('a on fri').text, 'a');
  assert.equal(parse('a weekend').due, '2026-10-24');
});

test('quick add: leaves ordinary words alone', () => {
  for (const text of ['Work on design', 'Next steps doc', 'In progress notes', 'May need review', 'Buy 2 apples', 'Talio Blender BOX Rutba']) {
    const r = parse(text);
    assert.equal(r.text, text, text);
    assert.equal(r.due, null, text);
  }
});

test('quick add: recurrence', () => {
  let r = parse('Invoices every month');
  assert.deepEqual(r.repeat, { freq: 'monthly', interval: 1, anchor: 21 });
  assert.equal(r.due, TODAY);
  assert.equal(r.text, 'Invoices');

  r = parse('Gym every monday 7am');
  assert.deepEqual(r.repeat, { freq: 'weekly', interval: 1 });
  assert.equal(r.due, '2026-10-26');
  assert.equal(r.dueTime, '07:00');

  assert.deepEqual(parse('x every 2 weeks').repeat, { freq: 'weekly', interval: 2 });
  assert.deepEqual(parse('x daily').repeat, { freq: 'daily', interval: 1 });
  assert.deepEqual(parse('x every weekday').repeat, { freq: 'weekdays', interval: 1 });
  assert.deepEqual(parse('x every other week').repeat, { freq: 'weekly', interval: 2 });
  assert.equal(parse('x every month 1 nov').due, '2026-11-01');
});

test('recurrence: next occurrence', () => {
  assert.equal(Core.nextOccurrence({ freq: 'daily', interval: 1 }, '2026-10-21'), '2026-10-22');
  assert.equal(Core.nextOccurrence({ freq: 'weekdays', interval: 1 }, '2026-10-23'), '2026-10-26');
  assert.equal(Core.nextOccurrence({ freq: 'monthly', interval: 1, anchor: 31 }, '2026-01-31'), '2026-02-28');
  assert.equal(Core.nextOccurrence({ freq: 'monthly', interval: 1, anchor: 31 }, '2026-02-28'), '2026-03-31');
  assert.equal(Core.nextOccurrence({ freq: 'yearly', interval: 1 }, '2026-10-21'), '2027-10-21');
  // Completing an overdue recurring task skips to the first date after today.
  assert.equal(Core.nextDueAfterCompletion({ due: '2026-10-01', repeat: { freq: 'weekly', interval: 1 } }, TODAY), '2026-10-22');
  assert.equal(Core.nextDueAfterCompletion({ due: null, repeat: { freq: 'daily', interval: 1 } }, TODAY), '2026-10-22');
});

test('spawnNextOccurrence resets checklist and keeps settings', () => {
  const task = Core.makeTask({ text: 'Invoices', due: '2026-10-21', dueTime: '10:00', urgent: true, repeat: { freq: 'monthly', interval: 1 },
    checklist: [{ id: 'i1', text: 'Sam', done: true }] }, 1000);
  const next = Core.spawnNextOccurrence(task, TODAY, 2000);
  assert.equal(next.due, '2026-11-21');
  assert.equal(next.dueTime, '10:00');
  assert.equal(next.urgent, true);
  assert.equal(next.status, 'NTS');
  assert.equal(next.checklist[0].done, false);
  assert.notEqual(next.checklist[0].id, 'i1');
  assert.equal(next.repeat.anchor, 21);
});

function legacyBoard() {
  return {
    version: 2,
    categories: [
      { id: 'c1', name: 'Acme', tasks: [
        { id: 't1', text: 'One', status: 'WIP', urgent: false },
        { id: 't2', text: 'Two', status: 'DONE', urgent: true }
      ] },
      { id: 'c2', name: 'Studio', tasks: [{ id: 't3', text: 'Three', status: 'NTS' }] }
    ]
  };
}

test('normalizeData migrates v2 boards', () => {
  const data = Core.normalizeData(legacyBoard(), { now: 5000 });
  assert.equal(data.version, 3);
  assert.deepEqual(data.categories.map(c => c.order), [0, 1]);
  const [t1, t2] = data.categories[0].tasks;
  assert.equal(t1.order, 0);
  assert.equal(t2.order, 1);
  assert.equal(t1.updatedAt, 0);
  assert.equal(t1.startedAt, 5000);
  assert.equal(t1.statusAt, 5000);
  assert.equal(t2.doneAt, null);
  assert.equal(data.categories[0].color, 'ink');
  assert.deepEqual(data.deleted, {});
  // v3 data round-trips unchanged
  assert.deepEqual(Core.normalizeData(Core.clone(data)), data);
  // garbage in → empty board
  assert.deepEqual(Core.normalizeData(null).categories, []);
});

test('stampChanges records edits, deletions and no-ops', () => {
  const before = Core.normalizeData(legacyBoard(), { now: 1 });
  const after = Core.clone(before);
  assert.equal(Core.stampChanges(before, Core.clone(before), 100), false, 'no-op');

  after.categories[0].tasks[0].text = 'One edited';
  after.categories[1].tasks = [];
  assert.equal(Core.stampChanges(before, after, 100), true);
  assert.equal(after.categories[0].tasks[0].updatedAt, 100);
  assert.equal(after.categories[0].tasks[1].updatedAt, 0, 'untouched task keeps its stamp');
  assert.equal(after.deleted.t3, 100);

  // moving a task between categories counts as a change to that task
  const moved = Core.clone(before);
  const [task] = moved.categories[0].tasks.splice(1, 1);
  moved.categories[1].tasks.push(task);
  Core.stampChanges(before, moved, 200);
  assert.equal(task.updatedAt, 200);
  assert.equal(moved.deleted.t2, undefined);
});

test('mergeData: independent edits on two devices both survive', () => {
  const base = Core.normalizeData(legacyBoard(), { now: 1 });
  const phone = Core.clone(base);
  const pc = Core.clone(base);

  phone.categories[0].tasks[0].text = 'Edited on phone';
  Core.stampChanges(base, phone, 100);

  pc.categories[1].tasks.push(Core.makeTask({ id: 't4', text: 'Added on PC', order: 1 }, 200));
  pc.categories[0].tasks[1].urgent = false;
  Core.stampChanges(base, pc, 200);

  const merged = Core.mergeData(phone, pc);
  const texts = merged.categories.flatMap(c => c.tasks.map(t => t.text));
  assert.deepEqual(texts, ['Edited on phone', 'Two', 'Three', 'Added on PC']);
  assert.equal(merged.categories[0].tasks[1].urgent, false);
  // merge is symmetric in content
  assert.deepEqual(Core.mergeData(pc, phone).categories, merged.categories);
});

test('mergeData: newer edit wins, deletions stick, undo beats tombstone', () => {
  const base = Core.normalizeData(legacyBoard(), { now: 1 });
  const a = Core.clone(base);
  const b = Core.clone(base);
  a.categories[0].tasks[0].text = 'A';
  Core.stampChanges(base, a, 100);
  b.categories[0].tasks[0].text = 'B';
  Core.stampChanges(base, b, 200);
  assert.equal(Core.mergeData(a, b).categories[0].tasks[0].text, 'B');
  assert.equal(Core.mergeData(b, a).categories[0].tasks[0].text, 'B');

  // deleted on one device, untouched on the other → stays deleted
  const del = Core.clone(base);
  del.categories[1].tasks = [];
  Core.stampChanges(base, del, 300);
  const merged = Core.mergeData(base, del, { now: 1000 });
  assert.equal(merged.categories[1].tasks.length, 0);
  assert.equal(merged.deleted.t3, 300);

  // restoring (undo) after the deletion brings it back everywhere
  const restored = Core.clone(merged);
  restored.categories[1].tasks.push(Core.clone(base.categories[1].tasks[0]));
  Core.stampChanges(merged, restored, 400);
  assert.equal(Core.mergeData(del, restored, { now: 1000 }).categories[1].tasks.length, 1);
});

test('mergeData: tasks in a category deleted elsewhere are rescued', () => {
  const base = Core.normalizeData(legacyBoard(), { now: 1 });
  const a = Core.clone(base);
  a.categories.pop();
  Core.stampChanges(base, a, 100);
  const b = Core.clone(base);
  b.categories[1].tasks.push(Core.makeTask({ id: 'late', text: 'Added after delete', order: 5 }, 200));
  Core.stampChanges(base, b, 200);
  const merged = Core.mergeData(a, b);
  assert.equal(merged.categories.length, 1);
  assert.ok(merged.categories[0].tasks.some(t => t.id === 'late'));
  assert.ok(!merged.categories[0].tasks.some(t => t.id === 't3'));
});

test('orderBetween', () => {
  assert.equal(Core.orderBetween(undefined, undefined), 0);
  assert.equal(Core.orderBetween(3, undefined), 4);
  assert.equal(Core.orderBetween(undefined, 3), 2);
  assert.equal(Core.orderBetween(1, 2), 1.5);
});

test('applyStatus tracks timestamps', () => {
  const task = Core.makeTask({ text: 'x' }, 10);
  assert.equal(Core.applyStatus(task, 'NTS', 20), false);
  Core.applyStatus(task, 'WIP', 30);
  assert.equal(task.startedAt, 30);
  Core.applyStatus(task, 'WAIT', 40);
  assert.equal(task.statusAt, 40);
  Core.applyStatus(task, 'DONE', 50);
  assert.equal(task.doneAt, 50);
  assert.equal(task.startedAt, 30);
  Core.applyStatus(task, 'NTS', 60);
  assert.equal(task.doneAt, null);
});

test('extractLinks', () => {
  assert.deepEqual(Core.extractLinks('See https://play.google.com/console, and (https://x.com/a).'), ['https://play.google.com/console', 'https://x.com/a']);
});

function sampleBoard() {
  const now = Date.parse('2026-10-21T06:00:00Z');
  const t = (fields) => Core.makeTask(fields, now);
  return Core.normalizeData({
    version: 3,
    categories: [
      { id: 'h', name: 'Acme', order: 0, tasks: [
        t({ id: 'a', text: 'Overdue thing', due: '2026-10-19', order: 0 }),
        t({ id: 'b', text: 'Due today', due: TODAY, dueTime: '15:00', order: 1 }),
        { ...t({ id: 'c', text: 'Shipped it', status: 'DONE', order: 2 }), doneAt: Date.parse('2026-10-20T10:00:00Z') },
        { ...t({ id: 'd', text: 'Old win', status: 'DONE', order: 3 }), doneAt: Date.parse('2026-10-01T10:00:00Z'), archivedAt: now }
      ] },
      { id: 'z', name: 'Studio', order: 1, tasks: [
        t({ id: 'e', text: 'Client review', status: 'WAIT', order: 0 }),
        t({ id: 'f', text: 'Urgent edit', urgent: true, status: 'WIP', order: 1 }),
        t({ id: 'g', text: 'Next week', due: '2026-10-23', order: 2 })
      ] }
    ]
  });
}

test('buildDigest', () => {
  const digest = Core.buildDigest(sampleBoard(), { today: TODAY, now: Date.parse('2026-10-24T06:00:00Z') });
  assert.deepEqual(digest.counts, { overdue: 1, today: 1, urgent: 1, upcoming: 1, waiting: 1, inProgress: 1, open: 5 });
  assert.match(digest.text, /Overdue \(1\)\n• Overdue thing — Acme \(2d overdue\)/);
  assert.match(digest.text, /Due today \(1\)\n• Due today — Acme \(3pm\)/);
  assert.match(digest.text, /Waiting on others \(1\)\n• Client review — Studio \(3d\)/);
  assert.equal(digest.isEmpty, false);
  assert.equal(Core.buildDigest(Core.emptyData(), { today: TODAY }).isEmpty, true);
  assert.match(Core.buildDigest(Core.emptyData(), { today: TODAY, name: 'Raza Ahmed' }).text, /^☀️ Good morning, Raza! Wed 21 Oct/);
});

test('buildReport', () => {
  const report = Core.buildReport(sampleBoard(), { start: '2026-10-19', end: '2026-10-25', today: TODAY, toDay: ts => new Date(ts).toISOString().slice(0, 10) });
  assert.equal(report.totals.completed, 1);
  assert.match(report.text, /^Weekly update · 19–25 Oct 2026/);
  assert.match(report.text, /ACME\n✅ Done \(1\)\n• Shipped it/);
  assert.match(report.text, /STUDIO\n🔄 In progress \(1\)\n• Urgent edit\n⏳ Waiting on feedback \(1\)\n• Client review\n📅 Coming up \(1\)\n• Next week \(Fri 23 Oct\)/);

  const single = Core.buildReport(sampleBoard(), { start: '2026-09-28', end: '2026-10-04', today: TODAY, categoryId: 'h', toDay: ts => new Date(ts).toISOString().slice(0, 10) });
  assert.match(single.text, /^Acme — update/);
  assert.match(single.text, /• Old win/, 'archived tasks still count as completed');
});
