// Reads a repo file for the renderer (readFile, explain). Path and symlink checks happen here.
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { resolveInside } from './paths'

export const READ_LIMIT_BYTES = 200 * 1024

/** True when any segment of a relative path is `.git`. Case-folded on Windows, where `.GIT` is the same folder. */
export function hasGitSegment(rel: string, caseInsensitive: boolean = process.platform === 'win32'): boolean {
  return rel.split(/[\\/]/).some((seg) => (caseInsensitive ? seg.toLowerCase() : seg) === '.git')
}

/**
 * First `maxBytes` of a repo file as UTF-8. Refuses paths outside the root, anything under `.git`
 * (checked on the lexical path and on the resolved one, so a symlink into .git is refused too),
 * symlinks that resolve outside the root, and non-files.
 */
export async function readRepoText(root: string, rel: string, maxBytes = READ_LIMIT_BYTES): Promise<string> {
  const abs = resolveInside(root, rel)
  if (hasGitSegment(path.relative(path.resolve(root), abs))) {
    throw new Error('Git internals are not readable')
  }
  const [realRoot, realAbs] = await Promise.all([fsp.realpath(root), fsp.realpath(abs)])
  const inside = path.relative(realRoot, realAbs)
  if (inside === '' || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) {
    throw new Error('Path is outside the repository')
  }
  if (hasGitSegment(inside)) throw new Error('Git internals are not readable')
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
