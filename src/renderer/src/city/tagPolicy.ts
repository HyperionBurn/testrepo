// Name-tag policy for the agent drones: which tags show, and where they sit on screen. Pure (no three.js, no DOM),
// so the rules are tested under vitest. Drones.tsx projects each tag, asks selectTags for the visible set and
// stackTags for the vertical offsets that keep them apart.
import type { AgentStatus } from '@shared/types'

/** Most tags on screen at once. Beyond this the busiest agents win; the rest stay as drones without a label. */
export const MAX_TAGS = 4

const ACTIVE: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['thinking', 'editing', 'reading', 'running'])

export interface TagCandidate {
  id: string
  status: AgentStatus
  /** A subagent escort (no cost line). Escorts rank after primary agents. */
  sub: boolean
  /** Depth in normalised device coordinates (smaller is nearer the camera). */
  depth: number
  /** Projected anchor, screen pixels. */
  x: number
  y: number
  w: number
  h: number
}

/**
 * The ids of the tags to show: active agents only (idle and done ones are hidden), primary agents before escorts,
 * then the nearest to the camera, at most `max`.
 */
export function selectTags(cands: readonly TagCandidate[], max = MAX_TAGS): Set<string> {
  const pool = cands.filter((c) => ACTIVE.has(c.status))
  pool.sort((a, b) => Number(a.sub) - Number(b.sub) || a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return new Set(pool.slice(0, Math.max(0, max)).map((c) => c.id))
}

interface Box { l: number; r: number; t: number; b: number }

/**
 * Vertical offsets (pixels, positive is down) that stop the tags from overlapping. Tags are placed top to bottom;
 * a tag that would overlap a placed one is pushed below it, up to `tries` times. Returns only non-zero offsets.
 */
export function stackTags(cands: readonly TagCandidate[], gap: number, tries = 8): Map<string, number> {
  const items = [...cands].sort((a, b) => a.y - b.y || (a.id < b.id ? -1 : 1))
  const placed: Box[] = []
  const out = new Map<string, number>()
  for (const it of items) {
    let y = it.y
    for (let k = 0; k < tries; k++) {
      const box: Box = { l: it.x - it.w / 2, r: it.x + it.w / 2, t: y - it.h / 2, b: y + it.h / 2 }
      const hit = placed.find((p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t)
      if (!hit) {
        placed.push(box)
        break
      }
      y = hit.b + gap + it.h / 2
    }
    const dy = Math.round(y - it.y)
    if (dy !== 0) out.set(it.id, dy)
  }
  return out
}
