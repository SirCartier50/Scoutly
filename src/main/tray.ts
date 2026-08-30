import { Menu, Tray, app, nativeImage } from 'electron'
import { resourcePath } from './paths'
import { appState } from './state'
import { showWindow } from './window'

let tray: Tray | null = null

export function createTray(onCheckNow: () => void): Tray {
  const icon = nativeImage.createFromPath(resourcePath('tray.png'))

  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('Career Watch')

  const menu = Menu.buildFromTemplate([
    { label: 'Open Career Watch', click: () => showWindow() },
    { type: 'separator' },
    { label: 'Check now', click: onCheckNow },
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
  tray.on('click', () => showWindow())

  return tray
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
