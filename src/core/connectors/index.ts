import type { ConnectorTarget, FetchOutcome, ParseConfig, RawPosting } from '@shared/connector'
import type { AtsType } from '@shared/types'
import { HttpError, absoluteUrl, getJson, getText, htmlToText, httpGet } from '../http'

/**
 * Every connector returns the company's FULL open list. Filtering happens in
 * SQL afterwards, because "what's new since this morning" is a set difference
 * that a pre-filtered fetch cannot produce.
 *
 * `description` may be null on the index pass; `hydrate` fills it in for the
 * few postings that turn out to be new, which keeps a 2000-job board from
 * pulling ~20MB twice a day.
 */
export interface Connector {
  readonly type: AtsType
  fetch(target: ConnectorTarget): Promise<RawPosting[]>
  hydrate?(target: ConnectorTarget, posting: RawPosting): Promise<string | null>
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null

/** Boards above this size skip inline descriptions on the index pass. */
const LARGE_BOARD = 150

/* ---------------------------------------------------------------- greenhouse */

interface GhJob {
  id: number
  title: string
  absolute_url: string
  updated_at?: string
  location?: { name?: string }
  content?: string
  departments?: { name?: string }[]
}

export const greenhouse: Connector = {
  type: 'greenhouse',
  async fetch(t) {
    const token = t.boardToken
    if (!token) throw new HttpError('greenhouse connector requires a board token', null, false)

    // Cheap index pass first so we can decide whether content is affordable.
    const index = await getJson<{ jobs: GhJob[] }>(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`
    )
    const jobs = index.jobs ?? []

    let withContent: GhJob[] = jobs
    if (jobs.length > 0 && jobs.length <= LARGE_BOARD) {
      const full = await getJson<{ jobs: GhJob[] }>(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`
      )
      if (full.jobs?.length) withContent = full.jobs
    }

    return withContent.map((j) => ({
      externalId: String(j.id),
      title: j.title ?? '(untitled)',
      location: str(j.location?.name),
      applyUrl: j.absolute_url,
      postedAt: str(j.updated_at),
      description: j.content ? htmlToText(decodeEntities(j.content)) : null,
      department: str(j.departments?.[0]?.name)
    }))
  },
  async hydrate(t, p) {
    if (!t.boardToken) return null
    const j = await getJson<GhJob>(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t.boardToken)}/jobs/${encodeURIComponent(p.externalId)}`
    )
    return j.content ? htmlToText(decodeEntities(j.content)) : null
  }
}

/** Greenhouse double-encodes job content. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/* --------------------------------------------------------------------- lever */

interface LeverJob {
  id: string
  text: string
  hostedUrl: string
  applyUrl?: string
  createdAt?: number
  descriptionPlain?: string
  categories?: { location?: string; team?: string }
}

export const lever: Connector = {
  type: 'lever',
  async fetch(t) {
    const token = t.boardToken
    if (!token) throw new HttpError('lever connector requires a board token', null, false)

    const jobs = await getJson<LeverJob[]>(
      `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`
    )

    return (jobs ?? []).map((j) => ({
      externalId: j.id,
      title: j.text ?? '(untitled)',
      location: str(j.categories?.location),
      applyUrl: j.hostedUrl ?? j.applyUrl ?? '',
      postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      description: str(j.descriptionPlain),
      department: str(j.categories?.team)
    }))
  }
}

/* --------------------------------------------------------------------- ashby */

interface AshbyJob {
  id: string
  title: string
  location?: string
  jobUrl?: string
  applyUrl?: string
  publishedAt?: string
  descriptionPlain?: string
  department?: string
  isListed?: boolean
}

export const ashby: Connector = {
  type: 'ashby',
  async fetch(t) {
    const token = t.boardToken
    if (!token) throw new HttpError('ashby connector requires a board token', null, false)

    const body = await getJson<{ jobs: AshbyJob[] }>(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=false`
    )

    return (body.jobs ?? [])
      .filter((j) => j.isListed !== false)
      .map((j) => ({
        externalId: j.id,
        title: j.title ?? '(untitled)',
        location: str(j.location),
        applyUrl: j.jobUrl ?? j.applyUrl ?? '',
        postedAt: str(j.publishedAt),
        description: str(j.descriptionPlain),
        department: str(j.department)
      }))
  }
}

/* ----------------------------------------------------------- smartrecruiters */

interface SrPosting {
  id: string
  name: string
  releasedDate?: string
  location?: { city?: string; region?: string; country?: string; remote?: boolean }
  department?: { label?: string }
  ref?: string
}

export const smartrecruiters: Connector = {
  type: 'smartrecruiters',
  async fetch(t) {
    const token = t.boardToken
    if (!token) throw new HttpError('smartrecruiters connector requires a company id', null, false)

    const out: RawPosting[] = []
    const limit = 100
    let offset = 0

    // Paginates; capped well below Cloudflare's 50-subrequest-per-invocation
    // ceiling (Free plan) shared across every watched company in the hourly
    // run - see the identical note on the Amazon/Microsoft/Google connectors.
    for (let page = 0; page < 5; page++) {
      const body = await getJson<{ totalFound?: number; content?: SrPosting[] }>(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=${limit}&offset=${offset}`
      )
      const batch = body.content ?? []
      for (const p of batch) {
        const city = [p.location?.city, p.location?.region, p.location?.country]
          .filter(Boolean)
          .join(', ')
        out.push({
          externalId: p.id,
          title: p.name ?? '(untitled)',
          location: p.location?.remote ? `Remote${city ? ` (${city})` : ''}` : str(city),
          applyUrl: `https://jobs.smartrecruiters.com/${encodeURIComponent(token)}/${encodeURIComponent(p.id)}`,
          postedAt: str(p.releasedDate),
          description: null,
          department: str(p.department?.label)
        })
      }
      offset += limit
      if (batch.length < limit) break
      if (body.totalFound && offset >= body.totalFound) break
    }

    return out
  }
}

/* ------------------------------------------------------------------- workday */

interface WdPosting {
  title: string
  externalPath: string
  locationsText?: string
  postedOn?: string
  bulletFields?: string[]
}

/**
 * Workday is the flakiest of the supported ATSes: the feed is a POST to an
 * undocumented CXS endpoint whose host/site pair varies per tenant. Scout
 * supplies the endpoint via parseConfig.url.
 */
export const workday: Connector = {
  type: 'workday',
  async fetch(t) {
    const endpoint = t.parseConfig?.url
    if (!endpoint) throw new HttpError('workday connector requires parseConfig.url', null, false)

    const origin = new URL(endpoint).origin
    const sitePath = endpoint.replace(/^.*\/wday\/cxs\/[^/]+\//, '').replace(/\/jobs$/, '')

    const out: RawPosting[] = []
    const limit = 20

    for (let page = 0; page < 50; page++) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'career-watch/0.1 (personal job-posting tracker)'
        },
        body: JSON.stringify({ appliedFacets: {}, limit, offset: page * limit, searchText: '' })
      })
      if (!res.ok) throw new HttpError(`workday HTTP ${res.status}`, res.status, res.status >= 500)

      const body = (await res.json()) as { total?: number; jobPostings?: WdPosting[] }
      const batch = body.jobPostings ?? []

      for (const p of batch) {
        out.push({
          externalId: p.externalPath,
          title: p.title ?? '(untitled)',
          location: str(p.locationsText),
          applyUrl: `${origin}/en-US/${sitePath}${p.externalPath}`,
          // "Posted 3 Days Ago" is relative and unparseable; never fabricate one.
          postedAt: null,
          description: null,
          department: null
        })
      }

      if (batch.length < limit) break
      if (body.total && (page + 1) * limit >= body.total) break
    }

    return out
  }
}

/* -------------------------------------------------------------- oraclehcm */

interface OracleReq {
  Id: string
  Title: string
  PostedDate?: string | null
  PrimaryLocation?: string | null
}
interface OracleSearchItem {
  requisitionList?: OracleReq[]
  TotalJobsCount?: number
}

/**
 * Oracle Fusion Cloud Recruiting ("Candidate Experience") - a generic
 * enterprise ATS, same category as Workday: many unrelated companies run
 * their own tenant of it. Found on Uber's career site (jobs.uber.com links
 * out to <pod>.fa.ocs.oraclecloud.com) by inspecting network traffic, same
 * way as Workday and the dedicated big-company connectors.
 *
 * Unlike Workday's POST-based CXS endpoint, this is a plain public GET REST
 * API (recruitingCEJobRequisitions) - no auth, no CSRF token, and it accepts
 * an `offset` inside the `finder` param for pagination.
 *
 * board_token packs three tenant-specific values that can't be derived from
 * each other: `<host>|<siteNumber>|<siteName>` - e.g.
 * `iaziqy.fa.ocs.oraclecloud.com|CX_1|UberCareers`. siteNumber selects the
 * search results (`finder=findReqs;siteNumber=...`); siteName is the path
 * segment the public job-detail/apply page lives under.
 */
export const oraclehcm: Connector = {
  type: 'oraclehcm',
  async fetch(t) {
    const token = t.boardToken
    if (!token) throw new HttpError('oraclehcm connector requires a board token', null, false)
    const [host, siteNumber, siteName] = token.split('|')
    if (!host || !siteNumber || !siteName) {
      throw new HttpError('oraclehcm board token must be "<host>|<siteNumber>|<siteName>"', null, false)
    }

    const out: RawPosting[] = []
    const limit = 200

    for (let page = 0; page < 25; page++) {
      const offset = page * limit
      const finder =
        `findReqs;siteNumber=${encodeURIComponent(siteNumber)},limit=${limit},offset=${offset},sortBy=POSTING_DATES_DESC`
      const url =
        `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
        `?onlyData=true&expand=requisitionList&finder=${encodeURIComponent(finder)}`

      const body = await getJson<{ items?: OracleSearchItem[] }>(url)
      const item = body.items?.[0]
      const batch = item?.requisitionList ?? []

      for (const r of batch) {
        out.push({
          externalId: r.Id,
          title: r.Title ?? '(untitled)',
          location: str(r.PrimaryLocation),
          applyUrl: `https://${host}/hcmUI/CandidateExperience/en/sites/${encodeURIComponent(siteName)}/job/${encodeURIComponent(r.Id)}`,
          // The board's own posted date - trustworthy, not fabricated.
          postedAt: str(r.PostedDate),
          // Full descriptions live behind a separate per-job detail call the
          // list endpoint doesn't include; left null on the index pass like
          // every other connector's "content" hydration.
          description: null,
          department: null
        })
      }

      if (batch.length < limit) break
      if (item?.TotalJobsCount && offset + batch.length >= item.TotalJobsCount) break
    }

    return out
  }
}

/* ---------------------------------------------------------------- careerpage */

function pluck(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[k]
    return undefined
  }, obj)
}

/**
 * Executes whatever config Scout produced for a custom career page.
 *
 * `json-endpoint` is strongly preferred: it is the same API the site's own
 * JavaScript calls, so it behaves like a public ATS feed and survives redesigns.
 * HTML selectors are the fragile last resort that Medic exists to repair.
 */
export const careerpage: Connector = {
  type: 'careerpage',
  async fetch(t) {
    const cfg = t.parseConfig
    if (!cfg) throw new HttpError('careerpage connector requires a parseConfig', null, false)

    if (cfg.kind === 'json-endpoint') return fetchJsonEndpoint(cfg, t)
    return fetchHtml(cfg, t, await getText(cfg.url))
  }
}

async function fetchJsonEndpoint(cfg: ParseConfig, t: ConnectorTarget): Promise<RawPosting[]> {
  const body = await getJson<unknown>(cfg.url)
  const items = cfg.itemsPath ? pluck(body, cfg.itemsPath) : body
  if (!Array.isArray(items)) {
    throw new HttpError(`parseConfig.itemsPath did not yield an array for ${t.name}`, null, false)
  }

  const f = cfg.fields ?? {}
  const base = cfg.baseUrl ?? t.careersUrl

  return items.map((item, i) => {
    const rawLink = f.applyUrl ? str(pluck(item, f.applyUrl)) : null
    const id = f.externalId ? str(pluck(item, f.externalId)) : null
    return {
      externalId: id ?? rawLink ?? `${t.id}-${i}`,
      title: (f.title ? str(pluck(item, f.title)) : null) ?? '(untitled)',
      location: f.location ? str(pluck(item, f.location)) : null,
      applyUrl: absoluteUrl(rawLink, base) ?? t.careersUrl,
      postedAt: f.postedAt ? str(pluck(item, f.postedAt)) : null,
      description: f.description ? str(pluck(item, f.description)) : null,
      department: null
    }
  })
}

/**
 * Extracts postings from HTML using CSS selectors.
 *
 * The parser is injected rather than imported: cheerio pulls Node built-ins
 * that don't exist on Cloudflare Workers, and this connector must run on both
 * the desktop app and the server. Electron supplies cheerio; the Worker
 * supplies a lightweight fallback.
 */
export interface HtmlParser {
  /** Returns each matching element as { text, attr } accessors. */
  select(html: string, itemSelector: string): HtmlNode[]
}

export interface HtmlNode {
  text(selector?: string): string
  attr(name: string, selector?: string): string | null
}

let htmlParser: HtmlParser | null = null

export function setHtmlParser(p: HtmlParser): void {
  htmlParser = p
}

export async function fetchHtml(
  cfg: ParseConfig,
  t: ConnectorTarget,
  html: string
): Promise<RawPosting[]> {
  const sel = cfg.selectors
  if (!sel) throw new HttpError('parseConfig.selectors missing for html connector', null, false)
  if (!htmlParser) {
    throw new HttpError('no HTML parser registered for this runtime', null, false)
  }

  const base = cfg.baseUrl ?? cfg.url ?? t.careersUrl
  const out: RawPosting[] = []

  htmlParser.select(html, sel.item).forEach((node, i) => {
    const title = (node.text(sel.title) || node.text()).trim()
    if (!title) return

    const href = sel.link ? node.attr('href', sel.link) : (node.attr('href') ?? node.attr('href', 'a'))
    const applyUrl = absoluteUrl(href, base) ?? t.careersUrl

    out.push({
      externalId: applyUrl !== t.careersUrl ? applyUrl : `${t.id}-${i}-${title.slice(0, 40)}`,
      title,
      location: sel.location ? node.text(sel.location).trim() || null : null,
      applyUrl,
      // Custom pages rarely expose a trustworthy date; the UI says "detected".
      postedAt: null,
      description: null,
      department: null
    })
  })

  return out
}

/* -------------------------------------------------------------- amazonjobs */

/**
 * Amazon's real student-programs search API, reverse-engineered from the
 * actual request their own site (amazon.jobs/content/en/career-programs/
 * university) makes - found by inspecting live network traffic, not guessed.
 *
 * It needs a two-step handshake: a plain GET establishes a `__Host-mons-sid`
 * session cookie, which the POST search must echo back. No JS execution, no
 * browser - just a session cookie, well within reach of a server-side fetch.
 * This is company-specific (not a platform used by many employers), so it
 * gets its own dedicated connector rather than living in the generic
 * `careerpage` JSON-endpoint path.
 */
interface AmazonHit {
  fields: {
    title?: string[]
    normalizedLocation?: string[]
    icimsJobId?: string[]
    artJobId?: string[]
    urlNextStep?: string[]
    createdDate?: string[]
    isIntern?: string[]
    shortDescription?: string[]
  }
}

export const amazonjobs: Connector = {
  type: 'amazonjobs',
  async fetch() {
    const ORIGIN = 'https://www.amazon.jobs'
    const sessionRes = await httpGet(`${ORIGIN}/content/en/career-programs/university`, {
      accept: 'text/html'
    })
    const setCookies = sessionRes.headers.getSetCookie?.() ?? []
    if (setCookies.length === 0) {
      throw new HttpError('amazon.jobs did not set a session cookie', null, true)
    }
    const cookie = setCookies.map((c) => c.split(';')[0]).join('; ')

    // Cloudflare's Free plan caps one Worker invocation at 50 outgoing
    // fetches total, shared across every watched company in the hourly run -
    // see the identical note on the Microsoft/Google connectors. 500 covers
    // the ~373 real postings seen in testing with one page of headroom.
    const out: RawPosting[] = []
    const size = 100
    for (let start = 0; start < 500; start += size) {
      const res = await fetch(`${ORIGIN}/api/jobs/search?is_als=true`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'career-watch/0.1 (personal job-posting tracker)',
          cookie
        },
        body: JSON.stringify({
          accessLevel: 'EXTERNAL',
          contentFilterFacets: [
            {
              name: 'primarySearchLabel',
              requestedFacetCount: 9999,
              values: [
                { name: 'studentprograms.team-internships-for-students' },
                { name: 'studentprograms.team-jobs-for-grads' },
                { name: 'auta.apprenticeships' }
              ]
            }
          ],
          excludeFacets: [{ name: 'isConfidential', values: [{ name: '1' }] }],
          filterFacets: [],
          includeFacets: [],
          jobTypeFacets: [],
          locationFacets: [],
          query: '',
          size,
          start,
          treatment: 'OM',
          sort: { sortOrder: 'DESCENDING', sortType: 'SCORE' }
        })
      })
      if (!res.ok) throw new HttpError(`amazon.jobs search HTTP ${res.status}`, res.status, res.status >= 500)

      const body = (await res.json()) as { found?: number; searchHits?: AmazonHit[] }
      const hits = body.searchHits ?? []
      for (const h of hits) {
        const f = h.fields
        const id = f.icimsJobId?.[0] ?? f.artJobId?.[0]
        const path = f.urlNextStep?.[0]
        if (!id || !path) continue
        out.push({
          externalId: id,
          title: f.title?.[0] ?? '(untitled)',
          location: str(f.normalizedLocation?.[0] ?? null),
          applyUrl: absoluteUrl(path, ORIGIN) ?? ORIGIN,
          // Amazon's createdDate is Unix SECONDS, not milliseconds - confirmed
          // against the live API (a 10-digit value like 1787918606). Feeding
          // that straight into `new Date()` silently produced a January 1970
          // timestamp on every posting, which the age-cutoff feature then
          // (correctly, given the bad input) closed as ancient.
          postedAt: f.createdDate?.[0] ? new Date(Number(f.createdDate[0]) * 1000).toISOString() : null,
          description: f.shortDescription?.[0] ? htmlToText(f.shortDescription[0]) : null,
          department: null
        })
      }
      if (hits.length < size || (body.found ?? 0) <= start + size) break
    }

    return out
  }
}

/* ------------------------------------------------------------ microsoftjobs */

/**
 * Microsoft's real careers search API - also reverse-engineered from live
 * network traffic. Unlike Amazon, this one needs no session at all: a single
 * unauthenticated GET, no cookies, no handshake.
 */
interface MsPosition {
  displayJobId?: string
  name?: string
  locations?: string[]
  postedTs?: number
  positionUrl?: string
}

export const microsoftjobs: Connector = {
  type: 'microsoftjobs',
  async fetch() {
    const ORIGIN = 'https://apply.careers.microsoft.com'
    const out = new Map<string, RawPosting>()

    // Microsoft's own search endpoint has no keyword-free "give me everything
    // early-career" mode discoverable without guessing an undocumented facet
    // syntax, and pulling its entire global req list (thousands of roles) every
    // check is too much for an hourly job. Targeted queries covering the
    // classifier's own vocabulary get most of what a full pull would, without
    // fetching every senior role at the company - deduped by job ID below.
    const queries = ['intern', 'new grad', 'early career']

    // Cloudflare Workers caps a single invocation at 50 outgoing fetches
    // (Free plan, hard limit). An hourly check processes every watched
    // company in one invocation, so each connector's worst case matters, not
    // just its typical case - 5 queries x an unbounded page depth here would
    // alone be able to exhaust the entire budget. 3 pages/query (~60 results
    // each) comfortably covers relevance-ranked results without letting one
    // company's pagination starve every other company in the same run.
    const MAX_PAGES_PER_QUERY = 2

    for (const q of queries) {
      for (let start = 0; start < MAX_PAGES_PER_QUERY * 20; start += 20) {
        const body = await getJson<{ data?: { positions?: MsPosition[]; count?: number } }>(
          `${ORIGIN}/api/pcsx/search?domain=microsoft.com&query=${encodeURIComponent(q)}&location=&start=${start}`
        )
        const positions = body.data?.positions ?? []
        for (const p of positions) {
          if (!p.displayJobId || !p.positionUrl || out.has(p.displayJobId)) continue
          out.set(p.displayJobId, {
            externalId: p.displayJobId,
            title: p.name ?? '(untitled)',
            location: str(p.locations?.[0] ?? null),
            applyUrl: absoluteUrl(p.positionUrl, ORIGIN) ?? ORIGIN,
            postedAt: p.postedTs ? new Date(p.postedTs * 1000).toISOString() : null,
            description: null,
            department: null
          })
        }
        if (positions.length < 20) break
      }
    }

    return [...out.values()]
  }
}

/* ---------------------------------------------------------------- googlejobs */

/**
 * Google's careers page looked, on first inspection, like the hardest possible
 * case: 1.4MB of obfuscated markup with nothing job-shaped in a plain fetch.
 * It turned out to be server-rendered after all - the listings are embedded
 * directly in the HTML as a `AF_initDataCallback({key: 'ds:1', ..., data: [...]})`
 * block (a standard pattern for Google's internal Angular/Wiz apps), confirmed
 * present in a bare unauthenticated curl, no browser needed. The array is
 * positional, not keyed, reverse-engineered field-by-field against live data:
 * [0]=id [1]=title [2]=absolute apply URL [3]=[null, descriptionHtml]
 * [9]=locations, each [displayName, [addressLines], city, zip, state, country].
 *
 * `?q=` filters server-side (confirmed: "software engineering intern" returned
 * only matching PhD/intern roles), which keeps this to a handful of requests
 * per check instead of pulling Google's entire global req list.
 */
interface GoogleRecord {
  0: string // id
  1: string // title
  2: string // apply url
  3?: [unknown, string] // description html
  9?: [string, string[], string, string | null, string, string][] // locations
}

function extractGoogleDs1(html: string): GoogleRecord[] {
  const m = /AF_initDataCallback\(\{key:\s*'ds:1'[^;]*?data:(\[[\s\S]*?\]), sideChannel/.exec(html)
  if (!m?.[1]) return []
  try {
    const parsed = JSON.parse(m[1]) as [GoogleRecord[]]
    return parsed[0] ?? []
  } catch {
    return []
  }
}

export const googlejobs: Connector = {
  type: 'googlejobs',
  async fetch() {
    const ORIGIN = 'https://www.google.com'
    const BASE = `${ORIGIN}/about/careers/applications/jobs/results/`
    const out = new Map<string, RawPosting>()

    // Same vocabulary strategy as Microsoft: Google has thousands of open
    // roles worldwide, so targeted queries covering the classifier's own
    // terms are fetched instead of the entire board.
    const queries = ['intern', 'new grad', 'early career']

    // Cloudflare's Free plan caps one Worker invocation at 50 outgoing
    // fetches total, shared across every watched company in the hourly run -
    // see the identical note in the Microsoft connector above. 3 pages/query
    // was enough to cover 184 real postings in testing.
    const MAX_PAGES_PER_QUERY = 2

    for (const q of queries) {
      for (let page = 1; page <= MAX_PAGES_PER_QUERY; page++) {
        const html = await getText(`${BASE}?q=${encodeURIComponent(q)}&page=${page}`, { retries: 1 })
        const records = extractGoogleDs1(html)
        if (records.length === 0) break

        for (const r of records) {
          if (!r[0] || out.has(r[0])) continue
          // Some Google postings list 20-30 eligible locations at once. The
          // full list is kept (not truncated to "first 3") so the location
          // filter - substring/US-recognizer matching against this string -
          // still sees a qualifying city even if it isn't among the first few;
          // the UI already truncates long text visually.
          const locs = r[9] ?? []
          const location = locs.length > 0 ? locs.map((l) => l[0]).join(' | ') : null

          out.set(r[0], {
            externalId: r[0],
            title: r[1] ?? '(untitled)',
            location: str(location),
            applyUrl: absoluteUrl(r[2], ORIGIN) ?? BASE,
            // Google's own listing exposes no posted date in this data block;
            // never fabricate one - the UI already says "detected" for these.
            postedAt: null,
            description: r[3]?.[1] ? htmlToText(r[3][1]) : null,
            department: null
          })
        }
        if (records.length < 20) break
      }
    }

    return [...out.values()]
  }
}

/* ----------------------------------------------------------------- applejobs */

/**
 * Apple's careers site, like Google's, turned out server-rendered rather than
 * needing a headless browser. The data lives in a React Router SSR hydration
 * blob: `window.__staticRouterHydrationData = JSON.parse("...")` - note the
 * DOUBLE encoding, a JSON string containing an escaped JSON string, a common
 * pattern for safely embedding complex data as script text. Confirmed present
 * in a bare unauthenticated fetch; the 403/436-style block encountered earlier
 * was hitting a different, more sensitive internal API endpoint, not this
 * page. Apple's own postDateInGMT gives a real, trustworthy posted date -
 * unlike Google, nothing here needs to fall back to "detected".
 */
interface AppleLocation {
  name?: string
  countryName?: string
  city?: string
}

interface AppleRecord {
  id: string
  postingTitle: string
  jobSummary?: string
  positionId: string
  transformedPostingTitle: string
  postDateInGMT?: string
  locations?: AppleLocation[]
  team?: { teamCode?: string }
}

function extractAppleHydrationData(html: string): AppleRecord[] {
  const m = /window\.__staticRouterHydrationData = JSON\.parse\((".*?")\);/s.exec(html)
  if (!m?.[1]) return []
  try {
    // The captured group is itself a valid JSON string literal (quoted and
    // escaped) - parsing it once undoes the JS-string escaping to recover the
    // inner JSON text, then parsing again yields the real object.
    const unescaped = JSON.parse(m[1]) as string
    const data = JSON.parse(unescaped) as {
      loaderData?: { search?: { searchResults?: AppleRecord[] } }
    }
    return data.loaderData?.search?.searchResults ?? []
  } catch {
    return []
  }
}

export const applejobs: Connector = {
  type: 'applejobs',
  async fetch() {
    const ORIGIN = 'https://jobs.apple.com'
    const BASE = `${ORIGIN}/en-us/search`
    const out = new Map<string, RawPosting>()

    const queries = ['intern', 'new grad', 'early career']
    // Cloudflare's Free plan caps one Worker invocation at 50 outgoing
    // fetches total, shared across every watched company in the hourly run -
    // see the identical note on the Microsoft/Google connectors.
    const MAX_PAGES_PER_QUERY = 2

    for (const q of queries) {
      for (let page = 1; page <= MAX_PAGES_PER_QUERY; page++) {
        const html = await getText(`${BASE}?search=${encodeURIComponent(q)}&page=${page}`, { retries: 1 })
        const records = extractAppleHydrationData(html)
        if (records.length === 0) break

        for (const r of records) {
          if (!r.id || out.has(r.id)) continue
          // Apple's location objects separate city/state from country - e.g.
          // {name:"Austin", countryName:"United States of America"}. Treating
          // these as `name || countryName` alternatives (an earlier version of
          // this connector did) silently drops the country whenever a city is
          // present, which broke the "United States" location filter for every
          // US posting that only lists a city: it correctly saw no country
          // evidence in a bare "Austin" and excluded the posting. Concatenating
          // both keeps that filter working.
          const location =
            r.locations && r.locations.length > 0
              ? r.locations
                  .map((l) => [l.name || l.city, l.countryName].filter(Boolean).join(', '))
                  .filter(Boolean)
                  .join(' | ')
              : null

          out.set(r.id, {
            externalId: r.id,
            title: r.postingTitle ?? '(untitled)',
            location: str(location),
            applyUrl: `${ORIGIN}/en-us/details/${r.positionId}/${r.transformedPostingTitle}${
              r.team?.teamCode ? `?team=${r.team.teamCode}` : ''
            }`,
            postedAt: str(r.postDateInGMT ?? null),
            description: r.jobSummary ? htmlToText(r.jobSummary) : null,
            department: null
          })
        }
        if (records.length < 20) break
      }
    }

    return [...out.values()]
  }
}

/* ------------------------------------------------------------------ dispatch */

const REGISTRY: Partial<Record<AtsType, Connector>> = {
  greenhouse,
  lever,
  ashby,
  smartrecruiters,
  workday,
  oraclehcm,
  careerpage,
  amazonjobs,
  microsoftjobs,
  googlejobs,
  applejobs
}

export function connectorFor(type: AtsType): Connector | null {
  return REGISTRY[type] ?? null
}

/** Fetches one company, converting throws into a structured outcome. */
export async function fetchCompany(target: ConnectorTarget): Promise<FetchOutcome> {
  const conn = connectorFor(target.atsType)
  if (!conn) {
    return { ok: false, postings: [], error: `no connector for "${target.atsType}"`, transient: false }
  }

  try {
    const postings = await conn.fetch(target)
    return { ok: true, postings }
  } catch (err) {
    const transient = err instanceof HttpError ? err.transient : true
    return {
      ok: false,
      postings: [],
      error: err instanceof Error ? err.message : String(err),
      transient
    }
  }
}

export { httpGet }
