// Best-effort import extraction. Regex based on purpose: no parser, no crashes on odd input.
// Every specifier is resolved to a repo-relative file path that exists in `fileSet`; the rest is dropped.
//
// Two steps, so a scan never has to hold every file's text at once:
//   collectImportRefs  reads one file's text and keeps only the raw references (small strings);
//   resolveImportRefs  matches those references against the full file set, once every file is known.
import { posix } from 'node:path'
import { langFromPath } from '../../shared/lang'
import type { Lang } from '../../shared/types'

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts']
const CSS_EXTS = ['.css', '.scss', '.sass', '.less']
const RS_CRATE_ROOTS = new Set(['mod.rs', 'lib.rs', 'main.rs'])

/** Files larger than this carry no import references. Generated bundles and lockfiles are not worth the regex time. */
export const IMPORT_SCAN_MAX_BYTES = 512 * 1024

/** A reference as written in the source, before it is matched against the repo's files. */
export type ImportRef =
  | { kind: 'js'; dir: string; spec: string }
  | { kind: 'css'; dir: string; spec: string }
  | { kind: 'py'; dir: string; parts: string[] }
  | { kind: 'rs'; name: string }

/** Languages whose files carry import statements worth parsing. */
export function hasImportSupport(lang: Lang): boolean {
  return lang === 'ts' || lang === 'js' || lang === 'py' || lang === 'css' || lang === 'rs'
}

/**
 * Repo-relative paths that `content` (of file `rel`) imports, existing in `fileSet`.
 * Deduplicated, sorted, never contains `rel` itself.
 */
export function extractImports(rel: string, content: string, fileSet: ReadonlySet<string>): string[] {
  return resolveImportRefs(rel, collectImportRefs(rel, content), fileSet)
}

/** Raw import references of one file. Empty for languages without import support, and for oversized files. */
export function collectImportRefs(rel: string, content: string): ImportRef[] {
  if (Buffer.byteLength(content, 'utf8') > IMPORT_SCAN_MAX_BYTES) return []
  const lang = langFromPath(rel)
  const dir = posix.dirname(rel)
  const refs: ImportRef[] = []
  if (lang === 'ts' || lang === 'js') {
    for (const spec of jsSpecifiers(content)) {
      if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
        refs.push({ kind: 'js', dir, spec })
      }
    }
  } else if (lang === 'py') {
    refs.push(...pythonRefs(rel, content))
  } else if (lang === 'css') {
    for (const spec of cssSpecifiers(content)) refs.push({ kind: 'css', dir, spec })
  } else if (lang === 'rs') {
    for (const name of rustModules(content)) refs.push({ kind: 'rs', name })
  }
  // Go and everything else: no import resolution.
  return refs
}

/** Matches collected references against the repo's files. Deduplicated, sorted, never contains `rel` itself. */
export function resolveImportRefs(rel: string, refs: readonly ImportRef[], fileSet: ReadonlySet<string>): string[] {
  const found = new Set<string>()
  const add = (target: string | undefined): void => {
    if (target && target !== rel && fileSet.has(target)) found.add(target)
  }
  for (const ref of refs) {
    switch (ref.kind) {
      case 'js':
        add(resolveJs(ref.dir, ref.spec, fileSet))
        break
      case 'css':
        add(resolveCss(ref.dir, ref.spec, fileSet))
        break
      case 'py':
        add(pyModule(ref.dir, ref.parts, fileSet))
        break
      case 'rs':
        add(resolveRust(rel, ref.name, fileSet))
        break
    }
  }
  return [...found].sort()
}

// ---- JS / TS ---------------------------------------------------------------

function jsSpecifiers(src: string): string[] {
  const out: string[] = []
  const patterns: RegExp[] = [
    // import x from 'y' · export * from 'y' · import type {A} from 'y' (bounded, stops at ; and quotes)
    /\b(?:import|export)\b[^;'"`]{0,300}?\bfrom\s*['"]([^'"\n]+)['"]/g,
    // side-effect import 'y'
    /\bimport\s*['"]([^'"\n]+)['"]/g,
    // import('y')
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    // require('y')
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g
  ]
  for (const re of patterns) {
    for (const m of src.matchAll(re)) out.push(m[1])
  }
  return out
}

function resolveJs(dir: string, spec: string, fileSet: ReadonlySet<string>): string | undefined {
  // The target is normalized once; every candidate below is built from it by appending an extension, so it
  // is checked as is. Normalizing each candidate made import resolution the main cost of a large scan.
  const target = trimSlash(posix.normalize(posix.join(dir, spec)))
  const hit = (p: string): string | undefined => (p !== '' && fileSet.has(p) ? p : undefined)
  let found = hit(target)
  if (found !== undefined) return found
  for (const ext of JS_EXTS) {
    found = hit(target + ext)
    if (found !== undefined) return found
  }
  // TS convention: './util.js' refers to './util.ts' on disk.
  const stripped = /\.(m|c)?jsx?$/.exec(target)
  if (stripped) {
    const stem = target.slice(0, -stripped[0].length)
    for (const ext of JS_EXTS) {
      found = hit(stem + ext)
      if (found !== undefined) return found
    }
  }
  const index = posix.join(target, 'index')
  for (const ext of JS_EXTS) {
    found = hit(index + ext)
    if (found !== undefined) return found
  }
  return undefined
}

// ---- Python ----------------------------------------------------------------

/** Lookups for every module a Python file names. Each lookup is {dir, parts}, resolved later by pyModule. */
function pythonRefs(rel: string, src: string): ImportRef[] {
  const out: ImportRef[] = []
  const fileDir = posix.dirname(rel)
  const py = (dir: string, parts: string[]): void => {
    out.push({ kind: 'py', dir, parts })
  }

  for (const m of src.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]*)/gm)) {
    const dots = m[1].length
    const parts = m[2] ? m[2].split('.') : []
    const names = pyNames(m[3])
    if (dots > 0) {
      let base = fileDir
      for (let i = 1; i < dots; i++) base = posix.dirname(base)
      if (parts.length > 0) py(base, parts)
      else for (const n of names) py(base, [n])
      for (const n of names) if (parts.length > 0) py(base, [...parts, n])
    } else if (parts.length > 0) {
      // Absolute import: repo root first, then the importing file's directory (script-style imports).
      py('', parts)
      py(fileDir, parts)
      // "from pkg import submodule" also resolves when submodule is a file.
      for (const n of names) {
        py('', [...parts, n])
        py(fileDir, [...parts, n])
      }
    }
  }

  for (const m of src.matchAll(/^[ \t]*import[ \t]+([^\n#]+)/gm)) {
    for (const item of m[1].split(',')) {
      const mod = item.trim().replace(/\s+as\s+\w+$/, '').trim()
      if (!/^[A-Za-z_][\w.]*$/.test(mod)) continue
      const parts = mod.split('.')
      py('', parts)
      py(fileDir, parts)
    }
  }
  return out
}

/** Imported names from the tail of a `from x import ...` line; '*' and aliases handled. */
function pyNames(tail: string): string[] {
  const body = tail.replace(/^\(|\)$/g, '').replace(/[()]/g, '')
  const names: string[] = []
  for (const raw of body.split(',')) {
    const name = raw.trim().replace(/\s+as\s+\w+$/, '').trim()
    if (/^[A-Za-z_]\w*$/.test(name)) names.push(name)
  }
  return names
}

function pyModule(dir: string, parts: string[], fileSet: ReadonlySet<string>): string | undefined {
  if (parts.length === 0 || parts.some((p) => p === '')) return undefined
  const stem = posix.join(dir, ...parts)
  return firstExisting([stem + '.py', posix.join(stem, '__init__.py')], fileSet)
}

// ---- CSS / SCSS / Sass / Less ------------------------------------------------

function cssSpecifiers(src: string): string[] {
  const out: string[] = []
  // Bounded: the statement must end with ';' within 300 characters on one line. An unbounded [^;]+ is
  // quadratic on input that repeats '@import ' with no ';' (each start position scans to the end).
  for (const m of src.matchAll(/@(?:import|use|forward)\s+([^;\n]{1,300});/g)) {
    for (const q of m[1].matchAll(/['"]([^'"\n]+)['"]/g)) out.push(q[1])
    for (const u of m[1].matchAll(/url\(\s*['"]?([^'")\s]+)/g)) out.push(u[1])
  }
  return out.filter((s) => !/^(https?:)?\/\//i.test(s) && !s.includes('://') && !s.startsWith('/'))
}

function resolveCss(dir: string, spec: string, fileSet: ReadonlySet<string>): string | undefined {
  // Only relative or bare names; bare names are relative to the importing file (Sass partials included).
  const cleaned = spec.replace(/^\.\//, '')
  const target = trimSlash(posix.normalize(posix.join(dir, cleaned)))
  const candidates: string[] = [target]
  for (const ext of CSS_EXTS) candidates.push(target + ext)
  const base = posix.basename(target)
  const folder = posix.dirname(target)
  for (const ext of ['.scss', '.sass', '.css']) candidates.push(posix.join(folder, '_' + base + ext))
  return firstExisting(candidates, fileSet)
}

// ---- Rust ----------------------------------------------------------------------

function rustModules(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/^[ \t]*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) out.push(m[1])
  return out
}

function resolveRust(rel: string, name: string, fileSet: ReadonlySet<string>): string | undefined {
  const dir = posix.dirname(rel)
  const file = posix.basename(rel)
  // Module files: children of mod.rs / lib.rs / main.rs live beside them; others use <stem>/.
  const modDir = RS_CRATE_ROOTS.has(file) ? dir : posix.join(dir, file.slice(0, -'.rs'.length))
  return firstExisting([posix.join(modDir, name + '.rs'), posix.join(modDir, name, 'mod.rs')], fileSet)
}

// ---- helpers ---------------------------------------------------------------------

function firstExisting(candidates: readonly string[], fileSet: ReadonlySet<string>): string | undefined {
  for (const c of candidates) {
    const p = trimSlash(posix.normalize(c))
    if (p !== '' && fileSet.has(p)) return p
  }
  return undefined
}

function trimSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p
}
