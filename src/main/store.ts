// Settings persisted to userData/settings.json. Small file, read once and cached in memory.
import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Settings } from '../shared/types'

export const DEFAULT_LLM_MODEL = 'qwen2.5-coder-1.5b'
export const MAX_RECENT_REPOS = 8

const DEFAULTS: Settings = { recentRepos: [], llmModel: DEFAULT_LLM_MODEL }

let cache: Settings | undefined

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/** Directory where the local LLM model is downloaded. */
export function modelsDir(): string {
  return join(app.getPath('userData'), 'models')
}

/** Coerces untrusted JSON into a valid Settings object, keeping known fields only. */
export function normalizeSettings(raw: unknown): Settings {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const recentRepos = Array.isArray(obj.recentRepos)
    ? dedupeRecent(obj.recentRepos.filter((r): r is string => typeof r === 'string' && r.trim() !== ''))
    : []
  const out: Settings = {
    recentRepos: recentRepos.slice(0, MAX_RECENT_REPOS),
    llmModel: typeof obj.llmModel === 'string' && obj.llmModel.trim() ? obj.llmModel : DEFAULTS.llmModel
  }
  if (typeof obj.claudeDir === 'string' && obj.claudeDir) out.claudeDir = obj.claudeDir
  if (typeof obj.codexDir === 'string' && obj.codexDir) out.codexDir = obj.codexDir
  return out
}

/** Recent list with `root` moved to the front, duplicates removed, capped at MAX_RECENT_REPOS. Pure. */
export function pushRecent(list: readonly string[], root: string): string[] {
  const abs = resolve(root)
  return dedupeRecent([abs, ...list]).slice(0, MAX_RECENT_REPOS)
}

function dedupeRecent(list: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of list) {
    const key = process.platform === 'win32' ? p.toLowerCase() : p
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

export function getSettings(): Settings {
  if (cache) return cache
  let raw: unknown = {}
  try {
    raw = JSON.parse(readFileSync(settingsFile(), 'utf8'))
  } catch {
    raw = {} // missing or corrupt file: defaults
  }
  cache = normalizeSettings(raw)
  return cache
}

/** Merges `patch` into the settings, updates the cache and writes the file (atomically, best-effort). */
export function saveSettings(patch: Partial<Settings>): Settings {
  const next = normalizeSettings({ ...getSettings(), ...patch })
  cache = next
  const file = settingsFile()
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    console.warn('[skyline] could not write settings:', err)
  }
  return next
}

export function addRecent(root: string): Settings {
  return saveSettings({ recentRepos: pushRecent(getSettings().recentRepos, root) })
}
