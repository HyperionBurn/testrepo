// Pure path guard for renderer-supplied repo paths. No fs access, so it is unit-testable.
import * as path from 'node:path'

/**
 * Resolves a repo-relative (or in-repo absolute) path against `root` and throws unless it names a
 * strictly inside location. Rejects "..", absolute paths outside root, NUL bytes and the root itself.
 */
export function resolveInside(root: string, rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('A file path is required')
  if (rel.includes('\0')) throw new Error('Invalid file path')
  const base = path.resolve(root)
  const abs = path.resolve(base, rel)
  const inside = path.relative(base, abs)
  if (inside === '') throw new Error('Path must name a file inside the repository')
  if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) {
    throw new Error('Path is outside the repository')
  }
  return abs
}
