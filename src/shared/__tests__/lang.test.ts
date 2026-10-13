import { describe, expect, it } from 'vitest'
import { IGNORED_DIRS, LANG_COLORS, LANG_IDS, LANG_LABEL, isProbablyBinary, langFromPath } from '../lang'

describe('langFromPath', () => {
  it.each([
    ['src/App.tsx', 'ts'],
    ['src/index.ts', 'ts'],
    ['lib/x.mts', 'ts'],
    ['src/App.jsx', 'js'],
    ['scripts/build.mjs', 'js'],
    ['scripts/build.cjs', 'js'],
    ['main.py', 'py'],
    ['stubs/mod.pyi', 'py'],
    ['src/lib.rs', 'rs'],
    ['cmd/main.go', 'go'],
    ['src/Main.java', 'java'],
    ['Program.cs', 'cs'],
    ['src/engine.cpp', 'cpp'],
    ['include/engine.hpp', 'cpp'],
    ['include/engine.h', 'c'],
    ['src/main.c', 'c'],
    ['app/models/user.rb', 'rb'],
    ['index.php', 'php'],
    ['App/View.swift', 'swift'],
    ['app/Main.kt', 'kt'],
    ['styles/app.css', 'css'],
    ['styles/app.scss', 'css'],
    ['index.html', 'html'],
    ['src/Card.vue', 'html'],
    ['README.md', 'md'],
    ['docs/guide.mdx', 'md'],
    ['tsconfig.json', 'json'],
    ['config/app.jsonc', 'json'],
    ['ci.yml', 'yaml'],
    ['config.yaml', 'yaml'],
    ['scripts/setup.sh', 'sh'],
    ['scripts/setup.ps1', 'sh'],
    ['db/schema.sql', 'sql'],
    ['LICENSE', 'other'],
    ['Makefile', 'other'],
    ['.gitignore', 'other'],
    ['photo.raw', 'other']
  ] as const)('maps %s to %s', (path, lang) => {
    expect(langFromPath(path)).toBe(lang)
  })

  it('is case-insensitive on the extension', () => {
    expect(langFromPath('SRC/APP.TSX')).toBe('ts')
    expect(langFromPath('notes/README.MD')).toBe('md')
  })

  it('accepts Windows separators and dotted directory names', () => {
    expect(langFromPath('C:\\dev\\app\\lib.rs')).toBe('rs')
    expect(langFromPath('.github/workflows/ci.yml')).toBe('yaml')
    expect(langFromPath('v1.2/readme')).toBe('other')
  })

  it('does not resolve Object.prototype keys as languages', () => {
    expect(langFromPath('weird.constructor')).toBe('other')
    expect(langFromPath('weird.__proto__')).toBe('other')
  })
})

describe('LANG_COLORS and LANG_LABEL', () => {
  it('covers every language with a hex color and a label', () => {
    for (const lang of LANG_IDS) {
      expect(LANG_COLORS[lang]).toMatch(/^#[0-9A-Fa-f]{6}$/)
      expect(LANG_LABEL[lang].length).toBeGreaterThan(0)
    }
    expect(new Set(LANG_IDS).size).toBe(21)
  })

  it('keeps the signature colors from the spec', () => {
    expect(LANG_COLORS.ts).toBe('#3B82F6')
    expect(LANG_COLORS.md).toBe('#F1F5F9')
  })
})

describe('isProbablyBinary', () => {
  it.each([
    'assets/logo.png',
    'assets/PHOTO.JPG',
    'fonts/inter.woff2',
    'dist.zip',
    'release.tar.gz',
    'media/clip.mp4',
    'native/addon.node',
    'lib/libfoo.so',
    'docs/spec.pdf',
    'package-lock.json',
    'frontend/yarn.lock',
    'pnpm-lock.yaml',
    'Cargo.lock',
    'go.sum'
  ])('treats %s as skip', (path) => {
    expect(isProbablyBinary(path)).toBe(true)
  })

  it.each([
    'src/index.ts',
    'README.md',
    'package.json',
    'config/app.yaml',
    'Makefile',
    '.gitignore'
  ])('treats %s as text', (path) => {
    expect(isProbablyBinary(path)).toBe(false)
  })
})

describe('IGNORED_DIRS', () => {
  it('lists the standard build and VCS directories', () => {
    expect(IGNORED_DIRS).toEqual([
      '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', 'venv', '.venv',
      '__pycache__', 'target', '.turbo', '.cache', 'coverage', 'release'
    ])
  })
})
