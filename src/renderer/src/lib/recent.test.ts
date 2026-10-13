import { describe, expect, it } from 'vitest'
import { parentLabel, recentWithoutActivity, repoKey } from './recent'

describe('parentLabel', () => {
  it('keeps the full parent folder with its leading slash', () => {
    expect(parentLabel('/home/user/testrepo')).toBe('/home/user')
    expect(parentLabel('/home/user/testrepo/')).toBe('/home/user')
  })

  it('keeps Windows drive paths and separators', () => {
    expect(parentLabel('C:\\dev\\app')).toBe('C:\\dev')
    expect(parentLabel('C:\\app')).toBe('C:\\')
  })

  it('shows the root for a top-level folder on POSIX', () => {
    expect(parentLabel('/app')).toBe('/')
  })

  it('returns nothing when there is no parent', () => {
    expect(parentLabel('app')).toBe('')
    expect(parentLabel('/')).toBe('')
  })

  it('shortens a long parent in the middle', () => {
    expect(parentLabel('/Users/someone/projects/clients/acme-corp/internal/tools/skyline', 24)).toBe(
      '/Users/someon…rnal/tools'
    )
  })
})

describe('repoKey', () => {
  it('ignores trailing slashes and the separator style', () => {
    expect(repoKey('/work/app/')).toBe(repoKey('/work/app'))
    expect(repoKey('C:\\dev\\app')).toBe(repoKey('C:/dev/app/'))
  })

  it('folds case for Windows drive paths only', () => {
    expect(repoKey('C:\\Dev\\App')).toBe('c:/dev/app')
    expect(repoKey('/Work/App')).toBe('/Work/App')
  })
})

describe('recentWithoutActivity', () => {
  it('drops recent repos that the activity list already shows', () => {
    const recent = ['/work/app', '/work/lib', '/work/tool']
    const activity = [{ cwd: '/work/lib' }]
    expect(recentWithoutActivity(recent, activity)).toEqual(['/work/app', '/work/tool'])
  })

  it('matches activity directories written with a trailing slash or Windows separators', () => {
    const recent = ['C:\\dev\\app', '/work/lib/']
    const activity = [{ cwd: 'C:/dev/app/' }, { cwd: '/work/lib' }]
    expect(recentWithoutActivity(recent, activity)).toEqual([])
  })

  it('keeps every recent repo when there is no activity, and keeps stored order', () => {
    expect(recentWithoutActivity(['/b', '/a'], [])).toEqual(['/b', '/a'])
  })

  it('lists each repo once', () => {
    expect(recentWithoutActivity(['/a', '/a/', '/b'], [])).toEqual(['/a', '/b'])
  })

  it('ignores blank entries', () => {
    expect(recentWithoutActivity(['  ', '/a'], [{ cwd: '' }])).toEqual(['/a'])
  })
})
