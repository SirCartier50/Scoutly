/**
 * End-to-end: real job boards -> connectors -> classifier -> filters -> SQLite
 * -> digest rendering, against a scratch database.
 *
 * This is the test that would catch the pipeline silently collecting nothing.
 *
 *   npm run check:e2e
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/main/db/index'
import {
  countOpenPostings, healthCounts, listCompanies, listPostings, markNotified,
  recordCheck, setWatched, syncPostings, unnotifiedPostings, upsertCompany,
  type FetchedPosting
} from '../src/main/db/repo'
import { getSettings, setSettings } from '../src/main/db/settings'
import { loadSeed } from '../src/main/db/seed'
import { fetchCompany } from '../src/core/connectors/index'
import { applyFilters, classifyPosting } from '../src/core/classify'
import { evaluateHealth } from '../src/main/health'
import { renderDigestHtml, renderDigestText } from '../src/core/digest-render'

let passed = 0
let failed = 0
const check = (l: string, c: boolean, d = ''): void => {
  if (c) { passed++; console.log(`  PASS  ${l}`) } else { failed++; console.log(`  FAIL  ${l}${d ? ` -- ${d}` : ''}`) }
}
const eq = <T,>(l: string, a: T, b: T): void => check(l, Object.is(a, b), `got ${String(a)}, want ${String(b)}`)

const dir = mkdtempSync(join(tmpdir(), 'cw-e2e-'))
const db = openDatabase(join(dir, 'e2e.db'))

try {
  loadSeed(db)
  setSettings(db, {
    locations: [], remoteOk: true,
    wantIntern: true, wantNewGrad: true, wantProgram: true
  })

  // Companies chosen because they reliably carry early-career roles right now.
  const TARGETS = ['Palantir', 'Notion', 'Figma', 'Roblox', 'Cloudflare']
  const all = listCompanies(db)
  const picked = all.filter((c) => TARGETS.includes(c.name))
  eq('found target companies in seed', picked.length, TARGETS.length)
  for (const c of picked) setWatched(db, c.id, true)
  eq('companies now watched', listCompanies(db, true).length, TARGETS.length)

  console.log('\n[live fetch -> classify -> filter -> store]')
  const settings = getSettings(db)
  let totalFetched = 0
  let totalStored = 0

  for (const c of picked) {
    const outcome = await fetchCompany({
      id: c.id, name: c.name, careersUrl: c.careersUrl,
      atsType: c.atsType, boardToken: c.boardToken, parseConfig: null
    })

    if (!outcome.ok) {
      check(`${c.name}: fetch`, false, outcome.error)
      recordCheck(db, c.id, { ok: false, error: outcome.error, health: 'broken' })
      continue
    }

    totalFetched += outcome.postings.length
    const classified = outcome.postings.map(classifyPosting)
    const wanted = applyFilters(classified, {
      locations: settings.locations, remoteOk: settings.remoteOk,
      wantIntern: settings.wantIntern, wantNewGrad: settings.wantNewGrad,
      wantProgram: settings.wantProgram
    })

    const toStore: FetchedPosting[] = wanted.map((p) => ({
      externalId: p.externalId, title: p.title, location: p.location,
      applyUrl: p.applyUrl, postedAt: p.postedAt, description: p.description,
      roleType: p.roleType
    }))

    const res = syncPostings(db, c.id, toStore)
    totalStored += res.newPostings.length
    recordCheck(db, c.id, { ok: true, yield: toStore.length, health: 'ok' })

    console.log(
      `        ${c.name.padEnd(12)} ${String(outcome.postings.length).padStart(4)} jobs -> ` +
      `${String(toStore.length).padStart(3)} early-career -> ${res.newPostings.length} new`
    )
  }

  check(`fetched real jobs across boards (${totalFetched})`, totalFetched > 100)
  check(`stored early-career postings (${totalStored})`, totalStored > 0)
  eq('open count matches stored', countOpenPostings(db), totalStored)
  eq('all watchers healthy', healthCounts(db).ok, TARGETS.length)

  console.log('\n[stored data is sane]')
  const rows = listPostings(db, {})
  check('every stored posting is early-career', rows.every((r) => r.roleType !== 'other'))
  check('every applyUrl is https', rows.every((r) => /^https:\/\//.test(r.applyUrl)))
  check('every posting names its company', rows.every((r) => !!r.companyName))
  check('internships sort first', rows.length === 0 || rows[0]?.roleType === 'intern')
  const interns = rows.filter((r) => r.roleType === 'intern')
  console.log(`        ${rows.length} stored: ${interns.length} intern, ` +
    `${rows.filter((r) => r.roleType === 'program').length} program, ` +
    `${rows.filter((r) => r.roleType === 'newgrad').length} newgrad`)
  for (const r of rows.slice(0, 6)) {
    console.log(`          [${r.roleType}] ${r.companyName}: ${r.title}`)
  }

  console.log('\n[idempotency — a second identical check reports nothing new]')
  let secondNew = 0
  for (const c of picked) {
    const outcome = await fetchCompany({
      id: c.id, name: c.name, careersUrl: c.careersUrl,
      atsType: c.atsType, boardToken: c.boardToken, parseConfig: null
    })
    if (!outcome.ok) continue
    const wanted = applyFilters(outcome.postings.map(classifyPosting), {
      locations: settings.locations, remoteOk: settings.remoteOk,
      wantIntern: true, wantNewGrad: true, wantProgram: true
    })
    secondNew += syncPostings(db, c.id, wanted.map((p) => ({
      externalId: p.externalId, title: p.title, location: p.location,
      applyUrl: p.applyUrl, postedAt: p.postedAt, description: p.description,
      roleType: p.roleType
    }))).newPostings.length
  }
  eq('second pass finds 0 new postings', secondNew, 0)
  eq('open count unchanged', countOpenPostings(db), totalStored)

  console.log('\n[digest]')
  const pending = unnotifiedPostings(db)
  eq('all stored postings are pending notification', pending.length, totalStored)
  if (pending.length > 0) {
    const html = renderDigestHtml(pending)
    const text = renderDigestText(pending)
    check('digest html includes a real posting title', html.includes(pending[0]!.title.slice(0, 20)))
    check('digest html links to the apply url', html.includes(pending[0]!.applyUrl))
    check('digest html escapes markup', !/<script/i.test(html))
    check('digest text lists postings', text.includes(pending[0]!.title.slice(0, 20)))
    markNotified(db, pending.map((p) => p.id))
    eq('nothing pending after send', unnotifiedPostings(db).length, 0)
  }

  console.log('\n[health rules]')
  eq('healthy when yield is steady', evaluateHealth(40, [40, 41, 39], 0).health, 'ok')
  eq('stale on a >70% yield collapse', evaluateHealth(5, [40, 41, 39], 0).health, 'stale')
  eq('broken on two consecutive zeroes', evaluateHealth(0, [40, 41], 1).health, 'broken')
  eq('a single zero is not yet broken', evaluateHealth(0, [40, 41], 0).health, 'stale')
  eq('small boards are not flagged on noise', evaluateHealth(2, [5, 4, 6], 0).health, 'ok')

  console.log('\n[failure must not delete data]')
  const before = countOpenPostings(db)
  const target = picked[0]!
  const bad = await fetchCompany({
    id: target.id, name: target.name, careersUrl: target.careersUrl,
    atsType: 'greenhouse', boardToken: 'not-a-real-board-xyz-123', parseConfig: null
  })
  check('bad connector fails', !bad.ok)
  recordCheck(db, target.id, { ok: false, error: bad.error, health: 'broken' })
  eq('postings survive a failed check', countOpenPostings(db), before)
  eq('company marked broken', healthCounts(db).broken, 1)
} finally {
  db.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
