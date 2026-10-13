// Which URLs count as the app itself. Pure: no Electron imports, so the rule is unit-testable.
// Navigation and IPC both use this one rule: the dev server origin, or the packaged renderer file.
import { pathToFileURL } from 'node:url'

export interface AppUrls {
  /** Vite dev server origin in development (ELECTRON_RENDERER_URL). Any URL on this origin is the app. */
  devUrl?: string
  /** Absolute path of the packaged renderer index.html. Only this file under file:// is the app. */
  rendererFile: string
  /** Compare file paths case-insensitively (Windows volumes). Defaults to false. */
  caseInsensitivePaths?: boolean
}

function parse(url: string | undefined | null): URL | undefined {
  if (typeof url !== 'string' || url === '') return undefined
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

/**
 * True when `url` names the app's own page: same origin as the dev server, or the renderer file.
 * Query and fragment are ignored for the file. Anything else (other origins, other files, about:,
 * data:, javascript:, malformed input) is not trusted.
 */
export function isTrustedAppUrl(url: string | undefined | null, app: AppUrls): boolean {
  const u = parse(url)
  if (!u) return false

  if (app.devUrl) {
    const dev = parse(app.devUrl)
    if (dev && (dev.protocol === 'http:' || dev.protocol === 'https:') && u.origin === dev.origin) return true
  }

  if (u.protocol !== 'file:') return false
  const expected = pathToFileURL(app.rendererFile).pathname
  const fold = (p: string): string => (app.caseInsensitivePaths ? p.toLowerCase() : p)
  return fold(u.pathname) === fold(expected)
}

/** http and https only. Used to decide which window.open targets go to the system browser. */
export function isWebUrl(url: string | undefined | null): boolean {
  const u = parse(url)
  return u !== undefined && (u.protocol === 'http:' || u.protocol === 'https:')
}
