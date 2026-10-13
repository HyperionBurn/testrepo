// Makes the Windows x64 native binaries that the app needs available in node_modules, so that
// `electron-builder --win` can package them from a non-Windows host (Linux cross-build).
//
// - On win32 this is a no-op: `npm ci` installs the matching optional deps natively.
// - Elsewhere it installs, without touching package.json or package-lock.json, the win32 optional
//   deps of the runtime packages (node-llama-cpp CPU and Vulkan builds, never CUDA; and the
//   @reflink/reflink Windows binary used by ipull).
// - Idempotent: packages already present at the pinned version are skipped.
//
// Usage: node scripts/prepare-win-deps.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform === 'win32') {
  console.log('prepare-win-deps: Windows host, optional deps are installed by npm ci. Nothing to do.')
  process.exit(0)
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

// Each entry: the runtime package whose optionalDependencies pin the versions, and the win32 x64
// packages to provide. Windows x64 only; the CUDA variants are deliberately not listed.
const SOURCES = [
  {
    from: 'node-llama-cpp',
    names: ['@node-llama-cpp/win-x64', '@node-llama-cpp/win-x64-vulkan']
  },
  {
    from: '@reflink/reflink',
    names: ['@reflink/reflink-win32-x64-msvc']
  }
]

const WANTED = []
for (const { from, names } of SOURCES) {
  const fromPkg = resolve(root, 'node_modules', from, 'package.json')
  if (!existsSync(fromPkg)) {
    console.error(`prepare-win-deps: node_modules/${from} is missing. Run \`npm ci\` first.`)
    process.exit(1)
  }
  const optional = readJson(fromPkg).optionalDependencies ?? {}
  for (const name of names) {
    if (!optional[name]) {
      console.error(`prepare-win-deps: ${name} is not listed in ${from} optionalDependencies.`)
      process.exit(1)
    }
    WANTED.push({ name, version: optional[name] })
  }
}

const specs = []
for (const { name, version } of WANTED) {
  const installed = resolve(root, 'node_modules', name, 'package.json')
  if (existsSync(installed) && readJson(installed).version === version) {
    console.log(`prepare-win-deps: ${name}@${version} already present.`)
    continue
  }
  specs.push(`${name}@${version}`)
}

if (specs.length > 0) {
  console.log(`prepare-win-deps: installing ${specs.join(', ')} (no-save)...`)
  // --force: npm would otherwise refuse the os/cpu mismatch. --ignore-scripts: skip the
  // root postinstall (electron-builder install-app-deps), which is not needed for this.
  const result = spawnSync(
    'npm',
    ['install', '--no-save', '--force', '--ignore-scripts', ...specs],
    { cwd: root, stdio: 'inherit' }
  )
  if (result.status !== 0) {
    console.error('prepare-win-deps: npm install failed.')
    process.exit(result.status ?? 1)
  }
}

for (const { name } of WANTED) {
  const installed = resolve(root, 'node_modules', name, 'package.json')
  if (!existsSync(installed)) {
    console.error(`prepare-win-deps: ${name} is still missing after install.`)
    process.exit(1)
  }
}
console.log('prepare-win-deps: Windows x64 runtime binaries ready.')
