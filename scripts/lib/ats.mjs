/**
 * Shared ATS detection + live verification for the discovery scripts.
 *
 * The rule every function here follows: a URL shape or an HTML string is a
 * HINT. Nothing becomes a company row until `verify` has called the
 * company's own real job API and gotten real postings back.
 */

export const UA = 'career-watch-discovery/0.1 (+bulk company onboarding, verifies every candidate live before trusting it)'

export function slugify(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * Infers a candidate (ats_type, token/config, and a clean careers_url that
 * points at the company's general board rather than one specific posting)
 * purely from a URL's shape - a hint, not yet trusted.
 */
export function inferFromUrl(url) {
  let m
  if ((m = /(?:job-boards|boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i.exec(url)))
    return { ats: 'greenhouse', token: m[1], careersUrl: `https://job-boards.greenhouse.io/${m[1]}` }
  if ((m = /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/i.exec(url)))
    return { ats: 'greenhouse', token: m[1], careersUrl: `https://job-boards.greenhouse.io/${m[1]}` }
  if ((m = /jobs\.lever\.co\/([a-z0-9_.-]+)/i.exec(url)))
    return { ats: 'lever', token: m[1], careersUrl: `https://jobs.lever.co/${m[1]}` }
  if ((m = /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i.exec(url)))
    return { ats: 'ashby', token: m[1], careersUrl: `https://jobs.ashbyhq.com/${m[1]}` }
  if ((m = /jobs\.smartrecruiters\.com\/([a-zA-Z0-9_-]+)\//i.exec(url)))
    return { ats: 'smartrecruiters', token: m[1], careersUrl: `https://jobs.smartrecruiters.com/${m[1]}` }
  if ((m = /careers\.smartrecruiters\.com\/([a-zA-Z0-9_-]+)/i.exec(url)))
    return { ats: 'smartrecruiters', token: m[1], careersUrl: `https://careers.smartrecruiters.com/${m[1]}` }
  if ((m = /https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([a-z0-9_-]+)\//i.exec(url))) {
    const [, tenant, wdN, site] = m
    // "wday" and "en-US"-style segments aren't site names.
    if (site.toLowerCase() === 'wday') return null
    return {
      ats: 'workday',
      endpoint: `https://${tenant}.${wdN}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`,
      careersUrl: `https://${tenant}.${wdN}.myworkdayjobs.com/${site}`
    }
  }
  if ((m = /([a-z0-9.-]+\.oraclecloud\.com)\/hcmUI\/CandidateExperience\/[a-z]{2}\/sites\/([^/?#"']+)/i.exec(url))) {
    const [, host, siteName] = m
    // The URL's own /sites/<X>/ segment IS the siteNumber in the common case;
    // verification is what catches it when this guess is wrong.
    return {
      ats: 'oraclehcm',
      token: `${host}|${siteName}|${siteName}`,
      careersUrl: `https://${host}/hcmUI/CandidateExperience/en/sites/${siteName}/requisitions`
    }
  }
  return null
}

/**
 * Platforms with no connector yet. Detected only so the discovery report can
 * say which connector would unlock the most missing companies - never added.
 */
export const UNSUPPORTED_PLATFORMS = {
  taleo: /taleo\.net/i,
  icims: /\.icims\.com/i,
  successfactors: /successfactors\.(com|eu)|jobs\.sap\.com|rmk-map|career\d*\.sapsf/i,
  phenom: /phenompeople|cdn\.phenom|phenom\.com\/|"phApp"|ph-app/i,
  avature: /avature\.net/i,
  jibe: /jibeapply|jibecdn|\.jibe\.com/i,
  brassring: /brassring\.com/i,
  ukg: /ultipro\.com|recruiting\.ultipro|ukg\.net/i,
  radancy: /tbcdn\.talentbrew|talentbrew\.com|radancy/i,
  workable: /apply\.workable\.com/i,
  paradox: /paradox\.ai/i
}

export function detectUnsupported(text) {
  return Object.entries(UNSUPPORTED_PLATFORMS)
    .filter(([, re]) => re.test(text))
    .map(([name]) => name)
}

/** Every URL in a page that points at a platform inferFromUrl understands. */
export function atsUrlsIn(text) {
  const re = /https?:\/\/[a-z0-9.-]*(?:greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|myworkdayjobs\.com|oraclecloud\.com)[^\s"'<>\\)]*/gi
  // Trailing slash so the Workday/SmartRecruiters shapes (which expect a
  // segment terminator) still match a bare board link.
  return [...new Set((text.match(re) ?? []).map((u) => u.replace(/&amp;/g, '&')))].map((u) =>
    /\/$/.test(u) ? u : `${u}/`
  )
}

/** m-cloud (the "CWS" WordPress careers plugin) embeds its org id in the page. */
export function mcloudOrgIn(text) {
  const m = /org_id\\?["']?\s*[:=]\s*\\?["']companies\\?\/([0-9a-f-]{36})/i.exec(text)
  return m ? m[1] : null
}

const withTimeout = (ms) => AbortSignal.timeout(ms)

/** Re-derives the real thing by calling the company's own public API - never trusts the hint alone. */
export async function verify(candidate) {
  try {
    if (candidate.ats === 'greenhouse') {
      const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${candidate.token}/jobs`, { headers: { 'user-agent': UA }, signal: withTimeout(20000) })
      if (!r.ok) return null
      const j = await r.json()
      return Array.isArray(j.jobs) && j.jobs.length > 0 ? { ats_type: 'greenhouse', board_token: candidate.token, count: j.jobs.length } : null
    }
    if (candidate.ats === 'lever') {
      const r = await fetch(`https://api.lever.co/v0/postings/${candidate.token}?mode=json`, { headers: { 'user-agent': UA }, signal: withTimeout(20000) })
      if (!r.ok) return null
      const j = await r.json()
      return Array.isArray(j) && j.length > 0 ? { ats_type: 'lever', board_token: candidate.token, count: j.length } : null
    }
    if (candidate.ats === 'ashby') {
      const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${candidate.token}`, { headers: { 'user-agent': UA }, signal: withTimeout(20000) })
      if (!r.ok) return null
      const j = await r.json()
      return Array.isArray(j.jobs) && j.jobs.length > 0 ? { ats_type: 'ashby', board_token: candidate.token, count: j.jobs.length } : null
    }
    if (candidate.ats === 'smartrecruiters') {
      const r = await fetch(`https://api.smartrecruiters.com/v1/companies/${candidate.token}/postings?limit=5`, { headers: { 'user-agent': UA }, signal: withTimeout(20000) })
      if (!r.ok) return null
      const j = await r.json()
      return (j.totalFound ?? 0) > 0 ? { ats_type: 'smartrecruiters', board_token: candidate.token, count: j.totalFound } : null
    }
    if (candidate.ats === 'workday') {
      const r = await fetch(candidate.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': UA },
        body: JSON.stringify({ appliedFacets: {}, limit: 5, offset: 0, searchText: '' }),
        signal: withTimeout(20000)
      })
      if (!r.ok) return null
      const j = await r.json()
      return (j.total ?? 0) > 0 ? { ats_type: 'workday', parse_config: { kind: 'json-endpoint', url: candidate.endpoint }, count: j.total } : null
    }
    if (candidate.ats === 'oraclehcm') {
      const [host, siteNumber] = candidate.token.split('|')
      const finder = `findReqs;siteNumber=${encodeURIComponent(siteNumber)},limit=5,offset=0,sortBy=POSTING_DATES_DESC`
      const r = await fetch(
        `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=${encodeURIComponent(finder)}`,
        { headers: { 'user-agent': UA, accept: 'application/json' }, signal: withTimeout(20000) }
      )
      if (!r.ok) return null
      const j = await r.json()
      const count = j.items?.[0]?.TotalJobsCount ?? 0
      return count > 0 ? { ats_type: 'oraclehcm', board_token: candidate.token, count } : null
    }
    if (candidate.ats === 'eightfold') {
      // candidate.origin: the Eightfold site's origin; candidate.token: the company domain.
      const r = await fetch(`${candidate.origin}/api/apply/v2/jobs?domain=${encodeURIComponent(candidate.token)}&start=0&num=1`, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: withTimeout(20000)
      })
      if (!r.ok) return null
      const j = await r.json()
      return (j.count ?? 0) > 0 ? { ats_type: 'eightfold', board_token: candidate.token, count: j.count } : null
    }
    if (candidate.ats === 'successfactors') {
      // candidate.token: the Career Site Builder host. A plain sitemap lists
      // every job; an RSS-style one (Sephora, ExxonMobil) means fall back to
      // the site's own search - the same two paths the connector takes.
      const host = candidate.token
      const sm = await fetch(`https://${host}/sitemap.xml`, { headers: { 'user-agent': UA }, signal: withTimeout(30000) })
      if (sm.ok) {
        const reader = sm.body.getReader()
        const { value } = await reader.read()
        const head = new TextDecoder().decode(value ?? new Uint8Array())
        await reader.cancel()
        if (/<urlset\b|<loc>/i.test(head) && !/<rss\b/i.test(head)) {
          const full = await (await fetch(`https://${host}/sitemap.xml`, { headers: { 'user-agent': UA }, signal: withTimeout(30000) })).text()
          const count = (full.match(/\/job\/[^<]+?\/\d+\/?<\/loc>/g) ?? []).length
          if (count > 0) return { ats_type: 'successfactors', board_token: host, count }
        }
      }
      const search = await fetch(`https://${host}/search/?q=&startrow=0`, { headers: { 'user-agent': UA }, signal: withTimeout(30000) })
      if (!search.ok) return null
      const html = await search.text()
      const count = (html.match(/class="jobTitle-link/g) ?? []).length
      return count > 0 ? { ats_type: 'successfactors', board_token: host, count } : null
    }
    if (candidate.ats === 'mcloud') {
      const r = await fetch(
        `https://jobsapi-google.m-cloud.io/api/job/search?CompanyName=${encodeURIComponent(`companies/${candidate.token}`)}&Offset=0&PageSize=1`,
        { headers: { 'user-agent': UA, accept: 'application/json' }, signal: withTimeout(20000) }
      )
      if (!r.ok) return null
      const j = await r.json()
      return (j.totalHits ?? 0) > 0 ? { ats_type: 'mcloud', board_token: candidate.token, count: j.totalHits } : null
    }
  } catch {
    return null
  }
  return null
}

export async function withConcurrency(items, limit, fn) {
  const results = []
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      results[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return results
}

/** One row of SQL, matching the format of the earlier discovery migrations. */
export function insertSql({ name, careersUrl, ats_type, board_token, parse_config }, source = 'discovery') {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`
  return [
    'INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)',
    `VALUES (${q(slugify(name))}, ${q(name)}, ${q(careersUrl)}, ${q(ats_type)}, ${board_token ? q(board_token) : 'NULL'}, ${parse_config ? q(JSON.stringify(parse_config)) : 'NULL'}, ${q(source)}, 'ok', '[]', 0, datetime('now'))`,
    'ON CONFLICT(slug) DO NOTHING;',
    ''
  ].join('\n')
}
