import type { DatabaseSync } from 'node:sqlite'
import { tx } from './index'
import { upsertCompany } from './repo'
import type { AtsType } from '@shared/types'
import seedData from '../../../data/seed-companies.json'

export interface SeedCompany {
  name: string
  careersUrl: string
  atsType: string
  boardToken: string
  topics: string[]
  verifiedJobs?: number
}

export const SEED_COMPANIES = seedData as SeedCompany[]

/**
 * Loads the bundled company list. Idempotent via slug upsert, so running it on
 * every launch refreshes metadata without duplicating rows or clobbering the
 * user's watch choices.
 *
 * Seeded companies start unwatched: the user opts in from the Companies tab,
 * rather than being emailed about 68 companies they never picked.
 */
export function loadSeed(db: DatabaseSync, watched = false): number {
  return tx(db, () => {
    let n = 0
    for (const c of SEED_COMPANIES) {
      upsertCompany(db, {
        name: c.name,
        careersUrl: c.careersUrl,
        atsType: c.atsType as AtsType,
        boardToken: c.boardToken,
        topics: c.topics,
        watched,
        source: 'seed'
      })
      n++
    }
    return n
  })
}

/** Ranks seeded companies by how many of the user's topics they match. */
export function suggestByTopics(topics: string[], limit = 12): SeedCompany[] {
  if (topics.length === 0) return []
  const want = new Set(topics.map((t) => t.toLowerCase()))
  return SEED_COMPANIES.map((c) => ({
    c,
    score: c.topics.filter((t) => want.has(t.toLowerCase())).length
  }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map((x) => x.c)
}
