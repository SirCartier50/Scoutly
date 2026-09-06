import type { ParseConfig, RawPosting } from '@shared/connector'
import type { AtsType } from '@shared/types'
import { getText } from '../http'
import { probe } from '../probe'
import { fetchCompany } from '../connectors/index'

/**
 * Scout: answers "what is this company's job feed?" exactly once per company.
 *
 *   tier 0  probe        free HTTP - resolves ~39% of arbitrary names outright
 *   tier 1  cheap model  reads the career page HTML we already fetched
 *   tier 2  strong model same prompt, higher-capability model
 *
 * Speaks the OpenAI chat-completions shape, so it runs against Groq,
 * OpenRouter, NVIDIA NIM, or OpenAI unchanged - and on Cloudflare Workers,
 * where no vendor SDK is available, it is a plain fetch.
 *
 * The validation gate is what makes starting cheap safe: nothing a model
 * proposes is trusted until it has actually returned a posting. A weak model
 * that invents a plausible endpoint fails loudly and escalates, instead of
 * installing a watcher that reports "no new jobs" forever - the one failure
 * mode this whole app exists to prevent.
 */

export interface ScoutInput {
  companyId: number
  name: string
  careersUrl: string
}

/** One real network response captured while a browser rendered a page. */
export interface CapturedCall {
  url: string
  method: string
  status: number
  contentType: string
  bodySnippet: string
}

export interface ScoutOptions {
  apiKey: string | null
  /** OpenAI-compatible endpoint, e.g. https://api.groq.com/openai/v1 */
  baseUrl?: string | null
  model?: string | null
  escalationModel?: string | null
  budgetUsd?: number
  /**
   * Optional real-browser capability, injected by the caller (the server has
   * one via Cloudflare Browser Rendering; the desktop client has none and
   * simply omits this). Kept as an injected function rather than an import so
   * this file never depends on a Workers-only package.
   */
  render?: (url: string) => Promise<CapturedCall[]>
}

export interface ScoutResult {
  ok: boolean
  atsType?: AtsType
  boardToken?: string | null
  parseConfig?: ParseConfig | null
  costUsd: number
  tier?: 'probe' | 'cheap' | 'strong' | 'render'
  error?: string
}

interface ScoutAnswer {
  found: boolean
  confidence: number
  atsType?: AtsType
  boardToken?: string
  parseConfig?: ParseConfig
  notes?: string
}

const SYSTEM = `You identify the machine-readable job feed behind a company's careers page.

Reply with ONLY a JSON object of this shape:
{"found":boolean,"confidence":0..1,"atsType":"greenhouse|lever|ashby|smartrecruiters|workday|oraclehcm|careerpage",
 "boardToken":"string","parseConfig":{"kind":"json-endpoint|html","url":"...","itemsPath":"...",
 "fields":{"externalId":"","title":"","location":"","applyUrl":"","postedAt":"","description":""},
 "selectors":{"item":"","title":"","location":"","link":""},"baseUrl":""},"notes":"string"}

Prefer, in order:
1. A public ATS board slug (Greenhouse, Lever, Ashby, SmartRecruiters): set atsType and boardToken.
2. Workday: atsType "workday", boardToken = the full CXS endpoint,
   e.g. https://TENANT.wd5.myworkdayjobs.com/wday/cxs/TENANT/SITE/jobs
3. Oracle Fusion Cloud Recruiting ("Candidate Experience" - URLs containing
   /hcmUI/CandidateExperience/ or a *.fa.*.oraclecloud.com host): atsType
   "oraclehcm", boardToken = "<host>|<siteNumber>|<siteName>" - the siteNumber
   comes from the page's own recruitingCEJobRequisitions call
   (finder=findReqs;siteNumber=...), siteName from the /sites/<siteName>/
   path segment.
4. The internal JSON endpoint the page's own JavaScript calls: atsType "careerpage",
   parseConfig.kind "json-endpoint", with itemsPath and field paths.
5. Only as a last resort, CSS selectors over server-rendered HTML.

A JSON endpoint survives redesigns; CSS selectors break constantly. Never invent an
endpoint you have not seen evidence for. If unsure, return found=false with low
confidence - a wrong answer is far worse than no answer, because it installs a
watcher that silently reports no new jobs forever.`

/** Trims page HTML to the parts that actually reveal a feed. */
function condense(html: string, limit = 40000): string {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]{0,3000}?)<\/script>/gi)]
    .map((m) => m[1] ?? '')
    .filter((s) => /api|json|jobs|careers|board|graphql|fetch|endpoint/i.test(s))
    .join('\n---\n')

  const links = [...html.matchAll(/href="([^"]{0,300})"/gi)]
    .map((m) => m[1] ?? '')
    .filter((h) => /job|career|greenhouse|lever|ashby|smartrecruiters|workday|myworkday/i.test(h))
    .slice(0, 120)
    .join('\n')

  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')

  return [
    `--- candidate links ---\n${links}`,
    `--- inline scripts mentioning APIs ---\n${scripts.slice(0, 15000)}`,
    `--- page markup ---\n${body.slice(0, limit)}`
  ].join('\n\n')
}

function parseAnswer(text: string): ScoutAnswer | null {
  const attempt = (s: string): ScoutAnswer | null => {
    try {
      return JSON.parse(s) as ScoutAnswer
    } catch {
      return null
    }
  }
  // Models sometimes wrap JSON in prose or a code fence even in JSON mode.
  return (
    attempt(text) ??
    attempt(text.replace(/^[\s\S]*?```(?:json)?/, '').replace(/```[\s\S]*$/, '')) ??
    attempt(/\{[\s\S]*\}/.exec(text)?.[0] ?? '')
  )
}

interface ChatUsage {
  prompt_tokens?: number
  completion_tokens?: number
}

async function askModel(
  opts: ScoutOptions,
  model: string,
  userContent: string
): Promise<{ answer: ScoutAnswer | null; usage: ChatUsage | null; error?: string }> {
  const base = (opts.baseUrl ?? 'https://api.groq.com/openai/v1').replace(/\/+$/, '')

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 90_000)

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        authorization: `Bearer ${opts.apiKey ?? ''}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userContent }
        ]
      })
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { answer: null, usage: null, error: `HTTP ${res.status}: ${body.slice(0, 200)}` }
    }

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
      usage?: ChatUsage
    }
    const text = body.choices?.[0]?.message?.content ?? ''
    return { answer: parseAnswer(text), usage: body.usage ?? null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { answer: null, usage: null, error: `request failed: ${msg}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The validation gate. A config is accepted only if it actually returns a
 * plausible posting - this is what makes the cheap-first ladder safe.
 */
async function validate(
  input: ScoutInput,
  answer: ScoutAnswer
): Promise<{ ok: boolean; reason?: string }> {
  if (!answer.found || !answer.atsType) return { ok: false, reason: 'model reported no feed found' }

  let outcome
  try {
    outcome = await fetchCompany({
      id: input.companyId,
      name: input.name,
      careersUrl: input.careersUrl,
      atsType: answer.atsType,
      boardToken: answer.boardToken ?? null,
      parseConfig: answer.parseConfig ?? null
    })
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }

  if (!outcome.ok) return { ok: false, reason: outcome.error ?? 'fetch failed' }
  if (outcome.postings.length === 0) return { ok: false, reason: 'config returned zero postings' }

  const plausible = outcome.postings.filter(
    (p: RawPosting) => p.title && p.title !== '(untitled)' && /^https?:/.test(p.applyUrl)
  )
  if (plausible.length === 0) return { ok: false, reason: 'postings lacked titles or valid URLs' }

  return { ok: true }
}

export async function runScout(input: ScoutInput, opts: ScoutOptions): Promise<ScoutResult> {
  try {
    return await scoutInner(input, opts)
  } catch (err) {
    // Discovery failing is survivable; taking the run down with it is not.
    return { ok: false, costUsd: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

async function scoutInner(input: ScoutInput, opts: ScoutOptions): Promise<ScoutResult> {
  // Tier 0 - free, no model involved.
  const probed = await probe(input.name, input.careersUrl)
  if (probed) {
    return {
      ok: true,
      atsType: probed.atsType,
      boardToken: probed.boardToken,
      parseConfig: null,
      costUsd: 0,
      tier: 'probe'
    }
  }

  if (!opts.apiKey) {
    return {
      ok: false,
      costUsd: 0,
      error: 'no ATS found by probe, and no model API key configured for discovery'
    }
  }

  let page = ''
  try {
    page = condense(await getText(input.careersUrl, { retries: 1 }))
  } catch (err) {
    page = `(could not fetch ${input.careersUrl}: ${err instanceof Error ? err.message : String(err)})`
  }

  const userContent = `Company: ${input.name}\nCareers URL: ${input.careersUrl}\n\nPage content:\n${page}`

  // Tier 1 - cheap model.
  const cheapModel = opts.model ?? 'llama-3.3-70b-versatile'
  const cheap = await askModel(opts, cheapModel, userContent)
  if (cheap.answer?.found && (cheap.answer.confidence ?? 0) >= 0.6) {
    const gate = await validate(input, cheap.answer)
    if (gate.ok) {
      return {
        ok: true,
        atsType: cheap.answer.atsType,
        boardToken: cheap.answer.boardToken ?? null,
        parseConfig: cheap.answer.parseConfig ?? null,
        costUsd: 0,
        tier: 'cheap'
      }
    }
  }

  // Tier 2 - stronger model, only after the cheap tier failed or was rejected.
  // Falls back to re-running the cheap model rather than giving up outright
  // when no distinct escalation model is configured: tier 3 (render) below
  // still needs SOME model to read its evidence, and reasoning over a real
  // captured network call is a much easier task than the raw-HTML guessing
  // tier 1 just failed at, so even the cheap model is worth letting try.
  const strongModel = opts.escalationModel ?? cheapModel

  const strong = strongModel === cheapModel ? cheap : await askModel(opts, strongModel, userContent)
  if (opts.escalationModel && strong.answer?.found) {
    const gate = await validate(input, strong.answer)
    if (gate.ok) {
      return {
        ok: true,
        atsType: strong.answer.atsType,
        boardToken: strong.answer.boardToken ?? null,
        parseConfig: strong.answer.parseConfig ?? null,
        costUsd: 0,
        tier: 'strong'
      }
    }
    return { ok: false, costUsd: 0, tier: 'strong', error: `validation gate rejected config: ${gate.reason}` }
  }

  // Tier 3 - real browser, reserved for pages where no amount of reading raw
  // HTML could ever work because the job data doesn't exist until JavaScript
  // runs (a single-page app calling its own internal API on load). This is
  // the slow, metered tier: only reached after both text-only tiers failed.
  if (opts.render) {
    let calls: CapturedCall[] = []
    try {
      calls = await opts.render(input.careersUrl)
    } catch (err) {
      return {
        ok: false, costUsd: 0, tier: 'render',
        error: `render capture failed: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (calls.length === 0) {
      return { ok: false, costUsd: 0, tier: 'render', error: 'no job-shaped network calls captured' }
    }

    const evidence = calls
      .map((c, i) => `[${i}] ${c.method} ${c.url}\ncontent-type: ${c.contentType}\nbody sample:\n${c.bodySnippet}`)
      .join('\n\n---\n\n')

    const renderContent =
      `Company: ${input.name}\nCareers URL: ${input.careersUrl}\n\n` +
      `A real browser loaded this page and made the following network requests. ` +
      `One of these is very likely the actual job-listing API - identify which, and how to ` +
      `call it as a stateless request (method, URL, and how to extract the job list from the ` +
      `response). This is real observed evidence, not a guess from markup.\n\n${evidence}`

    const rendered = await askModel(opts, strongModel, renderContent)
    if (rendered.answer?.found) {
      const gate = await validate(input, rendered.answer)
      if (gate.ok) {
        return {
          ok: true,
          atsType: rendered.answer.atsType,
          boardToken: rendered.answer.boardToken ?? null,
          parseConfig: rendered.answer.parseConfig ?? null,
          costUsd: 0,
          tier: 'render'
        }
      }
      return {
        ok: false, costUsd: 0, tier: 'render',
        error: `validation gate rejected config from captured network calls: ${gate.reason}`
      }
    }
    return { ok: false, costUsd: 0, tier: 'render', error: rendered.error ?? 'no feed identified from captured calls' }
  }

  return { ok: false, costUsd: 0, tier: 'strong', error: strong.error ?? 'no feed identified' }
}
