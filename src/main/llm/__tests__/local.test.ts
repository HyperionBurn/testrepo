import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { AgentEvent, AgentInfo, LlmStatus } from '../../../shared/types'
import { DEFAULT_MODEL_URI, LocalLlm, modelFileNameFor } from '../local'
import { heuristicDigest, heuristicExplain } from '../heuristic'

const DEFAULT_FILE = 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf'
const T0 = 1_780_000_000_000

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'skyline-llm-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const events: AgentEvent[] = [
  { id: '1', agentId: 'a1', type: 'edit', ts: T0, file: 'src/main/x.ts', linesAdded: 2, linesRemoved: 0 },
  { id: '2', agentId: 'a1', type: 'command', ts: T0 + 60_000, text: 'npm test' }
]
const agents: AgentInfo[] = [
  {
    id: 'a1',
    kind: 'claude-code',
    name: 'Claude · a1',
    cwd: '/repo',
    startedAt: T0,
    lastActiveAt: T0 + 60_000,
    status: 'idle',
    costUsd: 0.5,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    filesTouched: ['src/main/x.ts'],
    edits: 1,
    reads: 0,
    commands: 1,
    color: '#fff'
  }
]

describe('modelFileNameFor', () => {
  it('reads the file name from direct and hf file URIs', () => {
    expect(modelFileNameFor(DEFAULT_MODEL_URI)).toBe(DEFAULT_FILE)
    expect(modelFileNameFor('https://example.com/models/tiny.GGUF')).toBe('tiny.GGUF')
    expect(modelFileNameFor('hf:user/repo/file.gguf#main')).toBe('file.gguf')
  })

  it('pins a sanitised file name for quant-style URIs so the path is known without the network', () => {
    expect(modelFileNameFor('hf:user/repo:Q4_K_M')).toBe('user_repo_Q4_K_M.gguf')
  })

  it('reports ready after a restart when the model was downloaded earlier', () => {
    writeFileSync(path.join(dir, modelFileNameFor('hf:user/repo:Q4_K_M')), 'x')
    const llm = new LocalLlm({ modelsDir: dir, modelUri: 'hf:user/repo:Q4_K_M' })
    expect(llm.status().state).toBe('ready')
  })
})

describe('LocalLlm', () => {
  it('reports absent when the model file is not in an empty models directory', () => {
    const llm = new LocalLlm({ modelsDir: dir })
    expect(llm.status()).toEqual({ state: 'absent', model: DEFAULT_MODEL_URI })
  })

  it('reports ready when the model file is on disk, before it is loaded', () => {
    writeFileSync(path.join(dir, DEFAULT_FILE), 'not really a model')
    const llm = new LocalLlm({ modelsDir: dir })
    expect(llm.status().state).toBe('ready')
  })

  it('falls back to the heuristic digest when the model is absent, without downloading anything', async () => {
    const statuses: LlmStatus[] = []
    const llm = new LocalLlm({ modelsDir: dir })
    llm.on('status', (s: LlmStatus) => statuses.push(s))

    const digest = await llm.digest(events, agents, 'acme')

    expect(digest.model).toBe('heuristic')
    expect(digest.text).toBe(heuristicDigest(events, agents, digest.generatedAt))
    expect(readdirSync(dir)).toEqual([])
    expect(statuses).toEqual([])
    expect(llm.status().state).toBe('absent')
  })

  it('returns the quiet message for an empty window', async () => {
    const llm = new LocalLlm({ modelsDir: dir })
    const digest = await llm.digest([], [], 'acme')
    expect(digest.model).toBe('heuristic')
    expect(digest.text).toContain('All quiet')
  })

  it('falls back to the heuristic explanation when the model is absent', async () => {
    const llm = new LocalLlm({ modelsDir: dir })
    const content = 'export function f() {}\n'
    const text = await llm.explain('src/main/x.ts', content, 'acme')
    expect(text).toBe(heuristicExplain('src/main/x.ts', content, 'acme'))
    await llm.dispose()
  })

  it('falls back to the heuristic digest and reports error when the model file is corrupt', async () => {
    writeFileSync(path.join(dir, DEFAULT_FILE), 'this is not a gguf file')
    const llm = new LocalLlm({ modelsDir: dir })
    try {
      const digest = await llm.digest(events, agents, 'acme')
      expect(digest.model).toBe('heuristic')
      expect(llm.status().state).toBe('error')
      expect(llm.status().error).toBeTruthy()
      // A later call still works and still does not throw.
      const again = await llm.explain('src/main/x.ts', 'const a = 1\n', 'acme')
      expect(again).toContain('`src/main/x.ts`')
    } finally {
      await llm.dispose()
    }
  }, 120_000)
})
