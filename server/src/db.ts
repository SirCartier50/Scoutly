import { createClient, type Client, type InValue, type ResultSet } from '@libsql/client/web'

/**
 * Turso (libSQL) behind a D1-shaped interface.
 *
 * Why not D1: D1's Free plan caps writes at 100,000 rows/day, and once that's
 * hit it rejects EVERY query account-wide - reads included - until 00:00 UTC.
 * That took the whole app down (sign-in included) the first time the company
 * list got large enough to matter. Turso's free plan allows 10,000,000 rows
 * written per MONTH (~3x the daily-equivalent headroom) and is SQLite under
 * the hood too, so not one line of SQL in this codebase had to change.
 *
 * Why an adapter rather than rewriting every call site: the app only ever
 * uses `prepare().bind().all()/.first()/.run()` and `batch()`. Presenting
 * exactly that surface over libSQL keeps d1.ts, check.ts and index.ts
 * untouched apart from their type annotations - the storage engine swapped
 * without the application logic noticing.
 *
 * Two conversions here are load-bearing, not cosmetic:
 *
 *  1. libSQL `Row` is array-LIKE (numeric indexes plus a `length`), where D1
 *     hands back plain objects. Returning rows unmapped would serialize as
 *     `{"0":...,"1":...}` junk straight out of /api/postings. Every row is
 *     rebuilt as a plain object keyed by column name.
 *  2. `lastInsertRowid` is a bigint, and `JSON.stringify` THROWS on bigint.
 *     It's coerced to a number, and `intMode: 'number'` keeps ordinary
 *     integer columns from arriving as bigints in the first place.
 */

/** Exactly the slice of D1's surface this app uses - deliberately narrow. */
export interface BoundStatement {
  readonly sql: string
  readonly args: unknown[]
  bind(...args: unknown[]): BoundStatement
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<{ meta: { changes: number; last_row_id: number } }>
}

export interface Db {
  prepare(sql: string): BoundStatement
  /** Runs every statement in one transaction, like D1's batch(). */
  batch(statements: BoundStatement[]): Promise<void>
}

/** libSQL rejects `undefined`; D1 quietly tolerated it. Fail loudly-safe instead. */
const toInValue = (v: unknown): InValue => (v === undefined ? null : (v as InValue))

/** Rebuilds array-like libSQL rows into the plain objects the app expects. */
function toObjects<T>(rs: ResultSet): T[] {
  return rs.rows.map((row) => {
    const obj: Record<string, unknown> = {}
    rs.columns.forEach((col, i) => {
      obj[col] = (row as unknown as unknown[])[i]
    })
    return obj as T
  })
}

class TursoStatement implements BoundStatement {
  constructor(
    private readonly client: Client,
    readonly sql: string,
    readonly args: unknown[] = []
  ) {}

  bind(...args: unknown[]): BoundStatement {
    return new TursoStatement(this.client, this.sql, args)
  }

  private exec(): Promise<ResultSet> {
    return this.client.execute({ sql: this.sql, args: this.args.map(toInValue) })
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: toObjects<T>(await this.exec()) }
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return toObjects<T>(await this.exec())[0] ?? null
  }

  async run(): Promise<{ meta: { changes: number; last_row_id: number } }> {
    const rs = await this.exec()
    return {
      meta: {
        changes: rs.rowsAffected,
        last_row_id: Number(rs.lastInsertRowid ?? 0)
      }
    }
  }
}

class TursoDb implements Db {
  constructor(private readonly client: Client) {}

  prepare(sql: string): BoundStatement {
    return new TursoStatement(this.client, sql)
  }

  async batch(statements: BoundStatement[]): Promise<void> {
    if (statements.length === 0) return
    await this.client.batch(
      statements.map((s) => ({ sql: s.sql, args: s.args.map(toInValue) })),
      'write'
    )
  }
}

/**
 * Wraps an already-built libSQL client. Exists so tests can drive the exact
 * adapter used in production against a local file-backed client, which the
 * fetch-only `/web` build below can't open.
 */
export function wrapClient(client: Client): Db {
  return new TursoDb(client)
}

/**
 * Builds a client for one invocation. The `/web` entry point is the
 * fetch-only build - Workers has no TCP, so the default client (which can
 * open websockets) is the wrong one here.
 */
export function createDb(url: string, authToken: string): Db {
  return wrapClient(createClient({ url, authToken, intMode: 'number' }))
}
