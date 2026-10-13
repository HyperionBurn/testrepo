import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { JsonlTailer } from '../tail'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'skyline-tail-'))
  file = path.join(dir, 'session.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('JsonlTailer', () => {
  it('returns complete lines and only new lines on later reads', async () => {
    const t = new JsonlTailer()
    writeFileSync(file, 'a\nb\n')
    expect(await t.read(file)).toEqual(['a', 'b'])
    expect(await t.read(file)).toEqual([])
    appendFileSync(file, 'c\n')
    expect(await t.read(file)).toEqual(['c'])
    expect(t.offsetOf(file)).toBe(Buffer.byteLength('a\nb\nc\n'))
  })

  it('buffers a partial trailing line until its newline arrives', async () => {
    const t = new JsonlTailer()
    writeFileSync(file, '{"x":')
    expect(await t.read(file)).toEqual([])
    appendFileSync(file, '1}\n{"y"')
    expect(await t.read(file)).toEqual(['{"x":1}'])
    appendFileSync(file, ':2}\n')
    expect(await t.read(file)).toEqual(['{"y":2}'])
  })

  it('does not split multi-byte characters across reads', async () => {
    const t = new JsonlTailer({ chunkBytes: 1 })
    const bytes = Buffer.from('é→x\n', 'utf8')
    writeFileSync(file, bytes.subarray(0, 1))
    expect(await t.read(file)).toEqual([])
    appendFileSync(file, bytes.subarray(1))
    expect(await t.read(file)).toEqual(['é→x'])
  })

  it('strips CRLF, skips blank lines, and reads big appends in chunks', async () => {
    const t = new JsonlTailer({ chunkBytes: 7 })
    const body = Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\r\n') + '\r\n\r\n'
    writeFileSync(file, body)
    const got = await t.read(file)
    expect(got).toHaveLength(50)
    expect(got[0]).toBe('line-0')
    expect(got[49]).toBe('line-49')
  })

  it('restarts from the beginning when the file is truncated', async () => {
    const t = new JsonlTailer()
    writeFileSync(file, 'first long line that is quite long\n')
    expect(await t.read(file)).toEqual(['first long line that is quite long'])
    writeFileSync(file, 'new\n') // same inode, smaller size
    expect(await t.read(file)).toEqual(['new'])
  })

  it('restarts when the file is replaced by a new inode (rotation)', async () => {
    const t = new JsonlTailer()
    writeFileSync(file, 'old-1\nold-2\n')
    expect(await t.read(file)).toEqual(['old-1', 'old-2'])
    const replacement = path.join(dir, 'replacement.jsonl')
    writeFileSync(replacement, 'rotated-1\nrotated-2\nrotated-3\n')
    renameSync(replacement, file)
    expect(await t.read(file)).toEqual(['rotated-1', 'rotated-2', 'rotated-3'])
  })

  it('returns nothing for a missing file and recovers when it appears', async () => {
    const t = new JsonlTailer()
    expect(await t.read(file)).toEqual([])
    writeFileSync(file, 'hello\n')
    expect(await t.read(file)).toEqual(['hello'])
  })

  it('discards an over-long line up to its newline and keeps going', async () => {
    const t = new JsonlTailer({ maxPendingBytes: 10 })
    writeFileSync(file, 'x'.repeat(50))
    expect(await t.read(file)).toEqual([])
    appendFileSync(file, 'yyyy\nok\n')
    expect(await t.read(file)).toEqual(['ok'])
  })

  it('forget() makes the next read start from the top', async () => {
    const t = new JsonlTailer()
    writeFileSync(file, 'a\n')
    expect(await t.read(file)).toEqual(['a'])
    t.forget(file)
    expect(await t.read(file)).toEqual(['a'])
  })
})
