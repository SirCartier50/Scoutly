import { BrowserWindow, shell } from 'electron'
import { preloadFile, rendererDevUrl, rendererFile } from './paths'

/** Surface color used as the window background so launch never flashes white. */
const SURFACE_DARK = '#12121a'

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    show: false,
    backgroundColor: SURFACE_DARK,
    title: 'Career Watch',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadFile,
      // The security pair that matters: renderer gets no Node, and page
      // scripts cannot reach the preload's scope.
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload (type: module) requires the sandbox off.
      sandbox: false
    }
  })

  // Launched at login with --hidden: start in the tray, no window flash.
  const startHidden = process.argv.includes('--hidden')
  win.on('ready-to-show', () => {
    if (!startHidden) win.show()
  })

  // Idle CPU fix: the animated mesh background costs real CPU even when the
  // user cannot see it (tray app, unfocused window). Class toggle lets CSS
  // pause the animation and drop backdrop-filter without a renderer round-trip.
  win.on('focus', () => win.webContents.executeJavaScript("document.body.classList.remove('window-blurred')").catch(() => {}))
  win.on('blur', () => win.webContents.executeJavaScript("document.body.classList.add('window-blurred')").catch(() => {}))

  // Anything targeting a new window is a real career page: hand it to the
  // system browser rather than opening a second Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (rendererDevUrl) {
    void win.loadURL(rendererDevUrl)
  } else {
    void win.loadFile(rendererFile)
  }

  win.on('closed', () => {
    mainWindow = null
  })

  mainWindow = win
  return win
}

export function showWindow(): void {
  const win = mainWindow ?? createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
