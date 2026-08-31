#!/usr/bin/env node
// Diagnoses whether a deployed Career Watch Worker's hourly cron is actually
// firing, without needing Cloudflare API credentials - it just calls the
// Worker's own public HTTP surface.
//
// Usage:
//   node scripts/diagnose-server.mjs <server-url> <bearer-token>
// or via env vars:
//   CAREER_WATCH_WORKER_URL=... CAREER_WATCH_TOKEN=... node scripts/diagnose-server.mjs

const url = (process.argv[2] ?? process.env.CAREER_WATCH_WORKER_URL ?? '').replace(/\/+$/, '')
const token = process.argv[3] ?? process.env.CAREER_WATCH_TOKEN

if (!url) {
  console.error('Usage: node scripts/diagnose-server.mjs <server-url> [bearer-token]')
  console.error('   or: CAREER_WATCH_WORKER_URL=... CAREER_WATCH_TOKEN=... node scripts/diagnose-server.mjs')
  process.exit(1)
}

const CRON_INTERVAL_MIN = 60
// Give it real headroom over the nominal 60min interval before calling it
// overdue - a single slow run, a Cloudflare blip, or a bounded MAX_PER_RUN
// slice rotating through a big watch list can legitimately push this out.
const OVERDUE_AFTER_MIN = 100

async function main() {
  console.log(`Checking ${url} ...\n`)

  // 1. Is the Worker even deployed and reachable?
  let health
  try {
    const res = await fetch(`${url}/health`)
    health = { status: res.status, ok: res.ok, body: await res.text() }
  } catch (err) {
    console.log(`❌ Worker unreachable at ${url}/health`)
    console.log(`   ${err instanceof Error ? err.message : String(err)}`)
    console.log('\n   This means it is either not deployed, or the URL is wrong.')
    process.exitCode = 1; return
  }
  if (!health.ok) {
    console.log(`⚠️  ${url}/health returned HTTP ${health.status} - unexpected for a deployed Worker.`)
  } else {
    console.log(`✅ Worker is deployed and reachable (${url}/health -> 200)`)
  }

  if (!token) {
    console.log('\nNo bearer token given - skipping the /api/status check (that needs auth).')
    console.log('Re-run with a token to see whether the hourly cron is actually firing:')
    console.log(`  node scripts/diagnose-server.mjs ${url} <token>`)
    return
  }

  // 2. Is the cron actually producing runs, and how recently?
  let status
  try {
    const res = await fetch(`${url}/api/status`, { headers: { authorization: `Bearer ${token}` } })
    if (res.status === 401) {
      console.log('\n❌ /api/status returned 401 unauthorized - the token is wrong, expired, or')
      console.log('   (if this is the OLD single-user deployment) it wants the old shared')
      console.log('   CLIENT_TOKEN rather than a per-user token from POST /api/auth/google.')
      process.exitCode = 1; return
    }
    status = await res.json()
  } catch (err) {
    console.log(`\n❌ /api/status request failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1; return
  }

  const lastRun = status.lastRun
  if (!lastRun) {
    console.log('\n⚠️  No run_log entries at all - the cron has never fired since this D1 was created')
    console.log('   (or you are pointed at a fresh/local database, not the production one).')
    return
  }

  const startedAt = new Date(lastRun.started_at)
  const minutesAgo = Math.round((Date.now() - startedAt.getTime()) / 60000)
  console.log(`\nMost recent run: kind="${lastRun.kind}", started ${minutesAgo} min ago (${lastRun.started_at})`)
  console.log(`  companies checked: ${lastRun.companies_checked ?? '?'}, new postings: ${lastRun.new_postings ?? '?'}, errors: ${lastRun.errors ?? '?'}`)

  if (lastRun.kind !== 'scheduled') {
    console.log(`\n⚠️  The most recent run was "${lastRun.kind}", not "scheduled" - meaning the last`)
    console.log('   thing that actually ran was someone (or something) hitting POST /api/check')
    console.log('   manually, not the hourly cron trigger.')
  } else if (minutesAgo > OVERDUE_AFTER_MIN) {
    console.log(`\n❌ Last scheduled run was ${minutesAgo} min ago - the cron fires every`)
    console.log(`   ${CRON_INTERVAL_MIN} min, so this is overdue. The cron trigger is likely not firing`)
    console.log('   (check the "Cron Triggers" tab on this Worker in the Cloudflare dashboard).')
  } else {
    console.log('\n✅ A scheduled run happened recently - the cron looks like it is firing normally.')
  }
}

main()
