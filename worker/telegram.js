// Telegram: one shared bot for the team.
// - People link their own chat with a one-time code (t.me/<bot>?start=<code>).
// - Each person gets a morning digest at their chosen local time and days.
// - The owner gets join requests with Approve / Reject buttons, plus notes
//   when someone joins with an invite or deletes their account.
//
// Secrets: TELEGRAM_BOT_TOKEN (from @BotFather), TELEGRAM_WEBHOOK_SECRET (any
// random string; Telegram sends it back on every update so fakes are refused).

import Core from '../public/js/core.js';
import { HttpError, readJson } from './http.js';
import { ownerName, randomToken, sha256Hex, timingSafeEqual } from './auth.js';
import { approveRequest, rejectRequest } from './team.js';

const LINK_TTL_MS = 15 * 60 * 1000;
const DIGESTS_PER_RUN = 15;      // keeps each 15-minute run inside the free plan's limits
const DIGEST_WINDOW_MIN = 120;   // a digest goes out between its time and two hours later
const DIGEST_DAYS = { daily: [0, 1, 2, 3, 4, 5, 6], 'mon-sat': [1, 2, 3, 4, 5, 6], 'mon-fri': [1, 2, 3, 4, 5] };
const DAY_LABELS = { daily: 'every day', 'mon-sat': 'Mon–Sat', 'mon-fri': 'Mon–Fri' };

export function telegramReady(env) {
  return Boolean(env.TELEGRAM_BOT_TOKEN);
}

function appUrl(env) {
  return env.APP_URL || 'https://board.zawish.si';
}

export async function telegram(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    const err = new Error(`Telegram ${method} failed (${res.status}): ${body.description || 'unknown error'}`);
    err.status = res.status;
    throw err;
  }
  return body.result;
}

function send(env, chatId, text, extra = {}) {
  return telegram(env, 'sendMessage', { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true, ...extra });
}

async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

async function saveSetting(env, key, value) {
  await env.DB.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}

const UNLINK = 'telegram_chat_id = NULL, telegram_user_id = NULL, telegram_username = NULL, telegram_linked_at = NULL';

// ---------------------------------------------------------------------------
// Owner: activate the bot (point Telegram at this Worker)
// ---------------------------------------------------------------------------

export async function activateBot(env, origin) {
  if (!telegramReady(env)) throw new HttpError(400, 'Add the TELEGRAM_BOT_TOKEN secret in Cloudflare first.');
  if (!env.TELEGRAM_WEBHOOK_SECRET) throw new HttpError(500, 'The server is missing its TELEGRAM_WEBHOOK_SECRET.');
  try {
    const me = await telegram(env, 'getMe', {});
    await telegram(env, 'setWebhook', {
      url: `${origin}/api/telegram`,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true
    });
    await telegram(env, 'setMyCommands', {
      commands: [
        { command: 'start', description: 'Link this chat to your Workboard' },
        { command: 'stop', description: 'Stop messages and unlink' },
        { command: 'help', description: 'What this bot does' }
      ]
    });
    await saveSetting(env, 'bot_username', me.username);
    return { ok: true, username: me.username };
  } catch (err) {
    throw new HttpError(502, `Telegram said no: ${err.message}. Check the bot token.`);
  }
}

// ---------------------------------------------------------------------------
// Each person: link, settings, test
// ---------------------------------------------------------------------------

function validTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch (e) {
    return false;
  }
}

export async function getNotifications(env, user) {
  const row = await env.DB.prepare(
    `SELECT telegram_username, telegram_chat_id IS NOT NULL AS connected, digest_enabled, digest_time, digest_days,
            digest_mode, digest_skip_empty, timezone FROM users WHERE id = ?`
  ).bind(user.id).first();
  const botUsername = telegramReady(env) ? await getSetting(env, 'bot_username') : null;
  return {
    ok: true,
    botReady: Boolean(botUsername),
    tokenSet: telegramReady(env),
    botUsername,
    owner: await ownerName(env),
    connected: Boolean(row.connected),
    telegramName: row.telegram_username || '',
    settings: {
      enabled: Boolean(row.digest_enabled),
      time: row.digest_time,
      days: row.digest_days,
      mode: row.digest_mode,
      skipEmpty: Boolean(row.digest_skip_empty),
      timezone: row.timezone || ''
    }
  };
}

export async function saveNotifications(env, user, body) {
  const time = String(body.time || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, 'Pick a time like 08:00.');
  if (!DIGEST_DAYS[body.days]) throw new HttpError(400, 'Pick which days to get the digest.');
  if (body.mode !== 'full' && body.mode !== 'counts') throw new HttpError(400, 'Pick full or counts only.');
  const timezone = validTimeZone(body.timezone) ? body.timezone : null;
  await env.DB.prepare(
    `UPDATE users SET digest_enabled = ?, digest_time = ?, digest_days = ?, digest_mode = ?, digest_skip_empty = ?,
            timezone = COALESCE(?, timezone) WHERE id = ?`
  ).bind(body.enabled ? 1 : 0, time, body.days, body.mode, body.skipEmpty ? 1 : 0, timezone, user.id).run();
  return getNotifications(env, user);
}

// A one-time link that opens the bot; tapping Start links that chat to this person.
export async function createLink(env, user, body, now) {
  const botUsername = telegramReady(env) ? await getSetting(env, 'bot_username') : null;
  if (!botUsername) throw new HttpError(503, `Telegram isn’t set up yet. Ask ${await ownerName(env)} to activate the bot.`);
  const code = randomToken(24); // 32 characters: fits Telegram's 64-character limit
  const statements = [
    env.DB.prepare("DELETE FROM invites WHERE user_id = ? AND purpose = 'telegram' AND used_at IS NULL").bind(user.id),
    env.DB.prepare("INSERT INTO invites (token_hash, purpose, user_id, created_at, expires_at) VALUES (?, 'telegram', ?, ?, ?)")
      .bind(await sha256Hex(code), user.id, now, now + LINK_TTL_MS)
  ];
  if (validTimeZone(body.timezone)) {
    statements.push(env.DB.prepare('UPDATE users SET timezone = ? WHERE id = ?').bind(body.timezone, user.id));
  }
  await env.DB.batch(statements);
  return { ok: true, url: `https://t.me/${botUsername}?start=${code}`, expiresAt: now + LINK_TTL_MS };
}

export async function disconnect(env, user) {
  await env.DB.prepare(`UPDATE users SET ${UNLINK} WHERE id = ?`).bind(user.id).run();
  return getNotifications(env, user);
}

export async function sendTestDigest(env, user, now) {
  const row = await env.DB.prepare(
    `SELECT u.name, u.telegram_chat_id, u.timezone, u.digest_mode, b.data
       FROM users u LEFT JOIN boards b ON b.user_id = u.id WHERE u.id = ?`
  ).bind(user.id).first();
  if (!row || !row.telegram_chat_id) throw new HttpError(400, 'Connect Telegram first.');
  const clock = Core.zonedClock(new Date(now), row.timezone || env.DIGEST_TIMEZONE || 'UTC');
  const digest = Core.buildDigest(Core.normalizeData(row.data ? JSON.parse(row.data) : null), { today: clock.day, now, name: row.name, mode: row.digest_mode });
  try {
    await send(env, row.telegram_chat_id, digest.text, openButton(env));
  } catch (err) {
    throw new HttpError(502, 'Telegram didn’t accept the message. If you blocked the bot, unblock it and try again.');
  }
  return { ok: true };
}

function openButton(env) {
  return { reply_markup: { inline_keyboard: [[{ text: 'Open Workboard', url: appUrl(env) }]] } };
}

// ---------------------------------------------------------------------------
// Owner pings
// ---------------------------------------------------------------------------

export async function notifyOwner(env, text, extra = {}) {
  if (!telegramReady(env)) return;
  const owner = await env.DB.prepare(
    "SELECT telegram_chat_id FROM users WHERE role = 'owner' AND status = 'active' AND telegram_chat_id IS NOT NULL ORDER BY created_at LIMIT 1"
  ).first();
  if (owner) await send(env, owner.telegram_chat_id, text, extra);
}

export function requestPing(user, note) {
  return {
    text: `🙋 ${user.name} wants to join ZAWISH Workboard${note ? `\n“${note}”` : ''}`,
    extra: {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `ap:${user.id}` },
          { text: '✖ Reject', callback_data: `rj:${user.id}` }
        ]]
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Webhook: messages and button presses from Telegram
// ---------------------------------------------------------------------------

export async function handleWebhook(env, request, now) {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!env.TELEGRAM_WEBHOOK_SECRET || !timingSafeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
    throw new HttpError(401, 'Unauthorized');
  }
  const update = await readJson(request);
  try {
    if (update.callback_query) await onButton(env, update.callback_query, now);
    else if (update.message && typeof update.message.text === 'string') await onMessage(env, update.message, now);
  } catch (err) {
    console.error('Telegram update failed:', err);
  }
  // Always 200, otherwise Telegram keeps retrying the same update.
  return { ok: true };
}

async function onMessage(env, message, now) {
  if (!message.chat || message.chat.type !== 'private') return;
  const chatId = String(message.chat.id);
  const [command, code] = message.text.trim().split(/\s+/, 2);

  if (command === '/start' && code) {
    const link = await env.DB.prepare(
      `SELECT i.token_hash, u.id, u.name, u.status, u.digest_time, u.digest_days
         FROM invites i JOIN users u ON u.id = i.user_id
        WHERE i.token_hash = ? AND i.purpose = 'telegram' AND i.used_at IS NULL AND i.expires_at > ?`
    ).bind(await sha256Hex(code), now).first();
    if (!link || link.status !== 'active') {
      await send(env, chatId, 'That link has expired. Open ZAWISH Workboard → More → Notifications → Connect Telegram to get a new one.');
      return;
    }
    const from = message.from || {};
    const label = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' ');
    await env.DB.batch([
      // One Telegram chat belongs to one person.
      env.DB.prepare(`UPDATE users SET ${UNLINK} WHERE telegram_chat_id = ? AND id != ?`).bind(chatId, link.id),
      env.DB.prepare('UPDATE users SET telegram_chat_id = ?, telegram_user_id = ?, telegram_username = ?, telegram_linked_at = ? WHERE id = ?')
        .bind(chatId, String(from.id || ''), label.slice(0, 64), now, link.id),
      env.DB.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ?').bind(now, link.token_hash)
    ]);
    await send(env, chatId,
      `✅ Connected to ZAWISH Workboard as ${link.name}.\n\nYour morning digest arrives at ${Core.formatTime(link.digest_time)} (${DAY_LABELS[link.digest_days] || 'Mon–Sat'}). Change it in the app: More → Notifications.\n\nSend /stop any time to disconnect.`);
    return;
  }

  if (command === '/stop') {
    const result = await env.DB.prepare(`UPDATE users SET ${UNLINK} WHERE telegram_chat_id = ?`).bind(chatId).run();
    await send(env, chatId, result.meta.changes
      ? 'Disconnected. You won’t get any more messages. You can reconnect from the app any time.'
      : 'This chat isn’t linked to anyone.');
    return;
  }

  await send(env, chatId,
    'This is the ZAWISH Workboard bot. It sends your morning digest, and join requests to the owner.\n\nTo link this chat: open board.zawish.si → More → Notifications → Connect Telegram.\nSend /stop to disconnect.');
}

async function onButton(env, query, now) {
  const [action, userId] = String(query.data || '').split(':');
  const answer = text => telegram(env, 'answerCallbackQuery', { callback_query_id: query.id, text });
  const owner = await env.DB.prepare(
    "SELECT telegram_user_id FROM users WHERE role = 'owner' AND status = 'active' ORDER BY created_at LIMIT 1"
  ).first();
  // Only the owner's own Telegram account can approve; a forwarded message does nothing.
  if (!owner || !owner.telegram_user_id || String((query.from || {}).id) !== owner.telegram_user_id) {
    await answer('Only the owner can approve or reject requests.');
    return;
  }

  let result;
  try {
    if (action === 'ap') {
      const user = await approveRequest(env, userId, now);
      result = `✅ You approved ${user.name}. Their board is ready.`;
    } else if (action === 'rj') {
      const user = await rejectRequest(env, userId);
      result = `✖ You rejected ${user.name}’s request.`;
    } else {
      await answer('Unknown button.');
      return;
    }
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 404) throw err;
    result = 'This request was already handled in the app, or it expired.';
  }
  await answer(result.split('.')[0]);
  if (query.message) {
    // Replace the buttons with the outcome.
    await telegram(env, 'editMessageText', {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      text: `${query.message.text || ''}\n\n${result}`
    });
  }
}

// ---------------------------------------------------------------------------
// Scheduled: send digests that are due (runs every 15 minutes)
// ---------------------------------------------------------------------------

function minutesOf(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export async function sendDueDigests(env, now) {
  if (!telegramReady(env)) return { sent: 0, due: 0 };
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.telegram_chat_id, u.timezone, u.digest_time, u.digest_days, u.digest_mode,
            u.digest_skip_empty, u.digest_last_day, b.data
       FROM users u LEFT JOIN boards b ON b.user_id = u.id
      WHERE u.status = 'active' AND u.digest_enabled = 1 AND u.telegram_chat_id IS NOT NULL`
  ).all();

  const due = [];
  for (const row of results) {
    const clock = Core.zonedClock(new Date(now), row.timezone || env.DIGEST_TIMEZONE || 'UTC');
    if (row.digest_last_day === clock.day) continue;
    if (!(DIGEST_DAYS[row.digest_days] || DIGEST_DAYS['mon-sat']).includes(clock.weekday)) continue;
    const late = minutesOf(clock.time) - minutesOf(row.digest_time);
    if (late < 0 || late >= DIGEST_WINDOW_MIN) continue;
    due.push({ row, clock });
    if (due.length >= DIGESTS_PER_RUN) break; // the rest go 15 minutes later
  }

  const updates = [];
  let sent = 0;
  for (const { row, clock } of due) {
    const digest = Core.buildDigest(Core.normalizeData(row.data ? JSON.parse(row.data) : null), { today: clock.day, now, name: row.name, mode: row.digest_mode });
    if (row.digest_skip_empty && digest.isEmpty) {
      updates.push(env.DB.prepare('UPDATE users SET digest_last_day = ? WHERE id = ?').bind(clock.day, row.id));
      continue;
    }
    try {
      await send(env, row.telegram_chat_id, digest.text, openButton(env));
      sent += 1;
      updates.push(env.DB.prepare('UPDATE users SET digest_last_day = ? WHERE id = ?').bind(clock.day, row.id));
    } catch (err) {
      if (err.status === 403) {
        // They blocked the bot: stop trying.
        updates.push(env.DB.prepare(`UPDATE users SET ${UNLINK} WHERE id = ?`).bind(row.id));
      } else {
        console.warn('Digest not sent, will retry next run:', err.message);
      }
    }
  }
  if (updates.length) await env.DB.batch(updates);
  return { sent, due: due.length };
}
