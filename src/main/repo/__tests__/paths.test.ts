import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveInside } from '../paths'

const root = path.resolve('skyline-test-root')

describe('resolveInside', () => {
  it('resolves plain repo-relative files', () => {
    expect(resolveInside(root, 'src/main/index.ts')).toBe(path.resolve(root, 'src', 'main', 'index.ts'))
    expect(resolveInside(root, './README.md')).toBe(path.resolve(root, 'README.md'))
  })

  it('allows dots that stay inside the root', () => {
    expect(resolveInside(root, 'src/../README.md')).toBe(path.resolve(root, 'README.md'))
    expect(resolveInside(root, '..hidden')).toBe(path.resolve(root, '..hidden'))
  })

  it('accepts absolute paths only when they are inside the root', () => {
    expect(resolveInside(root, path.resolve(root, 'a.ts'))).toBe(path.resolve(root, 'a.ts'))
    expect(() => resolveInside(root, path.resolve(root, '..', 'secret.txt'))).toThrow(/outside/)
  })

  it.each(['../secret.txt', 'src/../../secret.txt', '../../../../etc/passwd', '..'])(
    'rejects traversal: %s',
    (rel) => {
      expect(() => resolveInside(root, rel)).toThrow(/outside/)
    }
  )

  it('rejects absolute paths outside the root', () => {
    expect(() => resolveInside(root, path.resolve('elsewhere', 'x.txt'))).toThrow()
  })

  it('rejects empty, root-naming, NUL and non-string input', () => {
    expect(() => resolveInside(root, '')).toThrow()
    expect(() => resolveInside(root, '.')).toThrow(/inside/)
    expect(() => resolveInside(root, 'src/../')).toThrow(/inside/)
    expect(() => resolveInside(root, 'a\0b.ts')).toThrow(/Invalid/)
    expect(() => resolveInside(root, undefined as unknown as string)).toThrow()
  })
})
