-- ZAWISH Workboard schema. Every person has their own board; nothing is shared.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',        -- owner | member
  status TEXT NOT NULL DEFAULT 'active',      -- pending | active | disabled
  pin_hash TEXT,                              -- NULL until the person sets a PIN
  pin_salt TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  lockouts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  last_active_at INTEGER
);

-- One row per signed-in device. Only a SHA-256 of the token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',      -- pending (awaiting approval) | active
  device TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- One-time links: first-time PIN setup, PIN resets, team invites.
CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,                      -- setup | reset | join
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- Each person's board as JSON, with a revision number for safe multi-device saves.
CREATE TABLE boards (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Fixed-window counters for login / request throttling.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
