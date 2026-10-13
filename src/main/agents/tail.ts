// Incremental JSONL reader: remembers a byte offset per file, returns only complete new lines,
// buffers a trailing partial line until its newline arrives, and resets on truncation or rotation.
import { promises as fsp } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

interface FileState {
  /** Bytes consumed from the file so far (including bytes held in `pending`). */
  offset: number
  /** Inode seen last time; a different inode means the file was replaced. */
  ino: number
  /** Bytes after the last newline, waiting for the rest of the line. */
  pending: Buffer
  /** True while discarding an over-long line until its newline. */
  skipping: boolean
}

export interface JsonlTailerOptions {
  /** Bytes read per chunk. Default 1 MiB. */
  chunkBytes?: number
  /** Longest partial line kept in memory before it is dropped. Default 32 MiB. */
  maxPendingBytes?: number
}

export class JsonlTailer {
  private readonly states = new Map<string, FileState>()
  private readonly chunkBytes: number
  private readonly maxPendingBytes: number

  constructor(opts: JsonlTailerOptions = {}) {
    this.chunkBytes = opts.chunkBytes ?? 1024 * 1024
    this.maxPendingBytes = opts.maxPendingBytes ?? 32 * 1024 * 1024
  }

  /** Returns the complete lines appended to `file` since the last call (no trailing newlines). */
  async read(file: string): Promise<string[]> {
    let fh: FileHandle
    try {
      fh = await fsp.open(file, 'r')
    } catch (err) {
      if (isNotFound(err)) this.states.delete(file)
      return []
    }
    try {
      const st = await fh.stat()
      let state = this.states.get(file)
      if (!state || (state.ino !== 0 && st.ino !== 0 && state.ino !== st.ino) || st.size < state.offset) {
        // New file, replaced file, or truncated file: start over.
        state = { offset: 0, ino: st.ino, pending: Buffer.alloc(0), skipping: false }
        this.states.set(file, state)
      }
      const lines: string[] = []
      let pos = state.offset
      let pending = state.pending
      let skipping = state.skipping
      while (pos < st.size) {
        const len = Math.min(this.chunkBytes, st.size - pos)
        const buf = Buffer.alloc(len)
        const { bytesRead } = await fh.read(buf, 0, len, pos)
        if (bytesRead === 0) break
        pos += bytesRead
        let data: Buffer = pending.length > 0 ? Buffer.concat([pending, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
        let start = 0
        for (;;) {
          const nl = data.indexOf(0x0a, start)
          if (nl === -1) break
          if (!skipping) pushLine(lines, data.subarray(start, nl))
          skipping = false
          start = nl + 1
        }
        pending = skipping ? Buffer.alloc(0) : Buffer.from(data.subarray(start))
        if (!skipping && pending.length > this.maxPendingBytes) {
          pending = Buffer.alloc(0)
          skipping = true
        }
      }
      state.offset = pos
      state.pending = pending
      state.skipping = skipping
      state.ino = st.ino
      return lines
    } catch (err) {
      // Read errors (file vanished mid-read, permissions) are not fatal; retry next time.
      if (isNotFound(err)) this.states.delete(file)
      return []
    } finally {
      await fh.close().catch(() => undefined)
    }
  }

  /** Stops tracking a file. The next read starts from the beginning. */
  forget(file: string): void {
    this.states.delete(file)
  }

  /** Byte offset consumed so far for a file (0 when untracked). */
  offsetOf(file: string): number {
    return this.states.get(file)?.offset ?? 0
  }

  /** Files currently tracked. */
  tracked(): string[] {
    return [...this.states.keys()]
  }
}

function pushLine(out: string[], bytes: Buffer): void {
  let end = bytes.length
  if (end > 0 && bytes[end - 1] === 0x0d) end-- // CRLF
  if (end === 0) return
  const text = bytes.subarray(0, end).toString('utf8')
  if (text.trim() !== '') out.push(text)
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT'
}
