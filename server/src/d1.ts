import type { RoleType } from '../../src/shared/types'
import type { BrowserWorker } from '@cloudflare/puppeteer'

/**
 * D1 repository. Mirrors the desktop repo layer's semantics exactly - the
 * difference is that every call is async, because D1 has no synchronous API.
 *
 * The safety property carried over from the desktop version: a posting is never
 * deleted, only marked closed, and closing only ever happens on the result of a
 * SUCCESSFUL fetch.
 *
 * Multi-tenant shape (see migrations/0006_multi_tenant.sql): companies and
 * postings stay GLOBAL - fetched once per company regardless of how many users
 * watch it, which is what keeps this inside Cloudflare's 50-subrequest-per-
 * invocation ceiling as the user base grows. Everything user-specific (watch
 * list, filter settings, notification state, application status) lives in
 * join tables and is applied at read/notify time, never baked into fetch or
 * storage.
 */

export interface Env {
  DB: D1Database
  RESEND_API_KEY?: string
  CLIENT_TOKEN?: string
  LLM_API_KEY?: string
  LLM_BASE_URL?: string
  LLM_MODEL?: string
  LLM_ESCALATION_MODEL?: string
  GOOGLE_CLIENT_ID?: string
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

/* ---------------------------------------------------------------- users */

export interface UserRow {
  id: number
  google_sub: string
  email: string
  name: string | null
  picture_url: string | null
  created_at: string
}

export async function upsertUser(
  db: D1Database,
  u: { googleSub: string; email: string; name?: string | null; pictureUrl?: string | null }
): Promise<UserRow> {
  await db
    .prepare(
      `INSERT INTO users (google_sub, email, name, picture_url, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(google_sub) DO UPDATE SET
         email = excluded.email, name = excluded.name, picture_url = excluded.picture_url`
    )
    .bind(u.googleSub, u.email, u.name ?? null, u.pictureUrl ?? null, now())
    .run()

  const row = await db.prepare('SELECT * FROM users WHERE google_sub = ?').bind(u.googleSub).first<UserRow>()
  if (!row) throw new Error('user upsert failed')
  return row
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Issues a new per-user bearer token, storing only its hash (never the raw value). */
export async function issueToken(db: D1Database, userId: number): Promise<string> {
  const raw = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const hash = await sha256Hex(raw)
  await db
    .prepare('INSERT INTO user_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)')
    .bind(hash, userId, now())
    .run()
  return raw
}

/** Resolves a raw bearer token to its owning user, updating last-used bookkeeping. */
export async function authenticateToken(db: D1Database, rawToken: string): Promise<UserRow | null> {
  if (!rawToken) return null
  const hash = await sha256Hex(rawToken)
  const row = await db
    .prepare(
      `SELECT u.* FROM user_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`
    )
    .bind(hash)
    .first<UserRow>()
  if (!row) return null
  await db.prepare('UPDATE user_tokens SET last_used_at = ? WHERE token_hash = ?').bind(now(), hash).run()
  return row
}

/* ------------------------------------------------------------- companies */

export interface CompanyRow {
  id: number
  slug: string
  name: string
  careers_url: string
  ats_type: string
  board_token: string | null
  parse_config: string | null
  topics: string
  health: string
  last_ok_at: string | null
  last_checked_at: string | null
  last_yield: number | null
  yield_history: string
  consecutive_zero: number
  last_error: string | null
  created_at: string
}

/** Every company ever added by anyone, global admin/debug view. */
export async function listAllCompanies(db: D1Database): Promise<CompanyRow[]> {
  const { results } = await db.prepare('SELECT * FROM companies ORDER BY name').all<CompanyRow>()
  return results ?? []
}

/** Companies on THIS user's watch list. */
export async function listCompaniesForUser(db: D1Database, userId: number): Promise<CompanyRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.* FROM companies c
       JOIN user_companies uc ON uc.company_id = c.id
       WHERE uc.user_id = ? ORDER BY c.name`
    )
    .bind(userId)
    .all<CompanyRow>()
  return results ?? []
}

/**
 * Companies watched by at least one user. This is what the hourly cron fetch
 * loop iterates - one fetch per company regardless of watcher count.
 */
export async function distinctWatchedCompanies(db: D1Database): Promise<CompanyRow[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT c.* FROM companies c
       JOIN user_companies uc ON uc.company_id = c.id`
    )
    .all<CompanyRow>()
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
    source?: string
  }
): Promise<number> {
  const slug = slugify(c.name)
  await db
    .prepare(
      `INSERT INTO companies (slug, name, careers_url, ats_type, board_token, topics, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
      c.source ?? 'manual',
      now()
    )
    .run()

  const row = await db.prepare('SELECT id FROM companies WHERE slug = ?').bind(slug).first<{ id: number }>()
  return row?.id ?? 0
}

/**
 * Adds a company to a user's watch list, seeding a notification baseline for
 * whatever is already open. Without this, a user adding a well-established
 * company would be emailed a flood of every posting that's been open for
 * months - the same "baseline on first run" idea from the single-user version,
 * just scoped to (user, company) instead of the whole app's first-ever run.
 */
export async function addUserCompany(db: D1Database, userId: number, companyId: number): Promise<void> {
  await db
    .prepare('INSERT INTO user_companies (user_id, company_id, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
    .bind(userId, companyId, now())
    .run()

  const { results: open } = await db
    .prepare('SELECT id FROM postings WHERE company_id = ? AND closed_at IS NULL')
    .bind(companyId)
    .all<{ id: number }>()
  if (open && open.length > 0) {
    const ts = now()
    const stmt = db.prepare(
      'INSERT INTO user_posting_notifications (user_id, posting_id, notified_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'
    )
    await db.batch(open.map((p) => stmt.bind(userId, p.id, ts)))
  }
}

/** Removes a company from a user's watch list only - the global company/postings are never touched. */
export async function removeUserCompany(db: D1Database, userId: number, companyId: number): Promise<void> {
  await db.prepare('DELETE FROM user_companies WHERE user_id = ? AND company_id = ?').bind(userId, companyId).run()
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
        posted_at, first_seen_at, last_seen_at, description, needs_triage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
  description: string | null
  applyUrl: string
  postedAt: string | null
  roleType: RoleType
  companyName: string
}

/**
 * Postings a given user has not yet been notified about, across companies THEY
 * watch. Deliberately does not apply location/degree/function/role-type
 * preferences here - that filtering happens at digest time in check.ts (via
 * the shared `applyFilters`), so a user changing their settings can surface an
 * older posting they hadn't been shown before, without re-fetching anything.
 */
export async function unnotifiedPostingsForUser(db: D1Database, userId: number): Promise<PendingNotification[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.title, p.location, p.description, p.apply_url AS applyUrl, p.posted_at AS postedAt,
              p.role_type AS roleType, c.name AS companyName
       FROM postings p
       JOIN companies c ON c.id = p.company_id
       JOIN user_companies uc ON uc.company_id = p.company_id AND uc.user_id = ?
       LEFT JOIN user_posting_notifications n ON n.posting_id = p.id AND n.user_id = ?
       WHERE n.user_id IS NULL AND p.closed_at IS NULL AND p.needs_triage = 0
       ORDER BY CASE p.role_type
                  WHEN 'intern' THEN 0 WHEN 'program' THEN 1
                  WHEN 'newgrad' THEN 2 ELSE 3 END, c.name`
    )
    .bind(userId, userId)
    .all<PendingNotification>()
  return results ?? []
}

export async function markUserNotified(db: D1Database, userId: number, postingIds: number[]): Promise<void> {
  if (postingIds.length === 0) return
  const ts = now()
  const stmt = db.prepare(
    'INSERT INTO user_posting_notifications (user_id, posting_id, notified_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'
  )
  await db.batch(postingIds.map((id) => stmt.bind(userId, id, ts)))
}

/** Every user who watches at least one company - the per-user digest pass iterates this. */
export async function usersWithWatches(db: D1Database): Promise<UserRow[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT u.* FROM users u JOIN user_companies uc ON uc.user_id = u.id`
    )
    .all<UserRow>()
  return results ?? []
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

/* --------------------------------------------------------- per-user status */

export async function setUserPostingStatus(
  db: D1Database,
  userId: number,
  postingId: number,
  status: string,
  note?: string | null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_posting_status (user_id, posting_id, app_status, app_updated_at, app_note)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, posting_id) DO UPDATE SET
         app_status = excluded.app_status,
         app_updated_at = excluded.app_updated_at,
         app_note = COALESCE(excluded.app_note, user_posting_status.app_note)`
    )
    .bind(userId, postingId, status, now(), note ?? null)
    .run()
}

/* -------------------------------------------------------- per-user settings */

export async function getUserSettings<T extends Record<string, unknown>>(
  db: D1Database,
  userId: number,
  defaults: T
): Promise<T> {
  const { results } = await db
    .prepare('SELECT key, value FROM user_settings WHERE user_id = ?')
    .bind(userId)
    .all<{ key: string; value: string }>()
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

export async function setUserSettings(db: D1Database, userId: number, patch: Record<string, unknown>): Promise<void> {
  const entries = Object.entries(patch)
  if (entries.length === 0) return
  const stmt = db.prepare(
    `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
  )
  await db.batch(entries.map(([k, v]) => stmt.bind(userId, k, JSON.stringify(v))))
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

/** Watched companies whose health has gone broken and may need re-discovery. */
export async function brokenCompanies(db: D1Database, limit = 10): Promise<CompanyRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.* FROM companies c
       WHERE c.health = 'broken' AND EXISTS (SELECT 1 FROM user_companies uc WHERE uc.company_id = c.id)
       ORDER BY c.last_checked_at ASC LIMIT ?`
    )
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
