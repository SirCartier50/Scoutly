import { app } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const __dirname_esm = dirname(fileURLToPath(import.meta.url))

/** Renderer entry differs between the dev server and the packaged build. */
export const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'] ?? null

export const rendererFile = join(__dirname_esm, '../renderer/index.html')

export const preloadFile = join(__dirname_esm, '../preload/index.mjs')

/**
 * Static assets live in resources/. Packaged builds copy them next to the app
 * via electron-builder's extraResources; in dev they sit at the project root.
 */
export function resourcePath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(__dirname_esm, '../../resources', name)
}
