import { app } from 'electron'
import { join } from 'node:path'
import { setDbPath, getDb } from './index'

/**
 * Opens the userData database and migrates it.
 *
 * The company directory and watch list now live server-side, so this local
 * database's only remaining job is `lastOpenedAt` - purely local viewing
 * state that has no reason to round-trip through the server.
 */
export function initDatabase(): void {
  setDbPath(join(app.getPath('userData'), 'career-watch.db'))
  getDb()
}
