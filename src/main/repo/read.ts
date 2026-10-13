// Reads a repo file for the renderer (readFile, explain). Path and symlink checks happen here.
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { resolveInside } from './paths'

export const READ_LIMIT_BYTES = 200 * 1024

/**
 * First `maxBytes` of a repo file as UTF-8. Refuses paths outside the root, anything under `.git`,
 * symlinks that resolve outside the root, and non-files.
 */
export async function readRepoText(root: string, rel: string, maxBytes = READ_LIMIT_BYTES): Promise<string> {
  const abs = resolveInside(root, rel)
  if (path.relative(path.resolve(root), abs).split(path.sep).includes('.git')) {
    throw new Error('Git internals are not readable')
  }
  const [realRoot, realAbs] = await Promise.all([fsp.realpath(root), fsp.realpath(abs)])
  const inside = path.relative(realRoot, realAbs)
  if (inside === '' || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) {
    throw new Error('Path is outside the repository')
  }
  const st = await fsp.stat(realAbs)
  if (!st.isFile()) throw new Error('Not a file')
  const fh = await fsp.open(realAbs, 'r')
  try {
    const buf = Buffer.alloc(Math.min(maxBytes, st.size))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}
