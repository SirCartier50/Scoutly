/**
 * Per-model token pricing, USD per 1M tokens. Used to write an auditable spend
 * ledger row for every model call so the monthly cap is enforced on real cost
 * rather than a guess.
 */
export interface ModelPrice {
  input: number
  output: number
  /** Cache reads bill at ~0.1x input; cache writes at ~1.25x. */
  cacheRead: number
  cacheWrite: number
}

export const PRICING: Record<string, ModelPrice> = {
  'claude-opus-5': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 }
}

export interface UsageLike {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/** Converts an API usage object into USD. Unknown models price as Opus (worst case). */
export function costOf(model: string, usage: UsageLike | undefined | null): number {
  const p = PRICING[model] ?? PRICING['claude-opus-5']
  if (!p || !usage) return 0

  const inTok = usage.input_tokens ?? 0
  const outTok = usage.output_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0

  return (
    (inTok * p.input + outTok * p.output + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite) /
    1_000_000
  )
}

export function usageTokens(usage: UsageLike | undefined | null): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
} {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0
  }
}
