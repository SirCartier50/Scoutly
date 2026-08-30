/**
 * Repairs an Electron install whose postinstall failed to unpack the binary.
 *
 * electron's installer uses extract-zip, which can stall on the ~130MB Windows
 * archive; npm then rolls the whole tree back, so the failure looks like an
 * unrelated package going missing. The download itself is almost always fine,
 * so this re-extracts the cached zip with the platform's own unzipper and
 * writes the path.txt marker that electron/index.js reads.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const distDir = join('node_modules', 'electron', 'dist')
const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron'

// The installed package version is the ONLY acceptable binary version.
// Extracting whatever zip happens to be newest in the cache silently produces
// a package/binary mismatch - an app that runs, but not on the runtime it was
// built and tested against.
const pkgVersion = JSON.parse(
  readFileSync(join('node_modules', 'electron', 'package.json'), 'utf8')
).version

if (existsSync(join(distDir, exeName))) {
  // Present, but is it the RIGHT one? A stale binary from a previous version
  // is worse than a missing one because nothing complains.
  const stamp = join(distDir, 'version')
  const have = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim().replace(/^v/, '') : null
  if (have === pkgVersion) {
    console.log(`electron ${pkgVersion} binary present and matching`)
    process.exit(0)
  }
  console.warn(`electron binary is ${have ?? 'an unknown version'} but package is ${pkgVersion} - re-extracting`)
}

const cacheRoot =
  process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? '', 'electron', 'Cache')
    : join(process.env.HOME ?? '', '.cache', 'electron')

if (!existsSync(cacheRoot)) {
  console.error(`no electron cache at ${cacheRoot} — run: npm install electron --foreground-scripts`)
  process.exit(1)
}

const zips = []
for (const dir of readdirSync(cacheRoot)) {
  const sub = join(cacheRoot, dir)
  if (!statSync(sub).isDirectory()) continue
  for (const f of readdirSync(sub)) {
    const wantPlatform = process.platform === 'win32' ? 'win32' : process.platform
    // Match the exact version, not merely the platform.
    if (f === `electron-v${pkgVersion}-${wantPlatform}-${process.arch}.zip`) {
      zips.push(join(sub, f))
    }
  }
}

if (zips.length === 0) {
  console.error(
    `no cached zip for electron ${pkgVersion} (${process.platform}-${process.arch}) under ${cacheRoot}
` +
    `run: npm install electron@${pkgVersion} --foreground-scripts`
  )
  process.exit(1)
}

zips.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
const zip = zips[0]
console.log(`extracting ${zip}`)

rmSync(distDir, { recursive: true, force: true })
mkdirSync(distDir, { recursive: true })

const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe') : 'tar'
execFileSync(tar, ['-xf', zip, '-C', distDir], { stdio: 'inherit' })

if (!existsSync(join(distDir, exeName))) {
  console.error('extraction finished but the binary is still missing')
  process.exit(1)
}

writeFileSync(join('node_modules', 'electron', 'path.txt'), exeName)
console.log(`ok — ${distDir}/${exeName} restored`)
