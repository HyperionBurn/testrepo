import { beforeAll, describe, expect, it, vi } from 'vitest'
import { pathToFileURL } from 'node:url'
import * as path from 'node:path'
import { IPC } from '../../shared/ipc'
import type { AppUrls } from '../security/trust'

// ipc.ts imports the shared channel names through the '@shared' alias, which only the electron-vite build resolves.
vi.mock('@shared/ipc', () => import('../../shared/ipc'))

// Captures every ipcMain.handle registration so the test can invoke handlers with chosen senders.
const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown> }))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/skyline-test', on: () => undefined },
  BrowserWindow: class {},
  clipboard: { writeImage: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  shell: { showItemInFolder: () => undefined, openExternal: async () => undefined },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      electron.handlers.set(channel, fn)
    }
  }
}))

const rendererFile = path.resolve('/opt/skyline/out/renderer/renderer/index.html')
const urls: AppUrls = { rendererFile }
const trusted = { senderFrame: { url: pathToFileURL(rendererFile).href } }
const untrusted = [
  { senderFrame: { url: 'https://evil.example/' } },
  { senderFrame: { url: 'file:///tmp/other.html' } },
  { senderFrame: null },
  {}
]

function fakeWindow(): unknown {
  return {
    minimize: () => undefined,
    maximize: () => undefined,
    unmaximize: () => undefined,
    isMaximized: () => false,
    close: () => undefined,
    webContents: { id: 1 }
  }
}

describe('IPC sender check', () => {
  beforeAll(async () => {
    const { registerIpc } = await import('../ipc')
    registerIpc(fakeWindow() as never, urls)
  })

  it('registers every invoke channel the shared contract declares', () => {
    for (const channel of Object.values(IPC)) {
      expect(electron.handlers.has(channel), channel).toBe(true)
    }
  })

  it('refuses every channel from an untrusted frame, before the handler body runs', async () => {
    for (const [channel, fn] of electron.handlers) {
      for (const event of untrusted) {
        await expect(Promise.resolve().then(() => fn(event, undefined)), channel).rejects.toThrow(/untrusted page/)
      }
    }
  })

  it('lets the app page through', async () => {
    const getAgents = electron.handlers.get(IPC.getAgents)!
    await expect(Promise.resolve(getAgents(trusted))).resolves.toEqual([])
    const autoOpen = electron.handlers.get(IPC.autoOpen)!
    await expect(Promise.resolve(autoOpen(trusted))).resolves.toBeNull()
  })
})
