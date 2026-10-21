/*
 * My Workboard core: dates, quick-add parsing, recurrence, data normalisation,
 * sync merging and text reports. Pure functions only, shared by the browser
 * (window.WorkboardCore), the API (require) and the unit tests.
 */
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.WorkboardCore = core;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA = 3;
  const DAY_MS = 86400000;
  const STATUSES = ['NTS', 'WIP', 'WAIT', 'DONE'];
  const STATUS_LABELS = { NTS: 'To start', WIP: 'In progress', WAIT: 'Waiting', DONE: 'Done' };
  // Clicking the status button cycles To start → In progress → Done; Waiting resumes to In progress.
  const NEXT_STATUS = { NTS: 'WIP', WIP: 'DONE', WAIT: 'WIP', DONE: 'NTS' };
  const CATEGORY_COLORS = ['ink', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'];
  const REPEAT_FREQS = ['daily', 'weekdays', 'weekly', 'monthly', 'yearly'];
  const TOMBSTONE_TTL_MS = 60 * DAY_MS;
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function dict(entries) {
    return Object.assign(Object.create(null), entries);
  }

  function makeId(prefix = 'id') {
    const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (c && typeof c.randomUUID === 'function') return `${prefix}-${c.randomUUID()}`;
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  }

  function cleanText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function finiteOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function timestampOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function byOrder(a, b) {
    return (a.order - b.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  function isValidTime(value) {
    return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  // ---------------------------------------------------------------------------
  // Dates. Due dates are plain "YYYY-MM-DD" strings; arithmetic runs in UTC so
  // daylight-saving shifts never move a date.
  // ---------------------------------------------------------------------------

  function dayFromParts(year, month, date) {
    return `${year}-${pad(month)}-${pad(date)}`;
  }

  function localDay(date = new Date()) {
    return dayFromParts(date.getFullYear(), date.getMonth() + 1, date.getDate());
  }

  function dayInTimeZone(date, timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(date);
      const get = type => parts.find(part => part.type === type).value;
      return `${get('year')}-${get('month')}-${get('day')}`;
    } catch (e) {
      return localDay(date);
    }
  }

  function dayToUTC(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  }

  function utcToDay(ms) {
    const d = new Date(ms);
    return dayFromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  function isValidDay(day) {
    const ms = dayToUTC(day);
    return !Number.isNaN(ms) && utcToDay(ms) === day;
  }

  function addDays(day, n) {
    return utcToDay(dayToUTC(day) + n * DAY_MS);
  }

  function daysBetween(from, to) {
    return Math.round((dayToUTC(to) - dayToUTC(from)) / DAY_MS);
  }

  function weekdayOf(day) {
    return new Date(dayToUTC(day)).getUTCDay();
  }

  function daysInMonth(year, monthIndex) {
    return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  }

  // Adds months, clamping to the month's last day; `anchorDate` keeps "31st" sticky.
  function addMonths(day, n, anchorDate) {
    const d = new Date(dayToUTC(day));
    const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
    const year = Math.floor(total / 12);
    const month = total - year * 12;
    const date = Math.min(anchorDate || d.getUTCDate(), daysInMonth(year, month));
    return dayFromParts(year, month + 1, date);
  }

  // Weeks start on Monday.
  function startOfWeek(day) {
    return addDays(day, -((weekdayOf(day) + 6) % 7));
  }

  function formatDay(day, { weekday = true, year = false } = {}) {
    if (!isValidDay(day)) return '';
    const d = new Date(dayToUTC(day));
    let text = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    if (weekday) text = `${WEEKDAYS[d.getUTCDay()]} ${text}`;
    if (year) text += ` ${d.getUTCFullYear()}`;
    return text;
  }

  function formatRange(start, end) {
    const a = new Date(dayToUTC(start));
    const b = new Date(dayToUTC(end));
    if (a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()) {
      return `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
    }
    if (a.getUTCFullYear() === b.getUTCFullYear()) {
      return `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} – ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
    }
    return `${formatDay(start, { weekday: false, year: true })} – ${formatDay(end, { weekday: false, year: true })}`;
  }

  // "17:30" → "5:30pm"
  function formatTime(time) {
    if (!isValidTime(time)) return '';
    const hour = Number(time.slice(0, 2));
    const minute = Number(time.slice(3));
    const suffix = hour >= 12 ? 'pm' : 'am';
    const h12 = hour % 12 || 12;
    return minute ? `${h12}:${pad(minute)}${suffix}` : `${h12}${suffix}`;
  }

  function ageInDays(timestamp, now = Date.now()) {
    return Math.max(0, Math.floor((now - timestamp) / DAY_MS));
  }

  // Label + tone for a task's due date relative to `today`.
  function describeDue(task, today) {
    if (!task || !isValidDay(task.due)) return null;
    const diff = daysBetween(today, task.due);
    const time = task.dueTime ? ` ${formatTime(task.dueTime)}` : '';
    let label;
    let tone;
    if (diff < 0) {
      label = diff === -1 ? 'Yesterday' : `${-diff}d overdue`;
      tone = 'overdue';
    } else if (diff === 0) {
      label = `Today${time}`;
      tone = 'today';
    } else if (diff === 1) {
      label = `Tomorrow${time}`;
      tone = 'soon';
    } else if (diff < 7) {
      label = `${WEEKDAYS[weekdayOf(task.due)]}${time}`;
      tone = 'soon';
    } else {
      label = formatDay(task.due, { weekday: false, year: task.due.slice(0, 4) !== today.slice(0, 4) }) + time;
      tone = 'later';
    }
    if (task.status === 'DONE') tone = 'done';
    return { label, tone, diff };
  }

  // ---------------------------------------------------------------------------
  // Recurrence
  // ---------------------------------------------------------------------------

  function normalizeRepeat(repeat) {
    if (!repeat || typeof repeat !== 'object' || !REPEAT_FREQS.includes(repeat.freq)) return null;
    const out = { freq: repeat.freq, interval: Math.min(99, Math.max(1, Math.round(finiteOr(repeat.interval, 1)))) };
    const anchor = Math.round(finiteOr(repeat.anchor, 0));
    if (anchor >= 1 && anchor <= 31) out.anchor = anchor;
    return out;
  }

  function describeRepeat(repeat) {
    if (!repeat) return '';
    const n = repeat.interval || 1;
    switch (repeat.freq) {
      case 'daily': return n === 1 ? 'Daily' : `Every ${n} days`;
      case 'weekdays': return 'Weekdays';
      case 'weekly': return n === 1 ? 'Weekly' : `Every ${n} weeks`;
      case 'monthly': return n === 1 ? 'Monthly' : `Every ${n} months`;
      case 'yearly': return n === 1 ? 'Yearly' : `Every ${n} years`;
      default: return '';
    }
  }

  function nextOccurrence(repeat, from) {
    const n = Math.max(1, repeat.interval || 1);
    const anchor = repeat.anchor || Number(from.slice(8, 10));
    switch (repeat.freq) {
      case 'daily': return addDays(from, n);
      case 'weekdays': {
        let day = addDays(from, 1);
        while (weekdayOf(day) === 0 || weekdayOf(day) === 6) day = addDays(day, 1);
        return day;
      }
      case 'weekly': return addDays(from, 7 * n);
      case 'monthly': return addMonths(from, n, anchor);
      case 'yearly': return addMonths(from, 12 * n, anchor);
      default: return addDays(from, 1);
    }
  }

  // The next due date after completing a recurring task, always after today.
  function nextDueAfterCompletion(task, today) {
    let next = nextOccurrence(task.repeat, isValidDay(task.due) ? task.due : today);
    for (let guard = 0; next <= today && guard < 2000; guard++) next = nextOccurrence(task.repeat, next);
    return next;
  }

  // ---------------------------------------------------------------------------
  // Quick add: "Send invoice fri 5pm ! #acme every month"
  // ---------------------------------------------------------------------------

  const WEEKDAY_WORDS = dict({
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6
  });
  const MONTH_WORDS = dict({
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
    jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
    nov: 10, november: 10, dec: 11, december: 11
  });
  const UNIT_WORDS = dict({
    d: 'day', day: 'day', days: 'day', w: 'week', wk: 'week', wks: 'week', week: 'week', weeks: 'week',
    m: 'month', mo: 'month', month: 'month', months: 'month', y: 'year', yr: 'year', year: 'year', years: 'year'
  });
  const UNIT_FREQ = dict({
    day: 'daily', days: 'daily', week: 'weekly', weeks: 'weekly', month: 'monthly', months: 'monthly', year: 'yearly', years: 'yearly'
  });
  const SIMPLE_REPEATS = dict({
    daily: ['daily', 1], everyday: ['daily', 1], weekdays: ['weekdays', 1], weekly: ['weekly', 1],
    biweekly: ['weekly', 2], fortnightly: ['weekly', 2], monthly: ['monthly', 1], yearly: ['yearly', 1], annually: ['yearly', 1]
  });
  const STATUS_WORDS = dict({
    wip: 'WIP', doing: 'WIP', progress: 'WIP', started: 'WIP', wait: 'WAIT', waiting: 'WAIT', blocked: 'WAIT',
    done: 'DONE', nts: 'NTS', todo: 'NTS'
  });

  function normalizeKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function findCategory(categories, token) {
    const key = normalizeKey(token);
    if (!key) return null;
    const list = categories.map(category => ({ category, key: normalizeKey(category.name) }));
    const hit = list.find(item => item.key === key)
      || list.find(item => item.key.startsWith(key))
      || list.find(item => item.key.includes(key));
    return hit ? hit.category : null;
  }

  function nextWeekday(today, target, strict = false) {
    let diff = (target - weekdayOf(today) + 7) % 7;
    if (strict && diff === 0) diff = 7;
    return addDays(today, diff);
  }

  function shiftDay(today, unit, n) {
    if (unit === 'day') return addDays(today, n);
    if (unit === 'week') return addDays(today, 7 * n);
    if (unit === 'month') return addMonths(today, n);
    return addMonths(today, 12 * n);
  }

  // A date without a year means the next time that date comes round.
  function resolveYearless(today, monthIndex, date) {
    const year = Number(today.slice(0, 4));
    for (let y = year; y <= year + 4; y++) {
      const day = dayFromParts(y, monthIndex + 1, date);
      if (isValidDay(day) && day >= today) return day;
    }
    return null;
  }

  function withYear(year, monthIndex, date) {
    const day = dayFromParts(year < 100 ? year + 2000 : year, monthIndex + 1, date);
    return isValidDay(day) ? day : null;
  }

  function parseOrdinal(word) {
    const m = /^(\d{1,2})(st|nd|rd|th)?$/.exec(word || '');
    return m ? Number(m[1]) : null;
  }

  function parseTimeWords(words, i) {
    const word = words[i];
    if (!word) return null;
    const build = (h, min, suffix, length) => {
      let hour = Number(h);
      const minute = Number(min || 0);
      if (hour < 1 || hour > 12 || minute > 59) return null;
      const pm = suffix[0] === 'p';
      if (hour === 12) hour = pm ? 12 : 0;
      else if (pm) hour += 12;
      return { length, time: `${pad(hour)}:${pad(minute)}` };
    };
    let m = /^(\d{1,2})(?::(\d{2}))?(am|pm|a|p)$/.exec(word);
    if (m) return build(m[1], m[2], m[3], 1);
    m = /^(\d{1,2})(?::(\d{2}))?$/.exec(word);
    if (m && /^(am|pm)$/.test(words[i + 1] || '')) return build(m[1], m[2], words[i + 1], 2);
    m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(word);
    if (m) return { length: 1, time: `${pad(Number(m[1]))}:${m[2]}` };
    if (word === 'noon') return { length: 1, time: '12:00' };
    return null;
  }

  function parseDateWords(words, i, ctx) {
    const { today } = ctx;
    const word = words[i];
    const next = words[i + 1];
    const third = words[i + 2];
    if (!word) return null;

    if (word === 'today' || word === 'tonight') return { length: 1, due: today };
    if (word === 'tomorrow' || word === 'tmr' || word === 'tmrw' || word === 'tmw') return { length: 1, due: addDays(today, 1) };

    if (word === 'next' && next) {
      if (next === 'week') return { length: 2, due: addDays(startOfWeek(today), 7) };
      if (next === 'month') return { length: 2, due: addMonths(dayFromParts(today.slice(0, 4), Number(today.slice(5, 7)), 1), 1) };
      if (WEEKDAY_WORDS[next] !== undefined) {
        const upcoming = nextWeekday(today, WEEKDAY_WORDS[next], true);
        const nextMonday = addDays(startOfWeek(today), 7);
        return { length: 2, due: upcoming < nextMonday ? addDays(upcoming, 7) : upcoming };
      }
    }
    if (word === 'this' && next === 'weekend') return { length: 2, due: nextWeekday(today, 6) };
    if (word === 'this' && WEEKDAY_WORDS[next] !== undefined) return { length: 2, due: nextWeekday(today, WEEKDAY_WORDS[next]) };
    if (word === 'weekend') return { length: 1, due: nextWeekday(today, 6) };
    if (WEEKDAY_WORDS[word] !== undefined) return { length: 1, due: nextWeekday(today, WEEKDAY_WORDS[word]) };

    if (word === 'in' && next) {
      const m = /^(\d{1,3})([a-z]+)?$/.exec(next);
      if (m) {
        const unit = UNIT_WORDS[m[2] || third];
        if (unit) return { length: m[2] ? 2 : 3, due: shiftDay(today, unit, Number(m[1])) };
      }
      if ((next === 'a' || next === 'one') && UNIT_WORDS[third]) return { length: 3, due: shiftDay(today, UNIT_WORDS[third], 1) };
      return null;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(word)) return isValidDay(word) ? { length: 1, due: word } : null;

    let m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?$/.exec(word);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      const [date, month] = ctx.dateOrder === 'MDY' ? [b, a] : [a, b];
      if (month < 1 || month > 12) return null;
      const due = m[3] ? withYear(Number(m[3]), month - 1, date) : resolveYearless(today, month - 1, date);
      return due ? { length: 1, due } : null;
    }

    // "oct 25", "october 25th 2026"
    if (MONTH_WORDS[word] !== undefined) {
      const date = parseOrdinal(next);
      if (date) {
        const year = /^\d{4}$/.test(third || '') ? Number(third) : null;
        const due = year ? withYear(year, MONTH_WORDS[word], date) : resolveYearless(today, MONTH_WORDS[word], date);
        return due ? { length: year ? 3 : 2, due } : null;
      }
    }
    // "25 oct", "25th october 2026"
    const date = parseOrdinal(word);
    if (date && MONTH_WORDS[next] !== undefined) {
      const year = /^\d{4}$/.test(third || '') ? Number(third) : null;
      const due = year ? withYear(year, MONTH_WORDS[next], date) : resolveYearless(today, MONTH_WORDS[next], date);
      return due ? { length: year ? 3 : 2, due } : null;
    }
    return null;
  }

  function parseRepeatWords(words, i, ctx) {
    const word = words[i];
    const next = words[i + 1];
    const third = words[i + 2];
    if (SIMPLE_REPEATS[word]) {
      const [freq, interval] = SIMPLE_REPEATS[word];
      return { length: 1, repeat: { freq, interval } };
    }
    if (word !== 'every' || !next) return null;
    if (next === 'other' && UNIT_FREQ[third]) return { length: 3, repeat: { freq: UNIT_FREQ[third], interval: 2 } };
    if (next === 'weekday' || next === 'weekdays') return { length: 2, repeat: { freq: 'weekdays', interval: 1 } };
    if (WEEKDAY_WORDS[next] !== undefined) {
      return { length: 2, repeat: { freq: 'weekly', interval: 1 }, impliedDue: nextWeekday(ctx.today, WEEKDAY_WORDS[next]) };
    }
    if (UNIT_FREQ[next]) return { length: 2, repeat: { freq: UNIT_FREQ[next], interval: 1 } };
    if (/^\d{1,2}$/.test(next) && UNIT_FREQ[third]) {
      return { length: 3, repeat: { freq: UNIT_FREQ[third], interval: Math.max(1, Number(next)) } };
    }
    return null;
  }

  /**
   * Parses quick-add text. Recognises:
   *   dates     today, tmr, fri, next fri, next week, in 3 days, 25 oct, 25/10, 2026-10-25
   *   times     5pm, 5:30pm, 17:00, at 9am, noon
   *   repeats   daily, weekly, monthly, every monday, every 2 weeks, every weekday
   *   flags     ! (urgent), #client (category), @waiting / @wip / @done
   */
  function parseQuickAdd(input, options = {}) {
    const today = options.today || localDay();
    const categories = options.categories || [];
    const ctx = { today, dateOrder: options.dateOrder === 'MDY' ? 'MDY' : 'DMY' };
    const raw = String(input || '').trim().split(/\s+/).filter(Boolean);
    const words = raw.map(word => word.toLowerCase().replace(/[,;]+$/, ''));
    const result = {
      text: '', categoryId: null, categoryName: null, unknownCategory: null,
      due: null, dueTime: null, urgent: false, status: null, repeat: null
    };
    const kept = [];
    let impliedDue = null;

    for (let i = 0; i < words.length;) {
      const word = words[i];

      if (/^#\S+/.test(word)) {
        const category = findCategory(categories, raw[i].slice(1));
        if (category) {
          result.categoryId = category.id;
          result.categoryName = category.name;
        } else {
          result.unknownCategory = raw[i].slice(1);
          kept.push(raw[i]);
        }
        i += 1;
        continue;
      }
      if (word[0] === '@' && STATUS_WORDS[word.slice(1)]) {
        result.status = STATUS_WORDS[word.slice(1)];
        i += 1;
        continue;
      }
      if (/^!{1,3}$/.test(word)) {
        result.urgent = true;
        i += 1;
        continue;
      }
      if (!result.repeat) {
        const repeat = parseRepeatWords(words, i, ctx);
        if (repeat) {
          result.repeat = repeat.repeat;
          if (repeat.impliedDue) impliedDue = repeat.impliedDue;
          i += repeat.length;
          continue;
        }
      }
      const prep = ['on', 'by', 'due', 'at'].includes(word) ? 1 : 0;
      if (!result.due && word !== 'at') {
        const date = parseDateWords(words, i + prep, ctx);
        if (date) {
          result.due = date.due;
          i += prep + date.length;
          continue;
        }
      }
      if (!result.dueTime && (prep === 0 || word === 'at' || word === 'by')) {
        const time = parseTimeWords(words, i + prep);
        if (time) {
          result.dueTime = time.time;
          i += prep + time.length;
          continue;
        }
      }
      kept.push(raw[i]);
      i += 1;
    }

    if (!result.due && impliedDue) result.due = impliedDue;
    if (!result.due && (result.dueTime || result.repeat)) result.due = today;
    if (result.repeat && (result.repeat.freq === 'monthly' || result.repeat.freq === 'yearly')) {
      result.repeat.anchor = Number(result.due.slice(8, 10));
    }
    result.text = cleanText(kept.join(' '));
    return result;
  }

  // ---------------------------------------------------------------------------
  // Data model (schema 3)
  //
  // { version: 3,
  //   categories: [{ id, name, color, order, updatedAt, tasks: [task] }],
  //   deleted: { [taskOrCategoryId]: deletedAt },   // tombstones for sync
  //   settings: { timezone, updatedAt } }
  // ---------------------------------------------------------------------------

  // Key order matters: change fingerprints compare JSON, so keep it in sync with normalizeTask.
  function makeTask(fields = {}, now = Date.now()) {
    const status = STATUSES.includes(fields.status) ? fields.status : 'NTS';
    return {
      id: fields.id || makeId('task'),
      text: cleanText(fields.text),
      status,
      urgent: Boolean(fields.urgent),
      due: isValidDay(fields.due) ? fields.due : null,
      dueTime: isValidTime(fields.dueTime) ? fields.dueTime : null,
      repeat: normalizeRepeat(fields.repeat),
      notes: typeof fields.notes === 'string' ? fields.notes : '',
      checklist: Array.isArray(fields.checklist) ? fields.checklist : [],
      order: finiteOr(fields.order, 0),
      createdAt: now,
      statusAt: now,
      startedAt: status === 'WIP' ? now : null,
      doneAt: status === 'DONE' ? now : null,
      archivedAt: null,
      updatedAt: now
    };
  }

  function makeCategory(fields = {}, now = Date.now()) {
    return {
      id: fields.id || makeId('category'),
      name: cleanText(fields.name) || 'New Category',
      color: CATEGORY_COLORS.includes(fields.color) ? fields.color : 'ink',
      order: finiteOr(fields.order, 0),
      updatedAt: now,
      tasks: []
    };
  }

  function normalizeChecklist(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter(item => item && typeof item === 'object')
      .map(item => ({
        id: typeof item.id === 'string' && item.id ? item.id : makeId('item'),
        text: cleanText(item.text).slice(0, 500),
        done: Boolean(item.done)
      }))
      .filter(item => item.text);
  }

  function normalizeTask(task, index, ctx) {
    const status = STATUSES.includes(task.status) ? task.status : 'NTS';
    const legacy = ctx.legacy;
    const seeded = legacy ? ctx.now : null; // legacy tasks have no history; start the clock now
    return {
      id: typeof task.id === 'string' && task.id ? task.id : makeId('task'),
      text: cleanText(task.text) || `Task ${index + 1}`,
      status,
      urgent: Boolean(task.urgent),
      due: isValidDay(task.due) ? task.due : null,
      dueTime: isValidTime(task.dueTime) ? task.dueTime : null,
      repeat: normalizeRepeat(task.repeat),
      notes: typeof task.notes === 'string' ? task.notes.replace(/\r\n/g, '\n').slice(0, 20000) : '',
      checklist: normalizeChecklist(task.checklist),
      order: legacy ? index : finiteOr(task.order, index),
      createdAt: timestampOrNull(task.createdAt),
      statusAt: timestampOrNull(task.statusAt) || (status === 'WIP' || status === 'WAIT' ? seeded : null),
      startedAt: timestampOrNull(task.startedAt) || (status === 'WIP' ? seeded : null),
      doneAt: status === 'DONE' ? timestampOrNull(task.doneAt) : null,
      archivedAt: timestampOrNull(task.archivedAt),
      updatedAt: legacy ? ctx.legacyUpdatedAt : finiteOr(task.updatedAt, 0)
    };
  }

  function normalizeSettings(settings) {
    const s = settings && typeof settings === 'object' ? settings : {};
    return {
      timezone: typeof s.timezone === 'string' && s.timezone && s.timezone.length < 64 ? s.timezone : null,
      updatedAt: finiteOr(s.updatedAt, 0)
    };
  }

  function emptyData() {
    return { version: SCHEMA, categories: [], deleted: {}, settings: normalizeSettings(null) };
  }

  // One-off fix carried over from v2: this task belongs under "Zawish Muslim work".
  function migrateLegacyContent(data) {
    const zawish = data.categories.find(c => c.id === 'zawish' || c.name.toLowerCase() === 'zawish');
    const muslim = data.categories.find(c => c.id === 'zawish-muslim-work' || c.name.toLowerCase() === 'zawish muslim work');
    if (!zawish || !muslim) return;
    const index = zawish.tasks.findIndex(t => t.text.toLowerCase() === 'society app development');
    const alreadyThere = muslim.tasks.some(t => t.text.toLowerCase() === 'society app development');
    if (index >= 0 && !alreadyThere) {
      const [task] = zawish.tasks.splice(index, 1);
      task.order = muslim.tasks.length ? muslim.tasks[muslim.tasks.length - 1].order + 1 : 0;
      muslim.tasks.push(task);
    }
  }

  /**
   * Cleans any stored board (v1/v2/v3) into schema 3. Legacy boards get
   * `order` from their array position and `updatedAt = legacyUpdatedAt`
   * (0 means "the cloud copy wins" when merging).
   */
  function normalizeData(input, options = {}) {
    if (!input || !Array.isArray(input.categories)) return emptyData();
    const legacy = !(Number(input.version) >= SCHEMA);
    const ctx = { legacy, now: options.now || Date.now(), legacyUpdatedAt: finiteOr(options.legacyUpdatedAt, 0) };
    const seenCategories = new Set();
    const seenTasks = new Set();
    const categories = [];

    input.categories.forEach((category, categoryIndex) => {
      if (!category || typeof category !== 'object') return;
      let id = typeof category.id === 'string' && category.id ? category.id : makeId('category');
      if (seenCategories.has(id)) id = makeId('category');
      seenCategories.add(id);

      const tasks = [];
      (Array.isArray(category.tasks) ? category.tasks : []).forEach((task, taskIndex) => {
        if (!task || typeof task !== 'object') return;
        const clean = normalizeTask(task, taskIndex, ctx);
        if (seenTasks.has(clean.id)) return;
        seenTasks.add(clean.id);
        tasks.push(clean);
      });
      tasks.sort(byOrder);

      categories.push({
        id,
        name: cleanText(category.name) || `Category ${categoryIndex + 1}`,
        color: CATEGORY_COLORS.includes(category.color) ? category.color : 'ink',
        order: legacy ? categoryIndex : finiteOr(category.order, categoryIndex),
        updatedAt: legacy ? ctx.legacyUpdatedAt : finiteOr(category.updatedAt, 0),
        tasks
      });
    });
    categories.sort(byOrder);

    const deleted = {};
    if (input.deleted && typeof input.deleted === 'object') {
      for (const [id, at] of Object.entries(input.deleted)) {
        const ts = timestampOrNull(at);
        if (ts) deleted[id] = ts;
      }
    }

    const data = { version: SCHEMA, categories, deleted, settings: normalizeSettings(input.settings) };
    if (legacy) migrateLegacyContent(data);
    return data;
  }

  function pruneTombstones(deleted, now) {
    const out = {};
    for (const [id, at] of Object.entries(deleted)) {
      if (now - at < TOMBSTONE_TTL_MS) out[id] = at;
    }
    return out;
  }

  function indexTasks(data) {
    const map = new Map();
    data.categories.forEach(category => category.tasks.forEach(task => map.set(task.id, { task, categoryId: category.id })));
    return map;
  }

  function taskFingerprint(task, categoryId) {
    return JSON.stringify([categoryId, { ...task, updatedAt: 0 }]);
  }

  function categoryFingerprint(category) {
    return JSON.stringify({ ...category, tasks: 0, updatedAt: 0 });
  }

  /**
   * Compares a board before and after an edit and records what changed:
   * changed tasks/categories get `updatedAt = now`, removed ones get a
   * tombstone. Returns false when nothing actually changed.
   */
  function stampChanges(before, after, now) {
    let changed = false;
    after.deleted = after.deleted || {};

    const prevTasks = indexTasks(before);
    const nextTasks = indexTasks(after);
    for (const [id, { task, categoryId }] of nextTasks) {
      const prev = prevTasks.get(id);
      if (!prev || taskFingerprint(prev.task, prev.categoryId) !== taskFingerprint(task, categoryId)) {
        task.updatedAt = now;
        delete after.deleted[id];
        changed = true;
      }
    }
    for (const id of prevTasks.keys()) {
      if (!nextTasks.has(id)) {
        after.deleted[id] = now;
        changed = true;
      }
    }

    const prevCategories = new Map(before.categories.map(c => [c.id, c]));
    const nextIds = new Set();
    for (const category of after.categories) {
      nextIds.add(category.id);
      const prev = prevCategories.get(category.id);
      if (!prev || categoryFingerprint(prev) !== categoryFingerprint(category)) {
        category.updatedAt = now;
        delete after.deleted[category.id];
        changed = true;
      }
    }
    for (const id of prevCategories.keys()) {
      if (!nextIds.has(id)) {
        after.deleted[id] = now;
        changed = true;
      }
    }

    if (JSON.stringify({ ...before.settings, updatedAt: 0 }) !== JSON.stringify({ ...after.settings, updatedAt: 0 })) {
      after.settings.updatedAt = now;
      changed = true;
    }

    after.deleted = pruneTombstones(after.deleted, now);
    return changed;
  }

  /**
   * Merges two normalised boards. Each task and category is resolved on its
   * own: the newer `updatedAt` wins (ties go to `remote`), and a tombstone
   * removes anything not edited after it was deleted. Tasks whose category
   * was deleted elsewhere are rescued into the first category.
   */
  function mergeData(local, remote, options = {}) {
    const now = options.now || Date.now();
    const deleted = { ...remote.deleted };
    for (const [id, at] of Object.entries(local.deleted || {})) {
      if (!deleted[id] || deleted[id] < at) deleted[id] = at;
    }
    const alive = entity => !(deleted[entity.id] >= entity.updatedAt);
    const newer = (a, b) => (!a ? b : !b ? a : a.updatedAt > b.updatedAt ? a : b);

    const categoryEntries = new Map();
    local.categories.forEach(c => categoryEntries.set(c.id, { local: c }));
    remote.categories.forEach(c => {
      const entry = categoryEntries.get(c.id) || {};
      entry.remote = c;
      categoryEntries.set(c.id, entry);
    });
    const categories = [];
    for (const entry of categoryEntries.values()) {
      const winner = newer(entry.local, entry.remote);
      if (alive(winner)) categories.push({ ...winner, tasks: [] });
    }
    categories.sort(byOrder);
    const categoryById = new Map(categories.map(c => [c.id, c]));

    const taskEntries = new Map();
    const collect = (data, side) => data.categories.forEach(category => category.tasks.forEach(task => {
      const entry = taskEntries.get(task.id) || {};
      entry[side] = { task, categoryId: category.id };
      taskEntries.set(task.id, entry);
    }));
    collect(local, 'local');
    collect(remote, 'remote');

    for (const entry of taskEntries.values()) {
      const winner = !entry.local ? entry.remote
        : !entry.remote ? entry.local
          : entry.local.task.updatedAt > entry.remote.task.updatedAt ? entry.local : entry.remote;
      if (!alive(winner.task)) continue;
      const home = categoryById.get(winner.categoryId) || categories[0];
      if (home) home.tasks.push({ ...winner.task });
    }
    categories.forEach(c => c.tasks.sort(byOrder));

    const settings = { ...newer(local.settings, remote.settings) };
    return { version: SCHEMA, categories, deleted: pruneTombstones(deleted, now), settings };
  }

  // A sort key between two neighbours (either may be missing).
  function orderBetween(before, after) {
    const hasBefore = typeof before === 'number' && Number.isFinite(before);
    const hasAfter = typeof after === 'number' && Number.isFinite(after);
    if (!hasBefore && !hasAfter) return 0;
    if (!hasBefore) return after - 1;
    if (!hasAfter) return before + 1;
    return (before + after) / 2;
  }

  function applyStatus(task, status, now = Date.now()) {
    if (!STATUSES.includes(status) || task.status === status) return false;
    task.status = status;
    task.statusAt = now;
    if (status === 'WIP' && !task.startedAt) task.startedAt = now;
    task.doneAt = status === 'DONE' ? now : null;
    return true;
  }

  // Builds the next copy of a recurring task (unchecked checklist, next due date).
  function spawnNextOccurrence(task, today, now = Date.now()) {
    if (!task.repeat) return null;
    const anchor = task.repeat.anchor || (isValidDay(task.due) ? Number(task.due.slice(8, 10)) : undefined);
    const repeat = { ...task.repeat };
    if ((repeat.freq === 'monthly' || repeat.freq === 'yearly') && anchor) repeat.anchor = anchor;
    return makeTask({
      text: task.text,
      urgent: task.urgent,
      due: nextDueAfterCompletion({ ...task, repeat }, today),
      dueTime: task.dueTime,
      repeat,
      notes: task.notes,
      checklist: task.checklist.map(item => ({ id: makeId('item'), text: item.text, done: false }))
    }, now);
  }

  function listTasks(data, { includeArchived = false } = {}) {
    const out = [];
    data.categories.forEach(category => category.tasks.forEach(task => {
      if (includeArchived || !task.archivedAt) out.push({ task, category });
    }));
    return out;
  }

  function compareDue(a, b) {
    const da = a.task ? a.task : a;
    const db = b.task ? b.task : b;
    if (da.due !== db.due) {
      if (!da.due) return 1;
      if (!db.due) return -1;
      return da.due < db.due ? -1 : 1;
    }
    const ta = da.dueTime || '99:99';
    const tb = db.dueTime || '99:99';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return Number(db.urgent) - Number(da.urgent);
  }

  function extractLinks(text) {
    const matches = String(text || '').match(/\bhttps?:\/\/[^\s<>"']+/gi) || [];
    return [...new Set(matches.map(url => url.replace(/[).,;:!?]+$/, '')))];
  }

  // ---------------------------------------------------------------------------
  // Text reports
  // ---------------------------------------------------------------------------

  function buildDigest(data, { today, now = Date.now() } = {}) {
    const open = listTasks(data).filter(({ task }) => task.status !== 'DONE');
    const overdue = open.filter(x => x.task.due && x.task.due < today).sort(compareDue);
    const dueToday = open.filter(x => x.task.due === today).sort(compareDue);
    const upcoming = open.filter(x => x.task.due && x.task.due > today && x.task.due <= addDays(today, 3)).sort(compareDue);
    const urgent = open.filter(x => x.task.urgent && !(x.task.due && x.task.due <= today));
    const waiting = open.filter(x => x.task.status === 'WAIT');
    const inProgress = open.filter(x => x.task.status === 'WIP').length;

    const line = ({ task, category }, extra) => `• ${task.text} — ${category.name}${extra ? ` (${extra})` : ''}`;
    const lines = [`☀️ Good morning! ${formatDay(today)}`];
    const section = (title, items, format) => {
      if (!items.length) return;
      lines.push('', `${title} (${items.length})`);
      items.slice(0, 15).forEach(item => lines.push(format(item)));
      if (items.length > 15) lines.push(`…and ${items.length - 15} more`);
    };
    section('🔴 Overdue', overdue, x => line(x, describeDue(x.task, today).label));
    section('📅 Due today', dueToday, x => line(x, formatTime(x.task.dueTime)));
    section('❗ Urgent', urgent, x => line(x, x.task.due ? describeDue(x.task, today).label : ''));
    section('🗓 Next 3 days', upcoming, x => line(x, describeDue(x.task, today).label));
    section('⏳ Waiting on others', waiting, x => line(x, x.task.statusAt ? `${ageInDays(x.task.statusAt, now)}d` : ''));

    const isEmpty = !overdue.length && !dueToday.length && !urgent.length;
    if (isEmpty) lines.splice(1, 0, '', 'Nothing overdue or due today. 🎉');
    lines.push('', `🔄 ${inProgress} in progress · ${open.length} open tasks`);

    return {
      text: lines.join('\n'),
      isEmpty,
      counts: {
        overdue: overdue.length, today: dueToday.length, urgent: urgent.length,
        upcoming: upcoming.length, waiting: waiting.length, inProgress, open: open.length
      }
    };
  }

  /**
   * Status report for [start, end] (inclusive day strings), grouped by
   * category. `toDay` converts completion timestamps into local days.
   */
  function buildReport(data, { start, end, today, categoryId = null, toDay = ts => localDay(new Date(ts)) } = {}) {
    const all = listTasks(data, { includeArchived: true });
    const upcomingEnd = addDays(today, 7);
    const categories = data.categories.filter(c => !categoryId || c.id === categoryId);

    const sections = categories.map(category => {
      const tasks = all.filter(x => x.category.id === category.id).map(x => x.task);
      const live = tasks.filter(t => !t.archivedAt);
      return {
        category,
        completed: tasks
          .filter(t => t.status === 'DONE' && t.doneAt && toDay(t.doneAt) >= start && toDay(t.doneAt) <= end)
          .sort((a, b) => a.doneAt - b.doneAt),
        inProgress: live.filter(t => t.status === 'WIP'),
        waiting: live.filter(t => t.status === 'WAIT'),
        upcoming: live.filter(t => t.status !== 'DONE' && t.due && t.due >= today && t.due <= upcomingEnd).sort(compareDue)
      };
    }).filter(s => s.completed.length || s.inProgress.length || s.waiting.length || s.upcoming.length);

    const single = categoryId ? data.categories.find(c => c.id === categoryId) : null;
    const lines = [single ? `${single.name} — update · ${formatRange(start, end)}` : `Weekly update · ${formatRange(start, end)}`];
    for (const s of sections) {
      if (!single) lines.push('', s.category.name.toUpperCase());
      const list = (title, tasks, extra) => {
        if (!tasks.length) return;
        lines.push(`${title} (${tasks.length})`);
        tasks.forEach(t => lines.push(`• ${t.text}${extra ? extra(t) : ''}`));
      };
      list('✅ Done', s.completed);
      list('🔄 In progress', s.inProgress);
      list('⏳ Waiting on feedback', s.waiting);
      list('📅 Coming up', s.upcoming, t => ` (${formatDay(t.due)}${t.dueTime ? ` ${formatTime(t.dueTime)}` : ''})`);
    }
    const totals = {
      completed: sections.reduce((n, s) => n + s.completed.length, 0),
      inProgress: sections.reduce((n, s) => n + s.inProgress.length, 0),
      waiting: sections.reduce((n, s) => n + s.waiting.length, 0)
    };
    if (!sections.length) lines.push('', 'Nothing to report for this period.');
    else lines.push('', `Total: ${totals.completed} completed · ${totals.inProgress} in progress · ${totals.waiting} waiting`);

    return { sections, totals, text: lines.join('\n') };
  }

  return {
    SCHEMA, DAY_MS, STATUSES, STATUS_LABELS, NEXT_STATUS, CATEGORY_COLORS, REPEAT_FREQS, WEEKDAYS, MONTHS,
    makeId, cleanText, clone, isValidTime,
    localDay, dayInTimeZone, isValidDay, addDays, addMonths, daysBetween, weekdayOf, startOfWeek,
    formatDay, formatRange, formatTime, ageInDays, describeDue,
    normalizeRepeat, describeRepeat, nextOccurrence, nextDueAfterCompletion,
    parseQuickAdd, findCategory,
    makeTask, makeCategory, normalizeData, emptyData, stampChanges, mergeData, orderBetween,
    applyStatus, spawnNextOccurrence, listTasks, compareDue, extractLinks,
    buildDigest, buildReport
  };
});
