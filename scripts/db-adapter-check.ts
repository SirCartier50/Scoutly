/**
 * Verifies the Turso/libSQL adapter presents D1's contract faithfully.
 *
 * Runs the REAL adapter (server/src/db.ts) against a real file-backed libSQL
 * database, because the parts most likely to break are exactly the parts a
 * mock would paper over: libSQL rows are array-like where D1's are plain
 * objects, and lastInsertRowid arrives as a bigint that JSON.stringify
 * throws on. Both would fail silently in production - the first as garbage
 * JSON out of /api/postings, the second as a 500 on any insert path.
 *
 *   node scripts/run-check.mjs scripts/db-adapter-check.ts
 */
import { createClient } from '@libsql/client'
import { wrapClient } from '../server/src/db'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main(): Promise<void> {
  // In-memory keeps the check hermetic; the adapter can't tell the difference.
  const db = wrapClient(createClient({ url: ':memory:', intMode: 'number' }))

  await db
    .prepare(
      `CREATE TABLE items (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL,
         qty INTEGER,
         note TEXT
       )`
    )
    .run()

  console.log('\n[shape: rows must be plain objects, not array-like]')
  await db.prepare('INSERT INTO items (name, qty, note) VALUES (?, ?, ?)').bind('alpha', 3, null).run()
  const one = await db.prepare('SELECT id, name, qty, note FROM items WHERE name = ?').bind('alpha').first<{
    id: number; name: string; qty: number; note: string | null
  }>()
  check('first() returns a row', one !== null)
  check('columns are addressable by name', one?.name === 'alpha', JSON.stringify(one))
  check('null column round-trips as null', one?.note === null)
  check(
    'row has no numeric index pollution',
    one !== null && !Object.keys(one).some((k) => /^\d+$/.test(k)),
    `keys: ${one ? Object.keys(one).join(',') : 'n/a'}`
  )
  check(
    'row survives JSON.stringify as an object',
    JSON.stringify(one).startsWith('{"id"'),
    JSON.stringify(one)
  )

  console.log('\n[integers: must be numbers, never bigint]')
  check('integer column is a JS number', typeof one?.qty === 'number', typeof one?.qty)
  const ins = await db.prepare('INSERT INTO items (name, qty) VALUES (?, ?)').bind('beta', 7).run()
  check('run() reports changes', ins.meta.changes === 1, String(ins.meta.changes))
  check('last_row_id is a number, not bigint', typeof ins.meta.last_row_id === 'number', typeof ins.meta.last_row_id)
  check('run() result is JSON-serializable', (() => {
    try { JSON.stringify(ins); return true } catch { return false }
  })())

  console.log('\n[all(): every row normalized]')
  const { results } = await db.prepare('SELECT id, name FROM items ORDER BY id').all<{ id: number; name: string }>()
  check('all() returns every row', results.length === 2, String(results.length))
  check('all() rows are plain objects', results.every((r) => !Object.keys(r).some((k) => /^\d+$/.test(k))))
  check('all() preserves order and values', results[0]?.name === 'alpha' && results[1]?.name === 'beta')

  console.log('\n[bind(): reusable prepared statement, like D1]')
  const stmt = db.prepare('INSERT INTO items (name, qty) VALUES (?, ?)')
  await db.batch([stmt.bind('gamma', 1), stmt.bind('delta', 2)])
  const after = await db.prepare('SELECT COUNT(*) AS n FROM items').first<{ n: number }>()
  check('batch() applied every statement', after?.n === 4, String(after?.n))
  check(
    'binding the same statement twice does not leak args',
    (await db.prepare('SELECT name FROM items WHERE qty = ?').bind(1).first<{ name: string }>())?.name === 'gamma'
  )

  console.log('\n[batch(): atomic — a failing statement rolls the whole batch back]')
  const before = (await db.prepare('SELECT COUNT(*) AS n FROM items').first<{ n: number }>())?.n ?? -1
  let threw = false
  try {
    await db.batch([
      db.prepare('INSERT INTO items (name, qty) VALUES (?, ?)').bind('epsilon', 9),
      // NOT NULL violation - must take the good insert down with it.
      db.prepare('INSERT INTO items (name, qty) VALUES (?, ?)').bind(null, 10)
    ])
  } catch {
    threw = true
  }
  const afterFail = (await db.prepare('SELECT COUNT(*) AS n FROM items').first<{ n: number }>())?.n ?? -1
  check('a bad batch rejects', threw)
  check('a bad batch leaves nothing behind', afterFail === before, `${before} -> ${afterFail}`)

  console.log('\n[empty results / undefined args]')
  const none = await db.prepare('SELECT * FROM items WHERE name = ?').bind('nonexistent').first()
  check('first() returns null when nothing matches', none === null)
  const { results: empty } = await db.prepare('SELECT * FROM items WHERE name = ?').bind('nonexistent').all()
  check('all() returns [] when nothing matches', Array.isArray(empty) && empty.length === 0)
  await db.prepare('INSERT INTO items (name, note) VALUES (?, ?)').bind('zeta', undefined).run()
  const undef = await db.prepare('SELECT note FROM items WHERE name = ?').bind('zeta').first<{ note: string | null }>()
  check('undefined binds as null rather than throwing', undef?.note === null)

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('adapter check crashed:', err)
  process.exit(1)
})
