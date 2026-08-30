import { DatabaseSync } from 'node:sqlite'
import { migrate } from './migrations'

export type { DatabaseSync }

/**
 * Opens (creating if needed) and migrates a database file.
 *
 * Kept free of any electron import so the schema and repo layer can be
 * exercised under plain node in tests; main supplies the userData path.
 */
export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file)

  // WAL lets the worker read while main writes, instead of blocking.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA synchronous = NORMAL')

  migrate(db)
  return db
}

let dbPath: string | null = null
let instance: DatabaseSync | null = null

export function setDbPath(file: string): void {
  dbPath = file
}

export function getDb(): DatabaseSync {
  if (instance) return instance
  if (!dbPath) throw new Error('db path not set — call setDbPath() during app startup')
  instance = openDatabase(dbPath)
  return instance
}

export function closeDb(): void {
  instance?.close()
  instance = null
}

/** node:sqlite rejects JS booleans; columns store 0/1. */
export const bool = (v: boolean): number => (v ? 1 : 0)
export const fromBool = (v: number): boolean => v === 1

/** Runs fn inside a transaction, rolling back on throw. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
