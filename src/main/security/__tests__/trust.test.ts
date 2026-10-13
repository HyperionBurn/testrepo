import { pathToFileURL } from 'node:url'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTrustedAppUrl, isWebUrl } from '../trust'

const rendererFile = path.resolve('/opt/skyline/out/renderer/renderer/index.html')
const rendererUrl = pathToFileURL(rendererFile).href
const dev = 'http://localhost:5173'

describe('isTrustedAppUrl (packaged app)', () => {
  const app = { rendererFile }

  it('trusts the renderer file, with or without query and fragment', () => {
    expect(isTrustedAppUrl(rendererUrl, app)).toBe(true)
    expect(isTrustedAppUrl(rendererUrl + '?x=1#top', app)).toBe(true)
  })

  it('rejects other files, including neighbours in the same folder', () => {
    expect(isTrustedAppUrl(pathToFileURL(path.join(path.dirname(rendererFile), 'other.html')).href, app)).toBe(false)
    expect(isTrustedAppUrl(pathToFileURL(path.resolve('/etc/passwd')).href, app)).toBe(false)
    expect(isTrustedAppUrl(rendererUrl + '/../../main/index.js', app)).toBe(false)
  })

  it('rejects web origins when there is no dev server', () => {
    expect(isTrustedAppUrl('https://example.com/', app)).toBe(false)
    expect(isTrustedAppUrl('http://localhost:5173/renderer/index.html', app)).toBe(false)
  })

  it('rejects non-document schemes and garbage', () => {
    for (const url of ['about:blank', 'data:text/html,hi', 'javascript:alert(1)', 'devtools://devtools/x', '', 'not a url']) {
      expect(isTrustedAppUrl(url, app)).toBe(false)
    }
    expect(isTrustedAppUrl(undefined, app)).toBe(false)
    expect(isTrustedAppUrl(null, app)).toBe(false)
  })

  it('rejects a file:// URL whose path is a prefix or extension of the renderer file', () => {
    expect(isTrustedAppUrl(rendererUrl + 'x', app)).toBe(false)
    expect(isTrustedAppUrl(rendererUrl.replace('index.html', 'index.htm'), app)).toBe(false)
  })
})

describe('isTrustedAppUrl (development)', () => {
  const app = { devUrl: dev, rendererFile }

  it('trusts the dev server origin, any path on it', () => {
    expect(isTrustedAppUrl(`${dev}/renderer/index.html`, app)).toBe(true)
    expect(isTrustedAppUrl(`${dev}/@vite/client`, app)).toBe(true)
  })

  it('does not trust other ports, hosts or schemes on the same host', () => {
    expect(isTrustedAppUrl('http://localhost:5174/renderer/index.html', app)).toBe(false)
    expect(isTrustedAppUrl('https://localhost:5173/renderer/index.html', app)).toBe(false)
    expect(isTrustedAppUrl('http://evil.localhost:5173/', app)).toBe(false)
    expect(isTrustedAppUrl('http://localhost.evil.com:5173/', app)).toBe(false)
  })

  it('still trusts the packaged file while a dev URL is set', () => {
    expect(isTrustedAppUrl(rendererUrl, app)).toBe(true)
  })

  it('ignores a malformed dev URL instead of trusting everything', () => {
    expect(isTrustedAppUrl('http://localhost:5173/', { devUrl: 'nonsense', rendererFile })).toBe(false)
    expect(isTrustedAppUrl('file:///x', { devUrl: 'file:///x', rendererFile })).toBe(false)
  })
})

describe('isTrustedAppUrl (case handling)', () => {
  it('compares paths exactly by default', () => {
    const upper = rendererUrl.replace('index.html', 'INDEX.html')
    expect(isTrustedAppUrl(upper, { rendererFile })).toBe(false)
  })

  it('folds case when asked (Windows volumes)', () => {
    const upper = rendererUrl.replace('index.html', 'INDEX.html')
    expect(isTrustedAppUrl(upper, { rendererFile, caseInsensitivePaths: true })).toBe(true)
  })
})

describe('isWebUrl', () => {
  it('accepts http and https only', () => {
    expect(isWebUrl('https://github.com/x')).toBe(true)
    expect(isWebUrl('http://example.com')).toBe(true)
    expect(isWebUrl('file:///etc/passwd')).toBe(false)
    expect(isWebUrl('javascript:alert(1)')).toBe(false)
    expect(isWebUrl('mailto:a@b.c')).toBe(false)
    expect(isWebUrl('')).toBe(false)
  })
})
