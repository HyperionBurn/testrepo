import { describe, expect, it } from 'vitest'
import { middleEllipsisDir } from './format'

describe('middleEllipsisDir', () => {
  it('returns short directories unchanged', () => {
    expect(middleEllipsisDir('src/hud', 24)).toBe('src/hud')
    expect(middleEllipsisDir('src/renderer/src/hud', 24)).toBe('src/renderer/src/hud')
  })

  it('keeps the first segment and the deepest segments, eliding the middle', () => {
    expect(middleEllipsisDir('src/renderer/src/hud', 14)).toBe('src/…/src/hud')
    expect(middleEllipsisDir('src/renderer/src/state/store/slices', 20)).toBe('src/…/store/slices')
  })

  it('never drops the first segment or the deepest segment', () => {
    const dirs = ['src/a/b/c/d/e/f/g/h', 'packages/electron-app/src/renderer/components/very-long-folder-name']
    for (const dir of dirs) {
      for (const max of [4, 10, 16, 24]) {
        const out = middleEllipsisDir(dir, max)
        const parts = dir.split('/')
        expect(out.startsWith(`${parts[0]}/`)).toBe(true)
        expect(out.endsWith(`/${parts[parts.length - 1]}`)).toBe(true)
      }
    }
  })

  it('leaves a single segment alone, since there is nothing to elide', () => {
    expect(middleEllipsisDir('a-very-long-single-directory-name', 8)).toBe('a-very-long-single-directory-name')
  })

  it('keeps a leading slash and handles Windows separators', () => {
    expect(middleEllipsisDir('/home/user/work/app/src', 15)).toBe('/home/…/app/src')
    expect(middleEllipsisDir('C:\\dev\\skyline\\src\\renderer', 14)).toBe('C:/…/renderer')
  })
})
