import { describe, expect, it } from 'vitest'
import { eventChannel, IPC } from './ipc'

describe('ipc channels', () => {
  it('names invoke channels with the skyline prefix', () => {
    for (const channel of Object.values(IPC)) {
      expect(channel.startsWith('skyline:')).toBe(true)
    }
  })

  it('builds main-to-renderer event channels', () => {
    expect(eventChannel('agents')).toBe('skyline:on:agents')
  })
})
