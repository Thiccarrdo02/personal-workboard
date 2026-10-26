-- Phase 3: each person can link their own Telegram and choose their morning digest.

ALTER TABLE users ADD COLUMN telegram_chat_id TEXT;
ALTER TABLE users ADD COLUMN telegram_user_id TEXT;
ALTER TABLE users ADD COLUMN telegram_username TEXT;
ALTER TABLE users ADD COLUMN telegram_linked_at INTEGER;

ALTER TABLE users ADD COLUMN digest_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN digest_time TEXT NOT NULL DEFAULT '08:00';   -- local HH:MM
ALTER TABLE users ADD COLUMN digest_days TEXT NOT NULL DEFAULT 'mon-sat'; -- daily | mon-sat | mon-fri
ALTER TABLE users ADD COLUMN digest_mode TEXT NOT NULL DEFAULT 'full';    -- full | counts
ALTER TABLE users ADD COLUMN digest_skip_empty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN timezone TEXT;                               -- IANA name, from their device
ALTER TABLE users ADD COLUMN digest_last_day TEXT;                        -- local YYYY-MM-DD of the last digest

-- Small key/value store (e.g. the bot's @username, learned when the owner activates it).
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
