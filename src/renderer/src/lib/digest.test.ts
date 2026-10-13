import { describe, expect, it } from 'vitest'
import { isCurrentDigest } from './digest'

describe('isCurrentDigest', () => {
  it('accepts a pushed digest that answers the latest request', () => {
    expect(isCurrentDigest({ requestId: 'r2' }, 'r2')).toBe(true)
  })

  it('drops a late digest that answers an older request', () => {
    expect(isCurrentDigest({ requestId: 'r1' }, 'r2')).toBe(false)
  })

  it('drops everything when no request is in flight or answered yet', () => {
    expect(isCurrentDigest({ requestId: 'r1' }, undefined)).toBe(false)
    expect(isCurrentDigest({}, undefined)).toBe(false)
  })

  it('drops a digest without an id while a request is current', () => {
    expect(isCurrentDigest({}, 'r2')).toBe(false)
  })
})
