import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { claudeProjectDirsFor, encodeClaudeProjectDir, parseClaudeLine } from '../claude'
import { parseApplyPatch, parseCodexLine } from '../codex'
import { relativeWithin, snippet, toRepoRelative } from '../common'

const FX = path.join(__dirname, 'fixtures')
const fixture = (name: string): string[] =>
  readFileSync(path.join(FX, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')

const REPO = '/work/demo-repo'
const claudeCtx = { repoRoot: REPO, agentId: 'S1' }
const codexCtx = { repoRoot: REPO, agentId: 'codex-sess-0001' }

describe('encodeClaudeProjectDir', () => {
  it('replaces every non-alphanumeric char with a dash', () => {
    expect(encodeClaudeProjectDir('/home/user/testrepo')).toBe('-home-user-testrepo')
    expect(encodeClaudeProjectDir('C:\\dev\\app')).toBe('C--dev-app')
    expect(encodeClaudeProjectDir('C:/dev/app')).toBe('C--dev-app')
    expect(encodeClaudeProjectDir('/a/my.app_v2')).toBe('-a-my-app-v2')
  })
})

describe('claudeProjectDirsFor', () => {
  it('returns the root dir and subfolder session dirs, but not look-alike repos', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'skyline-claude-home-'))
    try {
      const projects = path.join(home, 'projects')
      for (const d of ['-work-demo-repo', '-work-demo-repo-src', '-work-demo-repo2', '-other-place']) {
        mkdirSync(path.join(projects, d), { recursive: true })
      }
      const dirs = await claudeProjectDirsFor(REPO, home)
      expect(dirs.map((d) => path.basename(d))).toEqual(['-work-demo-repo', '-work-demo-repo-src'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns an empty list when there is no projects dir', async () => {
    expect(await claudeProjectDirsFor(REPO, '/definitely/not/here')).toEqual([])
  })
})

describe('relativeWithin / toRepoRelative', () => {
  it('relativizes POSIX paths and drops outside paths', () => {
    expect(relativeWithin('/work/demo-repo/src/a.ts', REPO)).toBe('src/a.ts')
    expect(relativeWithin('/work/demo-repo', REPO)).toBe('')
    expect(relativeWithin('/work/demo-repo/src/../a.ts', REPO)).toBe('a.ts')
    expect(relativeWithin('/work/demo-repo2/x.ts', REPO)).toBeNull()
    expect(relativeWithin('/etc/hosts', REPO)).toBeNull()
    expect(toRepoRelative('/etc/hosts', REPO)).toBeUndefined()
    expect(toRepoRelative(undefined, REPO)).toBeUndefined()
  })

  it('handles Windows backslash and forward-slash paths with a case-insensitive drive compare', () => {
    const root = 'C:\\dev\\app'
    expect(relativeWithin('C:\\dev\\app\\src\\a.ts', root)).toBe('src/a.ts')
    expect(relativeWithin('C:/dev/app/src/a.ts', root)).toBe('src/a.ts')
    expect(relativeWithin('c:\\dev\\app\\src\\a.ts', root)).toBe('src/a.ts')
    expect(relativeWithin('C:\\dev\\app', root)).toBe('')
    expect(relativeWithin('D:\\dev\\app\\a.ts', root)).toBeNull()
    expect(relativeWithin('C:\\dev\\app2\\a.ts', root)).toBeNull()
    // A POSIX path never matches a Windows repo root.
    expect(relativeWithin('/dev/app/src/a.ts', root)).toBeNull()
  })

  it('treats relative paths as repo-relative, or resolves them against a base', () => {
    expect(relativeWithin('src/a.ts', REPO)).toBe('src/a.ts')
    expect(relativeWithin('./src/a.ts', REPO)).toBe('src/a.ts')
    expect(relativeWithin('../x.ts', REPO)).toBeNull()
    expect(relativeWithin('app.ts', REPO, '/work/demo-repo/src')).toBe('src/app.ts')
  })

  it('keeps snippets within the limit', () => {
    expect(snippet('x'.repeat(200), 120).length).toBe(120)
    expect(snippet('a\n  b\tc', 120)).toBe('a b c')
  })
})

describe('parseClaudeLine', () => {
  const lines = fixture('claude-session.jsonl')

  it('returns null for junk and for lines with nothing useful', () => {
    expect(parseClaudeLine('', claudeCtx)).toBeNull()
    expect(parseClaudeLine('{not json', claudeCtx)).toBeNull()
    expect(parseClaudeLine('"just a string"', claudeCtx)).toBeNull()
    expect(parseClaudeLine('{"type":"queue-operation","operation":"enqueue"}', claudeCtx)).toBeNull()
  })

  it('reads the user prompt, cwd and timestamp', () => {
    const p = parseClaudeLine(lines[0]!, claudeCtx)!
    expect(p.userText).toBe('Add a login page to the demo app')
    expect(p.cwd).toBe(REPO)
    expect(p.ts).toBe(Date.parse('2026-10-13T10:00:00.000Z'))
    expect(p.events).toEqual([])
  })

  it('maps thinking and text blocks, and reports the last text', () => {
    const thinking = parseClaudeLine(lines[1]!, claudeCtx)!
    expect(thinking.events.map((e) => e.type)).toEqual(['thinking'])
    expect(thinking.usage).toEqual({
      messageId: 'msg_01',
      model: 'claude-sonnet-4-5-20250929',
      input: 3,
      output: 10,
      cacheRead: 100,
      cacheWrite: 50
    })
    const text = parseClaudeLine(lines[4]!, claudeCtx)!
    expect(text.events).toMatchObject([{ type: 'message', text: 'Reading the file now.', agentId: 'S1' }])
    expect(text.text).toBe('Reading the file now.')
    expect(text.status).toBe('thinking')
  })

  it('maps Read, Edit, Write, Bash and Agent tools to events', () => {
    const read = parseClaudeLine(lines[2]!, claudeCtx)!.events[0]!
    expect(read).toMatchObject({ type: 'read', file: 'src/app.ts', agentId: 'S1', ts: Date.parse('2026-10-13T10:00:01.200Z') })

    const edit = parseClaudeLine(lines[5]!, claudeCtx)!.events[0]!
    expect(edit).toMatchObject({ type: 'edit', file: 'src/app.ts', linesAdded: 4, linesRemoved: 2 })

    const write = parseClaudeLine(lines[6]!, claudeCtx)!.events[0]!
    expect(write).toMatchObject({ type: 'create', file: 'src/login.tsx', linesAdded: 3, linesRemoved: 0 })

    const bash = parseClaudeLine(lines[7]!, claudeCtx)!.events[0]!
    expect(bash.type).toBe('command')
    expect(bash.text!.length).toBeLessThanOrEqual(120)
    expect(bash.text).not.toMatch(/\n/)
    expect(bash.text!.startsWith('npm run build && npm test')).toBe(true)

    const spawn = parseClaudeLine(lines[8]!, claudeCtx)!.events[0]!
    expect(spawn).toMatchObject({ type: 'spawn', text: 'Write login tests' })
  })

  it('drops files outside the repo but keeps the event', () => {
    const p = parseClaudeLine(lines[9]!, claudeCtx)!
    expect(p.events.map((e) => [e.type, e.file])).toEqual([
      ['read', undefined],
      ['create', undefined]
    ])
  })

  it('maps Glob and Grep to read, attaching a file only when the path is a file', () => {
    const p = parseClaudeLine(lines[10]!, claudeCtx)!
    expect(p.events.map((e) => [e.type, e.file])).toEqual([
      ['read', undefined],
      ['read', 'src/app.ts']
    ])
  })

  it('ignores placeholder model messages for text and usage model', () => {
    const p = parseClaudeLine(lines[11]!, claudeCtx)!
    expect(p.events).toEqual([])
    expect(p.model).toBeUndefined()
    expect(p.text).toBeUndefined()
  })

  it('resolves Windows paths and relativizes them against a Windows repo root', () => {
    const win = { repoRoot: 'C:\\Users\\dev\\proj', agentId: 'W' }
    const line = JSON.stringify({
      type: 'assistant',
      cwd: 'C:\\Users\\dev\\proj',
      uuid: 'w1',
      timestamp: '2026-10-13T10:00:00.000Z',
      message: {
        model: 'claude-opus-4-1',
        id: 'msg_w',
        content: [
          { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'C:\\Users\\dev\\proj\\src\\app.ts', old_string: 'a', new_string: 'b' } },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'c:/users/dev/proj/src/lib/x.ts' } },
          { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: 'D:\\other\\y.ts' } }
        ],
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }
      }
    })
    const p = parseClaudeLine(line, win)!
    expect(p.events.map((e) => e.file)).toEqual(['src/app.ts', 'src/lib/x.ts', undefined])
  })

  it('gives every event in the fixture a unique id', () => {
    const ids = lines.flatMap((l) => parseClaudeLine(l, claudeCtx)?.events.map((e) => e.id) ?? [])
    expect(ids.length).toBeGreaterThan(10)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('parseClaudeLine subagent lines', () => {
  it('keeps the subagent agentId from the file context and reads the first prompt', () => {
    const lines = fixture('claude-subagent.jsonl')
    const first = parseClaudeLine(lines[0]!, { repoRoot: REPO, agentId: 'abc123def456789' })!
    expect(first.userText).toMatch(/login tests/)
    const bash = parseClaudeLine(lines[1]!, { repoRoot: REPO, agentId: 'abc123def456789' })!
    expect(bash.events[0]).toMatchObject({ type: 'command', text: 'npm test -- login', agentId: 'abc123def456789' })
    expect(bash.usage).toMatchObject({ messageId: 'msg_s1', input: 4, output: 40, cacheRead: 1000, cacheWrite: 0 })
  })
})

describe('parseApplyPatch', () => {
  it('counts +/- lines per section and maps Add/Update/Delete', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      '-old line',
      '+new line',
      '+another line',
      '*** Add File: src/new.ts',
      '+export const x = 1',
      '*** Delete File: src/old.ts',
      '*** End Patch',
      ''
    ].join('\n')
    const events = parseApplyPatch(patch, { repoRoot: REPO, agentId: 'a' }, { id: 'p', ts: 5 })
    expect(events.map((e) => [e.type, e.file, e.linesAdded, e.linesRemoved])).toEqual([
      ['edit', 'src/app.ts', 2, 1],
      ['create', 'src/new.ts', 1, 0],
      ['delete', 'src/old.ts', 0, 0]
    ])
  })

  it('edits the destination of a move', () => {
    const patch = '*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y\n*** End Patch'
    const [ev] = parseApplyPatch(patch, { repoRoot: REPO, agentId: 'a', base: REPO + '/src' }, { id: 'm', ts: 1 })
    expect(ev).toMatchObject({ type: 'edit', file: 'src/b.ts', linesAdded: 1, linesRemoved: 1 })
  })
})

describe('parseCodexLine', () => {
  const lines = fixture('codex-rollout.jsonl')

  it('reads session_meta and turn_context', () => {
    expect(parseCodexLine(lines[0]!, codexCtx)).toMatchObject({ sessionId: 'codex-sess-0001', cwd: REPO })
    expect(parseCodexLine(lines[1]!, codexCtx)).toMatchObject({ model: 'gpt-5-codex', cwd: REPO })
  })

  it('maps reasoning and shell function_call to thinking and command', () => {
    expect(parseCodexLine(lines[2]!, codexCtx)!.events.map((e) => e.type)).toEqual(['thinking'])
    const shell = parseCodexLine(lines[3]!, codexCtx)!
    expect(shell.events).toMatchObject([{ type: 'command', text: 'npm test' }])
  })

  it('reports cumulative token totals with cached input split out', () => {
    const tc = parseCodexLine(lines[4]!, codexCtx)!
    expect(tc.totalUsage).toEqual({ input: 1000, output: 50, cacheRead: 200, cacheWrite: 0 })
    expect(tc.usage).toBeUndefined()
  })

  it('maps apply_patch custom tool calls to file events', () => {
    const p = parseCodexLine(lines[5]!, codexCtx)!
    expect(p.events.map((e) => [e.type, e.file, e.linesAdded, e.linesRemoved])).toEqual([
      ['edit', 'src/app.ts', 2, 1],
      ['create', 'src/new.ts', 1, 0],
      ['delete', 'src/old.ts', 0, 0]
    ])
  })

  it('detects apply_patch run through the shell and does not emit a command for it', () => {
    const p = parseCodexLine(lines[7]!, codexCtx)!
    expect(p.events.map((e) => [e.type, e.file, e.linesAdded, e.linesRemoved])).toEqual([
      ['edit', 'README.md', 1, 1]
    ])
  })

  it('reads agent_message text and ignores the duplicate response_item message', () => {
    const msg = parseCodexLine(lines[8]!, codexCtx)!
    expect(msg.events).toMatchObject([{ type: 'message', text: 'Done. Added the new module and ran the tests.' }])
    expect(parseCodexLine(lines[9]!, codexCtx)).toBeNull()
  })

  it('resolves relative patch paths against the session cwd', () => {
    const line = JSON.stringify({
      timestamp: '2026-10-13T11:00:00.000Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: x.ts\n+1\n*** End Patch' }
    })
    const p = parseCodexLine(line, { repoRoot: REPO, agentId: 'c', cwd: REPO + '/src' })!
    expect(p.events[0]).toMatchObject({ type: 'create', file: 'src/x.ts' })
  })

  it('returns null for junk', () => {
    expect(parseCodexLine('', codexCtx)).toBeNull()
    expect(parseCodexLine('nope', codexCtx)).toBeNull()
    expect(parseCodexLine('[1,2]', codexCtx)).toBeNull()
  })
})
