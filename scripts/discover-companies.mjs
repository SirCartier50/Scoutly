#!/usr/bin/env node
/**
 * Bulk company discovery, using SimplifyJobs' community-maintained internship/
 * new-grad trackers (github.com/SimplifyJobs) purely as a source of COMPANY
 * NAMES + a hint at their ATS from the apply URL's own hostname shape - never
 * as a source of posting data itself. Every candidate is independently
 * re-verified against the real public ATS API before being trusted, exactly
 * the same validation-gate principle as Scout and the manual Uber/Citadel
 * work: a URL pattern match is a hint, not a fact, until it actually returns
 * real postings.
 *
 * Nothing from the source datasets (job titles, term tags, categorization,
 * their own compiled structure) is stored - only what THIS script
 * independently re-derives by calling the company's own public ATS endpoint
 * directly: company name, ats_type, board_token/parse_config.
 *
 * Usage:
 *   node scripts/discover-companies.mjs [--limit N] [--out path.sql]
 *
 * Output is a SQL migration for review - this never writes to D1 directly.
 */
import { writeFileSync } from 'node:fs'

const SOURCES = [
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json',
  'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json'
]

const UA = 'career-watch-discovery/0.1 (+bulk company onboarding, verifies every candidate live before trusting it)'

const args = process.argv.slice(2)
const limitIdx = args.indexOf('--limit')
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity
const outIdx = args.indexOf('--out')
const OUT = outIdx >= 0 ? args[outIdx + 1] : 'server/migrations/0010_discovered_companies.sql'

function slugify(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * Infers a candidate (ats_type, token/config, and a clean careers_url that
 * points at the company's general board rather than the one specific job
 * posting the source dataset happened to link) purely from the apply URL's
 * shape - a hint, not yet trusted.
 */
function inferFromUrl(url) {
  let m
  if ((m = /(?:job-boards|boards)\.greenhouse\.io\/([a-z0-9_-]+)/i.exec(url)))
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
    return {
      ats: 'workday',
      endpoint: `https://${tenant}.${wdN}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`,
      careersUrl: `https://${tenant}.${wdN}.myworkdayjobs.com/${site}`
    }
  }
  if ((m = /([a-z0-9.-]+\.oraclecloud\.com)\/hcmUI\/CandidateExperience\/en\/sites\/([^/]+)\//i.exec(url))) {
    const [, host, siteName] = m
    // The URL's own /sites/<X>/ segment IS the siteNumber in the common case
    // (Uber, whose siteNumber and siteName differ, is the exception, not the
    // rule) - verification below is what catches it when this guess is wrong.
    return {
      ats: 'oraclehcm',
      token: `${host}|${siteName}|${siteName}`,
      careersUrl: `https://${host}/hcmUI/CandidateExperience/en/sites/${siteName}/requisitions`
    }
  }
  return null
}

/** Re-derives the real thing by calling the company's own public API - never trusts the URL-shape hint alone. */
async function verify(candidate) {
  try {
    if (candidate.ats === 'greenhouse') {
      const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${candidate.token}/jobs`, { headers: { 'user-agent': UA } })
      if (!r.ok) return null
      const j = await r.json()
      return Array.isArray(j.jobs) && j.jobs.length > 0 ? { ats_type: 'greenhouse', board_token: candidate.token, count: j.jobs.length } : null
    }
    if (candidate.ats === 'lever') {
      const r = await fetch(`https://api.lever.co/v0/postings/${candidate.token}?mode=json`, { headers: { 'user-agent': UA } })
      if (!r.ok) return null
      const j = await r.json()
      return Array.isArray(j) && j.length > 0 ? { ats_type: 'lever', board_token: candidate.token, count: j.length } : null
    }
    if (candidate.ats === 'ashby') {
      const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${candidate.token}`, { headers: { 'user-agent': UA } })
      if (!r.ok) return null
      const j = await r.json()
      return Array.isArray(j.jobs) && j.jobs.length > 0 ? { ats_type: 'ashby', board_token: candidate.token, count: j.jobs.length } : null
    }
    if (candidate.ats === 'smartrecruiters') {
      const r = await fetch(`https://api.smartrecruiters.com/v1/companies/${candidate.token}/postings?limit=5`, { headers: { 'user-agent': UA } })
      if (!r.ok) return null
      const j = await r.json()
      return (j.totalFound ?? 0) > 0 ? { ats_type: 'smartrecruiters', board_token: candidate.token, count: j.totalFound } : null
    }
    if (candidate.ats === 'workday') {
      const r = await fetch(candidate.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': UA },
        body: JSON.stringify({ appliedFacets: {}, limit: 5, offset: 0, searchText: '' })
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
        { headers: { 'user-agent': UA, accept: 'application/json' } }
      )
      if (!r.ok) return null
      const j = await r.json()
      const count = j.items?.[0]?.TotalJobsCount ?? 0
      return count > 0 ? { ats_type: 'oraclehcm', board_token: candidate.token, count } : null
    }
  } catch {
    return null
  }
  return null
}

async function withConcurrency(items, limit, fn) {
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

async function main() {
  console.log('Fetching source datasets (discovery only - not stored)...')
  const byCompany = new Map()
  for (const src of SOURCES) {
    const res = await fetch(src, { headers: { 'user-agent': UA } })
    if (!res.ok) {
      console.error(`  ! ${src} -> HTTP ${res.status}, skipping`)
      continue
    }
    const rows = await res.json()
    for (const row of rows) {
      if (!row.company_name || !row.url) continue
      if (!byCompany.has(row.company_name)) byCompany.set(row.company_name, row.url)
    }
    console.log(`  fetched ${rows.length} rows from ${src.split('/').slice(3, 5).join('/')}`)
  }
  console.log(`${byCompany.size} unique company names total.`)

  const candidates = [...byCompany.entries()]
    .map(([name, url]) => ({ name, url, hint: inferFromUrl(url) }))
    .filter((c) => c.hint)
  console.log(`${candidates.length} have a recognizable ATS URL shape (the rest need Scout/manual review).`)

  const toCheck = candidates.slice(0, LIMIT)
  console.log(`Verifying ${toCheck.length} against their real public API (concurrency 10)...`)

  const verified = []
  let done = 0
  await withConcurrency(toCheck, 10, async (c) => {
    const result = await verify(c.hint)
    done++
    if (done % 200 === 0) console.log(`  ...${done}/${toCheck.length}`)
    if (result) verified.push({ name: c.name, careersUrl: c.hint.careersUrl, ...result })
  })

  console.log(`\n${verified.length} verified with real live postings (out of ${toCheck.length} candidates checked).`)

  const seen = new Set()
  const lines = [
    '-- Auto-discovered via scripts/discover-companies.mjs, using SimplifyJobs\'',
    '-- community-maintained trackers purely as a source of company names + a',
    '-- URL-shape hint - every row below was independently re-verified against',
    '-- the company\'s own real public ATS API before being included here.',
    '-- Review before applying.',
    ''
  ]
  for (const v of verified) {
    const slug = slugify(v.name)
    if (seen.has(slug)) continue
    seen.add(slug)
    const parseConfig = v.parse_config ? `'${JSON.stringify(v.parse_config).replace(/'/g, "''")}'` : 'NULL'
    const boardToken = v.board_token ? `'${v.board_token.replace(/'/g, "''")}'` : 'NULL'
    const name = v.name.replace(/'/g, "''")
    const careersUrl = v.careersUrl.replace(/'/g, "''")
    lines.push(
      `INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)`,
      `VALUES ('${slug}', '${name}', '${careersUrl}', '${v.ats_type}', ${boardToken}, ${parseConfig}, 'discovery', 'ok', '[]', 0, datetime('now'))`,
      `ON CONFLICT(slug) DO NOTHING;`,
      ''
    )
  }
  writeFileSync(OUT, lines.join('\n'))
  console.log(`Wrote ${seen.size} unique verified companies to ${OUT}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
