import { app, BrowserWindow, Notification } from 'electron'
import { EVENTS } from '@shared/ipc'
import { initDatabase } from './db/location'
import { markOpened, registerIpc } from './ipc'
import { appState } from './state'
import { createTray, destroyTray } from './tray'
import { getServerToken, getServerUrl, isConfigured } from './serverClient'
import { createWindow, getMainWindow, showWindow } from './window'

/**
 * The desktop app is an interface, not a worker: the server checks hourly on
 * its own schedule whether or not this app is even open. All this process
 * does locally is poll the server occasionally so the tray icon and a native
 * notification can reflect what already happened server-side.
 */
const POLL_INTERVAL_MS = 5 * 60_000
let lastKnownOpenCount = -1
let pollTimer: ReturnType<typeof setInterval> | null = null

async function pollForChanges(): Promise<void> {
  if (!isConfigured()) return
  try {
    const base = getServerUrl()
    const token = getServerToken()
    if (!base || !token) return

    const res = await fetch(`${base}/api/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) return
    const status = (await res.json()) as { openPostings: number }

    if (lastKnownOpenCount >= 0 && status.openPostings > lastKnownOpenCount) {
      const delta = status.openPostings - lastKnownOpenCount
      if (Notification.isSupported()) {
        const n = new Notification({
          title: `${delta} new opening${delta === 1 ? '' : 's'}`,
          body: 'Click to open Career Watch'
        })
        n.on('click', () => showWindow())
        n.show()
      }
    }
    lastKnownOpenCount = status.openPostings
    getMainWindow()?.webContents.send(EVENTS.runFinished)
  } catch {
    // A transient network blip is not worth surfacing; the next poll retries.
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  void app.whenReady().then(() => {
    initDatabase()
    registerIpc()
    createTray(() => void pollForChanges())

    const win = createWindow()
    win.webContents.on('did-finish-load', () => markOpened())

    win.on('close', (event) => {
      if (!appState.isQuitting) {
        event.preventDefault()
        win.hide()
      }
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    void pollForChanges()
    pollTimer = setInterval(() => void pollForChanges(), POLL_INTERVAL_MS)
  })

  app.on('window-all-closed', () => {})

  app.on('before-quit', () => {
    appState.isQuitting = true
  })

  app.on('will-quit', () => {
    if (pollTimer) clearInterval(pollTimer)
    destroyTray()
  })
}
