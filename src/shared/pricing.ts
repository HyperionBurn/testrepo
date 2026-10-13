// Token usage -> USD. Prices are USD per 1M tokens, matched by substring of the model id.
import type { AgentInfo } from './types'

export type TokenUsage = AgentInfo['tokens'];

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const SONNET: ModelPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }

/** Ordered: the first entry whose `match` is a substring of the lowercased model id wins. */
export const MODEL_PRICES: readonly { match: string; price: ModelPrice }[] = [
  { match: 'opus', price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  { match: 'sonnet', price: SONNET },
  { match: 'haiku', price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  { match: 'gpt-5', price: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } },
  { match: 'codex', price: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } }
]

/** Used when the model is missing or unrecognized. */
export const DEFAULT_PRICE: ModelPrice = SONNET

/** Price table entry for a model id (case-insensitive substring match). Falls back to sonnet. */
export function priceFor(model?: string): ModelPrice {
  if (model) {
    const m = model.toLowerCase()
    for (const entry of MODEL_PRICES) {
      if (m.includes(entry.match)) return entry.price
    }
  }
  return DEFAULT_PRICE
}

function count(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0
}

/** Cost in USD of the given token usage for a model. Negative or non-finite counts count as 0. */
export function costUsd(model: string | undefined, tokens: TokenUsage): number {
  const p = priceFor(model)
  const total =
    count(tokens.input) * p.input +
    count(tokens.output) * p.output +
    count(tokens.cacheRead) * p.cacheRead +
    count(tokens.cacheWrite) * p.cacheWrite
  return total / 1_000_000
}
