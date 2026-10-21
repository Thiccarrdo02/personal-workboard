// Serverless Function: morning digest (overdue, due today, urgent, waiting)
// sent to Telegram and/or email. Triggered daily by Vercel Cron (see vercel.json)
// or on demand from the app's "Morning digest" panel.
//
// Env vars:
//   CRON_SECRET                         required for the scheduled run (Vercel sends it as a Bearer token)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  Telegram delivery
//   RESEND_API_KEY, DIGEST_EMAIL_TO     email delivery via resend.com (DIGEST_EMAIL_FROM optional)
//   DIGEST_TIMEZONE                     fallback if the board has no timezone saved

const { verifyToken, extractToken } = require('../lib/auth');
const storage = require('../lib/storage');
const core = require('../public/js/core.js');

function config() {
  return {
    cronSecret: process.env.CRON_SECRET || '',
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    resendKey: process.env.RESEND_API_KEY || '',
    emailTo: process.env.DIGEST_EMAIL_TO || '',
    emailFrom: process.env.DIGEST_EMAIL_FROM || 'Workboard <onboarding@resend.dev>',
    fallbackTimezone: process.env.DIGEST_TIMEZONE || 'UTC'
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

// Lists chats that have messaged the bot, so the user can find their TELEGRAM_CHAT_ID.
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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const cfg = config();
  const authHeader = (req.headers && req.headers['authorization']) || '';
  const isCron = Boolean(cfg.cronSecret) && authHeader === `Bearer ${cfg.cronSecret}`;
  const isUser = verifyToken(extractToken(req) || body.token);
  if (!isCron && !isUser) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  const action = (req.query && req.query.action) || body.action || (isCron ? 'send' : 'status');

  try {
    if (action === 'status') {
      res.status(200).json({
        ok: true,
        channels: {
          telegram: Boolean(cfg.telegramToken && cfg.telegramChatId),
          email: Boolean(cfg.resendKey && cfg.emailTo)
        },
        telegramTokenSet: Boolean(cfg.telegramToken),
        telegramChatIdSet: Boolean(cfg.telegramChatId),
        cronSecretSet: Boolean(cfg.cronSecret),
        storage: storage.backend
      });
      return;
    }

    if (action === 'telegram-chats') {
      if (!isUser) throw new Error('Not allowed');
      if (!cfg.telegramToken) {
        res.status(400).json({ ok: false, error: 'Set TELEGRAM_BOT_TOKEN first.' });
        return;
      }
      res.status(200).json({ ok: true, chats: await telegramChats(cfg) });
      return;
    }

    if (action !== 'send') {
      res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
      return;
    }

    const record = await storage.readBoard({ fresh: true });
    const data = core.normalizeData(record && record.data);
    const timezone = data.settings.timezone || cfg.fallbackTimezone;
    const today = core.dayInTimeZone(new Date(), timezone);
    const digest = core.buildDigest(data, { today });

    const sent = [];
    const errors = [];
    if (cfg.telegramToken && cfg.telegramChatId) {
      try { await sendTelegram(cfg, digest.text); sent.push('telegram'); } catch (e) { errors.push(e.message); }
    }
    if (cfg.resendKey && cfg.emailTo) {
      try {
        await sendEmail(cfg, `Workboard · ${core.formatDay(today)} · ${digest.counts.overdue} overdue, ${digest.counts.today} due today`, digest.text);
        sent.push('email');
      } catch (e) { errors.push(e.message); }
    }
    if (!sent.length && !errors.length) errors.push('No delivery channel configured. Add Telegram or email env vars in Vercel.');

    res.status(errors.length && !sent.length ? 502 : 200).json({
      ok: sent.length > 0,
      sent,
      errors,
      timezone,
      // Only the signed-in user gets the digest text back.
      preview: isUser ? digest.text : undefined
    });
  } catch (err) {
    console.error('Error in /api/digest:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
