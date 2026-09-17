#!/usr/bin/env node
/**
 * Onboards the industry-leading companies in data/titans.json.
 *
 * Unlike discover-companies.mjs (which starts from other people's internship
 * trackers), this starts from a hand-curated list of the biggest names in each
 * industry and works out, per company, where its jobs actually live:
 *
 *   1. Skip anything already in the directory (by name or alias).
 *   2. Load the company's own careers pages - the common URL shapes built from
 *      its domain - and follow redirects, since most career sites hand off to
 *      the real job platform.
 *   3. Pull every job-platform link out of what came back, plus the ids the
 *      search-only platforms embed (Eightfold's domain, m-cloud's org id).
 *   4. Verify each candidate against the platform's real API. Only a
 *      candidate that returns real postings is written out.
 *
 * Anything on a platform with no connector yet is recorded rather than
 * guessed at, so the report shows which connector unlocks the most companies.
 *
 * Usage:
 *   node scripts/discover-titans.mjs --existing path/to/existing.json [--out file.sql] [--report file.json]
 *
 * Output is a SQL migration for review - this never writes to the database.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import {
  UA, atsUrlsIn, detectUnsupported, inferFromUrl, insertSql, mcloudOrgIn, verify, withConcurrency
} from './lib/ats.mjs'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const EXISTING = arg('--existing')
const OUT = arg('--out', 'server/migrations/0012_titan_companies.sql')
const REPORT = arg('--report', 'titans-report.json')

if (!EXISTING) {
  console.error('usage: node scripts/discover-titans.mjs --existing existing.json [--out file.sql] [--report file.json]')
  process.exit(1)
}

/** "The Estée Lauder Companies, Inc." -> "esteelauder" - so aliases and legal names still match. */
function normalize(name) {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\b(the|inc|incorporated|corp|corporation|company|companies|co|llc|ltd|plc|group|holdings|lp)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
}

/** Every page shape a career site commonly lives at, built from the domain. */
function candidatePages(domain) {
  return [
    `https://careers.${domain}/`,
    `https://jobs.${domain}/`,
    `https://www.${domain}/careers`,
    `https://www.${domain}/careers/`,
    `https://${domain}/careers`,
    `https://www.${domain}/jobs`,
    `https://explore.jobs.${domain.split('.')[0]}.net/`
  ]
}

async function load(url) {
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    })
    if (!r.ok) return null
    const type = r.headers.get('content-type') ?? ''
    if (!type.includes('html')) return null
    const html = (await r.text()).slice(0, 3_000_000)
    return { finalUrl: r.url, html }
  } catch {
    return null
  }
}

async function investigate(company) {
  const pages = (await Promise.all(candidatePages(company.domain).map(load))).filter(Boolean)
  if (pages.length === 0) return { status: 'no-careers-page' }

  const haystack = pages.map((p) => `${p.finalUrl}\n${p.html}`).join('\n')
  const candidates = []
  const seen = new Set()
  const add = (c) => {
    const key = JSON.stringify(c)
    if (!seen.has(key)) {
      seen.add(key)
      candidates.push(c)
    }
  }

  for (const url of atsUrlsIn(haystack)) {
    const hint = inferFromUrl(url)
    if (hint) add(hint)
  }
  for (const p of pages) {
    const hint = inferFromUrl(p.finalUrl.endsWith('/') ? p.finalUrl : `${p.finalUrl}/`)
    if (hint) add(hint)
  }

  const org = mcloudOrgIn(haystack)
  if (org) {
    const page = pages.find((p) => mcloudOrgIn(p.html)) ?? pages[0]
    add({ ats: 'mcloud', token: org, careersUrl: page.finalUrl })
  }

  if (/eightfold/i.test(haystack)) {
    // The Eightfold API lives on whichever loaded page is the Eightfold site.
    for (const p of pages) {
      if (/eightfold|\/careers\/job\/|pcsx/i.test(p.html)) {
        add({ ats: 'eightfold', token: company.domain, origin: new URL(p.finalUrl).origin, careersUrl: new URL(p.finalUrl).origin })
      }
    }
  }

  // Verify in order; the first candidate with real postings wins. Large boards
  // first would be nicer, but any verified board is a correct answer.
  const verified = []
  for (const c of candidates.slice(0, 12)) {
    const v = await verify(c)
    if (v) verified.push({ ...v, careersUrl: c.careersUrl })
  }
  if (verified.length > 0) {
    // Prefer the board with the most postings - a company's main board, not a
    // subsidiary's tiny one that happened to be linked from the same page.
    verified.sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    return { status: 'verified', result: verified[0], alternatives: verified.length - 1 }
  }

  const unsupported = detectUnsupported(haystack)
  if (unsupported.length > 0) return { status: 'unsupported-platform', platforms: unsupported }
  return {
    status: candidates.length > 0 ? 'candidates-failed-verification' : 'platform-not-found',
    pagesLoaded: pages.map((p) => p.finalUrl)
  }
}

async function main() {
  const titans = JSON.parse(readFileSync('data/titans.json', 'utf8'))
  const existing = JSON.parse(readFileSync(EXISTING, 'utf8'))
  const existingByNorm = new Map(existing.map((c) => [normalize(c.name), c]))

  const present = []
  const missing = []
  for (const t of titans) {
    const match = [t.name, ...(t.aliases ?? [])].map(normalize).map((n) => existingByNorm.get(n)).find(Boolean)
    if (match) present.push({ ...t, matched: match.name, ats: match.ats_type, health: match.health })
    else missing.push(t)
  }
  console.log(`${titans.length} titans: ${present.length} already in the directory, ${missing.length} to investigate.`)

  const outcomes = []
  let done = 0
  await withConcurrency(missing, 8, async (t) => {
    const outcome = await investigate(t)
    outcomes.push({ ...t, ...outcome })
    done++
    const tag = outcome.status === 'verified' ? `✓ ${outcome.result.ats_type} (${outcome.result.count})` : outcome.status
    console.log(`  [${done}/${missing.length}] ${t.name}: ${tag}${outcome.platforms ? ` - ${outcome.platforms.join(', ')}` : ''}`)
  })

  const verified = outcomes.filter((o) => o.status === 'verified')
  const lines = [
    '-- Industry-leading companies onboarded via scripts/discover-titans.mjs from',
    '-- the hand-curated data/titans.json. Each company\'s job platform was found',
    '-- from its own careers pages and every row below was verified against that',
    '-- platform\'s live API (real postings returned) before being included.',
    '-- Review before applying.',
    ''
  ]
  for (const v of verified) lines.push(insertSql({ name: v.name, careersUrl: v.result.careersUrl, ...v.result }))
  writeFileSync(OUT, lines.join('\n'))

  const platformTally = {}
  for (const o of outcomes.filter((x) => x.status === 'unsupported-platform')) {
    for (const p of o.platforms) (platformTally[p] ??= []).push(o.name)
  }

  const report = {
    generatedAt: new Date().toISOString(),
    totals: {
      titans: titans.length,
      alreadyPresent: present.length,
      newlyVerified: verified.length,
      unsupportedPlatform: outcomes.filter((o) => o.status === 'unsupported-platform').length,
      notFound: outcomes.filter((o) => o.status === 'platform-not-found' || o.status === 'no-careers-page').length,
      failedVerification: outcomes.filter((o) => o.status === 'candidates-failed-verification').length
    },
    presentButUnhealthy: present.filter((p) => p.health !== 'ok').map((p) => `${p.name} (${p.matched}, ${p.ats}, ${p.health})`),
    unsupportedByPlatform: Object.fromEntries(Object.entries(platformTally).sort((a, b) => b[1].length - a[1].length)),
    unresolved: outcomes
      .filter((o) => o.status !== 'verified' && o.status !== 'unsupported-platform')
      .map((o) => `${o.name} [${o.industry}]: ${o.status}`),
    verified: verified.map((v) => `${v.name} [${v.industry}]: ${v.result.ats_type} (${v.result.count} postings)`)
  }
  writeFileSync(REPORT, JSON.stringify(report, null, 2))

  console.log(`\n${verified.length} newly verified -> ${OUT}`)
  console.log(`Report -> ${REPORT}`)
  console.log(JSON.stringify(report.totals, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
