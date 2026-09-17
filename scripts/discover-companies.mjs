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
import { UA, inferFromUrl, slugify, verify, withConcurrency } from './lib/ats.mjs'

const SOURCES = [
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json',
  'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json'
]


const args = process.argv.slice(2)
const limitIdx = args.indexOf('--limit')
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity
const outIdx = args.indexOf('--out')
const OUT = outIdx >= 0 ? args[outIdx + 1] : 'server/migrations/0010_discovered_companies.sql'

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
