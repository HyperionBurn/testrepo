// Extension -> language mapping, language colors/labels, and "skip this file" heuristics.
// Pure logic: no node or electron imports.
import type { Lang } from './types'

/** Every Lang value, in a stable order. */
export const LANG_IDS: readonly Lang[] = [
  'ts', 'js', 'py', 'rs', 'go', 'java', 'cs', 'cpp', 'c', 'rb', 'php', 'swift', 'kt',
  'css', 'html', 'md', 'json', 'yaml', 'sh', 'sql', 'other'
]

// Built with Maps (not object literals) so keys like "constructor" cannot hit Object.prototype.
function table(groups: ReadonlyArray<readonly [Lang, readonly string[]]>): Map<string, Lang> {
  const m = new Map<string, Lang>()
  for (const [lang, exts] of groups) for (const e of exts) m.set(e, lang)
  return m
}

const EXT_TO_LANG: ReadonlyMap<string, Lang> = table([
  ['ts', ['ts', 'tsx', 'mts', 'cts']],
  ['js', ['js', 'jsx', 'mjs', 'cjs']],
  ['py', ['py', 'pyi', 'pyw']],
  ['rs', ['rs']],
  ['go', ['go']],
  ['java', ['java']],
  ['cs', ['cs']],
  ['cpp', ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx']],
  ['c', ['c', 'h']], // .h is ambiguous; C is the conventional reading of the bare extension
  ['rb', ['rb', 'rake', 'gemspec']],
  ['php', ['php']],
  ['swift', ['swift']],
  ['kt', ['kt', 'kts']],
  ['css', ['css', 'scss', 'sass', 'less', 'styl']],
  ['html', ['html', 'htm', 'vue', 'svelte', 'astro']], // component templates are markup-first
  ['md', ['md', 'mdx', 'markdown', 'rst']],
  ['json', ['json', 'jsonc', 'json5']],
  ['yaml', ['yaml', 'yml', 'toml']],
  ['sh', ['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd']],
  ['sql', ['sql']]
])

/** Neon-on-night palette: bright enough to read as emissive glow on a dark scene. */
export const LANG_COLORS: Readonly<Record<Lang, string>> = {
  ts: '#3B82F6',
  js: '#FBBF24',
  py: '#2DD4A3',
  rs: '#FB923C',
  go: '#22D3EE',
  java: '#EF4444',
  cs: '#C084FC',
  cpp: '#818CF8',
  c: '#A3E635',
  rb: '#FB7185',
  php: '#E879F9',
  swift: '#FDBA74',
  kt: '#F0ABFC',
  css: '#F472B6',
  html: '#38BDF8',
  md: '#F1F5F9',
  json: '#A78BFA',
  yaml: '#FDE68A',
  sh: '#4ADE80',
  sql: '#5EEAD4',
  other: '#64748B'
}

export const LANG_LABEL: Readonly<Record<Lang, string>> = {
  ts: 'TypeScript',
  js: 'JavaScript',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  java: 'Java',
  cs: 'C#',
  cpp: 'C++',
  c: 'C',
  rb: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  kt: 'Kotlin',
  css: 'CSS',
  html: 'HTML',
  md: 'Markdown',
  json: 'JSON',
  yaml: 'YAML',
  sh: 'Shell',
  sql: 'SQL',
  other: 'Other'
}

/** Directories never scanned or shown as districts. */
export const IGNORED_DIRS: readonly string[] = [
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', 'venv', '.venv',
  '__pycache__', 'target', '.turbo', '.cache', 'coverage', 'release'
]

const BINARY_EXTS: ReadonlySet<string> = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tif', 'tiff', 'psd', 'avif', 'heic', 'icns', 'cur',
  // fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // archives
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war', 'apk', 'dmg', 'iso', 'whl',
  // audio / video
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'wav', 'flac', 'ogg', 'm4a', 'aac',
  // compiled / native binaries
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'obj', 'a', 'lib', 'class', 'pyc', 'pyd', 'wasm', 'node',
  // documents and databases
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'sqlite', 'sqlite3', 'db'
])

/** Lockfiles and other generated, machine-written manifests (matched by lowercase basename). */
const SKIP_BASENAMES: ReadonlySet<string> = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock',
  'cargo.lock', 'gemfile.lock', 'poetry.lock', 'pipfile.lock', 'composer.lock', 'go.sum', 'uv.lock',
  'flake.lock', 'mix.lock', 'podfile.lock', 'packages.lock.json'
])

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return path.slice(i + 1)
}

/** Lowercase extension without the dot, or '' (dotfiles such as .gitignore have no extension). */
function extOf(base: string): string {
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1) : ''
}

/** Language of a file path (forward or back slashes). Unknown extensions map to 'other'. */
export function langFromPath(path: string): Lang {
  const base = baseName(path).toLowerCase()
  return EXT_TO_LANG.get(extOf(base)) ?? 'other'
}

/** True for files that should not be scanned for content: images, fonts, archives, media, binaries, lockfiles. */
export function isProbablyBinary(path: string): boolean {
  const base = baseName(path).toLowerCase()
  if (SKIP_BASENAMES.has(base)) return true
  return BINARY_EXTS.has(extOf(base))
}
