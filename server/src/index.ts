import { registerWorkerHtmlParser } from './htmlParser'
import { runCheck, DEFAULT_SETTINGS } from './check'
import { probe } from '../../src/core/probe'
import { runScout } from '../../src/core/agents/scout'
import { captureNetworkCalls } from './render'
import {
  deleteCompany, getSettings, listCompanies, recordAgentRun, setSettings, setWatched,
  slugify, upsertCompany, type Env
} from './d1'

registerWorkerHtmlParser()

/* --------------------------------------------------------------------- auth */

/**
 * A single bearer token shared with the desktop client. This is a personal
 * single-user service; the token exists so a stray request cannot read the
 * user's watch list or trigger checks, not to support multi-tenancy.
 */
function authorized(req: Request, env: Env): boolean {
  if (!env.CLIENT_TOKEN) return false
  const header = req.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (token.length !== env.CLIENT_TOKEN.length) return false
  // Constant-time-ish compare so the token can't be guessed byte by byte.
  let diff = 0
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ env.CLIENT_TOKEN.charCodeAt(i)
  return diff === 0
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  })

/* --------------------------------------------------------------------- api */

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const db = env.DB
  const path = url.pathname.replace(/^\/api/, '')

  if (req.method === 'GET' && path === '/status') {
    const companies = await listCompanies(db, true)
    const open = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM postings p JOIN companies c ON c.id = p.company_id
         WHERE p.closed_at IS NULL AND c.watched = 1 AND p.needs_triage = 0`
      )
      .first<{ n: number }>()
    const applied = await db
      .prepare("SELECT COUNT(*) AS n FROM postings WHERE app_status IN ('applied','interviewing','rejected','offer')")
      .first<{ n: number }>()
    const run = await db
      .prepare('SELECT * FROM run_log ORDER BY started_at DESC LIMIT 1')
      .first<Record<string, unknown>>()
    const health = await db
      .prepare('SELECT health, COUNT(*) AS n FROM companies WHERE watched = 1 GROUP BY health')
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

    const where = ['c.watched = 1', 'p.closed_at IS NULL', `p.needs_triage = ${maybe ? 1 : 0}`]
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
                p.app_status AS appStatus, p.app_note AS appNote, p.deadline
                ${selectExtra.length ? ',' + selectExtra.join(',') : ''}
         FROM postings p JOIN companies c ON c.id = p.company_id
         WHERE ${where.join(' AND ')}
         ORDER BY ${orderBy}
         LIMIT 500`
      )
      .bind(...selectArgs, ...args, ...whereArgs)
      .all()
    return json(results ?? [])
  }

  if (req.method === 'POST' && /^\/postings\/\d+\/status$/.test(path)) {
    const id = Number(path.split('/')[2])
    const body = (await req.json()) as { status?: string; note?: string }
    const allowed = ['none', 'interested', 'applied', 'interviewing', 'rejected', 'offer']
    if (!body.status || !allowed.includes(body.status)) return json({ error: 'bad status' }, 400)
    await db
      .prepare('UPDATE postings SET app_status = ?, app_updated_at = ?, app_note = COALESCE(?, app_note) WHERE id = ?')
      .bind(body.status, new Date().toISOString(), body.note ?? null, id)
      .run()
    return json({ ok: true })
  }

  if (req.method === 'GET' && path === '/companies') {
    return json(await listCompanies(db))
  }

  if (req.method === 'POST' && path === '/companies/watch') {
    const b = (await req.json()) as { id: number; watched: boolean }
    await setWatched(db, b.id, b.watched)
    return json({ ok: true })
  }

  if (req.method === 'DELETE' && /^\/companies\/\d+$/.test(path)) {
    await deleteCompany(db, Number(path.split('/')[2]))
    return json({ ok: true })
  }

  /**
   * Directory search. Unknown names are probed live and added on success, so
   * the shared directory grows for every future search instead of each client
   * re-probing the same companies.
   */
  if (req.method === 'GET' && path === '/directory') {
    const q = (url.searchParams.get('q') ?? '').trim()
    const topic = (url.searchParams.get('topic') ?? '').trim()

    const where: string[] = []
    const args: unknown[] = []
    if (q) { where.push('name LIKE ?'); args.push(`%${q}%`) }
    if (topic) { where.push('topics LIKE ?'); args.push(`%"${topic}"%`) }

    const { results } = await db
      .prepare(
        `SELECT slug, name, careers_url AS careersUrl, ats_type AS atsType,
                board_token AS boardToken, topics, job_count AS jobCount
         FROM directory ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY job_count DESC, name LIMIT 100`
      )
      .bind(...args)
      .all()
    return json(results ?? [])
  }

  if (req.method === 'POST' && path === '/companies/add') {
    const b = (await req.json()) as { name?: string; careersUrl?: string }
    if (!b.name?.trim()) return json({ error: 'name required' }, 400)

    const known = await db
      .prepare('SELECT * FROM directory WHERE slug = ?')
      .bind(slugify(b.name))
      .first<{ name: string; careers_url: string; ats_type: string; board_token: string; topics: string }>()

    if (known) {
      const id = await upsertCompany(db, {
        name: known.name, careersUrl: known.careers_url, atsType: known.ats_type,
        boardToken: known.board_token, topics: JSON.parse(known.topics) as string[],
        watched: true, source: 'directory'
      })
      return json({ ok: true, id, via: 'directory' })
    }

    const name = b.name.trim()
    let careersUrl = b.careersUrl?.trim() ?? ''
    if (careersUrl && !/^https?:\/\//i.test(careersUrl)) careersUrl = `https://${careersUrl}`

    const found = await probe(name, careersUrl || null)

    // The free probe only resolves companies on the four public ATS platforms.
    // Anything with a custom, in-house career site - which correlates strongly
    // with being large and famous (Google, Microsoft, Amazon, Apple) - falls
    // through here. Those are exactly the companies someone is most likely to
    // forget to check, so this is the one case Scout genuinely earns its cost.
    let scoutResult: Awaited<ReturnType<typeof runScout>> | null = null
    if (!found && env.LLM_API_KEY) {
      scoutResult = await runScout(
        { companyId: 0, name, careersUrl: careersUrl || `https://www.${slugify(name).replace(/-/g, '')}.com` },
        {
          apiKey: env.LLM_API_KEY, baseUrl: env.LLM_BASE_URL, model: env.LLM_MODEL,
          escalationModel: env.LLM_ESCALATION_MODEL,
          // Real Chromium only as a last resort, added by a manual add request -
          // never on the recurring check path. Adding one company this way uses
          // well under a minute of the free 10-min/day allowance.
          render: env.BROWSER ? (url) => captureNetworkCalls(env.BROWSER!, url) : undefined
        }
      )
      if (scoutResult.costUsd > 0) {
        await recordAgentRun(db, {
          role: 'scout', model: env.LLM_MODEL ?? 'unknown', companyId: null,
          usd: scoutResult.costUsd, ok: scoutResult.ok, error: scoutResult.error ?? null
        })
      }
    }

    const resolvedAts = found?.atsType ?? (scoutResult?.ok ? scoutResult.atsType : undefined)
    const resolvedToken = found?.boardToken ?? (scoutResult?.ok ? scoutResult.boardToken : null)
    const resolvedConfig = scoutResult?.ok ? scoutResult.parseConfig : null

    const id = await upsertCompany(db, {
      name,
      careersUrl: careersUrl || resolvedToken || 'https://example.invalid',
      atsType: resolvedAts ?? 'unknown',
      boardToken: resolvedToken ?? null,
      watched: true,
      source: 'manual'
    })

    if (resolvedConfig) {
      await db.prepare('UPDATE companies SET parse_config = ? WHERE id = ?').bind(JSON.stringify(resolvedConfig), id).run()
    }

    if (resolvedAts) {
      await db
        .prepare(
          `INSERT INTO directory (slug, name, careers_url, ats_type, board_token, topics, job_count, verified_at)
           VALUES (?, ?, ?, ?, ?, '[]', ?, ?)
           ON CONFLICT(slug) DO UPDATE SET job_count = excluded.job_count, verified_at = excluded.verified_at`
        )
        .bind(
          slugify(name), name, careersUrl, resolvedAts,
          resolvedToken, found?.jobCount ?? 0, new Date().toISOString()
        )
        .run()
    }

    const via = found ? 'probe' : scoutResult?.ok ? `scout-${scoutResult.tier}` : 'unresolved'
    return json({
      ok: true, id, via, atsType: resolvedAts ?? 'unknown',
      // Surfaced so the UI can tell the user WHY discovery failed, rather than
      // leaving an unresolved company silently unmonitored with no explanation.
      scoutError: !found && !scoutResult?.ok ? scoutResult?.error : undefined
    })
  }

  if (req.method === 'GET' && path === '/settings') {
    return json(await getSettings(db, DEFAULT_SETTINGS))
  }

  if (req.method === 'PUT' && path === '/settings') {
    const patch = (await req.json()) as Record<string, unknown>
    const allowed = Object.keys(DEFAULT_SETTINGS)
    const clean: Record<string, unknown> = {}
    for (const k of allowed) if (k in patch) clean[k] = patch[k]
    await setSettings(db, clean)
    return json({ ok: true })
  }

  if (req.method === 'POST' && path === '/check') {
    return json(await runCheck(env, 'manual'))
  }

  return json({ error: 'not found' }, 404)
}

/* ------------------------------------------------------------------ worker */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === '/health') return json({ ok: true })

    if (!url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404)
    if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401)

    try {
      return await handleApi(req, env, url)
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // waitUntil keeps the invocation alive for the async work after the handler
    // returns, which is how scheduled Workers are meant to do I/O.
    ctx.waitUntil(
      runCheck(env, 'scheduled')
        .then((s) => console.log('[cron]', JSON.stringify(s)))
        .catch((e) => console.error('[cron] failed', e))
    )
  }
}
