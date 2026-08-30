import type { AtsType } from '@shared/types'
import { getJson, getText, httpGet } from './http'

/**
 * Tier 0 discovery: find a company's job feed using only HTTP, no model.
 *
 * Two free signals, cheapest first:
 *   1. Read the career page and look for an ATS the site itself links to.
 *      A page that embeds boards.greenhouse.io/acme has told us the answer.
 *   2. Guess slugs from the company name and probe the four public APIs.
 *
 * Only when both fail does the Scout agent get involved. Measured against 93
 * real companies this resolved 68 of them at zero cost.
 */

export interface ProbeResult {
  atsType: AtsType
  boardToken: string
  jobCount: number
  via: 'page-link' | 'slug-guess'
}

const ENDPOINTS: Record<
  Exclude<AtsType, 'workday' | 'careerpage' | 'amazonjobs' | 'microsoftjobs' | 'googlejobs' | 'applejobs' | 'unknown'>,
  { url: (t: string) => string; count: (j: unknown) => number | null }
> = {
  greenhouse: {
    url: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`,
    count: (j) => arrLen((j as { jobs?: unknown[] })?.jobs)
  },
  lever: {
    url: (t) => `https://api.lever.co/v0/postings/${t}?mode=json`,
    count: (j) => arrLen(j)
  },
  ashby: {
    url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
    count: (j) => arrLen((j as { jobs?: unknown[] })?.jobs)
  },
  smartrecruiters: {
    url: (t) => `https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=10`,
    count: (j) => {
      const b = j as { totalFound?: number; content?: unknown[] }
      return typeof b?.totalFound === 'number' ? b.totalFound : arrLen(b?.content)
    }
  }
}

const arrLen = (v: unknown): number | null => (Array.isArray(v) ? v.length : null)

/** Patterns that reveal an ATS from a link on the company's own career page. */
const PAGE_PATTERNS: { re: RegExp; ats: AtsType }[] = [
  { re: /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i, ats: 'greenhouse' },
  { re: /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/i, ats: 'greenhouse' },
  { re: /jobs\.lever\.co\/([a-z0-9_-]+)/i, ats: 'lever' },
  { re: /api\.lever\.co\/v0\/postings\/([a-z0-9_-]+)/i, ats: 'lever' },
  { re: /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i, ats: 'ashby' },
  { re: /api\.ashbyhq\.com\/posting-api\/job-board\/([a-z0-9_.-]+)/i, ats: 'ashby' },
  { re: /careers\.smartrecruiters\.com\/([a-z0-9_-]+)/i, ats: 'smartrecruiters' },
  { re: /jobs\.smartrecruiters\.com\/([a-z0-9_-]+)/i, ats: 'smartrecruiters' }
]

/** Candidate slugs derived from a company name, most likely first. */
export function slugCandidates(name: string): string[] {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const dashed = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const noSuffix = base.replace(/(inc|llc|corp|corporation|labs|technologies|technology|ai)$/, '')

  return [...new Set([base, dashed, noSuffix, `${base}ai`, `${base}inc`].filter((s) => s.length >= 2))]
}

async function tryEndpoint(ats: keyof typeof ENDPOINTS, token: string): Promise<number | null> {
  const spec = ENDPOINTS[ats]
  if (!spec) return null
  try {
    const body = await getJson<unknown>(spec.url(token), { retries: 0, timeoutMs: 12000 })
    const n = spec.count(body)
    return n && n > 0 ? n : null
  } catch {
    return null
  }
}

/** Reads the career page and extracts an ATS link if the site exposes one. */
export async function probeCareerPage(careersUrl: string): Promise<ProbeResult | null> {
  let html: string
  try {
    html = await getText(careersUrl, { retries: 1, timeoutMs: 20000 })
  } catch {
    return null
  }

  for (const { re, ats } of PAGE_PATTERNS) {
    const m = re.exec(html)
    const token = m?.[1]
    if (!token) continue
    if (ats === 'workday' || ats === 'careerpage' || ats === 'amazonjobs' || ats === 'microsoftjobs' || ats === 'googlejobs' || ats === 'applejobs' || ats === 'unknown') continue

    const n = await tryEndpoint(ats, token)
    if (n !== null) return { atsType: ats, boardToken: token, jobCount: n, via: 'page-link' }
  }

  // Workday is identified by host shape; the CXS endpoint is derived from it.
  const wd = /https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:en-US\/)?([a-z0-9_-]+)/i.exec(html)
  if (wd) {
    const [, tenant, wdN, site] = wd
    return {
      atsType: 'workday',
      boardToken: `https://${tenant}.${wdN}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`,
      jobCount: 0,
      via: 'page-link'
    }
  }

  return null
}

/** Probes guessed slugs across the four public ATS APIs. */
export async function probeSlugs(name: string): Promise<ProbeResult | null> {
  for (const token of slugCandidates(name)) {
    for (const ats of ['greenhouse', 'lever', 'ashby', 'smartrecruiters'] as const) {
      const n = await tryEndpoint(ats, token)
      if (n !== null) return { atsType: ats, boardToken: token, jobCount: n, via: 'slug-guess' }
    }
  }
  return null
}

/**
 * Full tier-0 probe. Page-link first: it is authoritative, whereas a guessed
 * slug can collide with an unrelated company that happens to share a name.
 */
export async function probe(name: string, careersUrl: string | null): Promise<ProbeResult | null> {
  if (careersUrl) {
    const viaPage = await probeCareerPage(careersUrl)
    if (viaPage) return viaPage
  }
  return await probeSlugs(name)
}

export { httpGet }
