// Traffic signals: one emissive head per approach at every junction, lit red, amber or green by the same cycle the
// vehicles obey (lanes.ts signalPhase). Drawn as one additive light layer, so bloom picks the lit heads up.
import type { Network } from './lanes'
import { isSignalNode, PHASE_AMBER, PHASE_GREEN, PHASE_RED, signalOffset, signalPhase, type Phase } from './lanes'
import { LightPoints } from './Vehicles'
import { ROAD_Y } from './streets'

/** Height of the signal heads above the road, and their offset from the junction centre toward the approach. */
const HEAD_Y = 0.46
const HEAD_REACH = 0.42
/** Lit heads are bright enough to bloom. */
const LIT = 2.6

const COLOUR: Record<Phase, readonly [number, number, number]> = {
  [PHASE_GREEN]: [0.25, 1.0, 0.45],
  [PHASE_AMBER]: [1.0, 0.62, 0.08],
  [PHASE_RED]: [1.0, 0.08, 0.03]
}

interface Head { node: number; horizontal: boolean; x: number; z: number }

/** The signal heads of a network, one per approach at every junction. Pure: the same network gives the same heads. */
export function signalHeads(net: Network): Head[] {
  const heads: Head[] = []
  for (const node of net.nodes) {
    if (!isSignalNode(net, node.id)) continue
    for (const sid of node.segments) {
      const seg = net.segments[sid]!
      const other = net.nodes[seg.a === node.id ? seg.b : seg.a]!
      const dx = seg.horizontal ? Math.sign(other.x - node.x) : 0
      const dz = seg.horizontal ? 0 : Math.sign(other.z - node.z)
      heads.push({ node: node.id, horizontal: seg.horizontal, x: node.x + dx * HEAD_REACH, z: node.z + dz * HEAD_REACH })
    }
  }
  return heads
}

/** The heads as light points, updated from the simulation clock. */
export class SignalLayer {
  readonly lights: LightPoints
  private readonly heads: Head[]
  private readonly offsets: number[]

  constructor(net: Network) {
    this.heads = signalHeads(net)
    this.offsets = this.heads.map((h) => signalOffset(h.node))
    this.lights = new LightPoints(Math.max(1, this.heads.length))
    this.lights.setPx(1000)
    this.write(0)
  }

  /** Lights every head for the given clock (seconds). A frozen clock gives a static junction. */
  write(clock: number, pxPerUnit?: number): void {
    if (pxPerUnit !== undefined) this.lights.setPx(pxPerUnit)
    for (let i = 0; i < this.heads.length; i++) {
      const h = this.heads[i]!
      const phase = signalPhase(clock, this.offsets[i]!, h.horizontal)
      const c = COLOUR[phase]
      const g = LIT
      this.lights.set(i, h.x, ROAD_Y + HEAD_Y, h.z, c[0] * g, c[1] * g, c[2] * g, 0.3)
    }
    this.lights.commit(this.heads.length)
  }

  get count(): number {
    return this.heads.length
  }

  dispose(): void {
    this.lights.dispose()
  }
}

