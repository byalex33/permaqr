-- Optional hosted workspaces. These tables are unused unless HOSTED_MODE=true.
-- Operator codes stay in `codes`. Nothing here changes that table.

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  handle TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  setup_token_hash TEXT,
  setup_expires_at INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One Lemon Squeezy order per row. The identifier is the UUID from the receipt,
-- used once as the post-checkout password setup credential.
CREATE TABLE IF NOT EXISTS account_orders (
  order_id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  test_mode INTEGER NOT NULL DEFAULT 0 CHECK (test_mode IN (0, 1)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts (id)
);

CREATE TABLE IF NOT EXISTS account_codes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  destination TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  style TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (account_id, slug),
  FOREIGN KEY (account_id) REFERENCES accounts (id)
);

CREATE INDEX IF NOT EXISTS idx_account_codes_updated ON account_codes (account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS account_settings (
  account_id TEXT PRIMARY KEY,
  fallback_message TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts (id)
);
