import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ openExternal: vi.fn(async () => undefined) }))
vi.mock('electron', () => ({ shell: { openExternal: electron.openExternal } }))

import { denyAllPermissions, guardWebContents } from '../guards'
import type { AppUrls } from '../trust'

const rendererFile = path.resolve('/opt/skyline/out/renderer/renderer/index.html')
const urls: AppUrls = { rendererFile }
const appUrl = pathToFileURL(rendererFile).href

type Listener = (event: { preventDefault: () => void }, url: string) => void

function fakeContents() {
  const listeners = new Map<string, Listener>()
  let openHandler: ((details: { url: string }) => { action: string }) | undefined
  return {
    on: (name: string, fn: Listener) => listeners.set(name, fn),
    setWindowOpenHandler: (fn: typeof openHandler) => {
      openHandler = fn
    },
    open: (url: string) => openHandler!({ url }),
    emit: (name: string, url: string) => {
      const event = { prevented: false, preventDefault() { this.prevented = true } }
      listeners.get(name)!(event, url)
      return event.prevented
    }
  }
}

describe('guardWebContents', () => {
  beforeEach(() => electron.openExternal.mockClear())

  it('blocks top-level navigation away from the app and allows the app page', () => {
    const c = fakeContents()
    guardWebContents(c as never, urls)
    expect(c.emit('will-navigate', 'https://example.com/')).toBe(true)
    expect(c.emit('will-navigate', 'file:///etc/passwd')).toBe(true)
    expect(c.emit('will-navigate', appUrl)).toBe(false)
  })

  it('denies every window.open, and sends web links to the system browser only', () => {
    const c = fakeContents()
    guardWebContents(c as never, urls)
    expect(c.open('https://github.com/x')).toEqual({ action: 'deny' })
    expect(electron.openExternal).toHaveBeenCalledWith('https://github.com/x')
    expect(c.open('file:///etc/passwd')).toEqual({ action: 'deny' })
    expect(c.open('javascript:alert(1)')).toEqual({ action: 'deny' })
    expect(electron.openExternal).toHaveBeenCalledTimes(1)
  })

  it('refuses to attach a webview', () => {
    const c = fakeContents()
    guardWebContents(c as never, urls)
    expect(c.emit('will-attach-webview', 'anything')).toBe(true)
  })
})

describe('denyAllPermissions', () => {
  it('answers every request with no and every check with false', () => {
    let requestHandler: ((wc: unknown, perm: string, cb: (ok: boolean) => void) => void) | undefined
    let checkHandler: (() => boolean) | undefined
    const ses = {
      setPermissionRequestHandler: (fn: typeof requestHandler) => {
        requestHandler = fn
      },
      setPermissionCheckHandler: (fn: typeof checkHandler) => {
        checkHandler = fn
      }
    }
    denyAllPermissions(ses as never)
    const answers: boolean[] = []
    for (const perm of ['media', 'geolocation', 'clipboard-sanitized-write', 'notifications']) {
      requestHandler!(undefined, perm, (ok) => answers.push(ok))
    }
    expect(answers).toEqual([false, false, false, false])
    expect(checkHandler!()).toBe(false)
  })
})
