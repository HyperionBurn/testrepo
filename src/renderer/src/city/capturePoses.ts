// Named camera poses for marketing shots, in world units (1 unit = 10 m, y up) around the repo district at the origin.
// Pure: the ShotRig resolves them against the live layout, agents and metro plan. Geography comes from metro.ts:
// the Hudson is the western river band, the East River the eastern one, the bridge decks cross them, and the
// downtown cores come from metroCores(seed) (the same seed buildMetro uses), so the aerial shot always frames the
// densest core of the repo's own metropolis. Positions are first passes, to be tuned on screen.
import type { AgentInfo, CityLayout } from '@shared/types'
import { findBuilding } from '../../../shared/layout'
import { visCenter, visHeight } from './geom'
import { hashName, metroCores, RIVER_INNER, RIVER_OUTER, type Core } from './metro'
import type { ShotPose } from './capture'

export interface Vec3 { x: number; y: number; z: number }
export interface PoseTarget { pos: Vec3; look: Vec3 }

export interface PoseContext {
  repoName: string
  layout: CityLayout | null
  agents: readonly AgentInfo[]
}

/** The river band centre on the west side: the Hudson. */
const HUDSON_X = -(RIVER_INNER + RIVER_OUTER) / 2

/** Pose for a named shot, or null for 'overview' (the default framing the rig already computes). */
export function poseFor(pose: ShotPose, ctx: PoseContext): PoseTarget | null {
  switch (pose) {
    case 'overview':
      return null
    case 'hudson-blue':
      return hudsonBlue()
    case 'midtown-aerial':
      return midtownAerial(metroCores(hashName(ctx.repoName)))
    case 'canyon':
      return canyon(ctx.layout, ctx.agents)
  }
}

/** Low over the water, a little north of the mid-river, looking east across the repo district. The far skyline
 *  (the East River bank and beyond) sits behind it. */
export function hudsonBlue(): PoseTarget {
  return {
    pos: { x: HUDSON_X, y: 11, z: 44 },
    look: { x: 20, y: 9, z: -16 }
  }
}

/** High oblique over the densest core outside the repo square, looking back toward it. */
export function midtownAerial(cores: readonly Core[]): PoseTarget {
  const far = cores.filter((c) => Math.hypot(c.x, c.z) > 320)
  let best: Core | null = null
  for (const c of far) {
    if (!best || c.strength * c.r > best.strength * best.r) best = c
  }
  if (!best) return { pos: { x: 420, y: 200, z: -360 }, look: { x: 60, y: 20, z: -40 } }
  const d = Math.hypot(best.x, best.z)
  const ux = best.x / d
  const uz = best.z / d
  return {
    pos: { x: best.x + ux * 150, y: 170, z: best.z + uz * 150 },
    look: { x: best.x * 0.3, y: 20, z: best.z * 0.3 }
  }
}

/** Street level in the repo district, beside the building an agent is editing (or the nearest one when none is). */
export function canyon(layout: CityLayout | null, agents: readonly AgentInfo[]): PoseTarget | null {
  if (!layout || layout.buildings.length === 0) return null
  const editing = agents.find((a) => (a.status === 'editing' || a.status === 'running') && a.currentFile)
  const b = (editing?.currentFile ? findBuilding(layout, editing.currentFile) : undefined) ?? layout.buildings[0]
  if (!b) return null
  const c = visCenter(b, layout)
  const h = visHeight(b, layout)
  return {
    pos: { x: c.x + b.w / 2 + 6, y: 0.9, z: c.z + b.d / 2 + 4 },
    look: { x: c.x, y: Math.min(h * 0.45, 9), z: c.z }
  }
}
