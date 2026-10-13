import { describe, expect, it } from 'vitest'
import { extractImports } from '../imports'

const files = (...paths: string[]): Set<string> => new Set(paths)

describe('extractImports: JS / TS', () => {
  it('resolves static, export-from, side-effect, dynamic and require forms', () => {
    const fs = files('src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.css', 'src/f.js', 'src/main.ts')
    const src = [
      "import { a } from './a'",
      "import * as b from './b'",
      "export { c } from './c'",
      "export * from './d'",
      "import './e.css'",
      "const f = await import('./f')",
      "const g = require('./a')"
    ].join('\n')
    expect(extractImports('src/main.ts', src, fs)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.css', 'src/f.js'])
  })

  it('handles multi-line import clauses and type-only imports', () => {
    const fs = files('lib/types.ts', 'lib/util.ts')
    const src = "import type {\n  Foo,\n  Bar\n} from '../lib/types'\nimport Def, { util } from './util'"
    expect(extractImports('app/x.tsx', src, fs)).toEqual(['lib/types.ts'])
    expect(extractImports('lib/x.ts', src, fs)).toEqual(['lib/types.ts', 'lib/util.ts'])
  })

  it('tries extensions, then index files', () => {
    const fs = files('src/ui/index.tsx', 'src/lib/helpers.mjs', 'src/app.ts')
    const src = "import ui from './ui'\nimport h from './lib/helpers'"
    expect(extractImports('src/app.ts', src, fs)).toEqual(['src/lib/helpers.mjs', 'src/ui/index.tsx'])
  })

  it('maps TypeScript-style ./x.js specifiers to x.ts on disk', () => {
    const fs = files('src/store.ts', 'src/app.ts')
    expect(extractImports('src/app.ts', "import s from './store.js'", fs)).toEqual(['src/store.ts'])
  })

  it('resolves parent-relative specifiers from nested folders', () => {
    const fs = files('src/shared/types.ts', 'src/main/deep/x.ts')
    expect(extractImports('src/main/deep/x.ts', "import t from '../../shared/types'", fs)).toEqual(['src/shared/types.ts'])
  })

  it('ignores bare package specifiers, missing targets and self imports', () => {
    const fs = files('src/a.ts', 'src/self.ts')
    const src = "import React from 'react'\nimport m from './missing'\nimport s from './self'\nimport a from './a'"
    expect(extractImports('src/self.ts', src, fs)).toEqual(['src/a.ts'])
  })

  it('does not treat a folder name as a module without an index file', () => {
    const fs = files('src/lib/x.ts')
    expect(extractImports('src/app.ts', "import l from './lib'", fs)).toEqual([])
  })

  it('resolves ".", directory index and .js-style specifiers from the repo root and nested folders', () => {
    const fromRoot = files('index.ts', 'util.ts', 'pkg/index.js', 'pkg/mod.tsx')
    expect(extractImports('main.ts', "import i from '.'\nimport u from './util.js'\nimport p from './pkg'", fromRoot)).toEqual([
      'index.ts',
      'pkg/index.js',
      'util.ts'
    ])
    expect(extractImports('pkg/a.ts', "import m from './mod'\nimport x from '../util'", fromRoot)).toEqual([
      'pkg/mod.tsx',
      'util.ts'
    ])
  })
})

describe('extractImports: Python', () => {
  it('resolves relative from-imports, absolute from-imports and plain imports', () => {
    const fs = files('pkg/__init__.py', 'pkg/x.py', 'pkg/a/__init__.py', 'pkg/a/b.py', 'pkg/util.py', 'pkg/sub/__init__.py', 'other/mod.py', 'other/__init__.py', 'pkg/sibling.py')
    const src = [
      'from .a.b import c',
      'from pkg.util import helper',
      'import other.mod',
      'import os, sys',
      'from . import sibling'
    ].join('\n')
    expect(extractImports('pkg/x.py', src, fs)).toEqual(['other/mod.py', 'pkg/a/b.py', 'pkg/sibling.py', 'pkg/util.py'])
  })

  it('resolves a package import to its __init__.py', () => {
    const fs = files('tools/__init__.py', 'app/main.py')
    expect(extractImports('app/main.py', 'import tools', fs)).toEqual(['tools/__init__.py'])
  })

  it('resolves relative to the importing file directory for script-style imports', () => {
    const fs = files('scripts/helpers.py', 'scripts/run.py')
    expect(extractImports('scripts/run.py', 'from helpers import go', fs)).toEqual(['scripts/helpers.py'])
  })

  it('handles parenthesised, aliased and submodule imports', () => {
    const fs = files('pkg/__init__.py', 'pkg/models.py', 'pkg/views.py', 'pkg/api.py')
    const src = 'from pkg import (models as m,\n    views)\nimport pkg.api as api'
    expect(extractImports('main.py', src, fs)).toEqual(['pkg/__init__.py', 'pkg/api.py', 'pkg/models.py', 'pkg/views.py'])
  })

  it('ignores stdlib and unknown modules', () => {
    expect(extractImports('main.py', 'import json\nfrom collections import deque', files('main.py'))).toEqual([])
  })
})

describe('extractImports: CSS / SCSS', () => {
  it('resolves @import with and without extension and Sass partials', () => {
    const fs = files('styles/base.css', 'styles/_vars.scss', 'styles/theme/_dark.scss', 'styles/theme.scss', 'styles/main.scss')
    const src = "@import './base';\n@import 'vars';\n@use \"theme/dark\";\n@forward 'theme';\n@import url(https://fonts.example/x.css);"
    expect(extractImports('styles/main.scss', src, fs)).toEqual([
      'styles/_vars.scss',
      'styles/base.css',
      'styles/theme.scss',
      'styles/theme/_dark.scss'
    ])
  })
})

describe('extractImports: Rust', () => {
  it('resolves mod declarations next to crate roots and inside module folders', () => {
    const fs = files('src/lib.rs', 'src/util.rs', 'src/net.rs', 'src/net/proto.rs', 'src/net/mod.rs', 'src/store/mod.rs', 'src/store/disk.rs')
    expect(extractImports('src/lib.rs', 'pub mod util;\nmod net;\nmod missing;\nmod inline { }', fs)).toEqual(['src/net.rs', 'src/util.rs'])
    expect(extractImports('src/net.rs', 'mod proto;', fs)).toEqual(['src/net/proto.rs'])
    expect(extractImports('src/store/mod.rs', 'pub(crate) mod disk;', fs)).toEqual(['src/store/disk.rs'])
  })
})

describe('extractImports: other languages', () => {
  it('returns nothing for Go and unknown languages', () => {
    const fs = files('cmd/main.go', 'pkg/util.go')
    expect(extractImports('cmd/main.go', 'import "example.com/pkg"', fs)).toEqual([])
    expect(extractImports('README.md', '[x](./other.md)', files('other.md'))).toEqual([])
  })
})
