// Electron wiring for the app's trust boundary. The rules themselves live in trust.ts.
import { shell, type App, type Session, type WebContents } from 'electron'
import { isTrustedAppUrl, isWebUrl, type AppUrls } from './trust'

/**
 * Locks down every web contents the app creates (the main window, devtools, any future window):
 * - top-level navigation is allowed only to the app's own page, so a link or dropped file cannot replace the UI;
 * - window.open never opens a window; http(s) targets go to the system browser instead;
 * - <webview> tags are refused.
 */
export function guardWebContents(contents: WebContents, urls: AppUrls): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedAppUrl(url, urls)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}

/** Installs the guard on every web contents created from now on. Call before the first window is created. */
export function installWebContentsGuards(app: App, urls: AppUrls): void {
  app.on('web-contents-created', (_event, contents) => guardWebContents(contents, urls))
}

/** The app asks for no browser permissions (camera, mic, geolocation, notifications, clipboard reads...). Deny them all. */
export function denyAllPermissions(ses: Session): void {
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
}
