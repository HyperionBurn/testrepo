import { app, BrowserWindow, session, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'
import { disposeIpc, registerIpc } from './ipc'
import { createQuitGate } from './quit'
import { denyAllPermissions, installWebContentsGuards } from './security/guards'
import type { AppUrls } from './security/trust'

let mainWindow: BrowserWindow | null = null

// Output: out/renderer/renderer/index.html (see electron.vite.config.ts).
// Dev: ELECTRON_RENDERER_URL is the vite server whose root is src/.
const devUrl = process.env.ELECTRON_RENDERER_URL
const appUrls: AppUrls = {
  devUrl,
  rendererFile: join(__dirname, '../renderer/renderer/index.html'),
  caseInsensitivePaths: process.platform === 'win32'
}

// Registered before any window exists, so the first web contents is guarded too.
installWebContentsGuards(app, appUrls)

function createWindow(): BrowserWindow {
  const options: BrowserWindowConstructorOptions = {
    width: 1360,
    height: 860,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  }
  if (process.platform === 'win32') {
    // Win11 acrylic behind a frameless, hidden-titlebar window with native caption buttons.
    options.backgroundMaterial = 'acrylic'
    options.titleBarStyle = 'hidden'
    options.titleBarOverlay = { color: '#00000000', symbolColor: '#ffffff', height: 44 }
  }

  const win = new BrowserWindow(options)
  win.once('ready-to-show', () => win.show())

  if (devUrl) {
    void win.loadURL(`${devUrl}/renderer/index.html`)
  } else {
    void win.loadFile(appUrls.rendererFile)
  }
  return win
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('app.skyline')
    denyAllPermissions(session.defaultSession)

    // Single window app (Windows target). IPC handlers are registered once, so no 'activate' re-creation here.
    mainWindow = createWindow()
    registerIpc(mainWindow, appUrls)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Quit waits for the LLM's native objects to be freed (see quit.ts). A stuck dispose cannot block quit for long.
  const quitGate = createQuitGate({
    dispose: disposeIpc,
    quit: () => app.quit(),
    timeoutMs: 3000,
    onTimeout: () => console.warn('[skyline] LLM did not finish disposing within 3s; quitting anyway'),
    onError: (err) => console.error('[skyline] LLM dispose failed', err)
  })
  app.on('before-quit', (event) => quitGate.onBeforeQuit(event))
}
