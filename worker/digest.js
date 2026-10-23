// Morning digest (overdue, due today, urgent, waiting) sent to Telegram and/or
// email. For now it goes to the owner's own board; per-person digests come later.
//
// Secrets (Cloudflare → Workers → zawish-workboard → Settings → Variables and Secrets):
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID       Telegram delivery
//   RESEND_API_KEY, DIGEST_EMAIL_TO            email via resend.com (DIGEST_EMAIL_FROM optional)
//   DIGEST_TIMEZONE                            fallback if the board has no timezone saved

import Core from '../public/js/core.js';
import { HttpError } from './http.js';

function config(env) {
  return {
    telegramToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: env.TELEGRAM_CHAT_ID || '',
    resendKey: env.RESEND_API_KEY || '',
    emailTo: env.DIGEST_EMAIL_TO || '',
    emailFrom: env.DIGEST_EMAIL_FROM || 'Workboard <onboarding@resend.dev>',
    fallbackTimezone: env.DIGEST_TIMEZONE || 'UTC'
  };
}

async function sendTelegram(cfg, text) {
  const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.telegramChatId, text: text.slice(0, 4000), disable_web_page_preview: true })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(`Telegram error (${res.status}): ${body.description || 'unknown'}`);
}

async function sendEmail(cfg, subject, text) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${cfg.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: cfg.emailFrom, to: cfg.emailTo.split(',').map(s => s.trim()).filter(Boolean), subject, text })
  });
  if (!res.ok) throw new Error(`Email error (${res.status}): ${await res.text()}`);
}

// Lists chats that have messaged the bot, so the owner can find their TELEGRAM_CHAT_ID.
async function telegramChats(cfg) {
  const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/getUpdates`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(`Telegram error (${res.status}): ${body.description || 'unknown'}`);
  const chats = new Map();
  for (const update of body.result || []) {
    const chat = (update.message || update.channel_post || update.my_chat_member || {}).chat;
    if (chat) chats.set(chat.id, { id: chat.id, type: chat.type, name: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '' });
  }
  return [...chats.values()];
}

async function sendDigestFor(env, userId, now) {
  const cfg = config(env);
  const row = await env.DB.prepare('SELECT data FROM boards WHERE user_id = ?').bind(userId).first();
  const data = Core.normalizeData(row ? JSON.parse(row.data) : null);
  const timezone = data.settings.timezone || cfg.fallbackTimezone;
  const today = Core.dayInTimeZone(new Date(now), timezone);
  const digest = Core.buildDigest(data, { today, now });

  const sent = [];
  const errors = [];
  if (cfg.telegramToken && cfg.telegramChatId) {
    try { await sendTelegram(cfg, digest.text); sent.push('telegram'); } catch (e) { errors.push(e.message); }
  }
  if (cfg.resendKey && cfg.emailTo) {
    try {
      await sendEmail(cfg, `Workboard · ${Core.formatDay(today)} · ${digest.counts.overdue} overdue, ${digest.counts.today} due today`, digest.text);
      sent.push('email');
    } catch (e) { errors.push(e.message); }
  }
  if (!sent.length && !errors.length) errors.push('No delivery channel configured yet. Add the Telegram or email secrets in Cloudflare.');
  return { sent, errors, timezone, text: digest.text };
}

export async function handleDigest(env, user, action, now) {
  const cfg = config(env);
  if (action === 'status') {
    return {
      ok: true,
      channels: { telegram: Boolean(cfg.telegramToken && cfg.telegramChatId), email: Boolean(cfg.resendKey && cfg.emailTo) },
      telegramTokenSet: Boolean(cfg.telegramToken),
      telegramChatIdSet: Boolean(cfg.telegramChatId),
      scheduled: true,
      ownerOnly: user.role !== 'owner'
    };
  }
  if (user.role !== 'owner') throw new HttpError(403, 'Personal digests for each team member are coming soon.');
  if (action === 'telegram-chats') {
    if (!cfg.telegramToken) throw new HttpError(400, 'Add the TELEGRAM_BOT_TOKEN secret first.');
    return { ok: true, chats: await telegramChats(cfg) };
  }
  if (action === 'send') {
    const result = await sendDigestFor(env, user.id, now);
    return { ok: result.sent.length > 0, sent: result.sent, errors: result.errors, timezone: result.timezone, preview: result.text };
  }
  throw new HttpError(400, `Unknown action: ${action}`);
}

// Daily cron: send the owner's digest.
export async function sendScheduledDigest(env, now) {
  const owner = await env.DB.prepare("SELECT id FROM users WHERE role = 'owner' AND status = 'active' ORDER BY created_at LIMIT 1").first();
  if (!owner) return;
  const result = await sendDigestFor(env, owner.id, now);
  if (result.errors.length) console.warn('Scheduled digest:', result.errors.join(' | '));
}
