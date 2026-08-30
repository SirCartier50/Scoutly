/**
 * Bundles a TS check script (resolving @shared and JSON imports) and runs it on
 * electron's node, which is where node:sqlite lives.
 *
 *   node scripts/run-check.mjs scripts/db-check.ts
 */
import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const entry = process.argv[2]
if (!entry) {
  console.error('usage: node scripts/run-check.mjs <script.ts>')
  process.exit(1)
}

const out = `node_modules/.cache/${basename(entry, '.ts')}.mjs`
mkdirSync('node_modules/.cache', { recursive: true })

execFileSync(
  process.execPath,
  [require.resolve('esbuild/bin/esbuild'), entry, '--bundle', '--platform=node',
   '--format=esm', '--target=node22', '--alias:@shared=./src/shared',
   '--external:node:sqlite', '--external:electron', '--external:cheerio',
   `--outfile=${out}`, '--log-level=warning'],
  { stdio: 'inherit' }
)

execFileSync(require('electron'), [out], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' }
})
