-- Multi-tenant conversion.
--
-- companies/postings stay GLOBAL: one row per company/posting regardless of
-- how many users watch it. This is the load-bearing decision - if N users all
-- watch Google, the hourly cron fetches Google's feed ONCE, not N times,
-- which is the only way this survives Cloudflare's 50-subrequest-per-
-- invocation ceiling as the user base grows. Everything user-specific
-- (watch list, filters, per-user notification/application state) moves to
-- new join tables instead.

CREATE TABLE users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub  TEXT    NOT NULL UNIQUE,
  email       TEXT    NOT NULL,
  name        TEXT,
  picture_url TEXT,
  created_at  TEXT    NOT NULL
);

-- Bearer tokens are stored hashed (SHA-256), never in plaintext - same
-- principle as a password table, even though this is a capability token
-- rather than a credential the user chose themselves.
CREATE TABLE user_tokens (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX idx_user_tokens_user ON user_tokens(user_id);

-- Replaces companies.watched. A company with zero rows here is fetched by
-- nobody and the cron skips it, but its historical postings aren't deleted -
-- same "never delete" principle as everywhere else in this app.
CREATE TABLE user_companies (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  added_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, company_id)
);
CREATE INDEX idx_user_companies_company ON user_companies(company_id);

-- Replaces the single global `settings` table. Same key/value shape so
-- adding a new setting never needs a migration, just scoped per user now.
CREATE TABLE user_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- Replaces postings.notified. A posting is global, but "has THIS user been
-- emailed about it" is inherently per-user - two users watching the same
-- company should each get their own digest the first time they see a role,
-- on their own schedule (e.g. one user adds the company today, another next
-- month - the second user's "baseline" is seeded at add-time, see the
-- /api/companies/add handler).
CREATE TABLE user_posting_notifications (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  posting_id  INTEGER NOT NULL REFERENCES postings(id) ON DELETE CASCADE,
  notified_at TEXT NOT NULL,
  PRIMARY KEY (user_id, posting_id)
);
CREATE INDEX idx_user_posting_notif_posting ON user_posting_notifications(posting_id);

-- Replaces postings.app_status/app_updated_at/app_note. Whether YOU applied
-- to a posting is obviously per-user even though the posting itself is shared.
CREATE TABLE user_posting_status (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  posting_id     INTEGER NOT NULL REFERENCES postings(id) ON DELETE CASCADE,
  app_status     TEXT NOT NULL DEFAULT 'none',
  app_updated_at TEXT,
  app_note       TEXT,
  PRIMARY KEY (user_id, posting_id)
);

-- companies.watched is no longer meaningful (a company can have many
-- watchers or none); D1/SQLite ALTER TABLE DROP COLUMN is supported, but it
-- refuses to drop a column an index still references - the indexes have to
-- go first (confirmed by actually running this migration locally, not
-- assumed: the first attempt failed with exactly this error).
DROP INDEX IF EXISTS idx_companies_watched;
ALTER TABLE companies DROP COLUMN watched;

-- postings.notified/app_status/app_updated_at/app_note are now per-user
-- (above), so the global copies on the posting row are dropped.
DROP INDEX IF EXISTS idx_postings_notified;
DROP INDEX IF EXISTS idx_postings_app;
ALTER TABLE postings DROP COLUMN notified;
ALTER TABLE postings DROP COLUMN app_status;
ALTER TABLE postings DROP COLUMN app_updated_at;
ALTER TABLE postings DROP COLUMN app_note;

-- The old single-row global `settings` table (locations/functions/degree/
-- baselined/etc.) is superseded by user_settings. `baselined` in particular
-- is replaced by the add-time seeding described above, which is strictly
-- better: it's per (user, company) instead of one global flag for the whole
-- app's first-ever run.
DROP TABLE IF EXISTS settings;
