import { BrowserWindow, Notification, app } from 'electron'
import electronUpdater from 'electron-updater'
import { EVENTS } from '@shared/ipc'
import type { UpdateStatus } from '@shared/ipc'
import { appState } from './state'
import { setTrayUpdateReady } from './tray'
import { showWindow } from './window'

/**
 * Auto-updates from GitHub Releases (publish config in electron-builder.yml).
 *
 * Only the installed app can update itself. The desktop shortcut runs
 * Electron straight against the repo's build output, and there's no installer
 * there to swap - updating that setup means `git pull` + `npm run build`, so
 * the updater stays off and says so rather than pretending to check.
 *
 * Downloads happen in the background; installing never does. The user picks
 * when to restart, because a surprise restart would drop whatever they were
 * in the middle of (a half-filled profile, a tailoring run).
 */

// electron-updater is CommonJS; this is its documented import shape under ESM.
const { autoUpdater } = electronUpdater

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 15_000

let status: UpdateStatus = { state: 'idle', currentVersion: app.getVersion() }
let timer: ReturnType<typeof setInterval> | null = null

function publish(next: Partial<UpdateStatus>): void {
  status = { ...status, ...next, currentVersion: app.getVersion() }
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(EVENTS.updateStatus, status)
  setTrayUpdateReady(status.state === 'ready' ? () => installUpdate() : null)
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged) return status
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    publish({ state: 'error', error: friendlyError(err) })
  }
  return status
}

export function installUpdate(): void {
  if (status.state !== 'ready') return
  // Without this the window's close handler just hides to tray and the
  // installer never gets to run.
  appState.isQuitting = true
  autoUpdater.quitAndInstall(false, true)
}

/** Turns the updater's raw errors into something a person can act on. */
function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/404|latest\.yml|Cannot find latest/i.test(msg)) return 'No published release to update from yet.'
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|net::/i.test(msg)) return 'Could not reach GitHub - will try again later.'
  return msg.split('\n')[0]?.slice(0, 200) ?? 'Update check failed.'
}

export function initUpdater(): void {
  if (!app.isPackaged) {
    status = {
      state: 'disabled',
      currentVersion: app.getVersion(),
      reason: 'Running from source (the desktop shortcut). Update with git pull, then npm run build.'
    }
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => publish({ state: 'checking', error: undefined }))
  autoUpdater.on('update-not-available', () => publish({ state: 'up-to-date', checkedAt: new Date().toISOString() }))
  autoUpdater.on('update-available', (info) => publish({ state: 'downloading', availableVersion: info.version, progress: 0 }))
  autoUpdater.on('download-progress', (p) => publish({ state: 'downloading', progress: Math.round(p.percent) }))
  autoUpdater.on('error', (err) => publish({ state: 'error', error: friendlyError(err) }))
  autoUpdater.on('update-downloaded', (info) => {
    publish({ state: 'ready', availableVersion: info.version, progress: 100 })
    if (Notification.isSupported()) {
      const n = new Notification({
        title: `Career Watch ${info.version} is ready`,
        body: 'Restart the app to finish updating.'
      })
      n.on('click', () => showWindow())
      n.show()
    }
  })

  setTimeout(() => void checkForUpdates(), FIRST_CHECK_DELAY_MS)
  timer = setInterval(() => void checkForUpdates(), CHECK_EVERY_MS)
}

export function stopUpdater(): void {
  if (timer) clearInterval(timer)
  timer = null
}
