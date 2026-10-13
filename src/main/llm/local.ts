// Local LLM service (node-llama-cpp). Owns the model file, the lazy load, a single-flight request
// queue, and the heuristic fallbacks. Nothing here runs until digest/explain/download is called,
// and node-llama-cpp is only imported inside methods so this module loads even if its native
// bindings are broken.
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AgentEvent, AgentInfo, Digest, LlmStatus } from '../../shared/types'
import type { Llama, LlamaContext, LlamaContextSequence, LlamaModel, ModelDownloader } from 'node-llama-cpp'
import { digestTotalsLine, heuristicDigest, heuristicExplain } from './heuristic'
import { buildDigestMessages, buildExplainMessages } from './prompts'
import { errorMessage } from './text'

export const DEFAULT_MODEL_URI =
  'hf:Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf'

const CONTEXT_SIZE = 4096
const DIGEST_MAX_TOKENS = 350
const EXPLAIN_MAX_TOKENS = 350
const TEMPERATURE = 0.3
// Discourages the small model from looping on repeated list items.
const REPEAT_PENALTY = { penalty: 1.15, frequencyPenalty: 0.2, presencePenalty: 0.1, lastTokens: 128 }
// A full-budget prompt (about 2400 tokens) plus 350 output tokens takes roughly 2 minutes on a
// 4-core CPU, so the cap has to leave room for that.
const GENERATION_TIMEOUT_MS = 300_000
/** digest() answers with the heuristic when the model has not finished within this long. */
export const DIGEST_WAIT_MS = 20_000
/** Model label on a heuristic digest returned while the model is still working. */
export const STILL_THINKING_MODEL = 'heuristic (LLM still thinking)'
const PROGRESS_EMIT_MIN_DELTA = 0.005
const PROGRESS_EMIT_MIN_INTERVAL_MS = 250

export interface LocalLlmOptions {
  /** Directory the model file lives in (created by the downloader if missing). */
  modelsDir: string
  /** node-llama-cpp model URI. Defaults to DEFAULT_MODEL_URI. */
  modelUri?: string
  /** How long digest() waits for the model before answering with the heuristic. Default DIGEST_WAIT_MS. */
  digestWaitMs?: number
}

/** Extra event, beyond the contract: one per completed generation, for timing and diagnostics. */
export interface GenerationStats {
  promptTokens: number
  outputTokens: number
  ms: number
}

/**
 * Local file name for a model URI. It is pinned explicitly when downloading, so the path is known
 * without asking the network (node-llama-cpp would otherwise name `hf:` files `hf_<user>_<file>`).
 * `hf:user/repo/file.gguf` and `https://…/file.gguf` keep their basename; anything else gets a
 * sanitised name, e.g. `hf:user/repo:Q4_K_M` becomes `user_repo_Q4_K_M.gguf`.
 */
export function modelFileNameFor(modelUri: string): string {
  const withoutBranch = modelUri.split('#')[0]
  const last = withoutBranch.split('/').pop() ?? ''
  if (/\.gguf$/i.test(last)) return last
  const stem = withoutBranch
    .replace(/^[a-z]+:/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${stem || 'model'}.gguf`
}

export class LocalLlm extends EventEmitter {
  private readonly modelsDir: string
  private readonly modelUri: string
  private readonly digestWaitMs: number
  /** Where the model file is or will be. */
  private modelPath: string

  private current: LlmStatus
  private llama?: Llama
  private model?: LlamaModel
  private context?: LlamaContext
  private sequence?: LlamaContextSequence

  private loading?: Promise<void>
  private downloading?: Promise<void>
  private downloader?: ModelDownloader
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(opts: LocalLlmOptions) {
    super()
    this.modelsDir = opts.modelsDir
    this.modelUri = opts.modelUri?.trim() || DEFAULT_MODEL_URI
    this.digestWaitMs = opts.digestWaitMs ?? DIGEST_WAIT_MS
    this.modelPath = join(this.modelsDir, modelFileNameFor(this.modelUri))
    this.current = this.diskStatus()
  }

  /**
   * 'absent' when the model file is not on disk, 'downloading' / 'loading' / 'error' while those
   * operations run or after they fail, and 'ready' once loaded. A file that is on disk but not
   * loaded yet also reports 'ready': it can be used and loads on first digest/explain.
   */
  status(): LlmStatus {
    if (!this.busy() && !this.isLoaded() && this.current.state !== 'error') {
      this.setStatus(this.diskStatus())
    }
    return { ...this.current }
  }

  /** Downloads the model with progress events. Resolves immediately if it is already on disk. */
  async download(): Promise<void> {
    if (this.disposed) throw new Error('LocalLlm is disposed')
    if (this.downloading) return this.downloading

    const onDisk = this.modelOnDisk()
    if (onDisk && this.current.state !== 'error') {
      this.setStatus(this.isLoaded() ? this.readyStatus() : this.diskStatus())
      return
    }
    this.downloading = this.runDownload(onDisk)
    try {
      await this.downloading
    } finally {
      this.downloading = undefined
    }
  }

  /**
   * Summary of agent activity: an exact totals line (computed, never generated) followed by the
   * model's bullets. Uses the model when it is on disk and usable, otherwise the heuristic digest.
   * If the model has not answered within digestWaitMs, returns the heuristic digest at once
   * (model 'heuristic (LLM still thinking)') and emits 'digest' with the model's digest when it is
   * ready. Never throws and never waits for a download.
   */
  async digest(events: AgentEvent[], agents: AgentInfo[], repoName: string): Promise<Digest> {
    const now = Date.now()
    const fallback = (model = 'heuristic'): Digest => ({ generatedAt: now, text: heuristicDigest(events, agents, now), model })
    if (this.disposed || this.downloading || events.length === 0 || !this.modelOnDisk()) return fallback()

    const work = this.enqueue(async (): Promise<Digest> => {
      if (this.disposed) return fallback()
      try {
        const msgs = buildDigestMessages({ events, agents, repoName, now })
        const narrative = await this.generate(msgs.system, msgs.user, DIGEST_MAX_TOKENS)
        if (!narrative) return fallback()
        const text = `${digestTotalsLine(events, agents, now)}\n\n${narrative}`
        return { generatedAt: now, text, model: this.modelUri }
      } catch (err) {
        this.emit('generation-error', errorMessage(err))
        return fallback()
      }
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.digestWaitMs)
    })
    const first = await Promise.race([work, deadline])
    clearTimeout(timer)
    if (first) return first

    // The model is still busy (loading or generating). The caller gets the heuristic now; the model's
    // digest follows as a 'digest' event. Errors inside work are already turned into a fallback.
    void work.then(
      (late) => {
        if (!this.disposed) this.emit('digest', late)
      },
      () => undefined
    )
    return fallback(STILL_THINKING_MODEL)
  }

  /** Plain-English explanation of a file (two paragraphs), or a heuristic description. */
  async explain(path: string, content: string, repoName: string): Promise<string> {
    const fallback = (): string => heuristicExplain(path, content, repoName)
    if (this.disposed || this.downloading || !this.modelOnDisk()) return fallback()

    return this.enqueue(async (): Promise<string> => {
      if (this.disposed) return fallback()
      try {
        const msgs = buildExplainMessages({ path, content, repoName })
        const text = await this.generate(msgs.system, msgs.user, EXPLAIN_MAX_TOKENS)
        return text || fallback()
      } catch (err) {
        this.emit('generation-error', errorMessage(err))
        return fallback()
      }
    })
  }

  /** Waits for in-flight work, cancels a download, and frees the native model and context. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try {
      await this.downloader?.cancel()
    } catch {
      // The download promise reports the cancellation to its caller.
    }
    await this.queue
    await this.loading?.catch(() => undefined)
    const seq = this.sequence
    const ctx = this.context
    const model = this.model
    const llama = this.llama
    this.sequence = undefined
    this.context = undefined
    this.model = undefined
    this.llama = undefined
    await seq?.dispose().catch(() => undefined)
    await ctx?.dispose().catch(() => undefined)
    await model?.dispose().catch(() => undefined)
    await llama?.dispose().catch(() => undefined)
  }

  // ---- internals ----------------------------------------------------------------------------

  private busy(): boolean {
    return this.downloading !== undefined || this.loading !== undefined
  }

  private isLoaded(): boolean {
    return this.model !== undefined && this.context !== undefined && this.sequence !== undefined
  }

  private modelOnDisk(): boolean {
    return existsSync(this.modelPath)
  }

  private diskStatus(): LlmStatus {
    return this.modelOnDisk() ? this.readyStatus() : { state: 'absent', model: this.modelUri }
  }

  private readyStatus(): LlmStatus {
    return { state: 'ready', model: this.modelUri }
  }

  private setStatus(next: LlmStatus): void {
    const prev = this.current
    if (
      prev.state === next.state &&
      prev.progress === next.progress &&
      prev.error === next.error &&
      prev.model === next.model
    ) {
      return
    }
    this.current = next
    this.emit('status', { ...next })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async runDownload(forceRedownload: boolean): Promise<void> {
    this.setStatus({ state: 'downloading', progress: 0, model: this.modelUri })
    let lastEmitAt = 0
    let lastProgress = -1
    try {
      const { createModelDownloader } = await import('node-llama-cpp')
      const downloader = await createModelDownloader({
        modelUri: this.modelUri,
        dirPath: this.modelsDir,
        fileName: basename(this.modelPath),
        skipExisting: !forceRedownload,
        showCliProgress: false,
        onProgress: ({ totalSize, downloadedSize }) => {
          const progress = totalSize > 0 ? Math.min(1, downloadedSize / totalSize) : 0
          const at = Date.now()
          if (progress - lastProgress < PROGRESS_EMIT_MIN_DELTA && at - lastEmitAt < PROGRESS_EMIT_MIN_INTERVAL_MS) {
            return
          }
          lastProgress = progress
          lastEmitAt = at
          this.setStatus({ state: 'downloading', progress, model: this.modelUri })
        }
      })
      this.downloader = downloader
      this.modelPath = downloader.entrypointFilePath
      await downloader.download()
      this.downloader = undefined
      this.setStatus(this.isLoaded() ? this.readyStatus() : this.diskStatus())
    } catch (err) {
      this.downloader = undefined
      this.setStatus({ state: 'error', error: errorMessage(err), model: this.modelUri })
      throw err
    }
  }

  /** Loads the model once; concurrent callers share the same load. Errors leave state 'error'. */
  private ensureLoaded(): Promise<void> {
    if (this.isLoaded()) return Promise.resolve()
    if (!this.loading) {
      this.loading = this.load().finally(() => {
        this.loading = undefined
      })
    }
    return this.loading
  }

  private async load(): Promise<void> {
    const modelPath = this.modelPath
    if (!existsSync(modelPath)) {
      throw new Error(`model file not found in ${this.modelsDir}`)
    }
    this.setStatus({ state: 'loading', model: this.modelUri })
    try {
      const { getLlama } = await import('node-llama-cpp')
      const llama = this.llama ?? (await getLlama({ gpu: 'auto' }))
      this.llama = llama
      const model = await llama.loadModel({ modelPath })
      const context = await model.createContext({ contextSize: CONTEXT_SIZE })
      if (this.disposed) {
        await context.dispose().catch(() => undefined)
        await model.dispose().catch(() => undefined)
        throw new Error('LocalLlm was disposed while loading')
      }
      this.model = model
      this.context = context
      this.sequence = context.getSequence()
      this.setStatus(this.readyStatus())
    } catch (err) {
      this.setStatus({ state: 'error', error: errorMessage(err), model: this.modelUri })
      throw err
    }
  }

  /** One chat turn on the shared sequence. Only call from inside enqueue(). */
  private async generate(system: string, user: string, maxTokens: number): Promise<string> {
    await this.ensureLoaded()
    const model = this.model
    const sequence = this.sequence
    if (!model || !sequence) throw new Error('model is not loaded')

    const started = Date.now()
    await sequence.clearHistory()
    const { LlamaChatSession } = await import('node-llama-cpp')
    const session = new LlamaChatSession({ contextSequence: sequence, systemPrompt: system })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS)
    try {
      const raw = await session.prompt(user, {
        maxTokens,
        temperature: TEMPERATURE,
        repeatPenalty: REPEAT_PENALTY,
        signal: controller.signal
      })
      const text = raw.trim()
      const stats: GenerationStats = {
        promptTokens: model.tokenize(system + user).length,
        outputTokens: model.tokenize(text).length,
        ms: Date.now() - started
      }
      this.emit('generation', stats)
      return text
    } finally {
      clearTimeout(timer)
      await session.dispose()
    }
  }
}
