import { describe, expect, it } from 'vitest'
import { EVENT_CHANNELS, eventChannel, IPC } from './ipc'

describe('ipc channels', () => {
  it('names invoke channels with the skyline prefix', () => {
    for (const channel of Object.values(IPC)) {
      expect(channel.startsWith('skyline:')).toBe(true)
    }
  })

  it('builds main-to-renderer event channels', () => {
    expect(eventChannel('agents')).toBe('skyline:on:agents')
  })

  it('lists the digest and history event channels and builds their names', () => {
    expect(EVENT_CHANNELS).toEqual(expect.arrayContaining(['digest', 'history']))
    expect(eventChannel('digest')).toBe('skyline:on:digest')
    expect(eventChannel('history')).toBe('skyline:on:history')
  })

  it('has an invoke channel for listSessions', () => {
    expect(IPC.listSessions).toBe('skyline:listSessions')
  })
})
