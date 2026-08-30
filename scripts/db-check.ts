/**
 * Exercises the storage layer against a scratch database.
 *
 * Focused on the diff engine, because "what opened since the last check" is the
 * product: a bug here either spams the digest or silently swallows a posting.
 *
 *   npm run check:db
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase, closeDb } from '../src/main/db/index'
import { MIGRATIONS } from '../src/main/db/migrations'
import {
  countOpenPostings,
  finishRun,
  healthCounts,
  latestRun,
  listCompanies,
  markNotified,
  medianYield,
  monthToDateSpend,
  recordAgentRun,
  recordCheck,
  setWatched,
  slugify,
  startRun,
  syncPostings,
  unnotifiedPostings,
  upsertCompany,
  applicationCounts,
  setApplicationStatus,
  type FetchedPosting
} from '../src/main/db/repo'
import { getSettings, setSettings } from '../src/main/db/settings'
import { SEED_COMPANIES, loadSeed, suggestByTopics } from '../src/main/db/seed'

let passed = 0
let failed = 0

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`)
  }
}

function eq<T>(label: string, actual: T, expected: T): void {
  check(label, Object.is(actual, expected), `got ${String(actual)}, want ${String(expected)}`)
}

const latest = Math.max(...MIGRATIONS.map((m) => m.version))
const dir = mkdtempSync(join(tmpdir(), 'cw-dbcheck-'))
const dbFile = join(dir, 'test.db')
const db = openDatabase(dbFile)

try {
  console.log('\n[migrations]')
  const uv = db.prepare('PRAGMA user_version').get() as unknown as { user_version: number }
  eq(`user_version bumped to ${latest}`, uv.user_version, latest)
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as unknown as { name: string }[]
  ).map((r) => r.name)
  for (const t of ['companies', 'postings', 'programs', 'settings', 'jobs', 'agent_runs', 'run_log']) {
    check(`table ${t} exists`, tables.includes(t))
  }
  const jm = db.prepare('PRAGMA journal_mode').get() as unknown as { journal_mode: string }
  eq('journal_mode is WAL', jm.journal_mode.toLowerCase(), 'wal')

  // Upgrading an existing install must not lose data. Build a v1 database the
  // way a shipped v1 would have, then run the real migrator over it.
  console.log('\n[upgrade from v1]')
  {
    const oldFile = join(dir, 'v1.db')
    const old = new DatabaseSync(oldFile)
    const first = MIGRATIONS.find((m) => m.version === 1)
    if (!first) throw new Error('migration 1 missing')
    first.up(old)
    old.exec('PRAGMA user_version = 1')
    const ts = new Date().toISOString()
    old
      .prepare(
        "INSERT INTO companies (slug, name, careers_url, ats_type, topics, watched, source, created_at)" +
          " VALUES ('legacy','Legacy Co','https://example.invalid','greenhouse','[]',1,'manual',?)"
      )
      .run(ts)
    const cid = (
      old.prepare("SELECT id FROM companies WHERE slug='legacy'").get() as unknown as { id: number }
    ).id
    old
      .prepare(
        'INSERT INTO postings (company_id, external_id, title, role_type, apply_url, first_seen_at, last_seen_at)' +
          " VALUES (?,'x1','Legacy Intern','intern','https://example.invalid/j',?,?)"
      )
      .run(cid, ts, ts)
    old.close()

    const up = openDatabase(oldFile)
    const uv2 = up.prepare('PRAGMA user_version').get() as unknown as { user_version: number }
    eq('v1 database upgrades to latest', uv2.user_version, latest)
    const cols = (
      up.prepare('PRAGMA table_info(postings)').all() as unknown as { name: string }[]
    ).map((c) => c.name)
    for (const c of ['app_status', 'app_updated_at', 'app_note', 'deadline']) {
      check(`upgrade added postings.${c}`, cols.includes(c))
    }
    const nCo = (up.prepare('SELECT COUNT(*) AS n FROM companies').get() as unknown as { n: number }).n
    const nPo = (up.prepare('SELECT COUNT(*) AS n FROM postings').get() as unknown as { n: number }).n
    const nWa = (
      up.prepare('SELECT COUNT(*) AS n FROM companies WHERE watched=1').get() as unknown as { n: number }
    ).n
    eq('existing company survived upgrade', nCo, 1)
    eq('existing posting survived upgrade', nPo, 1)
    eq('watch state survived upgrade', nWa, 1)
    const st = up.prepare('SELECT app_status FROM postings').get() as unknown as { app_status: string }
    eq('existing rows default to app_status none', st.app_status, 'none')
    up.close()
  }

  console.log('\n[application tracking]')
  {
    const c = upsertCompany(db, {
      name: 'Tracker Co',
      careersUrl: 'https://example.invalid',
      watched: true
    })
    syncPostings(db, c, [
      {
        externalId: 't1',
        title: 'SWE Intern',
        location: null,
        applyUrl: 'https://example.invalid/t1',
        postedAt: null,
        description: null,
        roleType: 'intern'
      }
    ])
    const pid = (
      db.prepare("SELECT id FROM postings WHERE external_id='t1'").get() as unknown as { id: number }
    ).id
    eq('no applications initially', applicationCounts(db).totalApplied, 0)
    setApplicationStatus(db, pid, 'applied')
    eq('applied counted', applicationCounts(db).totalApplied, 1)
    setApplicationStatus(db, pid, 'interviewing')
    eq('progressing still counts as applied', applicationCounts(db).totalApplied, 1)
    eq('stage tracked separately', applicationCounts(db).interviewing, 1)
    setApplicationStatus(db, pid, 'interested')
    eq('interested is not an application', applicationCounts(db).totalApplied, 0)
    db.prepare('DELETE FROM companies WHERE id = ?').run(c)
  }

  console.log('\n[seed]')
  const seedSize = SEED_COMPANIES.length
  const n = loadSeed(db)
  eq(`seed loaded ${seedSize} companies`, n, seedSize)
  eq('all seeded rows present', listCompanies(db).length, seedSize)
  eq('seeded companies start unwatched', listCompanies(db, true).length, 0)
  const again = loadSeed(db)
  eq('re-seeding is idempotent (no duplicates)', listCompanies(db).length, seedSize)
  eq('re-seed touched same count', again, seedSize)
  eq('slugify handles punctuation', slugify('Weights & Biases'), 'weights-biases')
  eq('slugify handles spaces', slugify('Scale AI'), 'scale-ai')

  console.log('\n[topic suggestions]')
  const sugg = suggestByTopics(['fintech'])
  check('fintech suggests companies', sugg.length > 0)
  check('all fintech suggestions are tagged fintech', sugg.every((s) => s.topics.includes('fintech')))
  eq('unknown topic suggests nothing', suggestByTopics(['underwater-basketweaving']).length, 0)
  eq('empty topics suggests nothing', suggestByTopics([]).length, 0)

  console.log('\n[settings]')
  const s0 = getSettings(db)
  eq('default cap is $10', s0.monthlyCapUsd, 10)
  eq('default schedule is twice daily', s0.scheduleTimes.length, 2)
  check('defaults prefer internships', s0.wantIntern)
  setSettings(db, { locations: ['New York', 'Remote'], monthlyCapUsd: 5 })
  const s1 = getSettings(db)
  eq('locations round-tripped', s1.locations.join(','), 'New York,Remote')
  eq('cap updated', s1.monthlyCapUsd, 5)
  eq('untouched setting keeps default', s1.scheduleTimes.length, 2)
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('locations', 'not-json{')
  eq('corrupt value falls back to default', getSettings(db).locations.length, 0)

  console.log('\n[diff engine]')
  const acme = upsertCompany(db, {
    name: 'Acme Corp',
    careersUrl: 'https://example.invalid/careers',
    atsType: 'greenhouse',
    boardToken: 'acme',
    watched: true
  })
  setWatched(db, acme, true)

  const mk = (id: string, title: string, role: FetchedPosting['roleType'] = 'intern'): FetchedPosting => ({
    externalId: id,
    title,
    location: 'New York, NY',
    applyUrl: `https://example.invalid/jobs/${id}`,
    postedAt: '2026-08-01T00:00:00.000Z',
    description: `About ${title}`,
    roleType: role
  })

  // First check: everything is new.
  const r1 = syncPostings(db, acme, [mk('1', 'SWE Intern'), mk('2', 'Data Intern')])
  eq('first sync reports 2 new', r1.newPostings.length, 2)
  eq('first sync closed nothing', r1.closed, 0)

  // Identical feed: nothing may be reported as new a second time.
  const r2 = syncPostings(db, acme, [mk('1', 'SWE Intern'), mk('2', 'Data Intern')])
  eq('re-running same feed reports 0 new', r2.newPostings.length, 0)
  eq('re-running same feed updates 2', r2.updated, 2)
  eq('still 2 open postings', countOpenPostings(db), 2)

  // One new arrival alongside the existing two.
  const r3 = syncPostings(db, acme, [mk('1', 'SWE Intern'), mk('2', 'Data Intern'), mk('3', 'ML Intern')])
  eq('new arrival detected', r3.newPostings.length, 1)
  eq('new arrival is the right one', r3.newPostings[0]?.title, 'ML Intern')

  // A posting disappearing from the feed is closed, not deleted.
  const r4 = syncPostings(db, acme, [mk('1', 'SWE Intern'), mk('3', 'ML Intern')])
  eq('disappeared posting closed', r4.closed, 1)
  eq('open count drops to 2', countOpenPostings(db), 2)
  const stillThere = db
    .prepare('SELECT COUNT(*) AS n FROM postings WHERE company_id = ?')
    .get(acme) as unknown as { n: number }
  eq('closed posting retained, not deleted', stillThere.n, 3)

  // A posting reopening clears closed_at rather than duplicating.
  const r5 = syncPostings(db, acme, [mk('1', 'SWE Intern'), mk('2', 'Data Intern'), mk('3', 'ML Intern')])
  eq('reopened posting is not re-reported as new', r5.newPostings.length, 0)
  eq('reopened posting counts as open again', countOpenPostings(db), 3)

  // A connector that briefly reports a wrong posted_at (this actually happened:
  // Amazon's date field is Unix seconds, fed in as milliseconds, stamping every
  // posting circa January 1970) must be able to self-correct on the next sync,
  // not require a manual data fix.
  // Every sync below carries the full current feed (1, 2, 3) so the diff
  // engine doesn't close postings 2/3 as "missing" - only posting 1's date is
  // varied, isolating the posted_at-refresh behavior from the diff logic.
  syncPostings(db, acme, [mk('1', 'SWE Intern'), mk('2', 'Data Intern'), mk('3', 'ML Intern')])
  const badDate = db.prepare("SELECT posted_at FROM postings WHERE external_id='1'").get() as unknown as { posted_at: string }
  eq('posting 1 has the seeded date', badDate.posted_at, '2026-08-01T00:00:00.000Z')
  const corrected: FetchedPosting = { ...mk('1', 'SWE Intern'), postedAt: '2026-08-15T00:00:00.000Z' }
  syncPostings(db, acme, [corrected, mk('2', 'Data Intern'), mk('3', 'ML Intern')])
  const fixedDate = db.prepare("SELECT posted_at FROM postings WHERE external_id='1'").get() as unknown as { posted_at: string }
  eq('resync corrects a previously-wrong posted_at', fixedDate.posted_at, '2026-08-15T00:00:00.000Z')
  const nullDatePass = { ...mk('1', 'SWE Intern'), postedAt: null }
  syncPostings(db, acme, [nullDatePass, mk('2', 'Data Intern'), mk('3', 'ML Intern')])
  const keptDate = db.prepare("SELECT posted_at FROM postings WHERE external_id='1'").get() as unknown as { posted_at: string }
  eq('a fetch with no date does not erase a known-good one', keptDate.posted_at, '2026-08-15T00:00:00.000Z')
  eq('open count still 3 after the date-refresh probes', countOpenPostings(db), 3)

  // The critical safety property: a FAILED fetch must never close anything.
  recordCheck(db, acme, { ok: false, error: 'connection reset', health: 'broken' })
  eq('failed check leaves postings open', countOpenPostings(db), 3)
  const h = healthCounts(db)
  eq('failed check marks company broken', h.broken, 1)

  console.log('\n[notification queue]')
  const pending = unnotifiedPostings(db)
  eq('three postings await notification', pending.length, 3)
  check('unwatched companies are excluded', pending.every((p) => p.companyName === 'Acme Corp'))
  markNotified(db, pending.map((p) => p.id))
  eq('nothing pending after marking', unnotifiedPostings(db).length, 0)
  const r6 = syncPostings(db, acme, [mk('1', 'SWE Intern'), mk('4', 'Infra Intern')])
  eq('only the newest posting is pending', unnotifiedPostings(db).length, 1)
  eq('and it is the new one', unnotifiedPostings(db)[0]?.title, 'Infra Intern')
  eq('sanity: sync reported it new', r6.newPostings.length, 1)

  console.log('\n[health / yield]')
  recordCheck(db, acme, { ok: true, yield: 40 })
  recordCheck(db, acme, { ok: true, yield: 42 })
  recordCheck(db, acme, { ok: true, yield: 38 })
  const hist = db.prepare('SELECT yield_history FROM companies WHERE id = ?').get(acme) as
    | unknown as { yield_history: string }
  eq('yield history accumulates', (JSON.parse(hist.yield_history) as number[]).length, 3)
  eq('median of 3 yields', medianYield([40, 42, 38]), 40)
  eq('median of even count averages', medianYield([10, 20, 30, 40]), 25)
  eq('median of empty is null', medianYield([]), null)
  eq('successful check restores health', healthCounts(db).ok, 1)
  const zero = db.prepare('SELECT consecutive_zero FROM companies WHERE id = ?').get(acme) as
    | unknown as { consecutive_zero: number }
  eq('consecutive_zero reset by non-zero yield', zero.consecutive_zero, 0)
  recordCheck(db, acme, { ok: true, yield: 0 })
  recordCheck(db, acme, { ok: true, yield: 0 })
  const zero2 = db.prepare('SELECT consecutive_zero FROM companies WHERE id = ?').get(acme) as
    | unknown as { consecutive_zero: number }
  eq('consecutive zero yields counted', zero2.consecutive_zero, 2)

  console.log('\n[run log]')
  const runId = startRun(db, 'manual')
  finishRun(db, runId, { companiesChecked: 1, newPostings: 1, errors: 0 })
  const run = latestRun(db)
  eq('run recorded', run?.new_postings, 1)
  eq('run kind recorded', run?.kind, 'manual')
  check('run has finish time', run?.finished_at !== null)

  console.log('\n[spend ledger]')
  eq('starts at zero', monthToDateSpend(db), 0)
  recordAgentRun(db, {
    role: 'scout', model: 'claude-haiku-4-5', companyId: acme,
    inputTokens: 30000, outputTokens: 1000, usd: 0.031, ok: true
  })
  recordAgentRun(db, {
    role: 'scout', model: 'claude-opus-5', companyId: acme,
    inputTokens: 30000, outputTokens: 1200, usd: 0.17, ok: true
  })
  const spend = monthToDateSpend(db)
  check('spend accumulates', Math.abs(spend - 0.201) < 1e-9, `got ${spend}`)

  console.log('\n[cascade]')
  db.prepare('DELETE FROM companies WHERE id = ?').run(acme)
  const orphans = db
    .prepare('SELECT COUNT(*) AS n FROM postings WHERE company_id = ?')
    .get(acme) as unknown as { n: number }
  eq('deleting a company cascades to its postings', orphans.n, 0)
} finally {
  closeDb()
  db.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
