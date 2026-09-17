import { Menu, Tray, app, nativeImage } from 'electron'
import { resourcePath } from './paths'
import { appState } from './state'
import { showWindow } from './window'

let tray: Tray | null = null
let checkNow: () => void = () => undefined
let installUpdate: (() => void) | null = null

function rebuildMenu(): void {
  if (!tray) return
  const menu = Menu.buildFromTemplate([
    { label: 'Open Career Watch', click: () => showWindow() },
    // Only present once an update has finished downloading - the tray is
    // where a minimised-to-tray app is most likely to be noticed.
    ...(installUpdate
      ? ([{ label: 'Restart to update', click: installUpdate }, { type: 'separator' }] as const)
      : ([{ type: 'separator' }] as const)),
    { label: 'Check now', click: checkNow },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        appState.isQuitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
}

export function createTray(onCheckNow: () => void): Tray {
  const icon = nativeImage.createFromPath(resourcePath('tray.png'))

  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('Career Watch')
  checkNow = onCheckNow
  rebuildMenu()
  tray.on('click', () => showWindow())

  return tray
}

/** Shows (or hides, with null) the tray's "Restart to update" item. */
export function setTrayUpdateReady(onInstall: (() => void) | null): void {
  installUpdate = onInstall
  rebuildMenu()
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
