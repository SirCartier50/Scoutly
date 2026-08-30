/**
 * Exercises Scout against companies the free probe cannot resolve.
 *
 * These are the real hard cases (Workday tenants and custom career sites), so
 * this is the only honest way to know whether the cheap-model tier earns its
 * place - and whether the validation gate actually rejects bad configs rather
 * than installing a watcher that silently reports nothing forever.
 *
 *   LLM_API_KEY=... npm run check:scout
 */
import { runScout } from '../src/core/agents/scout'
import { probe } from '../src/core/probe'
import { registerCheerio } from '../src/main/htmlParser'

await registerCheerio()

const apiKey = process.env.LLM_API_KEY ?? null
const baseUrl = process.env.LLM_BASE_URL ?? 'https://openrouter.ai/api/v1'
const model = process.env.LLM_MODEL ?? 'nvidia/nemotron-3.5-lightning:free'
const escalationModel = process.env.LLM_ESCALATION_MODEL ?? null

if (!apiKey) {
  console.log('LLM_API_KEY not set — skipping (Scout is optional; everything else runs without it)')
  process.exit(0)
}

const TARGETS = [
  { name: 'Netflix', careersUrl: 'https://explore.jobs.netflix.net/careers' },
  { name: 'Nvidia', careersUrl: 'https://www.nvidia.com/en-us/about-nvidia/careers/' },
  { name: 'DoorDash', careersUrl: 'https://careers.doordash.com/' },
  { name: 'Shopify', careersUrl: 'https://www.shopify.com/careers' }
]

console.log(`model: ${model}`)
console.log(`endpoint: ${baseUrl}\n`)

let resolved = 0
let rejected = 0

for (const [i, t] of TARGETS.entries()) {
  // Confirm the free probe really does fail, so we know Scout is being tested
  // on a genuinely hard case rather than getting a free pass.
  const free = await probe(t.name, t.careersUrl)
  if (free) {
    console.log(`${t.name}: probe already resolved it (${free.atsType}/${free.boardToken}) — not a Scout case`)
    continue
  }

  const started = Date.now()
  const res = await runScout(
    { companyId: 1000 + i, name: t.name, careersUrl: t.careersUrl },
    { apiKey, baseUrl, model, escalationModel }
  )
  const secs = ((Date.now() - started) / 1000).toFixed(1)

  if (res.ok) {
    resolved++
    console.log(`${t.name}: RESOLVED via ${res.tier} in ${secs}s`)
    console.log(`    atsType=${res.atsType} token=${String(res.boardToken).slice(0, 80)}`)
    if (res.parseConfig) console.log(`    parseConfig=${JSON.stringify(res.parseConfig).slice(0, 200)}`)
  } else {
    rejected++
    console.log(`${t.name}: not resolved (${res.tier ?? 'n/a'}) in ${secs}s`)
    console.log(`    reason: ${res.error}`)
  }
}

console.log(`\n${resolved} resolved, ${rejected} not resolved`)
console.log(
  rejected > 0
    ? 'Unresolved is an acceptable outcome: the validation gate refuses configs that\n' +
        'do not actually return postings, which is the point. A wrong config would be worse.'
    : 'All targets resolved and passed the live-fetch validation gate.'
)
