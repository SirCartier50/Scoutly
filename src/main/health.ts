import type { Health } from '@shared/types'
import { medianYield } from './db/repo'

/**
 * Health is measured on YIELD, not just errors.
 *
 * The dangerous failure mode is a board that still returns HTTP 200 and still
 * parses, but yields 12 jobs where it used to yield 400 - an error-only check
 * calls that healthy and the user silently stops hearing about internships.
 *
 * Kept as a pure, electron-free utility purely so `scripts/e2e-check.ts` can
 * exercise the rule directly; the server (`server/src/check.ts`) has its own
 * copy since it owns the actual check cycle now.
 */
export function evaluateHealth(
  yieldNow: number,
  history: number[],
  consecutiveZero: number
): { health: Health; reason?: string } {
  const median = medianYield(history)

  if (yieldNow === 0 && consecutiveZero >= 1) {
    return { health: 'broken', reason: 'zero postings on two consecutive checks' }
  }
  if (yieldNow === 0 && (median ?? 0) > 0) {
    return { health: 'stale', reason: 'zero postings where there were some before' }
  }
  if (median !== null && median >= 10 && yieldNow < median * 0.3) {
    return { health: 'stale', reason: `yield ${yieldNow} is >70% below 7-day median ${median}` }
  }
  return { health: 'ok' }
}
