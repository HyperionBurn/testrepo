import { describe, expect, it } from 'vitest'
import { DEFAULT_PRICE, MODEL_PRICES, type ModelPrice, costUsd, modelLabel, priceFor } from '../pricing'
import type { AgentInfo } from '../types'

type Tokens = AgentInfo['tokens']
const MILLION: Tokens = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }
const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

// One million of each token class costs the sum of the four per-1M prices.
const CASES: { model: string; price: ModelPrice; million: number }[] = [
  { model: 'claude-fable-5-1', price: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }, million: 72.75 },
  { model: 'claude-fable-5', price: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }, million: 72.75 },
  { model: 'claude-mythos-5', price: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }, million: 72.75 },
  { model: 'claude-opus-5-5', price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, million: 29.2 },
  { model: 'claude-opus-5', price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, million: 36.75 },
  { model: 'claude-opus-4-8', price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, million: 36.75 },
  { model: 'claude-opus-4-7', price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, million: 36.75 },
  { model: 'claude-opus-4-6', price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, million: 36.75 },
  { model: 'claude-opus-4-5-20251101', price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, million: 36.75 },
  { model: 'claude-opus-4-1-20250805', price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }, million: 110.25 },
  { model: 'claude-opus-4', price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }, million: 110.25 },
  { model: 'claude-3-opus-20240229', price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }, million: 110.25 },
  { model: 'claude-sonnet-5-5', price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, million: 14.7 },
  { model: 'claude-sonnet-5', price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, million: 14.7 },
  { model: 'claude-sonnet-4-6', price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, million: 22.05 },
  { model: 'claude-sonnet-4-5-20250929', price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, million: 22.05 },
  { model: 'claude-3-7-sonnet-latest', price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, million: 22.05 },
  { model: 'claude-haiku-5-5', price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }, million: 0.735 },
  { model: 'claude-haiku-4-5-20251001', price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, million: 7.35 },
  { model: 'claude-3-5-haiku-latest', price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, million: 7.35 },
  { model: 'gpt-5', price: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }, million: 11.375 },
  { model: 'gpt-5-codex', price: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }, million: 11.375 },
  { model: 'codex-mini', price: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }, million: 11.375 }
]

describe('priceFor', () => {
  it.each(CASES)('$model uses its table row', ({ model, price }) => {
    expect(priceFor(model)).toEqual(price)
  })

  it('checks the most specific pattern first', () => {
    // 'claude-opus-5' is a substring of 'claude-opus-5-5', so the 5.5 row must win.
    expect(priceFor('claude-opus-5-5')).not.toEqual(priceFor('claude-opus-5'))
    expect(priceFor('claude-opus-5-5')).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })
    // Bare 'claude-opus-4' is a substring of the 4.5..4.8 ids, which keep the 5/25 tier.
    expect(priceFor('claude-opus-4-5')).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
    expect(priceFor('claude-fable-5-1')).toEqual(priceFor('claude-fable-5'))
  })

  it('has a unique label for every row', () => {
    const labels = MODEL_PRICES.map((r) => r.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('is case-insensitive', () => {
    expect(priceFor('Claude-OPUS-4')).toEqual(priceFor('claude-opus-4'))
    expect(priceFor('CLAUDE-OPUS-5-5')).toEqual(priceFor('claude-opus-5-5'))
  })

  it('falls back to the Sonnet 5.5 default for missing or unknown models', () => {
    expect(priceFor(undefined)).toBe(DEFAULT_PRICE)
    expect(priceFor('')).toBe(DEFAULT_PRICE)
    expect(priceFor('some-local-model')).toBe(DEFAULT_PRICE)
    expect(DEFAULT_PRICE).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 })
  })
})

describe('costUsd', () => {
  it.each(CASES)('$model prices one million of each token class', ({ model, million }) => {
    expect(costUsd(model, MILLION)).toBeCloseTo(million, 10)
  })

  it('computes small counts exactly', () => {
    const tokens: Tokens = { input: 1234, output: 567, cacheRead: 10_000, cacheWrite: 2_000 }
    // opus 5.5: 1234*4 + 567*20 + 10000*0.2 + 2000*5, all over 1e6
    expect(costUsd('claude-opus-5-5', tokens)).toBeCloseTo(28_276 / 1_000_000, 12)
    // haiku 4.5: 1234*1 + 567*5 + 10000*0.1 + 2000*1.25, all over 1e6
    expect(costUsd('claude-haiku-4-5', tokens)).toBeCloseTo((1234 + 567 * 5 + 1000 + 2500) / 1_000_000, 12)
    // opus 4.1: 1234*15 + 567*75 + 10000*1.5 + 2000*18.75, all over 1e6
    expect(costUsd('claude-opus-4-1', tokens)).toBeCloseTo(0.01851 + 0.042525 + 0.015 + 0.0375, 12)
  })

  it('uses the Sonnet 5.5 default when the model is undefined', () => {
    expect(costUsd(undefined, MILLION)).toBeCloseTo(14.7, 10)
    expect(costUsd('some-local-model', MILLION)).toBeCloseTo(costUsd('claude-sonnet-5-5', MILLION), 12)
  })

  it('is zero for zero tokens', () => {
    expect(costUsd('claude-opus-4', ZERO)).toBe(0)
  })

  it('treats negative and non-finite counts as zero', () => {
    const weird: Tokens = { input: -5, output: Number.NaN, cacheRead: Number.POSITIVE_INFINITY, cacheWrite: 1_000_000 }
    expect(costUsd('claude-haiku-4', weird)).toBeCloseTo(1.25, 12)
  })

  it('is linear in tokens', () => {
    const one: Tokens = { input: 700, output: 300, cacheRead: 5000, cacheWrite: 40 }
    const two: Tokens = { input: 1400, output: 600, cacheRead: 10_000, cacheWrite: 80 }
    expect(costUsd('claude-sonnet-4', two)).toBeCloseTo(2 * costUsd('claude-sonnet-4', one), 12)
  })
})

describe('modelLabel', () => {
  it.each([
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-opus-5', 'Opus 5'],
    ['claude-opus-4-5-20251101', 'Opus 4.5'],
    ['claude-opus-4-1-20250805', 'Opus 4.1'],
    ['claude-opus-4', 'Opus 4'],
    ['claude-3-opus-20240229', 'Opus 3'],
    ['claude-haiku-5-5', 'Haiku 5.5'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['claude-3-5-haiku-latest', 'Haiku 3.5'],
    ['claude-sonnet-5-5', 'Sonnet 5.5'],
    ['claude-sonnet-4-6', 'Sonnet 4.6'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['claude-mythos-5', 'Mythos 5'],
    ['gpt-5-codex', 'GPT 5 Codex'],
    ['gpt-5', 'GPT 5'],
    ['codex-mini', 'Codex'],
    // no version in the id: family name
    ['claude-sonnet-latest', 'Sonnet'],
    ['claude-opus', 'Opus'],
    // unknown family: raw id
    ['some-local-model', 'some-local-model'],
    // missing or empty id
    [undefined, 'Unknown'],
    ['', 'Unknown']
  ])('%s -> %s', (model, label) => {
    expect(modelLabel(model)).toBe(label)
  })
})
