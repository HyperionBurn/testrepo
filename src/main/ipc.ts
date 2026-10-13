import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'

/** Wires ipcMain handlers. Called once, after the main window is created. */
export function registerIpc(win: BrowserWindow): void {
  // Window chrome (custom titlebar buttons)
  ipcMain.handle(IPC.winMin, () => {
    win.minimize()
  })
  ipcMain.handle(IPC.winMax, () => {
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle(IPC.winClose, () => {
    win.close()
  })

  ipcMain.handle(IPC.pickFolder, async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // TODO: implement these (repo/scan.ts, repo/git.ts, agents/hub.ts, llm/local.ts, store.ts).
  // Registered as stubs so the renderer gets a clear error instead of "no handler registered".
  const stubs = [
    IPC.openRepo,
    IPC.getAgents,
    IPC.getEvents,
    IPC.getHistory,
    IPC.readFile,
    IPC.dispatch,
    IPC.stopAgent,
    IPC.llmStatus,
    IPC.llmDownload,
    IPC.digest,
    IPC.explain,
    IPC.getSettings
  ]
  for (const channel of stubs) {
    ipcMain.handle(channel, () => {
      throw new Error(`not implemented: ${channel}`)
    })
  }
}
