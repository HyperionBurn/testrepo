import { app, BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'

let mainWindow: BrowserWindow | null = null

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
      sandbox: false
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

  // Output: out/renderer/renderer/index.html (see electron.vite.config.ts).
  // Dev: ELECTRON_RENDERER_URL is the vite server whose root is src/.
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(`${devUrl}/renderer/index.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/renderer/index.html'))
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

    // Single window app (Windows target). IPC handlers are registered once, so no 'activate' re-creation here.
    mainWindow = createWindow()
    registerIpc(mainWindow)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
