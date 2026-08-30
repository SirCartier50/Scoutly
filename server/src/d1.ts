import type { RoleType } from '../../src/shared/types'
import type { BrowserWorker } from '@cloudflare/puppeteer'

/**
 * D1 repository. Mirrors the desktop repo layer's semantics exactly - the
 * difference is that every call is async, because D1 has no synchronous API.
 *
 * The safety property carried over from the desktop version: a posting is never
 * deleted, only marked closed, and closing only ever happens on the result of a
 * SUCCESSFUL fetch.
 */

export interface Env {
  DB: D1Database
  RESEND_API_KEY?: string
  DIGEST_TO?: string
  CLIENT_TOKEN?: string
  LLM_API_KEY?: string
  LLM_BASE_URL?: string
  LLM_MODEL?: string
  LLM_ESCALATION_MODEL?: string
  BROWSER?: BrowserWorker
}

const now = (): string => new Date().toISOString()

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export interface CompanyRow {
  id: number
  slug: string
  name: string
  careers_url: string
  ats_type: string
  board_token: string | null
  parse_config: string | null
  topics: string
  watched: number
  health: string
  last_ok_at: string | null
  last_yield: number | null
  yield_history: string
  consecutive_zero: number
  last_error: string | null
}

export async function listCompanies(db: D1Database, onlyWatched = false): Promise<CompanyRow[]> {
  const sql = onlyWatched
    ? 'SELECT * FROM companies WHERE watched = 1 ORDER BY name'
    : 'SELECT * FROM companies ORDER BY name'
  const { results } = await db.prepare(sql).all<CompanyRow>()
  return results ?? []
}

export async function upsertCompany(
  db: D1Database,
  c: {
    name: string
    careersUrl: string
    atsType?: string
    boardToken?: string | null
    topics?: string[]
    watched?: boolean
    source?: string
  }
): Promise<number> {
  const slug = slugify(c.name)
  await db
    .prepare(
      `INSERT INTO companies (slug, name, careers_url, ats_type, board_token, topics, watched, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         name        = excluded.name,
         careers_url = excluded.careers_url,
         ats_type    = CASE WHEN excluded.ats_type = 'unknown' THEN companies.ats_type ELSE excluded.ats_type END,
         board_token = COALESCE(excluded.board_token, companies.board_token),
         topics      = excluded.topics`
    )
    .bind(
      slug,
      c.name,
      c.careersUrl,
      c.atsType ?? 'unknown',
      c.boardToken ?? null,
      JSON.stringify(c.topics ?? []),
      c.watched ? 1 : 0,
      c.source ?? 'manual',
      now()
    )
    .run()

  const row = await db.prepare('SELECT id FROM companies WHERE slug = ?').bind(slug).first<{ id: number }>()
  return row?.id ?? 0
}

export async function setWatched(db: D1Database, id: number, watched: boolean): Promise<void> {
  await db.prepare('UPDATE companies SET watched = ? WHERE id = ?').bind(watched ? 1 : 0, id).run()
}

export async function deleteCompany(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM companies WHERE id = ?').bind(id).run()
}

/* ------------------------------------------------------------- postings */

export interface FetchedPosting {
  externalId: string
  title: string
  location: string | null
  applyUrl: string
  postedAt: string | null
  description: string | null
  roleType: RoleType
  needsTriage?: boolean
}

export interface SyncResult {
  newPostings: { id: number; title: string; roleType: RoleType }[]
  updated: number
  closed: number
}

/**
 * Reconciles one company's feed against stored state.
 *
 * Only ever called with a SUCCESSFUL fetch: absence means "closed", so running
 * this on a failed fetch would read as every job closing at once and produce a
 * false all-clear.
 */
export async function syncPostings(
  db: D1Database,
  companyId: number,
  fetched: FetchedPosting[]
): Promise<SyncResult> {
  const ts = now()
  const { results } = await db
    .prepare('SELECT external_id FROM postings WHERE company_id = ?')
    .bind(companyId)
    .all<{ external_id: string }>()
  const known = new Set((results ?? []).map((r) => r.external_id))
  const seen = new Set<string>()

  const statements: D1PreparedStatement[] = []
  const inserted: string[] = []
  let updated = 0

  // posted_at is refreshed here too, not just set at insert: a connector that
  // reported a wrong date (as the Amazon one briefly did - Unix seconds fed in
  // as milliseconds, stamping every posting as January 1970) needs a plain
  // resync to self-correct, without requiring a manual data fix. COALESCE
  // keeps a previously-known-good date if this fetch didn't supply one.
  const updateStmt = db.prepare(
    `UPDATE postings SET last_seen_at = ?, title = ?, location = ?, apply_url = ?,
       description = COALESCE(?, description), posted_at = COALESCE(?, posted_at),
       closed_at = NULL
     WHERE company_id = ? AND external_id = ?`
  )
  const insertStmt = db.prepare(
    `INSERT INTO postings
       (company_id, external_id, title, location, role_type, apply_url,
        posted_at, first_seen_at, last_seen_at, description, notified, needs_triage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  )

  for (const p of fetched) {
    seen.add(p.externalId)
    if (known.has(p.externalId)) {
      statements.push(
        updateStmt.bind(ts, p.title, p.location, p.applyUrl, p.description, p.postedAt, companyId, p.externalId)
      )
      updated++
    } else {
      statements.push(
        insertStmt.bind(
          companyId, p.externalId, p.title, p.location, p.roleType, p.applyUrl,
          p.postedAt, ts, ts, p.description, p.needsTriage ? 1 : 0
        )
      )
      inserted.push(p.externalId)
    }
  }

  const closeStmt = db.prepare(
    'UPDATE postings SET closed_at = ? WHERE company_id = ? AND external_id = ? AND closed_at IS NULL'
  )
  let closedCount = 0
  for (const id of known) {
    if (seen.has(id)) continue
    statements.push(closeStmt.bind(ts, companyId, id))
    closedCount++
  }

  // D1 batches run atomically, which is the closest equivalent to the desktop
  // version's transaction.
  if (statements.length > 0) await db.batch(statements)

  const newPostings: SyncResult['newPostings'] = []
  if (inserted.length > 0) {
    const placeholders = inserted.map(() => '?').join(',')
    const { results: rows } = await db
      .prepare(
        `SELECT id, title, role_type AS roleType FROM postings
         WHERE company_id = ? AND external_id IN (${placeholders})`
      )
      .bind(companyId, ...inserted)
      .all<{ id: number; title: string; roleType: RoleType }>()
    newPostings.push(...(rows ?? []))
  }

  return { newPostings, updated, closed: closedCount }
}

export async function recordCheck(
  db: D1Database,
  id: number,
  outcome: { ok: boolean; yield?: number; error?: string; health?: string }
): Promise<void> {
  const ts = now()
  if (!outcome.ok) {
    await db
      .prepare('UPDATE companies SET last_checked_at = ?, last_error = ?, health = ? WHERE id = ?')
      .bind(ts, outcome.error ?? 'unknown error', outcome.health ?? 'broken', id)
      .run()
    return
  }

  const row = await db
    .prepare('SELECT yield_history FROM companies WHERE id = ?')
    .bind(id)
    .first<{ yield_history: string }>()
  const history = row ? (JSON.parse(row.yield_history) as number[]) : []
  const y = outcome.yield ?? 0
  history.push(y)
  while (history.length > 14) history.shift()

  await db
    .prepare(
      `UPDATE companies SET last_checked_at = ?, last_ok_at = ?, last_yield = ?,
         yield_history = ?, last_error = NULL, health = ?,
         consecutive_zero = CASE WHEN ? = 0 THEN consecutive_zero + 1 ELSE 0 END
       WHERE id = ?`
    )
    .bind(ts, ts, y, JSON.stringify(history), outcome.health ?? 'ok', y, id)
    .run()
}

export interface PendingNotification {
  id: number
  title: string
  location: string | null
  applyUrl: string
  postedAt: string | null
  roleType: RoleType
  companyName: string
}

export async function unnotifiedPostings(db: D1Database): Promise<PendingNotification[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.title, p.location, p.apply_url AS applyUrl, p.posted_at AS postedAt,
              p.role_type AS roleType, c.name AS companyName
       FROM postings p JOIN companies c ON c.id = p.company_id
       WHERE p.notified = 0 AND p.closed_at IS NULL AND c.watched = 1
         AND p.needs_triage = 0
       ORDER BY CASE p.role_type
                  WHEN 'intern' THEN 0 WHEN 'program' THEN 1
                  WHEN 'newgrad' THEN 2 ELSE 3 END, c.name`
    )
    .all<PendingNotification>()
  return results ?? []
}

export async function markNotified(db: D1Database, ids: number[]): Promise<void> {
  if (ids.length === 0) return
  const stmt = db.prepare('UPDATE postings SET notified = 1 WHERE id = ?')
  await db.batch(ids.map((id) => stmt.bind(id)))
}

/**
 * Auto-closes postings past a maximum age, even if the company's feed still
 * lists them - some ATS boards leave stale reqs listed for months. Age is
 * measured from the real posted date when the feed provides one, falling back
 * to when we first saw it (the same "posted vs detected" distinction the UI
 * already shows). Closed, never deleted - identical to how a posting
 * disappearing from a feed is handled, so history and stats stay intact.
 */
export async function closeStalePostings(db: D1Database, cutoffIso: string): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE postings SET closed_at = ?
       WHERE closed_at IS NULL AND COALESCE(posted_at, first_seen_at) < ?`
    )
    .bind(new Date().toISOString(), cutoffIso)
    .run()
  return res.meta.changes ?? 0
}

/* -------------------------------------------------------------- settings */

export async function getSettings<T extends Record<string, unknown>>(
  db: D1Database,
  defaults: T
): Promise<T> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>()
  const out = { ...defaults }
  for (const r of results ?? []) {
    if (!(r.key in defaults)) continue
    try {
      ;(out as Record<string, unknown>)[r.key] = JSON.parse(r.value)
    } catch {
      // A corrupt value falls back to the default rather than breaking a run.
    }
  }
  return out
}

export async function setSettings(db: D1Database, patch: Record<string, unknown>): Promise<void> {
  const entries = Object.entries(patch)
  if (entries.length === 0) return
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  await db.batch(entries.map(([k, v]) => stmt.bind(k, JSON.stringify(v))))
}

/* ------------------------------------------------------------- run log */

export async function startRun(db: D1Database, kind: string): Promise<number> {
  await db.prepare('INSERT INTO run_log (kind, started_at) VALUES (?, ?)').bind(kind, now()).run()
  const r = await db.prepare('SELECT last_insert_rowid() AS id').first<{ id: number }>()
  return r?.id ?? 0
}

export async function finishRun(
  db: D1Database,
  runId: number,
  s: { companiesChecked: number; newPostings: number; errors: number }
): Promise<void> {
  await db
    .prepare(
      'UPDATE run_log SET finished_at = ?, companies_checked = ?, new_postings = ?, errors = ? WHERE id = ?'
    )
    .bind(now(), s.companiesChecked, s.newPostings, s.errors, runId)
    .run()
}

/* ------------------------------------------------------------ triage/medic */

export interface TriageCandidate {
  id: number
  title: string
  description: string | null
  companyId: number
}

/** Postings flagged ambiguous by the classifier, oldest first, capped per run. */
export async function triageQueue(db: D1Database, limit = 20): Promise<TriageCandidate[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, description, company_id AS companyId FROM postings
       WHERE needs_triage = 1 AND closed_at IS NULL
       ORDER BY first_seen_at ASC LIMIT ?`
    )
    .bind(limit)
    .all<TriageCandidate>()
  return results ?? []
}

export async function resolveTriage(
  db: D1Database,
  id: number,
  roleType: RoleType | null
): Promise<void> {
  if (roleType) {
    // Confirmed early-career: clear the flag so it joins the normal digest flow.
    await db.prepare('UPDATE postings SET role_type = ?, needs_triage = 0 WHERE id = ?').bind(roleType, id).run()
  } else {
    // Confirmed NOT early-career: drop it from consideration entirely.
    await db.prepare("UPDATE postings SET role_type = 'other', needs_triage = 0 WHERE id = ?").bind(id).run()
  }
}

/** Companies whose health has gone broken and may need re-discovery. */
export async function brokenCompanies(db: D1Database, limit = 10): Promise<CompanyRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM companies WHERE watched = 1 AND health = 'broken' ORDER BY last_checked_at ASC LIMIT ?")
    .bind(limit)
    .all<CompanyRow>()
  return results ?? []
}

export async function setConnector(
  db: D1Database,
  id: number,
  atsType: string,
  boardToken: string | null,
  parseConfig: unknown | null
): Promise<void> {
  await db
    .prepare('UPDATE companies SET ats_type = ?, board_token = ?, parse_config = ?, health = ?, consecutive_zero = 0 WHERE id = ?')
    .bind(atsType, boardToken, parseConfig ? JSON.stringify(parseConfig) : null, 'ok', id)
    .run()
}

export async function recordAgentRun(
  db: D1Database,
  r: { role: string; model: string; companyId?: number | null; usd: number; ok: boolean; error?: string | null }
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO agent_runs (role, model, company_id, usd, ok, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(r.role, r.model, r.companyId ?? null, r.usd, r.ok ? 1 : 0, r.error ?? null, now())
    .run()
}
