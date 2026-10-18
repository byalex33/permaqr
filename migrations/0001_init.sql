-- PermaQR schema. Scan rows store country, device, OS, and referrer host only.
-- IP addresses are intentionally not stored.

CREATE TABLE IF NOT EXISTS codes (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  destination TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  style TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_codes_created ON codes (created_at DESC);

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id TEXT NOT NULL,
  scanned_at INTEGER NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_scans_code_time ON scans (code_id, scanned_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
