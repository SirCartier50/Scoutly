-- Career Watch server schema (D1). Mirrors the desktop SQLite schema so the
-- shared core behaves identically on both runtimes.

CREATE TABLE IF NOT EXISTS companies (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  slug             TEXT    NOT NULL UNIQUE,
  name             TEXT    NOT NULL,
  careers_url      TEXT    NOT NULL,
  ats_type         TEXT    NOT NULL DEFAULT 'unknown',
  board_token      TEXT,
  parse_config     TEXT,
  topics           TEXT    NOT NULL DEFAULT '[]',
  watched          INTEGER NOT NULL DEFAULT 0,
  source           TEXT    NOT NULL DEFAULT 'manual',
  health           TEXT    NOT NULL DEFAULT 'ok',
  last_ok_at       TEXT,
  last_checked_at  TEXT,
  last_yield       INTEGER,
  yield_history    TEXT    NOT NULL DEFAULT '[]',
  consecutive_zero INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companies_watched ON companies(watched);
CREATE INDEX IF NOT EXISTS idx_companies_health  ON companies(health);

CREATE TABLE IF NOT EXISTS postings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  external_id    TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  location       TEXT,
  role_type      TEXT    NOT NULL DEFAULT 'other',
  apply_url      TEXT    NOT NULL,
  posted_at      TEXT,
  first_seen_at  TEXT    NOT NULL,
  last_seen_at   TEXT    NOT NULL,
  closed_at      TEXT,
  description    TEXT,
  notified       INTEGER NOT NULL DEFAULT 0,
  needs_triage   INTEGER NOT NULL DEFAULT 0,
  app_status     TEXT    NOT NULL DEFAULT 'none',
  app_updated_at TEXT,
  app_note       TEXT,
  deadline       TEXT,
  UNIQUE(company_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_postings_company  ON postings(company_id);
CREATE INDEX IF NOT EXISTS idx_postings_role     ON postings(role_type);
CREATE INDEX IF NOT EXISTS idx_postings_open     ON postings(closed_at) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_postings_notified ON postings(notified) WHERE notified = 0;
CREATE INDEX IF NOT EXISTS idx_postings_app      ON postings(app_status) WHERE app_status != 'none';

CREATE TABLE IF NOT EXISTS programs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  url             TEXT    NOT NULL,
  content_hash    TEXT,
  status          TEXT,
  apply_url       TEXT,
  eligibility     TEXT,
  deadline        TEXT,
  first_seen_at   TEXT    NOT NULL,
  last_changed_at TEXT    NOT NULL,
  notified        INTEGER NOT NULL DEFAULT 0,
  UNIQUE(company_id, url)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  role                  TEXT    NOT NULL,
  model                 TEXT    NOT NULL,
  company_id            INTEGER,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  usd                   REAL    NOT NULL DEFAULT 0,
  ok                    INTEGER NOT NULL DEFAULT 1,
  error                 TEXT,
  created_at            TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_created ON agent_runs(created_at);

CREATE TABLE IF NOT EXISTS run_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT    NOT NULL DEFAULT 'scheduled',
  started_at        TEXT    NOT NULL,
  finished_at       TEXT,
  companies_checked INTEGER NOT NULL DEFAULT 0,
  new_postings      INTEGER NOT NULL DEFAULT 0,
  new_programs      INTEGER NOT NULL DEFAULT 0,
  errors            INTEGER NOT NULL DEFAULT 0,
  error_detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_log_started ON run_log(started_at);

-- The verified company directory, shared by every client and grown on demand.
CREATE TABLE IF NOT EXISTS directory (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  careers_url TEXT NOT NULL,
  ats_type    TEXT NOT NULL,
  board_token TEXT NOT NULL,
  topics      TEXT NOT NULL DEFAULT '[]',
  job_count   INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_directory_name ON directory(name);
