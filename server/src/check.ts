import { fetchCompany } from '../../src/core/connectors/index'
import { applyFilters, classify, classifyPosting, maybePostings } from '../../src/core/classify'
import type { DegreeLevel, JobFunction } from '../../src/core/classify'
import { runScout } from '../../src/core/agents/scout'
import type { AtsType, RoleType } from '../../src/shared/types'
import {
  finishRun, listCompanies, markNotified, recordCheck, startRun, syncPostings,
  unnotifiedPostings, getSettings, brokenCompanies, setConnector, recordAgentRun,
  triageQueue, resolveTriage, closeStalePostings, type Env, type FetchedPosting
} from './d1'
import { sendDigest } from './email'

/**
 * One check cycle.
 *
 * Companies are processed in a bounded slice ordered by least-recently-checked,
 * not all at once: a Worker invocation has a CPU budget, and a user watching 300
 * companies would blow through it. With a small watch list every company is
 * checked every hour; with a large one they rotate fairly, and nothing is
 * silently skipped forever.
 */
const MAX_PER_RUN = 40
const CONCURRENCY = 6

export interface ServerSettings extends Record<string, unknown> {
  locations: string[]
  remoteOk: boolean
  wantIntern: boolean
  wantNewGrad: boolean
  wantProgram: boolean
  functions: JobFunction[]
  degreeLevel: DegreeLevel | null
  baselined: boolean
  /**
   * A posting this old gets auto-closed even if the company's feed still
   * lists it - applying to a 3-month-old req is a waste of time regardless of
   * whether the board bothered to take it down. Default matches how long a
   * typical internship posting stays worth applying to.
   */
  maxPostingAgeDays: number
}

export const DEFAULT_SETTINGS: ServerSettings = {
  locations: [],
  remoteOk: true,
  wantIntern: true,
  wantNewGrad: true,
  wantProgram: true,
  functions: ['engineering', 'data'],
  degreeLevel: 'bachelors',
  baselined: false,
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
  emailed: boolean
  emailReason?: string
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
 * Deliberately does NOT pass `render` to runScout: this fires on the hourly
 * cron, and real-browser rendering is slow and metered (the free tier is 10
 * browser-minutes/day). Spending that budget on scheduled, automatic repairs
 * would leave nothing for the deliberate case it exists for - a user adding a
 * new hard company by hand. A company Medic can't fix with tiers 0-2 stays
 * broken until someone looks at it, which is the correct failure mode: no
 * cron job should be able to quietly exhaust a shared, capped resource.
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
 * shares Cloudflare's 50-subrequest-per-invocation ceiling (Free plan) with
 * the per-company fetch loop, Medic, and the digest email in the same run -
 * a queue backlog should drain over a few hours, not risk starving the fetch
 * pass that actually matters.
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
      const valid: RoleType[] = ['intern', 'newgrad', 'program', 'other']
      if (parsed.roleType && valid.includes(parsed.roleType as RoleType)) {
        await resolveTriage(env.DB, item.id, parsed.roleType === 'other' ? null : (parsed.roleType as RoleType))
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
  const settings = await getSettings(db, DEFAULT_SETTINGS)

  const all = await listCompanies(db, true)
  // Least-recently-checked first, so rotation is fair and nothing starves.
  const slice = all
    .sort((a, b) => (a.last_ok_at ?? '').localeCompare(b.last_ok_at ?? ''))
    .slice(0, MAX_PER_RUN)

  const runId = await startRun(db, kind)
  let newCount = 0
  let errors = 0

  const queue = [...slice]
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
      const prefs = {
        locations: settings.locations,
        remoteOk: settings.remoteOk,
        wantIntern: settings.wantIntern,
        wantNewGrad: settings.wantNewGrad,
        wantProgram: settings.wantProgram,
        functions: settings.functions,
        degreeLevel: settings.degreeLevel
      }

      const wanted = applyFilters(classified, prefs)
      const maybes = maybePostings(classified, prefs)

      const toStore: FetchedPosting[] = [
        ...wanted.map((p) => ({
          externalId: p.externalId, title: p.title, location: p.location,
          applyUrl: p.applyUrl, postedAt: p.postedAt, description: p.description,
          roleType: p.roleType, needsTriage: false
        })),
        // The "maybe" band is stored but flagged, so it can be reviewed without
        // ever being emailed as if it were a confident match.
        ...maybes.map((p) => ({
          externalId: p.externalId, title: p.title, location: p.location,
          applyUrl: p.applyUrl, postedAt: p.postedAt, description: p.description,
          roleType: p.roleType, needsTriage: true
        }))
      ]

      const res = await syncPostings(db, c.id, toStore)
      newCount += res.newPostings.length

      // Health reflects whether the CONNECTOR is working, not whether the
      // user's own filters happened to match anything this hour. A narrow
      // filter (a specific degree level, a specific country) legitimately
      // yields zero often - measuring health on that number made Palantir show
      // "broken" with 65 real internships open, because "United States" as a
      // location filter didn't literally appear in "Washington, D.C." style
      // strings. Health is measured on the raw early-career count irrespective
      // of the user's personal filters; toStore (used above) is what actually
      // gets stored and emailed.
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
  await finishRun(db, runId, { companiesChecked: slice.length, newPostings: newCount, errors })

  // Auto-close anything past the age cutoff, even if the company's feed still
  // lists it - some boards leave stale reqs up for months, and applying to a
  // 3-month-old posting wastes the time this app exists to save. Runs once per
  // cycle, independent of which companies happened to be in this run's slice,
  // so a posting doesn't stay "open" for weeks just because its company wasn't
  // due for a check.
  const cutoff = new Date(Date.now() - settings.maxPostingAgeDays * 86_400_000).toISOString()
  const staleClosed = await closeStalePostings(db, cutoff)

  // Medic and Triage run after the main fetch pass so they never compete with
  // it for the Worker's CPU budget, and Triage sees postings from THIS run.
  const healed = await runMedic(env)
  const triaged = await runTriage(env)

  // The first run records what is already open without emailing about postings
  // that predate the install.
  const pending = await unnotifiedPostings(db)
  if (!settings.baselined) {
    await markNotified(db, pending.map((p) => p.id))
    await import('./d1').then((m) => m.setSettings(db, { baselined: true }))
    return {
      runId, checked: slice.length, newPostings: newCount, errors,
      emailed: false, emailReason: 'baseline run', healed, triaged, staleClosed
    }
  }

  const mail = await sendDigest(pending, { apiKey: env.RESEND_API_KEY, to: env.DIGEST_TO })
  // Only mark on success, so a mail outage retries instead of losing openings.
  if (mail.sent) await markNotified(db, pending.map((p) => p.id))

  return {
    runId,
    checked: slice.length,
    newPostings: newCount,
    errors,
    emailed: mail.sent,
    emailReason: mail.reason,
    healed,
    triaged,
    staleClosed
  }
}
