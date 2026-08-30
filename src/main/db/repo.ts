import type { DatabaseSync } from 'node:sqlite'
import { bool, tx } from './index'
import type { AtsType, Company, Health, RoleType } from '@shared/types'

const now = (): string => new Date().toISOString()

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/* ------------------------------------------------------------------ companies */

interface CompanyRow {
  id: number
  slug: string
  name: string
  careers_url: string
  ats_type: string
  board_token: string | null
  topics: string
  watched: number
  source: string
  health: string
  last_ok_at: string | null
  last_yield: number | null
}

function toCompany(r: CompanyRow): Company {
  return {
    id: r.id,
    name: r.name,
    careersUrl: r.careers_url,
    atsType: r.ats_type as AtsType,
    boardToken: r.board_token,
    topics: JSON.parse(r.topics) as string[],
    watched: r.watched === 1,
    source: r.source as Company['source'],
    lastOkAt: r.last_ok_at,
    lastYield: r.last_yield,
    health: r.health as Health
  }
}

export interface UpsertCompanyInput {
  name: string
  careersUrl: string
  atsType?: AtsType
  boardToken?: string | null
  topics?: string[]
  watched?: boolean
  source?: Company['source']
}

/**
 * Idempotent by slug. Re-importing the same seed or CSV updates metadata
 * without duplicating the company or resetting its watch state.
 */
export function upsertCompany(db: DatabaseSync, input: UpsertCompanyInput): number {
  const slug = slugify(input.name)
  db.prepare(
    `INSERT INTO companies (slug, name, careers_url, ats_type, board_token, topics, watched, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       name        = excluded.name,
       careers_url = excluded.careers_url,
       ats_type    = CASE WHEN excluded.ats_type = 'unknown' THEN companies.ats_type ELSE excluded.ats_type END,
       board_token = COALESCE(excluded.board_token, companies.board_token),
       topics      = excluded.topics`
  ).run(
    slug,
    input.name,
    input.careersUrl,
    input.atsType ?? 'unknown',
    input.boardToken ?? null,
    JSON.stringify(input.topics ?? []),
    bool(input.watched ?? true),
    input.source ?? 'manual',
    now()
  )
  const row = db.prepare('SELECT id FROM companies WHERE slug = ?').get(slug) as { id: number }
  return row.id
}

export function listCompanies(db: DatabaseSync, onlyWatched = false): Company[] {
  const sql = onlyWatched
    ? 'SELECT * FROM companies WHERE watched = 1 ORDER BY name'
    : 'SELECT * FROM companies ORDER BY name'
  return (db.prepare(sql).all() as unknown as CompanyRow[]).map(toCompany)
}

export function getCompany(db: DatabaseSync, id: number): Company | null {
  const r = db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as
    | unknown as CompanyRow | undefined
  return r ? toCompany(r) : null
}

export function setWatched(db: DatabaseSync, id: number, watched: boolean): void {
  db.prepare('UPDATE companies SET watched = ? WHERE id = ?').run(bool(watched), id)
}

export function setConnector(
  db: DatabaseSync,
  id: number,
  atsType: AtsType,
  boardToken: string | null,
  parseConfig: unknown | null
): void {
  db.prepare(
    'UPDATE companies SET ats_type = ?, board_token = ?, parse_config = ? WHERE id = ?'
  ).run(atsType, boardToken, parseConfig ? JSON.stringify(parseConfig) : null, id)
}

/** Keeps a bounded window of recent yields so health can use a rolling median. */
export function recordCheck(
  db: DatabaseSync,
  id: number,
  outcome: { ok: boolean; yield?: number; error?: string; health?: Health }
): void {
  const ts = now()

  if (!outcome.ok) {
    db.prepare('UPDATE companies SET last_checked_at = ?, last_error = ?, health = ? WHERE id = ?').run(
      ts,
      outcome.error ?? 'unknown error',
      outcome.health ?? 'broken',
      id
    )
    return
  }

  const row = db.prepare('SELECT yield_history FROM companies WHERE id = ?').get(id) as
    | unknown as { yield_history: string } | undefined
  const history = row ? (JSON.parse(row.yield_history) as number[]) : []
  const y = outcome.yield ?? 0
  history.push(y)
  while (history.length > 14) history.shift()

  db.prepare(
    `UPDATE companies SET
       last_checked_at = ?, last_ok_at = ?, last_yield = ?, yield_history = ?,
       last_error = NULL, health = ?,
       consecutive_zero = CASE WHEN ? = 0 THEN consecutive_zero + 1 ELSE 0 END
     WHERE id = ?`
  ).run(ts, ts, y, JSON.stringify(history), outcome.health ?? 'ok', y, id)
}

export function medianYield(history: number[]): number | null {
  const recent = history.slice(-7)
  if (recent.length === 0) return null
  const s = [...recent].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0)
}

/* ------------------------------------------------------------------- postings */

export interface FetchedPosting {
  externalId: string
  title: string
  location: string | null
  applyUrl: string
  postedAt: string | null
  description: string | null
  roleType: RoleType
}

export interface NewPosting {
  id: number
  title: string
  location: string | null
  applyUrl: string
  roleType: RoleType
}

export interface SyncResult {
  newPostings: NewPosting[]
  updated: number
  closed: number
}

/**
 * Reconciles one company's fetched feed against stored state.
 *
 * Only ever called with the result of a SUCCESSFUL fetch: absence is treated as
 * "closed", so running this on a failed fetch would read as every job closing at
 * once and produce a false all-clear.
 */
export function syncPostings(
  db: DatabaseSync,
  companyId: number,
  fetched: FetchedPosting[]
): SyncResult {
  return tx(db, () => {
    const ts = now()
    const seen = new Set<string>()
    const newPostings: NewPosting[] = []
    let updated = 0

    const existing = db
      .prepare('SELECT external_id FROM postings WHERE company_id = ?')
      .all(companyId) as unknown as { external_id: string }[]
    const known = new Set(existing.map((e) => e.external_id))

    // posted_at is refreshed here too, not just set at insert, so a connector
    // that briefly reported a wrong date can self-correct on the next sync
    // rather than needing a manual data fix.
    const updateStmt = db.prepare(
      `UPDATE postings SET last_seen_at = ?, title = ?, location = ?, apply_url = ?,
         description = COALESCE(?, description), posted_at = COALESCE(?, posted_at),
         closed_at = NULL
       WHERE company_id = ? AND external_id = ?`
    )
    const insertStmt = db.prepare(
      `INSERT INTO postings
         (company_id, external_id, title, location, role_type, apply_url,
          posted_at, first_seen_at, last_seen_at, description, notified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
    const idStmt = db.prepare(
      'SELECT id FROM postings WHERE company_id = ? AND external_id = ?'
    )

    for (const p of fetched) {
      seen.add(p.externalId)
      if (known.has(p.externalId)) {
        updateStmt.run(ts, p.title, p.location, p.applyUrl, p.description, p.postedAt, companyId, p.externalId)
        updated++
      } else {
        insertStmt.run(
          companyId,
          p.externalId,
          p.title,
          p.location,
          p.roleType,
          p.applyUrl,
          p.postedAt,
          ts,
          ts,
          p.description
        )
        const row = idStmt.get(companyId, p.externalId) as unknown as { id: number }
        newPostings.push({
          id: row.id,
          title: p.title,
          location: p.location,
          applyUrl: p.applyUrl,
          roleType: p.roleType
        })
      }
    }

    let closed = 0
    const closeStmt = db.prepare(
      'UPDATE postings SET closed_at = ? WHERE company_id = ? AND external_id = ? AND closed_at IS NULL'
    )
    for (const id of known) {
      if (seen.has(id)) continue
      closed += Number(closeStmt.run(ts, companyId, id).changes)
    }

    return { newPostings, updated, closed }
  })
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

/** Internships first, then programs, then new-grad — the digest ordering. */
export function unnotifiedPostings(db: DatabaseSync): PendingNotification[] {
  return db
    .prepare(
      `SELECT p.id, p.title, p.location, p.apply_url AS applyUrl,
              p.posted_at AS postedAt, p.role_type AS roleType, c.name AS companyName
       FROM postings p JOIN companies c ON c.id = p.company_id
       WHERE p.notified = 0 AND p.closed_at IS NULL AND c.watched = 1
       ORDER BY CASE p.role_type
                  WHEN 'intern' THEN 0 WHEN 'program' THEN 1
                  WHEN 'newgrad' THEN 2 ELSE 3 END, c.name`
    )
    .all() as unknown as PendingNotification[]
}

export function markNotified(db: DatabaseSync, ids: number[]): void {
  if (ids.length === 0) return
  const stmt = db.prepare('UPDATE postings SET notified = 1 WHERE id = ?')
  tx(db, () => {
    for (const id of ids) stmt.run(id)
  })
}

export function countOpenPostings(db: DatabaseSync): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM postings p JOIN companies c ON c.id = p.company_id
       WHERE p.closed_at IS NULL AND c.watched = 1`
    )
    .get() as unknown as { n: number }
  return r.n
}

/* -------------------------------------------------------------------- run_log */

export function startRun(db: DatabaseSync, kind: 'scheduled' | 'manual' | 'catchup'): number {
  db.prepare('INSERT INTO run_log (kind, started_at) VALUES (?, ?)').run(kind, now())
  const r = db.prepare('SELECT last_insert_rowid() AS id').get() as unknown as { id: number }
  return r.id
}

export function finishRun(
  db: DatabaseSync,
  runId: number,
  stats: { companiesChecked: number; newPostings: number; newPrograms?: number; errors: number }
): void {
  db.prepare(
    `UPDATE run_log SET finished_at = ?, companies_checked = ?, new_postings = ?,
       new_programs = ?, errors = ? WHERE id = ?`
  ).run(
    now(),
    stats.companiesChecked,
    stats.newPostings,
    stats.newPrograms ?? 0,
    stats.errors,
    runId
  )
}

export interface RunRow {
  id: number
  kind: string
  started_at: string
  finished_at: string | null
  companies_checked: number
  new_postings: number
  new_programs: number
  errors: number
}

export function latestRun(db: DatabaseSync): RunRow | null {
  const r = db
    .prepare('SELECT * FROM run_log ORDER BY started_at DESC LIMIT 1')
    .get() as unknown as RunRow | undefined
  return r ?? null
}

/* --------------------------------------------------------------- spend ledger */

export function recordAgentRun(
  db: DatabaseSync,
  r: {
    role: string
    model: string
    companyId?: number | null
    jobId?: number | null
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    usd: number
    ok: boolean
    error?: string | null
  }
): void {
  db.prepare(
    `INSERT INTO agent_runs (role, model, company_id, job_id, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, usd, ok, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    r.role,
    r.model,
    r.companyId ?? null,
    r.jobId ?? null,
    r.inputTokens,
    r.outputTokens,
    r.cacheReadTokens ?? 0,
    r.cacheCreationTokens ?? 0,
    r.usd,
    bool(r.ok),
    r.error ?? null,
    now()
  )
}

/** Month-to-date spend, which the dispatcher checks before any agent job. */
export function monthToDateSpend(db: DatabaseSync): number {
  const start = new Date()
  start.setUTCDate(1)
  start.setUTCHours(0, 0, 0, 0)
  const r = db
    .prepare('SELECT COALESCE(SUM(usd), 0) AS total FROM agent_runs WHERE created_at >= ?')
    .get(start.toISOString()) as unknown as { total: number }
  return r.total
}

export function healthCounts(db: DatabaseSync): { ok: number; stale: number; broken: number } {
  const rows = db
    .prepare('SELECT health, COUNT(*) AS n FROM companies WHERE watched = 1 GROUP BY health')
    .all() as unknown as { health: string; n: number }[]
  const out = { ok: 0, stale: 0, broken: 0 }
  for (const r of rows) {
    if (r.health === 'ok' || r.health === 'stale' || r.health === 'broken') out[r.health] = r.n
  }
  return out
}

/* ------------------------------------------------------- listing for the UI */

export interface PostingRow {
  id: number
  companyId: number
  companyName: string
  externalId: string
  title: string
  location: string | null
  roleType: RoleType
  applyUrl: string
  postedAt: string | null
  firstSeenAt: string
  lastSeenAt: string
  closedAt: string | null
  description: string | null
  notified: number
}

export interface PostingQuery {
  roleTypes?: RoleType[]
  companyId?: number
  includeClosed?: boolean
  search?: string
  limit?: number
}

export function listPostings(db: DatabaseSync, q: PostingQuery = {}): PostingRow[] {
  const where: string[] = ['c.watched = 1']
  const args: (string | number)[] = []

  if (!q.includeClosed) where.push('p.closed_at IS NULL')

  if (q.roleTypes && q.roleTypes.length > 0) {
    where.push(`p.role_type IN (${q.roleTypes.map(() => '?').join(',')})`)
    args.push(...q.roleTypes)
  }
  if (q.companyId !== undefined) {
    where.push('p.company_id = ?')
    args.push(q.companyId)
  }
  if (q.search) {
    where.push('(p.title LIKE ? OR c.name LIKE ? OR p.location LIKE ?)')
    const like = `%${q.search}%`
    args.push(like, like, like)
  }

  args.push(q.limit ?? 500)

  return db
    .prepare(
      `SELECT p.id, p.company_id AS companyId, c.name AS companyName, p.external_id AS externalId,
              p.title, p.location, p.role_type AS roleType, p.apply_url AS applyUrl,
              p.posted_at AS postedAt, p.first_seen_at AS firstSeenAt, p.last_seen_at AS lastSeenAt,
              p.closed_at AS closedAt, p.description, p.notified
       FROM postings p JOIN companies c ON c.id = p.company_id
       WHERE ${where.join(' AND ')}
       ORDER BY CASE p.role_type
                  WHEN 'intern' THEN 0 WHEN 'program' THEN 1
                  WHEN 'newgrad' THEN 2 ELSE 3 END,
                p.first_seen_at DESC
       LIMIT ?`
    )
    .all(...args) as unknown as PostingRow[]
}

export interface ProgramRow {
  id: number
  companyId: number
  companyName: string
  name: string
  url: string
  applyUrl: string | null
  eligibility: string | null
  deadline: string | null
  status: string | null
  lastChangedAt: string
}

export function listPrograms(db: DatabaseSync): ProgramRow[] {
  return db
    .prepare(
      `SELECT pr.id, pr.company_id AS companyId, c.name AS companyName, pr.name, pr.url,
              pr.apply_url AS applyUrl, pr.eligibility, pr.deadline, pr.status,
              pr.last_changed_at AS lastChangedAt
       FROM programs pr JOIN companies c ON c.id = pr.company_id
       WHERE c.watched = 1
       ORDER BY c.name`
    )
    .all() as unknown as ProgramRow[]
}

/** Postings first seen after the given timestamp - drives "new since last open". */
export function postingsSince(db: DatabaseSync, since: string | null): PostingRow[] {
  if (!since) return []
  return db
    .prepare(
      `SELECT p.id, p.company_id AS companyId, c.name AS companyName, p.external_id AS externalId,
              p.title, p.location, p.role_type AS roleType, p.apply_url AS applyUrl,
              p.posted_at AS postedAt, p.first_seen_at AS firstSeenAt, p.last_seen_at AS lastSeenAt,
              p.closed_at AS closedAt, p.description, p.notified
       FROM postings p JOIN companies c ON c.id = p.company_id
       WHERE c.watched = 1 AND p.closed_at IS NULL AND p.first_seen_at > ?
       ORDER BY p.first_seen_at DESC LIMIT 200`
    )
    .all(since) as unknown as PostingRow[]
}

export function deleteCompany(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM companies WHERE id = ?').run(id)
}

/* --------------------------------------------------- application tracking */

export type AppStatus = 'none' | 'interested' | 'applied' | 'interviewing' | 'rejected' | 'offer'

export const APP_STATUSES: AppStatus[] = [
  'none', 'interested', 'applied', 'interviewing', 'rejected', 'offer'
]

export function setApplicationStatus(
  db: DatabaseSync,
  postingId: number,
  status: AppStatus,
  note?: string | null
): void {
  db.prepare(
    `UPDATE postings SET app_status = ?, app_updated_at = ?,
       app_note = COALESCE(?, app_note) WHERE id = ?`
  ).run(status, now(), note ?? null, postingId)
}

/**
 * Counts by pipeline stage. "applied" is cumulative - a posting that reached
 * interviewing or offer was still an application sent, so the headline number
 * doesn't drop when you progress.
 */
export function applicationCounts(db: DatabaseSync): {
  interested: number
  applied: number
  interviewing: number
  rejected: number
  offer: number
  totalApplied: number
} {
  const rows = db
    .prepare(
      `SELECT app_status AS s, COUNT(*) AS n FROM postings
       WHERE app_status != 'none' GROUP BY app_status`
    )
    .all() as unknown as { s: string; n: number }[]

  const out = { interested: 0, applied: 0, interviewing: 0, rejected: 0, offer: 0, totalApplied: 0 }
  for (const r of rows) {
    if (r.s in out) (out as Record<string, number>)[r.s] = r.n
  }
  out.totalApplied = out.applied + out.interviewing + out.rejected + out.offer
  return out
}

/** Postings with a stated deadline still ahead, soonest first. */
export function closingSoon(db: DatabaseSync, limit = 10): PostingRow[] {
  return db
    .prepare(
      `SELECT p.id, p.company_id AS companyId, c.name AS companyName, p.external_id AS externalId,
              p.title, p.location, p.role_type AS roleType, p.apply_url AS applyUrl,
              p.posted_at AS postedAt, p.first_seen_at AS firstSeenAt, p.last_seen_at AS lastSeenAt,
              p.closed_at AS closedAt, p.description, p.notified
       FROM postings p JOIN companies c ON c.id = p.company_id
       WHERE c.watched = 1 AND p.closed_at IS NULL AND p.deadline IS NOT NULL
         AND p.deadline >= date('now')
       ORDER BY p.deadline ASC LIMIT ?`
    )
    .all(limit) as unknown as PostingRow[]
}

/** Open early-career postings per watched company, busiest first. */
export function postingsByCompany(db: DatabaseSync): { companyId: number; name: string; open: number }[] {
  return db
    .prepare(
      `SELECT c.id AS companyId, c.name, COUNT(p.id) AS open
       FROM companies c LEFT JOIN postings p
         ON p.company_id = c.id AND p.closed_at IS NULL
       WHERE c.watched = 1
       GROUP BY c.id, c.name
       HAVING open > 0
       ORDER BY open DESC, c.name`
    )
    .all() as unknown as { companyId: number; name: string; open: number }[]
}
