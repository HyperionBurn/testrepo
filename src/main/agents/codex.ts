// Codex CLI rollout parser (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). Defensive: unknown
// shapes are ignored rather than rejected.
import type { AgentEvent } from '../../shared/types'
import {
  COMMAND_MAX,
  MESSAGE_MAX,
  hashString,
  parseTs,
  relativeWithin,
  snippet,
  statusFromEventType,
  type ParseCtx,
  type ParsedLine
} from './common'

export type ParsedCodex = ParsedLine

type Rec = Record<string, unknown>

function asRec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** Joins a Codex command (string or argv array) into one command string. */
function commandText(cmd: unknown): string | undefined {
  if (typeof cmd === 'string') return cmd
  if (!Array.isArray(cmd) || cmd.length === 0) return undefined
  const parts = cmd.map((p) => String(p))
  // ['bash', '-lc', '<script>'] → the script itself
  if (parts.length >= 3 && /^(-lc|-c)$/.test(parts[1] ?? '') && /(^|\/)(ba|z|da)?sh$/.test(parts[0] ?? '')) {
    return parts[2]
  }
  return parts.join(' ')
}

function parseArgs(args: unknown): Rec | undefined {
  if (typeof args === 'string') {
    try {
      return asRec(JSON.parse(args))
    } catch {
      return undefined
    }
  }
  return asRec(args)
}

/**
 * Parses an apply_patch body into file events. Recognizes `*** Add File:`, `*** Update File:`,
 * `*** Delete File:` and `*** Move to:`. Line counts come from '+' and '-' lines in each section.
 */
export function parseApplyPatch(
  patch: string,
  ctx: { repoRoot: string; agentId: string; base?: string },
  meta: { id: string; ts: number }
): AgentEvent[] {
  type Section = { kind: 'Add' | 'Update' | 'Delete'; path: string; moveTo?: string; added: number; removed: number }
  const sections: Section[] = []
  let cur: Section | null = null
  for (const raw of patch.split('\n')) {
    // Trailing whitespace goes first, so the patterns below never backtrack over a long run of spaces.
    const line = raw.replace(/\r$/, '').trimEnd()
    const head = /^\*\*\* (Add|Update|Delete) File:\s*(.+)$/.exec(line)
    if (head) {
      cur = { kind: head[1] as Section['kind'], path: head[2] ?? '', added: 0, removed: 0 }
      sections.push(cur)
      continue
    }
    const move = /^\*\*\* Move to:\s*(.+)$/.exec(line)
    if (move) {
      if (cur) cur.moveTo = move[1]
      continue
    }
    if (/^\*\*\* (Begin|End) Patch/.test(line)) {
      cur = null
      continue
    }
    if (!cur) continue
    if (line.startsWith('+')) cur.added++
    else if (line.startsWith('-')) cur.removed++
  }

  const events: AgentEvent[] = []
  const rel = (p: string): string | undefined => {
    const r = relativeWithin(p, ctx.repoRoot, ctx.base)
    return r ? r : undefined
  }
  sections.forEach((s, i) => {
    const base = { id: `${meta.id}:p${i}`, agentId: ctx.agentId, ts: meta.ts }
    if (s.kind === 'Add') {
      events.push({ ...base, type: 'create', file: rel(s.path), linesAdded: s.added, linesRemoved: 0 })
    } else if (s.kind === 'Delete') {
      events.push({ ...base, type: 'delete', file: rel(s.path), linesAdded: 0, linesRemoved: s.removed })
    } else {
      const target = s.moveTo ?? s.path
      events.push({ ...base, type: 'edit', file: rel(target), linesAdded: s.added, linesRemoved: s.removed })
    }
  })
  return events
}

/** Parses one line of a Codex rollout. Returns null when the line carries nothing useful. Never throws. */
export function parseCodexLine(line: string, ctx: ParseCtx): ParsedCodex | null {
  const text = line.trim()
  if (!text) return null
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  const rec = asRec(o)
  if (!rec) return null
  const ts = parseTs(rec.timestamp)
  const at = ts ?? Date.now()
  const payload = asRec(rec.payload) ?? {}
  const key = hashString(text)
  const out: ParsedCodex = { events: [], ts }
  const base = (i: number) => ({ id: `cx:${key}:${i}`, agentId: ctx.agentId, ts: at })

  switch (rec.type) {
    case 'session_meta': {
      out.sessionId = str(payload.id)
      out.cwd = str(payload.cwd)
      out.model = str(payload.model)
      break
    }
    case 'turn_context': {
      out.cwd = str(payload.cwd)
      out.model = str(payload.model)
      break
    }
    case 'response_item': {
      handleResponseItem(payload, ctx, out, base, at, key)
      break
    }
    case 'event_msg': {
      if (payload.type === 'token_count') {
        const info = asRec(payload.info)
        const total = asRec(info?.total_token_usage)
        if (total) {
          // input_tokens includes the cached part; the hub splits it after diffing the raw totals.
          out.totalUsage = {
            input: num(total.input_tokens),
            output: num(total.output_tokens),
            cacheRead: num(total.cached_input_tokens),
            cacheWrite: 0
          }
        }
      } else if (payload.type === 'agent_message') {
        const t = str(payload.message)
        if (t && t.trim()) {
          out.text = snippet(t, MESSAGE_MAX)
          out.events.push({ ...base(0), type: 'message', text: out.text })
        }
      }
      break
    }
    default:
      break
  }

  const last = out.events[out.events.length - 1]
  out.status = statusFromEventType(last?.type)
  const useful =
    out.events.length > 0 || out.totalUsage !== undefined || out.cwd !== undefined || out.sessionId !== undefined
  return useful ? out : null
}

function handleResponseItem(
  payload: Rec,
  ctx: ParseCtx,
  out: ParsedCodex,
  base: (i: number) => { id: string; agentId: string; ts: number },
  at: number,
  key: string
): void {
  const ptype = str(payload.type)
  switch (ptype) {
    case 'function_call': {
      const name = str(payload.name) ?? ''
      const args = parseArgs(payload.arguments)
      if (name === 'apply_patch') {
        const body = str(args?.input) ?? str(args?.patch) ?? str(payload.arguments)
        if (body) pushPatch(out, body, ctx, args?.workdir, base(0), at, key)
        return
      }
      if (args && args.command !== undefined) {
        handleShell(commandText(args.command), args.workdir, ctx, out, base(0), at, key)
      }
      return
    }
    case 'local_shell_call': {
      const action = asRec(payload.action)
      if (action) handleShell(commandText(action.command), action.working_directory, ctx, out, base(0), at, key)
      return
    }
    case 'custom_tool_call': {
      if (payload.name === 'apply_patch') {
        const body = str(payload.input)
        if (body) pushPatch(out, body, ctx, undefined, base(0), at, key)
      }
      return
    }
    case 'message':
      // Assistant text is taken from event_msg agent_message to avoid counting it twice.
      return
    case 'reasoning': {
      out.events.push({ ...base(0), type: 'thinking' })
      return
    }
    default:
      return
  }
}

function handleShell(
  cmd: string | undefined,
  workdir: unknown,
  ctx: ParseCtx,
  out: ParsedCodex,
  base: { id: string; agentId: string; ts: number },
  at: number,
  key: string
): void {
  if (!cmd) return
  if (/\*\*\* Begin Patch/.test(cmd) || /^\s*apply_patch\b/.test(cmd)) {
    pushPatch(out, cmd, ctx, workdir, base, at, key)
    return
  }
  out.events.push({ ...base, type: 'command', text: snippet(cmd, COMMAND_MAX) })
}

function pushPatch(
  out: ParsedCodex,
  body: string,
  ctx: ParseCtx,
  workdir: unknown,
  base: { id: string; agentId: string; ts: number },
  at: number,
  key: string
): void {
  const dir = typeof workdir === 'string' && workdir.trim() ? workdir : ctx.cwd
  const events = parseApplyPatch(
    body,
    { repoRoot: ctx.repoRoot, agentId: ctx.agentId, base: dir },
    { id: `${base.id}:${key}`, ts: at }
  )
  out.events.push(...events)
}
