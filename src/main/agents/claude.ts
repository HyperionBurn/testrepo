// Claude Code transcript parser (~/.claude/projects/<encoded cwd>/<session>.jsonl).
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import type { AgentEvent } from '../../shared/types'
import {
  COMMAND_MAX,
  MESSAGE_MAX,
  countLines,
  parseTs,
  snippet,
  statusFromEventType,
  toRepoRelative,
  type ParseCtx,
  type ParsedLine
} from './common'

export type ParsedClaude = ParsedLine

/** Claude Code's project directory name for a cwd: every non-alphanumeric char becomes '-'. */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Existing project directories under `<claudeHome>/projects` that can hold sessions for
 * `repoRoot`: the root's own directory plus directories of sessions started in subfolders
 * (encoded name starts with the root's encoded name followed by '-').
 */
export async function claudeProjectDirsFor(repoRoot: string, claudeHome: string): Promise<string[]> {
  const projects = path.join(claudeHome, 'projects')
  let names: string[]
  try {
    names = await fsp.readdir(projects)
  } catch {
    return []
  }
  const encoded = encodeClaudeProjectDir(repoRoot.replace(/[\\/]+$/, ''))
  const out: string[] = []
  for (const name of names) {
    if (name === encoded || name.startsWith(encoded + '-')) {
      out.push(path.join(projects, name))
    }
  }
  return out.sort()
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** Model ids like '<synthetic>' are placeholders, not real models. */
function realModel(v: unknown): string | undefined {
  const s = str(v)
  return s && !s.startsWith('<') ? s : undefined
}

function looksLikeFile(p: string): boolean {
  const last = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return /\.[A-Za-z0-9]+$/.test(last)
}

/**
 * Parses one line of a Claude Code transcript. Returns null for lines that are not JSON
 * or carry nothing the engine uses. Never throws.
 */
export function parseClaudeLine(line: string, ctx: ParseCtx): ParsedClaude | null {
  const text = line.trim()
  if (!text) return null
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const rec = o as Record<string, unknown>
  const ts = parseTs(rec.timestamp)
  const out: ParsedClaude = { events: [], ts, cwd: str(rec.cwd), sessionId: str(rec.sessionId) }
  const msg = rec.message && typeof rec.message === 'object' ? (rec.message as Record<string, unknown>) : undefined
  const at = ts ?? Date.now()
  const lineKey = str(rec.uuid) ?? str(msg?.id) ?? 'line'

  if (rec.type === 'assistant' && msg) {
    const model = realModel(msg.model)
    if (model) out.model = model
    const content = Array.isArray(msg.content) ? msg.content : []
    // Placeholder messages (model '<synthetic>') are not agent output.
    const synthetic = typeof msg.model === 'string' && msg.model.startsWith('<')
    let lastText: string | undefined
    content.forEach((block: unknown, i: number) => {
      if (!block || typeof block !== 'object') return
      const b = block as Record<string, unknown>
      const id = `cl:${lineKey}:${i}`
      const base = { id, agentId: ctx.agentId, ts: at }
      switch (b.type) {
        case 'text': {
          const t = str(b.text)
          if (t && t.trim() && !synthetic) {
            lastText = t
            out.events.push({ ...base, type: 'message', text: snippet(t, MESSAGE_MAX) })
          }
          break
        }
        case 'thinking':
          out.events.push({ ...base, type: 'thinking' })
          break
        case 'tool_use':
          pushToolEvents(out.events, b, base, ctx)
          break
        default:
          break
      }
    })
    if (lastText !== undefined) out.text = snippet(lastText, MESSAGE_MAX)
    const usage = msg.usage && typeof msg.usage === 'object' ? (msg.usage as Record<string, unknown>) : undefined
    const messageId = str(msg.id)
    if (usage && messageId) {
      out.usage = {
        messageId,
        model: out.model,
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens)
      }
    }
  } else if (rec.type === 'user' && msg && !rec.isMeta) {
    if (typeof msg.content === 'string') {
      if (msg.content.trim() && !msg.content.trimStart().startsWith('<')) out.userText = msg.content
    } else if (Array.isArray(msg.content)) {
      const first = msg.content.find(
        (b: unknown) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text'
      ) as Record<string, unknown> | undefined
      const t = str(first?.text)
      if (t && t.trim() && !t.trimStart().startsWith('<')) out.userText = t
    }
  }

  const last = out.events[out.events.length - 1]
  out.status = statusFromEventType(last?.type)
  const useful =
    out.events.length > 0 || out.usage !== undefined || out.cwd !== undefined || out.userText !== undefined
  return useful ? out : null
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

type Base = Pick<AgentEvent, 'id' | 'agentId' | 'ts'>

function pushToolEvents(events: AgentEvent[], b: Record<string, unknown>, base: Base, ctx: ParseCtx): void {
  const name = str(b.name) ?? ''
  const input = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {}
  const file = (p: unknown): string | undefined => toRepoRelative(p, ctx.repoRoot)
  switch (name) {
    case 'Read': {
      const f = file(input.file_path ?? input.path)
      events.push({ ...base, type: 'read', file: f, text: f ? undefined : 'Read' })
      return
    }
    case 'Grep':
    case 'Glob':
    case 'LS': {
      const target = str(input.path)
      const f = target && looksLikeFile(target) ? file(target) : undefined
      const what = str(input.pattern) ?? target ?? ''
      events.push({ ...base, type: 'read', file: f, text: snippet(`${name} ${what}`, COMMAND_MAX) })
      return
    }
    case 'Edit': {
      events.push({
        ...base,
        type: 'edit',
        file: file(input.file_path),
        linesAdded: countLines(input.new_string),
        linesRemoved: countLines(input.old_string)
      })
      return
    }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits : []
      let added = 0
      let removed = 0
      for (const e of edits) {
        if (!e || typeof e !== 'object') continue
        const ed = e as Record<string, unknown>
        added += countLines(ed.new_string)
        removed += countLines(ed.old_string)
      }
      events.push({ ...base, type: 'edit', file: file(input.file_path), linesAdded: added, linesRemoved: removed })
      return
    }
    case 'NotebookEdit': {
      events.push({
        ...base,
        type: 'edit',
        file: file(input.notebook_path ?? input.file_path),
        linesAdded: countLines(input.new_source),
        linesRemoved: 0
      })
      return
    }
    case 'Write': {
      events.push({
        ...base,
        type: 'create',
        file: file(input.file_path),
        linesAdded: countLines(input.content),
        linesRemoved: 0
      })
      return
    }
    case 'Bash': {
      const cmd = str(input.command) ?? ''
      events.push({ ...base, type: 'command', text: snippet(cmd, COMMAND_MAX) })
      return
    }
    case 'Task':
    case 'Agent': {
      const what = str(input.description) ?? str(input.prompt) ?? 'subagent'
      events.push({ ...base, type: 'spawn', text: snippet(what, COMMAND_MAX) })
      return
    }
    default:
      return
  }
}
