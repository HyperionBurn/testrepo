// Deterministic, offline fallbacks for the LLM features. Pure functions only: the same inputs
// (including `now`) always produce the same text.
import type { AgentEvent, AgentInfo } from '../../shared/types'
import { langFromPath, LANG_LABEL } from '../../shared/lang'
import {
  changedFilesByRecency,
  summarizeActivity,
  type ActivityGroup,
  type ActivitySummary,
  type FileTally
} from './activity'
import { formatDuration, formatUsd, plural } from './text'

const MAX_AGENT_BULLETS = 8
const MAX_FILES_PER_AGENT = 3
const MAX_HOTSPOTS = 3
const MAX_LISTED_NAMES = 8

/**
 * Markdown digest of agent activity, built without a model.
 * `events` should already be limited to the window the user cares about; the window length is
 * measured from the earliest event to `now`. Cost is the sum of the active agents' session costs.
 */
export function heuristicDigest(
  events: readonly AgentEvent[],
  agents: readonly AgentInfo[],
  now: number
): string {
  if (events.length === 0) return 'All quiet: no agent activity was recorded in this window.'

  const s = summarizeActivity(events, agents, now)
  const groups = [...s.agentGroups].sort(byActivityDesc)

  let changes = 0
  let commands = 0
  let reads = 0
  let cost = 0
  const files = new Set<string>()
  for (const g of groups) {
    changes += g.changes
    commands += g.commands
    reads += g.reads
    cost += g.agent?.costUsd ?? 0
    for (const path of g.files.keys()) files.add(path)
  }

  const lines: string[] = []
  lines.push(`While you were away (${formatDuration(now - s.start)}), ${leadSentence(groups, s, { changes, commands, reads, files: files.size, cost })}.`)
  lines.push('')

  for (const g of groups.slice(0, MAX_AGENT_BULLETS)) lines.push(agentBullet(g))
  if (groups.length > MAX_AGENT_BULLETS) lines.push(`- …and ${groups.length - MAX_AGENT_BULLETS} more.`)
  if (groups.length > 0 && s.unattributed && s.unattributed.changes > 0) {
    const u = s.unattributed
    lines.push(`- **Unattributed** — ${plural(u.changes, 'change')} in ${plural(u.files.size, 'file')} not tied to any agent.`)
  }

  const hot = hotspots(s)
  if (hot) {
    lines.push('')
    lines.push(hot)
  }
  return lines.join('\n')
}

interface Totals {
  changes: number
  commands: number
  reads: number
  files: number
  cost: number
}

function leadSentence(groups: ActivityGroup[], s: ActivitySummary, t: Totals): string {
  if (groups.length === 0 && s.unattributed) {
    const u = s.unattributed
    return `${plural(u.changes, 'change')} to ${plural(u.files.size, 'file')} came from outside any agent`
  }
  const clauses: string[] = []
  if (t.changes > 0) clauses.push(`made ${plural(t.changes, 'edit')} across ${plural(t.files, 'file')}`)
  if (t.commands > 0) clauses.push(`ran ${plural(t.commands, 'command')}`)
  if (clauses.length === 0 && t.reads > 0) clauses.push(`read ${plural(t.reads, 'file')}`)
  if (clauses.length === 0) clauses.push('showed activity')
  let sentence = `${plural(groups.length, 'agent')} ${joinWords(clauses)}`
  if (t.cost > 0) sentence += `, spending ${formatUsd(t.cost)}`
  return sentence
}

function agentBullet(g: ActivityGroup): string {
  const parts: string[] = []
  const ranked = rankedFiles(g)
  if (g.changes > 0) {
    if (ranked.length > 0) {
      const dir = dominantDir(ranked)
      const names = ranked.slice(0, MAX_FILES_PER_AGENT).map((f) => baseName(f.path))
      const more = ranked.length > MAX_FILES_PER_AGENT ? ' …' : ''
      const where = dir === '' ? 'mostly at the repo root' : `mostly in \`${dir}\``
      parts.push(`${where} (edited ${names.join(', ')}${more})`)
    } else {
      parts.push(`made ${plural(g.changes, 'edit')}`)
    }
  } else if (g.reads > 0) {
    parts.push(`read ${plural(g.readFiles.size || g.reads, 'file')}`)
  }
  if (g.spawns > 0) parts.push(`spawned ${plural(g.spawns, 'subagent')}`)
  if (g.testRuns > 0) parts.push(`ran tests ${g.testRuns}×`)
  const other = g.commands - g.testRuns
  if (other > 0) parts.push(`ran ${other} other ${other === 1 ? 'command' : 'commands'}`)
  if (parts.length === 0) parts.push('was active')
  return `- **${g.name}** — ${joinWords(parts)}.`
}

function hotspots(s: ActivitySummary): string {
  const totals = new Map<string, number>()
  const groups = [...s.agentGroups, ...(s.unattributed ? [s.unattributed] : [])]
  for (const g of groups) {
    for (const f of g.files.values()) totals.set(f.path, (totals.get(f.path) ?? 0) + f.changes)
  }
  const top = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, MAX_HOTSPOTS)
  if (top.length === 0) return ''
  return `Hotspots: ${top.map(([p, n]) => `\`${p}\` (${plural(n, 'edit')})`).join(', ')}.`
}

function byActivityDesc(a: ActivityGroup, b: ActivityGroup): number {
  const wa = a.changes + a.commands + a.reads
  const wb = b.changes + b.commands + b.reads
  if (wa !== wb) return wb - wa
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

function rankedFiles(g: ActivityGroup): FileTally[] {
  return [...g.files.values()].sort((a, b) => b.changes - a.changes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Directory holding the most changes (ties broken alphabetically). '' means the repo root. */
function dominantDir(ranked: FileTally[]): string {
  const weight = new Map<string, number>()
  for (const f of ranked) {
    const d = dirName(f.path)
    weight.set(d, (weight.get(d) ?? 0) + f.changes)
  }
  let best = ''
  let bestW = -1
  for (const [d, w] of [...weight.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    if (w > bestW) {
      best = d
      bestW = w
    }
  }
  return best
}

function dirName(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

function listNames(names: string[]): string {
  const shown = names.slice(0, MAX_LISTED_NAMES).map((n) => `\`${n}\``)
  const rest = names.length - shown.length
  return joinWords(rest > 0 ? [...shown, `${rest} more`] : shown)
}

// ---- explain fallback -----------------------------------------------------------------------

const EXPORT_RE = /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}/
const FUNC_RES: RegExp[] = [
  /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, // js/ts
  /^(?:async\s+)?def\s+([A-Za-z_]\w*)/, // python
  /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, // rust
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ // go
]
const TYPE_RES: RegExp[] = [
  /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, // js/ts/python
  /^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/, // rust
  /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/ // go
]
const IMPORT_RE = /^(?:import\s|from\s+[\w.]+\s+import\s|use\s+(?!strict\b)[\w:{]|#include\s|(?:const|let|var)\s[^=]*=\s*require\(|require\(['"])/

interface Declarations {
  exports: string[]
  functions: string[]
  types: string[]
  imports: number
}

/** Top-level declarations only (lines that start at column 0), matched with per-language regexes. */
function extractDeclarations(lines: string[]): Declarations {
  const exported = new Set<string>()
  const functions = new Set<string>()
  const types = new Set<string>()
  let imports = 0

  for (const raw of lines) {
    const trimmed = raw.trim()
    if (IMPORT_RE.test(trimmed)) imports++
    if (raw.length === 0 || raw[0] === ' ' || raw[0] === '\t') continue

    const exp = EXPORT_RE.exec(raw)
    if (exp) exported.add(exp[1])
    const list = EXPORT_LIST_RE.exec(raw)
    if (list) {
      for (const item of list[1].split(',')) {
        const m = /(?:as\s+)?([A-Za-z_$][\w$]*)$/.exec(item.trim())
        if (m) exported.add(m[1])
      }
    }
    for (const re of FUNC_RES) {
      const m = re.exec(raw)
      if (m) functions.add(m[1])
    }
    for (const re of TYPE_RES) {
      const m = re.exec(raw)
      if (m) types.add(m[1])
    }
  }

  for (const name of exported) {
    functions.delete(name)
    types.delete(name)
  }
  return {
    exports: [...exported].sort(),
    functions: [...functions].sort(),
    types: [...types].sort(),
    imports
  }
}

/**
 * Plain-English description of a file without a model: language, lines of code, top-level
 * exports/functions/types and import count. Markdown, two short paragraphs.
 */
export function heuristicExplain(path: string, content: string, repoName: string): string {
  const lang = langFromPath(path)
  const label = LANG_LABEL[lang]
  const kind = lang === 'other' ? 'source' : label
  const lines = content.split(/\r?\n/)
  const loc = lines.filter((l) => l.trim() !== '').length
  const decl = extractDeclarations(lines)

  const parts: string[] = []
  if (decl.exports.length > 0) parts.push(`exports ${listNames(decl.exports)}`)
  if (decl.functions.length > 0) {
    parts.push(`defines ${plural(decl.functions.length, 'function')} ${listNames(decl.functions)}`)
  }
  if (decl.types.length > 0) {
    parts.push(`declares ${plural(decl.types.length, 'class or type', 'classes or types')} ${listNames(decl.types)}`)
  }
  if (decl.imports > 0) parts.push(`imports ${plural(decl.imports, 'module')}`)

  const second = parts.length > 0
    ? `It ${joinWords(parts)}.`
    : 'It has no top-level declarations that the heuristic can recognise.'

  return [
    `\`${path}\` is a ${kind} file in ${repoName} with ${plural(loc, 'line')} of code.`,
    '',
    second,
    '',
    '_Heuristic summary: the local model is not available, so this is a pattern-based description._'
  ].join('\n')
}
