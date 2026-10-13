import { describe, expect, it } from 'vitest'
import { collectImportRefs, extractImports, IMPORT_SCAN_MAX_BYTES, resolveImportRefs } from '../imports'

const files = (...paths: string[]): Set<string> => new Set(paths)

function timed(fn: () => unknown): number {
  const start = performance.now()
  fn()
  return performance.now() - start
}

describe('import extraction bounds', () => {
  it('finishes 1MB of "@import " with no ";" well under 200ms', () => {
    const big = '@import '.repeat(Math.ceil((1024 * 1024) / 8))
    const ms = timed(() => extractImports('styles/a.scss', big, files('styles/b.scss')))
    expect(ms).toBeLessThan(200)
  })

  it('stays fast just under the size cap, where the regex itself does the work', () => {
    const under = '@import '.repeat(Math.floor((IMPORT_SCAN_MAX_BYTES - 16) / 8))
    const ms = timed(() => extractImports('styles/a.scss', under, files('styles/b.scss')))
    expect(ms).toBeLessThan(200)
  })

  it('skips import extraction for files over 512KB, even when they contain real imports', () => {
    const padded = "@import './b.css';\n" + ' '.repeat(IMPORT_SCAN_MAX_BYTES)
    expect(extractImports('styles/a.css', padded, files('styles/b.css'))).toEqual([])
    expect(collectImportRefs('styles/a.css', padded)).toEqual([])
  })

  it('still extracts from a file just under the cap', () => {
    const small = "@import './b.css';\n" + ' '.repeat(IMPORT_SCAN_MAX_BYTES - 100)
    expect(extractImports('styles/a.css', small, files('styles/b.css'))).toEqual(['styles/b.css'])
  })

  it('does not match a CSS @import whose statement is longer than 300 characters on one line', () => {
    const long = `@import '${'x'.repeat(400)}';\n@import './b.css';\n`
    expect(extractImports('styles/a.css', long, files('styles/b.css'))).toEqual(['styles/b.css'])
  })
})

describe('collect then resolve', () => {
  it('collects references without the file set, and resolves them later against a complete set', () => {
    const src = "import { a } from './a'\nfrom . import helper\n"
    const refs = collectImportRefs('pkg/main.py', 'from . import helper\n')
    expect(refs.length).toBeGreaterThan(0)
    expect(resolveImportRefs('pkg/main.py', refs, files('pkg/helper.py'))).toEqual(['pkg/helper.py'])
    // Same answer as the one-step API.
    expect(extractImports('pkg/main.py', 'from . import helper\n', files('pkg/helper.py'))).toEqual(['pkg/helper.py'])
    expect(collectImportRefs('src/x.ts', src).every((r) => r.kind === 'js')).toBe(true)
  })

  it('collects no references for languages without import support', () => {
    expect(collectImportRefs('main.go', 'import "fmt"\n')).toEqual([])
  })
})
