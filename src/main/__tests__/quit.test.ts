import { describe, expect, it } from 'vitest'
import { createQuitGate } from '../quit'

/** A before-quit event that records whether the handler held the quit. */
function quitEvent(): { event: { preventDefault: () => void }; held: () => boolean } {
  let prevented = false
  return { event: { preventDefault: () => (prevented = true) }, held: () => prevented }
}

/** A promise the test resolves by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('createQuitGate', () => {
  it('holds the first quit, disposes once, then quits again and lets that quit through', async () => {
    let disposes = 0
    let quits = 0
    const d = deferred()
    const gate = createQuitGate({
      dispose: () => {
        disposes++
        return d.promise
      },
      quit: () => quits++,
      timeoutMs: 1000
    })

    const first = quitEvent()
    gate.onBeforeQuit(first.event)
    expect(first.held()).toBe(true)
    expect(gate.phase()).toBe('disposing')
    expect(disposes).toBe(1)
    expect(quits).toBe(0)

    d.resolve()
    await tick()
    expect(quits).toBe(1)
    expect(gate.phase()).toBe('done')

    // The app's own second quit, triggered by quit(): it must not be held again.
    const second = quitEvent()
    gate.onBeforeQuit(second.event)
    expect(second.held()).toBe(false)
    expect(disposes).toBe(1)
  })

  it('holds a quit that arrives during cleanup without starting a second cleanup', async () => {
    let disposes = 0
    const d = deferred()
    const gate = createQuitGate({
      dispose: () => {
        disposes++
        return d.promise
      },
      quit: () => undefined,
      timeoutMs: 1000
    })
    gate.onBeforeQuit(quitEvent().event)
    const during = quitEvent()
    gate.onBeforeQuit(during.event)
    expect(during.held()).toBe(true)
    expect(disposes).toBe(1)
    d.resolve()
    await tick()
  })

  it('quits anyway when dispose does not finish within the timeout', async () => {
    let quits = 0
    const timedOut: string[] = []
    const gate = createQuitGate({
      dispose: () => new Promise<void>(() => undefined), // never settles
      quit: () => quits++,
      timeoutMs: 20,
      onTimeout: () => timedOut.push('timeout')
    })
    gate.onBeforeQuit(quitEvent().event)
    await new Promise((r) => setTimeout(r, 80))
    expect(quits).toBe(1)
    expect(timedOut).toEqual(['timeout'])
    expect(gate.phase()).toBe('done')
  })

  it('still quits when dispose fails, and reports the error', async () => {
    let quits = 0
    const errors: unknown[] = []
    const boom = new Error('native teardown failed')
    const gate = createQuitGate({
      dispose: () => Promise.reject(boom),
      quit: () => quits++,
      timeoutMs: 1000,
      onError: (err) => errors.push(err)
    })
    gate.onBeforeQuit(quitEvent().event)
    await tick()
    expect(errors).toEqual([boom])
    expect(quits).toBe(1)
  })

  it('does not hold quit when dispose throws synchronously, and still quits', async () => {
    let quits = 0
    const gate = createQuitGate({
      dispose: () => {
        throw new Error('sync failure')
      },
      quit: () => quits++,
      timeoutMs: 1000,
      onError: () => undefined
    })
    gate.onBeforeQuit(quitEvent().event)
    await tick()
    expect(quits).toBe(1)
    const again = quitEvent()
    gate.onBeforeQuit(again.event)
    expect(again.held()).toBe(false)
  })
})
