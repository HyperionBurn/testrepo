// Incremental JSONL reader: remembers a byte offset per file, returns only complete new lines,
// buffers a trailing partial line until its newline arrives, and resets on truncation or rotation.
// Each call consumes at most `maxBytes`, so a large backlog is read over several calls.
import { promises as fsp } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

const MIB = 1024 * 1024
const DEFAULT_MAX_BYTES = 4 * MIB

interface FileState {
  /** Bytes consumed from the file so far (including bytes held in `pending`). */
  offset: number
  /** File size seen at the last read. */
  size: number
  /** Inode seen last time; a different inode means the file was replaced. */
  ino: number
  /** Bytes after the last newline, waiting for the rest of the line. */
  pending: Buffer
  /** True while discarding an over-long line until its newline. */
  skipping: boolean
}

export interface JsonlTailerOptions {
  /** Bytes read per fs call. Default 1 MiB. */
  chunkBytes?: number
  /** Longest partial line kept in memory before it is dropped. Default 32 MiB. */
  maxPendingBytes?: number
  /** A file first seen above this size starts `tailStartBytes` before its end. Default 50 MiB. */
  largeFileBytes?: number
  /** Where a first read of a large file starts, counted back from its end. Default 20 MiB. */
  tailStartBytes?: number
}

export interface ReadOptions {
  /** Most bytes consumed by one call (complete lines returned never exceed this). Default 4 MiB. */
  maxBytes?: number
}

export interface ReadChunk {
  /** Complete lines read by this call, no trailing newlines. */
  lines: string[]
  /** Bytes consumed by this call. */
  bytes: number
  /** True when the file holds bytes this call did not reach; call again after yielding. */
  more: boolean
}

const EMPTY: ReadChunk = { lines: [], bytes: 0, more: false }

export class JsonlTailer {
  private readonly states = new Map<string, FileState>()
  private readonly chunkBytes: number
  private readonly maxPendingBytes: number
  private readonly largeFileBytes: number
  private readonly tailStartBytes: number

  constructor(opts: JsonlTailerOptions = {}) {
    this.chunkBytes = opts.chunkBytes ?? MIB
    this.maxPendingBytes = opts.maxPendingBytes ?? 32 * MIB
    this.largeFileBytes = opts.largeFileBytes ?? 50 * MIB
    this.tailStartBytes = opts.tailStartBytes ?? 20 * MIB
  }

  /** Returns the complete lines appended to `file` since the last call (at most `maxBytes` consumed). */
  async read(file: string, opts: ReadOptions = {}): Promise<string[]> {
    return (await this.readChunk(file, opts)).lines
  }

  /** Like `read`, also reporting how many bytes were consumed and whether more remain unread. */
  async readChunk(file: string, opts: ReadOptions = {}): Promise<ReadChunk> {
    const maxBytes = Math.max(1, Math.floor(opts.maxBytes ?? DEFAULT_MAX_BYTES))
    let fh: FileHandle
    try {
      fh = await fsp.open(file, 'r')
    } catch (err) {
      if (isNotFound(err)) this.states.delete(file)
      return EMPTY
    }
    try {
      const st = await fh.stat()
      const known = this.states.get(file)
      let state: FileState
      if (!known) {
        state = {
          offset: await this.startOffset(fh, st.size),
          size: st.size,
          ino: st.ino,
          pending: Buffer.alloc(0),
          skipping: false
        }
      } else if ((known.ino !== 0 && st.ino !== 0 && known.ino !== st.ino) || st.size < known.offset) {
        // Replaced or truncated file: start over.
        state = { offset: 0, size: st.size, ino: st.ino, pending: Buffer.alloc(0), skipping: false }
      } else {
        state = known
      }
      this.states.set(file, state)

      const lines: string[] = []
      let pos = state.offset
      let pending = state.pending
      let skipping = state.skipping
      let consumed = 0
      while (pos < st.size && consumed < maxBytes) {
        const len = Math.min(this.chunkBytes, st.size - pos, maxBytes - consumed)
        const buf = Buffer.alloc(len)
        const { bytesRead } = await fh.read(buf, 0, len, pos)
        if (bytesRead === 0) break
        pos += bytesRead
        consumed += bytesRead
        const data: Buffer = pending.length > 0 ? Buffer.concat([pending, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
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
      state.size = st.size
      state.pending = pending
      state.skipping = skipping
      state.ino = st.ino
      return { lines, bytes: consumed, more: pos < st.size }
    } catch (err) {
      // Read errors (file vanished mid-read, permissions) are not fatal; retry next time.
      if (isNotFound(err)) this.states.delete(file)
      return EMPTY
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

  /**
   * Where the first read of a file starts. A file above `largeFileBytes` starts at the first line
   * that begins after `size - tailStartBytes`: older history is not read at all. Accepted trade-off
   * for huge old transcripts, whose early turns are not shown.
   */
  private async startOffset(fh: FileHandle, size: number): Promise<number> {
    if (size <= this.largeFileBytes) return 0
    const start = size - this.tailStartBytes
    if (start <= 0) return 0
    // Search from the byte before `start`, so a start that already sits on a line boundary is kept.
    let pos = start - 1
    const buf = Buffer.alloc(this.chunkBytes)
    while (pos < size) {
      const len = Math.min(buf.length, size - pos)
      const { bytesRead } = await fh.read(buf, 0, len, pos)
      if (bytesRead === 0) break
      const nl = buf.subarray(0, bytesRead).indexOf(0x0a)
      if (nl !== -1) return pos + nl + 1
      pos += bytesRead
    }
    return size
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
