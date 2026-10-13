// Token usage -> USD. Prices are USD per 1M tokens, matched by substring of the model id.
import type { AgentInfo } from './types'

export type TokenUsage = AgentInfo['tokens'];

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const FABLE: ModelPrice = { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }
const OPUS_5_5: ModelPrice = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }
const OPUS_4_5: ModelPrice = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
const OPUS_OLD: ModelPrice = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }
const SONNET_5_5: ModelPrice = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }
const SONNET_4: ModelPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
const HAIKU_5_5: ModelPrice = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }
const HAIKU_4_5: ModelPrice = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }
const GPT_5: ModelPrice = { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }

/**
 * Ordered: the first entry whose `match` is a substring of the lowercased model id wins.
 * More specific patterns must come before the ones they contain (e.g. 'opus-5-5' before 'opus-5',
 * 'opus-4-5' before the bare 'claude-opus-4').
 */
export const MODEL_PRICES: readonly { match: string; label: string; price: ModelPrice }[] = [
  { match: 'fable-5-1', label: 'Fable 5.1', price: FABLE },
  { match: 'fable-5', label: 'Fable 5', price: FABLE },
  { match: 'mythos-5', label: 'Mythos 5', price: FABLE },
  { match: 'opus-5-5', label: 'Opus 5.5', price: OPUS_5_5 },
  { match: 'opus-5', label: 'Opus 5', price: OPUS_4_5 },
  { match: 'opus-4-8', label: 'Opus 4.8', price: OPUS_4_5 },
  { match: 'opus-4-7', label: 'Opus 4.7', price: OPUS_4_5 },
  { match: 'opus-4-6', label: 'Opus 4.6', price: OPUS_4_5 },
  { match: 'opus-4-5', label: 'Opus 4.5', price: OPUS_4_5 },
  { match: 'opus-4-1', label: 'Opus 4.1', price: OPUS_OLD },
  { match: 'claude-opus-4', label: 'Opus 4', price: OPUS_OLD },
  { match: 'opus', label: 'Opus', price: OPUS_OLD },
  { match: 'sonnet-5-5', label: 'Sonnet 5.5', price: SONNET_5_5 },
  { match: 'sonnet-5', label: 'Sonnet 5', price: SONNET_5_5 },
  { match: 'sonnet-4', label: 'Sonnet 4', price: SONNET_4 },
  { match: 'sonnet', label: 'Sonnet', price: SONNET_4 },
  { match: 'haiku-5-5', label: 'Haiku 5.5', price: HAIKU_5_5 },
  { match: 'haiku-4-5', label: 'Haiku 4.5', price: HAIKU_4_5 },
  { match: 'haiku', label: 'Haiku', price: HAIKU_4_5 },
  { match: 'gpt-5', label: 'GPT 5', price: GPT_5 },
  { match: 'codex', label: 'Codex', price: GPT_5 }
]

/** Used when the model is missing or unrecognized (Sonnet 5.5 pricing). */
export const DEFAULT_PRICE: ModelPrice = SONNET_5_5

/** Price table entry for a model id (case-insensitive substring match). Falls back to DEFAULT_PRICE. */
export function priceFor(model?: string): ModelPrice {
  if (model) {
    const m = model.toLowerCase()
    for (const entry of MODEL_PRICES) {
      if (m.includes(entry.match)) return entry.price
    }
  }
  return DEFAULT_PRICE
}

const FAMILY_ORDER = ['fable', 'mythos', 'opus', 'sonnet', 'haiku', 'gpt', 'codex'] as const
const FAMILY_NAME: Record<(typeof FAMILY_ORDER)[number], string> = {
  fable: 'Fable',
  mythos: 'Mythos',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  gpt: 'GPT',
  codex: 'Codex'
}

/** Version from ids like 'claude-opus-4-5-20251001' (-> '4.5'), 'claude-3-5-haiku-latest' (-> '3.5'), 'gpt-5-codex' (-> '5'). */
function versionOf(m: string, family: string): string | undefined {
  const after = new RegExp(`${family}[-_ ]?(\\d{1,2})(?!\\d)(?:[-.](\\d{1,2})(?!\\d))?`).exec(m)
  const before = new RegExp(`^claude-(\\d{1,2})(?!\\d)(?:[-.](\\d{1,2})(?!\\d))?[-_ ]${family}`).exec(m)
  const hit = after ?? before
  if (!hit) return undefined
  return hit[2] ? `${hit[1]}.${hit[2]}` : hit[1]
}

/**
 * Short friendly name for a model id, e.g. 'Opus 5.5', 'Haiku 4.5', 'Sonnet 4.6'.
 * Falls back to the family name when no version is present, and to the raw id when
 * the family is unknown. A missing or empty id gives 'Unknown'.
 */
export function modelLabel(model?: string): string {
  const id = model?.trim() ?? ''
  if (!id) return 'Unknown'
  const m = id.toLowerCase()
  const family = FAMILY_ORDER.find((f) => m.includes(f))
  if (!family) return id
  const version = versionOf(m, family)
  let label = version ? `${FAMILY_NAME[family]} ${version}` : FAMILY_NAME[family]
  if (family === 'gpt' && m.includes('codex')) label += ' Codex'
  return label
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
