import { registerWorkerHtmlParser } from './htmlParser'
import { enqueueFetchJobs, fetchAndStoreCompany, runNotifyPass, DEFAULT_USER_SETTINGS } from './check'
import { verifyGoogleIdToken } from './auth'
import {
  authenticateToken, getUserSettings, issueToken, listAllCompanies,
  requestCompany, setUserPostingStatus, setUserSettings, upsertUser,
  type Env, type FetchJob, type UserRow
} from './d1'

registerWorkerHtmlParser()

/* --------------------------------------------------------------------- auth */

/**
 * Resolves a request's bearer token to the user it belongs to. Replaces the
 * old single shared CLIENT_TOKEN: every user (desktop or web) now presents
 * their own per-user token, obtained once via /api/auth/google and stored
 * client-side exactly the way the shared token used to be - the desktop
 * app's serverClient needed zero code changes for this.
 */
async function authenticate(req: Request, env: Env): Promise<UserRow | null> {
  const header = req.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return null
  return await authenticateToken(env.DB, token)
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  })

/* --------------------------------------------------------------------- api */

/** The one public, unauthenticated endpoint: trading a Google ID token for a Career Watch bearer token. */
async function handleGoogleAuth(req: Request, env: Env): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID) return json({ error: 'server not configured for Google sign-in' }, 500)
  const body = (await req.json().catch(() => null)) as { idToken?: string } | null
  if (!body?.idToken) return json({ error: 'idToken required' }, 400)

  let identity
  try {
    identity = await verifyGoogleIdToken(body.idToken, env.GOOGLE_CLIENT_ID)
  } catch (err) {
    return json({ error: `invalid Google token: ${err instanceof Error ? err.message : String(err)}` }, 401)
  }

  const user = await upsertUser(env.DB, {
    googleSub: identity.sub, email: identity.email, name: identity.name, pictureUrl: identity.picture
  })
  const token = await issueToken(env.DB, user.id)

  return json({
    token,
    user: { id: user.id, email: user.email, name: user.name, pictureUrl: user.picture_url }
  })
}

async function handleApi(req: Request, env: Env, url: URL, user: UserRow): Promise<Response> {
  const db = env.DB
  const userId = user.id
  const path = url.pathname.replace(/^\/api/, '')

  if (req.method === 'GET' && path === '/status') {
    // Every count here is global (same for every user) except applications
    // sent, which is inherently per-user - there's no more per-user company
    // selection to scope the rest to.
    const companies = await listAllCompanies(db)
    const open = await db
      .prepare(`SELECT COUNT(*) AS n FROM postings WHERE closed_at IS NULL AND needs_triage = 0`)
      .first<{ n: number }>()
    const applied = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM user_posting_status
         WHERE user_id = ? AND app_status IN ('applied','interviewing','rejected','offer')`
      )
      .bind(userId)
      .first<{ n: number }>()
    const run = await db
      .prepare('SELECT * FROM run_log ORDER BY started_at DESC LIMIT 1')
      .first<Record<string, unknown>>()
    const health = await db
      .prepare(`SELECT health, COUNT(*) AS n FROM companies GROUP BY health`)
      .all<{ health: string; n: number }>()

    const counts = { ok: 0, stale: 0, broken: 0 }
    for (const r of health.results ?? []) {
      if (r.health in counts) (counts as Record<string, number>)[r.health] = r.n
    }

    return json({
      watchedCompanies: companies.length,
      openPostings: open?.n ?? 0,
      applicationsSent: applied?.n ?? 0,
      lastRun: run ?? null,
      health: counts
    })
  }

  if (req.method === 'GET' && path === '/postings') {
    const roles = url.searchParams.get('roleTypes')?.split(',').filter(Boolean) ?? []
    const search = url.searchParams.get('search')?.trim() ?? ''
    const maybe = url.searchParams.get('maybe') === '1'
    const companyId = url.searchParams.get('companyId')

    const where = ['p.closed_at IS NULL', `p.needs_triage = ${maybe ? 1 : 0}`]
    const args: unknown[] = []
    if (roles.length > 0) {
      where.push(`p.role_type IN (${roles.map(() => '?').join(',')})`)
      args.push(...roles)
    }
    if (companyId) {
      where.push('p.company_id = ?')
      args.push(Number(companyId))
    }

    // Recency, not role type, is the default sort - COALESCE mirrors the same
    // "real date if the feed has one, otherwise when we detected it" rule the
    // UI already uses for display, so "most recent" never silently favors
    // postings that merely have no postedAt.
    let orderBy = 'COALESCE(p.posted_at, p.first_seen_at) DESC'
    const selectExtra: string[] = []
    // Bind params in TWO groups because they land in different clauses of the
    // final SQL: the relevance CASE lives in the SELECT list, which precedes
    // WHERE in the query text, so its placeholders must be bound first
    // regardless of which block of code builds them.
    const selectArgs: unknown[] = []
    const whereArgs: unknown[] = []

    if (search) {
      const like = `%${search}%`
      where.push('(p.title LIKE ? OR c.name LIKE ? OR p.location LIKE ? OR p.description LIKE ?)')
      whereArgs.push(like, like, like, like)

      // A relevance rank, closest match first: an exact title match beats a
      // title that starts with the term, which beats the term appearing
      // anywhere in the title, then company/location, then only the
      // (long, noisy) description matching. Recency still breaks ties within
      // each rank, so among equally-relevant results the newest leads.
      selectExtra.push(`
        CASE
          WHEN p.title = ? THEN 0
          WHEN p.title LIKE ? THEN 1
          WHEN p.title LIKE ? THEN 2
          WHEN c.name LIKE ? THEN 3
          WHEN p.location LIKE ? THEN 4
          ELSE 5
        END AS relevance
      `)
      selectArgs.push(search, `${search}%`, like, like, like)
      orderBy = 'relevance ASC, ' + orderBy
    }

    const { results } = await db
      .prepare(
        `SELECT p.id, p.company_id AS companyId, c.name AS companyName, p.title, p.location,
                p.role_type AS roleType, p.apply_url AS applyUrl, p.posted_at AS postedAt,
                p.first_seen_at AS firstSeenAt, p.closed_at AS closedAt, p.description,
                COALESCE(s.app_status, 'none') AS appStatus, s.app_note AS appNote
                ${selectExtra.length ? ',' + selectExtra.join(',') : ''}
         FROM postings p
         JOIN companies c ON c.id = p.company_id
         LEFT JOIN user_posting_status s ON s.posting_id = p.id AND s.user_id = ?
         WHERE ${where.join(' AND ')}
         ORDER BY ${orderBy}
         LIMIT 500`
      )
      .bind(...selectArgs, userId, ...args, ...whereArgs)
      .all()
    return json(results ?? [])
  }

  if (req.method === 'POST' && /^\/postings\/\d+\/status$/.test(path)) {
    const id = Number(path.split('/')[2])
    const body = (await req.json()) as { status?: string; note?: string }
    const allowed = ['none', 'interested', 'applied', 'interviewing', 'rejected', 'offer']
    if (!body.status || !allowed.includes(body.status)) return json({ error: 'bad status' }, 400)
    await setUserPostingStatus(db, userId, id, body.status, body.note ?? null)
    return json({ ok: true })
  }

  // The same list for every signed-in user - see d1.ts's listAllCompanies.
  if (req.method === 'GET' && path === '/companies') {
    return json(await listAllCompanies(db))
  }

  /**
   * Requests that a company be added to the shared list everyone gets.
   * Deliberately does NOT attempt live discovery inline - a probe/Scout
   * result was trusted automatically here once, and it's exactly how Uber
   * ended up wired to the wrong ATS (a SmartRecruiters slug that resolved to
   * a single dummy posting) until caught and fixed by hand. Now it just
   * queues; resolving it - today, by hand (inspect the site, run Scout/probe,
   * verify against live data, then a migration adds it); later, potentially
   * an automated Scout pass reviewed before being trusted - is a deliberate,
   * verified step before anything is added to the global list.
   */
  if (req.method === 'POST' && path === '/companies/request') {
    const b = (await req.json()) as { name?: string; careersUrl?: string }
    if (!b.name?.trim()) return json({ error: 'name required' }, 400)
    const id = await requestCompany(db, userId, b.name.trim(), b.careersUrl?.trim() || null)
    return json({ ok: true, id })
  }

  if (req.method === 'GET' && path === '/settings') {
    return json(await getUserSettings(db, userId, DEFAULT_USER_SETTINGS))
  }

  if (req.method === 'PUT' && path === '/settings') {
    const patch = (await req.json()) as Record<string, unknown>
    const allowed = Object.keys(DEFAULT_USER_SETTINGS)
    const clean: Record<string, unknown> = {}
    for (const k of allowed) if (k in patch) clean[k] = patch[k]
    await setUserSettings(db, userId, clean)
    return json({ ok: true })
  }

  // Enqueues the fetch fan-out; does not wait for it to drain (see check.ts's
  // doc comment on why fetch and notify are two independent passes now).
  if (req.method === 'POST' && path === '/check') {
    return json(await enqueueFetchJobs(env))
  }

  // Runs the per-user notify pass immediately against whatever's already
  // stored, rather than waiting for its own later cron - useful for testing
  // and for a "send me what's ready now" manual trigger.
  if (req.method === 'POST' && path === '/notify') {
    return json(await runNotifyPass(env, 'manual'))
  }

  return json({ error: 'not found' }, 404)
}

/* ------------------------------------------------------------------ worker */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === '/health') return json({ ok: true })
    if (url.pathname === '/api/auth/google' && req.method === 'POST') return await handleGoogleAuth(req, env)

    if (!url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404)

    const user = await authenticate(req, env)
    if (!user) return json({ error: 'unauthorized' }, 401)

    try {
      return await handleApi(req, env, url, user)
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Cloudflare fires this same handler for every cron on the Worker.
    // Previously told apart via event.cron === '<the enqueue cron string>' -
    // in production that comparison silently never matched (confirmed: the
    // notify cron fired correctly on schedule per run_log, the enqueue cron
    // produced zero effect for a full day despite being registered
    // identically - both crons showed up correctly via the API, so this was
    // a runtime string-matching failure, not a config problem). Branching on
    // the scheduled minute instead sidesteps it entirely: the enqueue cron
    // (wrangler.toml) fires on the hour (:00), the notify cron 30 minutes
    // later (:30) - event.scheduledTime is a real epoch timestamp Cloudflare
    // computed from the matched cron, not a string this code has to
    // reproduce verbatim.
    const isEnqueue = new Date(event.scheduledTime).getUTCMinutes() < 15
    // waitUntil keeps the invocation alive for the async work after the handler
    // returns, which is how scheduled Workers are meant to do I/O.
    ctx.waitUntil(
      (isEnqueue ? enqueueFetchJobs(env) : runNotifyPass(env, 'scheduled'))
        .then((s) => console.log(`[cron:${isEnqueue ? 'enqueue' : 'notify'}]`, JSON.stringify(s)))
        .catch((e) => console.error(`[cron:${isEnqueue ? 'enqueue' : 'notify'}] failed`, e))
    )
  },

  /**
   * Drains the fetch queue. Cloudflare runs many invocations of this
   * concurrently (up to max_concurrency in wrangler.toml) to process
   * different batches at once - see check.ts's doc comment on why this is
   * what actually lets the company count scale past a few hundred.
   */
  async queue(batch: MessageBatch<FetchJob>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await fetchAndStoreCompany(env, msg.body.companyId)
        msg.ack()
      } catch (err) {
        console.error('[queue] fetch failed for company', msg.body.companyId, err)
        msg.retry()
      }
    }
  }
}
