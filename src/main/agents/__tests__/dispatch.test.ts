import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dispatchAgent, quoteForCmd } from '../dispatch'

describe('quoteForCmd', () => {
  it.each([
    ['plain', 'plain'],
    ['', '""'],
    ['a b', '"a b"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['line one\nline two', '"line one line two"'],
    ['a&b', '"a&b"']
  ])('quotes %j', (input, expected) => {
    expect(quoteForCmd(input)).toBe(expected)
  })

  it('doubles trailing backslashes so the closing quote is not escaped', () => {
    expect(quoteForCmd('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"')
  })
})

describe('dispatchAgent validation', () => {
  const root = process.cwd()
  let savedPath: string | undefined

  beforeEach(() => {
    savedPath = process.env.PATH
  })
  afterEach(() => {
    process.env.PATH = savedPath
  })

  it('rejects unknown kinds and empty prompts before spawning anything', async () => {
    await expect(dispatchAgent(root, { kind: 'cursor' as never, prompt: 'x', worktree: false })).rejects.toThrow(/Unknown agent kind/)
    await expect(dispatchAgent(root, { kind: 'codex', prompt: '   ', worktree: false })).rejects.toThrow(/empty/)
  })

  it('reports a friendly error when the CLI is not on PATH', async () => {
    process.env.PATH = ''
    await expect(dispatchAgent(root, { kind: 'claude-code', prompt: 'hi', worktree: false })).rejects.toThrow(
      'Claude Code CLI not found on PATH — install it from https://claude.com/claude-code'
    )
  })
})
