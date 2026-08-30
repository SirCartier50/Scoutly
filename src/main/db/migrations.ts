import type { DatabaseSync } from 'node:sqlite'

export interface Migration {
  version: number
  name: string
  up: (db: DatabaseSync) => void
}

/**
 * Ordered, append-only. Each migration bumps user_version; never edit one that
 * has shipped — add a new entry instead.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE companies (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          slug          TEXT    NOT NULL UNIQUE,
          name          TEXT    NOT NULL,
          careers_url   TEXT    NOT NULL,
          ats_type      TEXT    NOT NULL DEFAULT 'unknown',
          board_token   TEXT,
          parse_config  TEXT,
          topics        TEXT    NOT NULL DEFAULT '[]',
          watched       INTEGER NOT NULL DEFAULT 1,
          source        TEXT    NOT NULL DEFAULT 'manual',
          health        TEXT    NOT NULL DEFAULT 'ok',
          last_ok_at    TEXT,
          last_checked_at TEXT,
          last_yield    INTEGER,
          yield_history TEXT    NOT NULL DEFAULT '[]',
          consecutive_zero INTEGER NOT NULL DEFAULT 0,
          last_error    TEXT,
          created_at    TEXT    NOT NULL
        ) STRICT;

        CREATE INDEX idx_companies_watched ON companies(watched);
        CREATE INDEX idx_companies_health  ON companies(health);

        CREATE TABLE postings (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          external_id   TEXT    NOT NULL,
          title         TEXT    NOT NULL,
          location      TEXT,
          role_type     TEXT    NOT NULL DEFAULT 'other',
          apply_url     TEXT    NOT NULL,
          posted_at     TEXT,
          first_seen_at TEXT    NOT NULL,
          last_seen_at  TEXT    NOT NULL,
          closed_at     TEXT,
          description   TEXT,
          notified      INTEGER NOT NULL DEFAULT 0,
          UNIQUE(company_id, external_id)
        ) STRICT;

        CREATE INDEX idx_postings_company  ON postings(company_id);
        CREATE INDEX idx_postings_role     ON postings(role_type);
        CREATE INDEX idx_postings_open     ON postings(closed_at) WHERE closed_at IS NULL;
        CREATE INDEX idx_postings_notified ON postings(notified) WHERE notified = 0;

        CREATE TABLE programs (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          name           TEXT    NOT NULL,
          url            TEXT    NOT NULL,
          content_hash   TEXT,
          status         TEXT,
          apply_url      TEXT,
          eligibility    TEXT,
          deadline       TEXT,
          first_seen_at  TEXT    NOT NULL,
          last_changed_at TEXT   NOT NULL,
          notified       INTEGER NOT NULL DEFAULT 0,
          UNIQUE(company_id, url)
        ) STRICT;

        CREATE INDEX idx_programs_company ON programs(company_id);

        -- Key/value so new settings never need a migration.
        CREATE TABLE settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;

        CREATE TABLE jobs (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          type        TEXT    NOT NULL,
          company_id  INTEGER REFERENCES companies(id) ON DELETE CASCADE,
          payload     TEXT,
          status      TEXT    NOT NULL DEFAULT 'queued',
          priority    INTEGER NOT NULL DEFAULT 100,
          attempts    INTEGER NOT NULL DEFAULT 0,
          error       TEXT,
          cost_usd    REAL    NOT NULL DEFAULT 0,
          run_id      INTEGER,
          created_at  TEXT    NOT NULL,
          started_at  TEXT,
          finished_at TEXT
        ) STRICT;

        CREATE INDEX idx_jobs_dispatch ON jobs(status, priority, created_at);
        CREATE INDEX idx_jobs_run      ON jobs(run_id);

        -- Spend ledger: one row per model call, so the cap is auditable.
        CREATE TABLE agent_runs (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          role                  TEXT    NOT NULL,
          model                 TEXT    NOT NULL,
          company_id            INTEGER REFERENCES companies(id) ON DELETE SET NULL,
          job_id                INTEGER,
          input_tokens          INTEGER NOT NULL DEFAULT 0,
          output_tokens         INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
          cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
          usd                   REAL    NOT NULL DEFAULT 0,
          ok                    INTEGER NOT NULL DEFAULT 1,
          error                 TEXT,
          created_at            TEXT    NOT NULL
        ) STRICT;

        CREATE INDEX idx_agent_runs_created ON agent_runs(created_at);

        CREATE TABLE run_log (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          kind              TEXT    NOT NULL DEFAULT 'scheduled',
          started_at        TEXT    NOT NULL,
          finished_at       TEXT,
          companies_checked INTEGER NOT NULL DEFAULT 0,
          new_postings      INTEGER NOT NULL DEFAULT 0,
          new_programs      INTEGER NOT NULL DEFAULT 0,
          errors            INTEGER NOT NULL DEFAULT 0,
          error_detail      TEXT
        ) STRICT;

        CREATE INDEX idx_run_log_started ON run_log(started_at);
      `)
    }
  },
  {
    version: 2,
    name: 'application tracking',
    up: (db) => {
      db.exec(`
        ALTER TABLE postings ADD COLUMN app_status TEXT NOT NULL DEFAULT 'none';
        ALTER TABLE postings ADD COLUMN app_updated_at TEXT;
        ALTER TABLE postings ADD COLUMN app_note TEXT;
        ALTER TABLE postings ADD COLUMN deadline TEXT;

        CREATE INDEX idx_postings_app_status ON postings(app_status)
          WHERE app_status != 'none';
      `)
    }
  }
]

export function migrate(db: DatabaseSync): { from: number; to: number; applied: string[] } {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  const from = row.user_version
  const applied: string[] = []

  for (const m of MIGRATIONS) {
    if (m.version <= from) continue
    db.exec('BEGIN')
    try {
      m.up(db)
      // PRAGMA won't take a bound parameter, and version is a trusted literal.
      db.exec(`PRAGMA user_version = ${m.version}`)
      db.exec('COMMIT')
      applied.push(`${m.version}:${m.name}`)
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`migration ${m.version} (${m.name}) failed: ${(err as Error).message}`)
    }
  }

  const to = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  return { from, to, applied }
}
