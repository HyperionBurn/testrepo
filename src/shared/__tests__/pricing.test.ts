import { describe, expect, it } from 'vitest'
import { DEFAULT_PRICE, costUsd, priceFor } from '../pricing'
import type { AgentInfo } from '../types'

type Tokens = AgentInfo['tokens']
const MILLION: Tokens = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }
const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

describe('priceFor', () => {
  it('matches model families by substring', () => {
    expect(priceFor('claude-opus-4-1-20250805')).toEqual({ input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 })
    expect(priceFor('claude-sonnet-4-5')).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
    expect(priceFor('claude-haiku-4-5')).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 })
    expect(priceFor('claude-3-5-haiku-latest')).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 })
    expect(priceFor('gpt-5')).toEqual({ input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 })
    expect(priceFor('gpt-5-codex')).toEqual({ input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 })
    expect(priceFor('codex-mini')).toEqual({ input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 })
  })

  it('is case-insensitive', () => {
    expect(priceFor('Claude-OPUS-4')).toEqual(priceFor('claude-opus-4'))
  })

  it('falls back to sonnet for missing or unknown models', () => {
    expect(priceFor(undefined)).toBe(DEFAULT_PRICE)
    expect(priceFor('')).toBe(DEFAULT_PRICE)
    expect(priceFor('some-local-model')).toBe(DEFAULT_PRICE)
    expect(DEFAULT_PRICE).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
  })
})

describe('costUsd', () => {
  it('prices one million of each token class per model', () => {
    expect(costUsd('claude-opus-4', MILLION)).toBeCloseTo(15 + 75 + 1.5 + 18.75, 10)
    expect(costUsd('claude-sonnet-4-5', MILLION)).toBeCloseTo(3 + 15 + 0.3 + 3.75, 10)
    expect(costUsd('claude-haiku-4-5', MILLION)).toBeCloseTo(1 + 5 + 0.1 + 1.25, 10)
    expect(costUsd('gpt-5-codex', MILLION)).toBeCloseTo(1.25 + 10 + 0.125, 10)
  })

  it('computes small counts exactly', () => {
    const tokens: Tokens = { input: 1234, output: 567, cacheRead: 10_000, cacheWrite: 2_000 }
    // opus: 1234*15 + 567*75 + 10000*1.5 + 2000*18.75, all over 1e6
    const expected = (1234 * 15 + 567 * 75 + 10_000 * 1.5 + 2_000 * 18.75) / 1_000_000
    expect(costUsd('claude-opus-4', tokens)).toBeCloseTo(expected, 12)
    expect(costUsd('claude-opus-4', tokens)).toBeCloseTo(0.01851 + 0.042525 + 0.015 + 0.0375, 12)
  })

  it('uses the sonnet default when the model is undefined', () => {
    expect(costUsd(undefined, MILLION)).toBeCloseTo(costUsd('claude-sonnet-4', MILLION), 12)
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
