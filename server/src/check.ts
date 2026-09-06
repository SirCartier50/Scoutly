import { fetchCompany } from '../../src/core/connectors/index'
import { classify, classifyPosting, matchesLocation, functionAllowed, degreeRequirement, degreeAllowed } from '../../src/core/classify'
import type { DegreeLevel, JobFunction } from '../../src/core/classify'
import { runScout } from '../../src/core/agents/scout'
import type { AtsType, RoleType } from '../../src/shared/types'
import {
  finishRun, listAllCompanies, listAllUsers, markUserNotified, recordCheck, startRun, syncPostings,
  unnotifiedPostingsForUser, getUserSettings, brokenCompanies, setConnector,
  recordAgentRun, triageQueue, resolveTriage, closeStalePostings, type Env, type FetchedPosting
} from './d1'
import { sendDigest } from './email'

/**
 * One check cycle, in two passes.
 *
 * Pass 1 (global, fetch/classify/store): EVERY approved company is fetched
 * every run, not a slice - there is no per-user watch list gating which
 * companies matter, so cost depends only on the total company count, never
 * on how many users exist. N users still cost ONE fetch per company, not N.
 * Every early-career-shaped posting is stored regardless of any one user's
 * preferences: role-type/location/function/degree filtering is a per-user
 * lens applied afterward, never baked into what gets fetched or kept.
 *
 * This is why the cron fires a few times a day (see wrangler.toml) rather
 * than hourly: covering the full company list in one invocation needs
 * Workers Paid's 1000-subrequest-per-invocation ceiling (Free is 50), and
 * running that many fetches a few times a day costs less overall than
 * spreading a smaller slice across 24 hourly runs would.
 *
 * Pass 2 (per-user, notify): every signed-up user gets their own
 * unnotified-postings query, filtered through THEIR settings, and their own
 * digest email + notification bookkeeping.
 */
const CONCURRENCY = 12

export interface UserSettings extends Record<string, unknown> {
  locations: string[]
  remoteOk: boolean
  wantIntern: boolean
  wantNewGrad: boolean
  wantProgram: boolean
  functions: JobFunction[]
  degreeLevel: DegreeLevel | null
  digestEmail: string | null
  /**
   * A posting this old gets auto-closed even if the company's feed still
   * lists it - applying to a 3-month-old req is a waste of time regardless of
   * whether the board bothered to take it down. Default matches how long a
   * typical internship posting stays worth applying to. This one setting stays
   * effectively global in practice (it drives a single shared closeStalePostings
   * pass; keying that off just the first user's value would be wrong) - so it
   * is read per user but the run uses the most permissive (largest) value
   * across everyone, meaning no one's postings close earlier than configured.
   */
  maxPostingAgeDays: number
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  locations: [],
  remoteOk: true,
  wantIntern: true,
  wantNewGrad: true,
  wantProgram: true,
  functions: ['engineering', 'data'],
  degreeLevel: 'bachelors',
  digestEmail: null,
  maxPostingAgeDays: 90
}

/** Health is measured on yield, not just errors - see the desktop equivalent. */
function evaluateHealth(yieldNow: number, history: number[], consecutiveZero: number): string {
  const recent = history.slice(-7)
  const median = recent.length
    ? [...recent].sort((a, b) => a - b)[Math.floor(recent.length / 2)] ?? 0
    : null

  if (yieldNow === 0 && consecutiveZero >= 1) return 'broken'
  if (yieldNow === 0 && (median ?? 0) > 0) return 'stale'
  if (median !== null && median >= 10 && yieldNow < median * 0.3) return 'stale'
  return 'ok'
}

export interface RunSummary {
  runId: number
  checked: number
  newPostings: number
  errors: number
  usersNotified: number
  healed: number
  triaged: number
  staleClosed: number
}

/**
 * Medic: when a watcher goes broken, re-run discovery from the company's NAME
 * rather than retrying the stale config - a moved career page or an ATS
 * migration is just a re-Scout. The validation gate (inside runScout) means a
 * bad proposal can never replace a working config with a worse one; it can
 * only replace "broken" with "verified working" or leave it broken.
 *
 * Bounded to a handful per run so a bad patch of the internet cannot burn the
 * whole model budget in one hour.
 *
 * Deliberately does NOT pass `render` to runScout: this fires on the
 * scheduled cron, and real-browser rendering is slow and metered (the free
 * tier is 10 browser-minutes/day). Spending that budget on scheduled,
 * automatic repairs would leave nothing for the deliberate case it exists
 * for - resolving a company request by hand (see requestCompany in d1.ts).
 * A company Medic can't fix with tiers 0-2 stays broken until someone looks
 * at it, which is the correct failure mode: no cron job should be able to
 * quietly exhaust a shared, capped resource.
 */
async function runMedic(env: Env, limit = 3): Promise<number> {
  if (!env.LLM_API_KEY) return 0
  const broken = await brokenCompanies(env.DB, limit)
  let healed = 0

  for (const c of broken) {
    const res = await runScout(
      { companyId: c.id, name: c.name, careersUrl: c.careers_url },
      { apiKey: env.LLM_API_KEY, baseUrl: env.LLM_BASE_URL, model: env.LLM_MODEL, escalationModel: env.LLM_ESCALATION_MODEL }
    )
    if (res.costUsd > 0) {
      await recordAgentRun(env.DB, {
        role: 'medic', model: env.LLM_MODEL ?? 'unknown', companyId: c.id,
        usd: res.costUsd, ok: res.ok, error: res.error ?? null
      })
    }
    if (res.ok && res.atsType) {
      await setConnector(env.DB, c.id, res.atsType, res.boardToken ?? null, res.parseConfig ?? null)
      healed++
    }
  }
  return healed
}

/**
 * Triage: classifies the small ambiguous band the regex classifier deferred
 * (PhD-tagged titles, "Nucleus", year-tagged research roles). Runs the SAME
 * cheap model as Scout, since this is a much easier question - one title in,
 * one of four labels out - not open-ended discovery.
 *
 * Limit kept modest (each item is its own model-call subrequest) because this
 * shares one invocation's subrequest budget with the per-company fetch loop,
 * Medic, and the digest emails - a queue backlog should drain over a few
 * runs, not risk starving the fetch pass that actually matters.
 */
async function runTriage(env: Env, limit = 8): Promise<number> {
  if (!env.LLM_API_KEY) return 0
  const queue = await triageQueue(env.DB, limit)
  if (queue.length === 0) return 0

  let resolved = 0
  for (const item of queue) {
    // A local re-check first: cheap, and catches cases where the regex
    // deferred a title that a slightly different angle can resolve for free.
    const local = classify(item.title, item.description)
    if (!local.needsTriage) {
      await resolveTriage(env.DB, item.id, local.roleType === 'other' ? null : local.roleType)
      resolved++
      continue
    }

    const base = (env.LLM_BASE_URL ?? 'https://api.groq.com/openai/v1').replace(/\/+$/, '')
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.LLM_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: env.LLM_MODEL,
          temperature: 0,
          max_tokens: 200,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'Classify this job posting title as exactly one of: intern, newgrad, program, other. ' +
                '"other" means NOT an early-career role (e.g. a senior/staff position, or unrelated to ' +
                'internships/new-grad/fellowships). Reply with ONLY {"roleType":"intern|newgrad|program|other"}.'
            },
            { role: 'user', content: `Title: ${item.title}\n\nDescription excerpt: ${(item.description ?? '').slice(0, 1500)}` }
          ]
        })
      })
      if (!res.ok) continue
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const text = body.choices?.[0]?.message?.content ?? ''
      const parsed = JSON.parse(text) as { roleType?: string }
      const valid = ['intern', 'newgrad', 'program', 'other']
      if (parsed.roleType && valid.includes(parsed.roleType)) {
        await resolveTriage(env.DB, item.id, parsed.roleType === 'other' ? null : (parsed.roleType as 'intern' | 'newgrad' | 'program'))
        resolved++
      }
    } catch {
      // Leave it in the queue; a transient failure retries next run rather
      // than silently guessing.
    }
  }
  return resolved
}

export async function runCheck(env: Env, kind = 'scheduled'): Promise<RunSummary> {
  const db = env.DB

  /* --------------------------------------------------- pass 1: fetch/store */

  const all = await listAllCompanies(db)

  const runId = await startRun(db, kind)
  let newCount = 0
  let errors = 0

  const queue = [...all]
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const c = queue.shift()
      if (!c) return

      const outcome = await fetchCompany({
        id: c.id,
        name: c.name,
        careersUrl: c.careers_url,
        atsType: c.ats_type as AtsType,
        boardToken: c.board_token,
        parseConfig: c.parse_config ? JSON.parse(c.parse_config) : null
      })

      if (!outcome.ok) {
        errors++
        await recordCheck(db, c.id, {
          ok: false,
          error: outcome.error,
          health: outcome.transient ? 'stale' : 'broken'
        })
        continue
      }

      const classified = outcome.postings.map(classifyPosting)

      // Store everything early-career-shaped, unfiltered by any one user's
      // preferences - filtering happens per-user at digest/read time instead.
      const toStore: FetchedPosting[] = classified
        .filter((p) => p.roleType !== 'other' || p.needsTriage)
        .map((p) => ({
          externalId: p.externalId, title: p.title, location: p.location,
          applyUrl: p.applyUrl, postedAt: p.postedAt, description: p.description,
          roleType: p.roleType, needsTriage: p.needsTriage
        }))

      const res = await syncPostings(db, c.id, toStore)
      newCount += res.newPostings.length

      // Health reflects whether the CONNECTOR is working, not any user's
      // personal filters - see the single-user version's note on why this
      // caused false "broken" reads when measured post-filter instead.
      const rawEarlyCareerYield = classified.filter((p) => p.roleType !== 'other').length

      const history = JSON.parse(c.yield_history) as number[]
      await recordCheck(db, c.id, {
        ok: true,
        yield: rawEarlyCareerYield,
        health: evaluateHealth(rawEarlyCareerYield, history, c.consecutive_zero)
      })
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  await finishRun(db, runId, { companiesChecked: all.length, newPostings: newCount, errors })

  // Medic and Triage run after the main fetch pass so they never compete with
  // it for the Worker's CPU budget, and Triage sees postings from THIS run.
  const healed = await runMedic(env)
  const triaged = await runTriage(env)

  /* --------------------------------------------------- pass 2: per-user notify */

  const users = await listAllUsers(db)
  let usersNotified = 0
  let maxAgeDays = DEFAULT_USER_SETTINGS.maxPostingAgeDays

  for (const user of users) {
    const settings = await getUserSettings(db, user.id, DEFAULT_USER_SETTINGS)
    maxAgeDays = Math.max(maxAgeDays, settings.maxPostingAgeDays)

    const pending = await unnotifiedPostingsForUser(db, user.id)
    if (pending.length === 0) continue

    // Same building blocks applyFilters is made of, applied directly to the
    // PendingNotification shape (which carries id/companyName that
    // ClassifiedPosting doesn't) rather than round-tripping through it.
    const wantedRoles = new Set<RoleType>()
    if (settings.wantIntern) wantedRoles.add('intern')
    if (settings.wantNewGrad) wantedRoles.add('newgrad')
    if (settings.wantProgram) wantedRoles.add('program')

    const matched = pending.filter((p) => {
      if (!wantedRoles.has(p.roleType)) return false
      if (!matchesLocation(p.location, settings.locations, settings.remoteOk)) return false
      if (!functionAllowed(p.title, p.roleType, settings.functions)) return false
      if (!degreeAllowed(degreeRequirement(p.title, p.description), settings.degreeLevel)) return false
      return true
    })
    if (matched.length === 0) continue

    const to = settings.digestEmail ?? user.email
    const mail = await sendDigest(matched, { apiKey: env.RESEND_API_KEY, to })
    // Only mark on success, so a mail outage retries instead of losing openings.
    if (mail.sent) {
      await markUserNotified(db, user.id, matched.map((p) => p.id))
      usersNotified++
    }
  }

  // Auto-close anything past the age cutoff, even if the company's feed still
  // lists it - some boards leave stale reqs up for months, and applying to a
  // 3-month-old posting wastes the time this app exists to save. Runs once per
  // cycle using the most permissive configured cutoff across all watching
  // users, so no one's postings close earlier than they asked for.
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString()
  const staleClosed = await closeStalePostings(db, cutoff)

  return { runId, checked: all.length, newPostings: newCount, errors, usersNotified, healed, triaged, staleClosed }
}
