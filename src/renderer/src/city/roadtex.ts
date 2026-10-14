// Road surface rasters: one square texture pair per layout, painted on the CPU from the street mask and the traffic
// network. Pure data (no three.js) except the last helper, which wraps the bytes in DataTextures.
//   surface: R street coverage, G white paint (dashes, zebra), B yellow paint (avenue double line), A kerb / sidewalk
//   glow:    R lamp light pools, G signal heads, B sodium band on avenues, A junction boost
// Texel (px, py) covers world x = origin + (px + 0.5) / P, z = origin + (py + 0.5) / P, with origin = -size / 2.
import { DataTexture, LinearFilter, RGBAFormat, ClampToEdgeWrapping, UnsignedByteType } from 'three'
import type { CityLayout } from '@shared/types'
import { buildLanes, isSignalNode, type Network } from './lanes'
import { lampArmDirection, streetGrid, type Grid } from './streets'

/** Texels per world unit, at most, and the texture side limit. */
const PX_MAX = 8
const TEXELS_MAX = 2048
/** Segments at least this long are avenues: sodium band, yellow centre line, brighter junctions. */
export const AVENUE_LENGTH = 7
/** Dash pattern of white centre lines on ordinary streets (world units). */
const DASH_ON = 1.6
const DASH_PERIOD = 3.2
/** Share of a street cell that is kerb / sidewalk, from each edge that faces a building. */
const KERB = 0.2
/** Zebra zone along a segment, measured from the junction (world units). */
const ZEBRA_NEAR = 0.45
const ZEBRA_FAR = 1.1
const ZEBRA_PITCH = 0.2
/** Head of a lamp: the arm reaches this far from the pole toward the road. */
const LAMP_REACH = 0.27

export interface RoadRaster {
  /** Texels per side (the texture is width x width). */
  width: number
  /** Texels per world unit. */
  pxPerUnit: number
  /** World size covered, centred on the origin. */
  size: number
  /** World x (and z) of the first texel's corner. */
  origin: number
  surface: Uint8Array
  glow: Uint8Array
  /** Number of avenue segments and junctions, for tests and stats. */
  avenues: number
  junctions: number
}

function clamp255(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v)
}

/** Adds `v` into channel `c` of texel (px, py) with a max or an add. */
function put(buf: Uint8Array, w: number, px: number, py: number, c: number, v: number, add: boolean) {
  const k = (py * w + px) * 4 + c
  buf[k] = add ? clamp255(buf[k]! + v) : Math.max(buf[k]!, clamp255(v))
}

/**
 * Paints the raster for a layout. `lights` are the lamp poles from the road plan (pole position and arm rotation),
 * and the traffic network supplies the centre lines, avenues and junctions.
 */
export function buildRoadRaster(
  layout: CityLayout,
  lamps: readonly { x: number; z: number; rot: number }[] = [],
  net?: Network,
  grid?: Grid
): RoadRaster {
  const size = Math.max(1, layout.size)
  const g = grid ?? streetGrid(layout)
  const network = net ?? buildLanes(layout)
  const pxPerUnit = Math.max(2, Math.min(PX_MAX, Math.floor(TEXELS_MAX / size)))
  const width = Math.max(4, Math.round(size * pxPerUnit))
  const origin = -size / 2
  const surface = new Uint8Array(width * width * 4)
  const glow = new Uint8Array(width * width * 4)
  const P = pxPerUnit
  const toPx = (x: number) => (x - origin) * P - 0.5
  const toPy = (z: number) => (z - origin) * P - 0.5

  // 1. Street coverage and kerbs, from the cell mask.
  const { n, cell } = g
  const street = (i: number, j: number) => i >= 0 && j >= 0 && i < n && j < n && g.street[j * n + i] === 1
  for (let py = 0; py < width; py++) {
    const z = origin + (py + 0.5) / P
    const fzAll = (z - g.origin) / cell
    const j = Math.floor(fzAll)
    for (let px = 0; px < width; px++) {
      const x = origin + (px + 0.5) / P
      const fxAll = (x - g.origin) / cell
      const i = Math.floor(fxAll)
      if (!street(i, j)) continue
      const fx = fxAll - i
      const fz = fzAll - j
      const k = (py * width + px) * 4
      surface[k] = 255
      const kerb = (fx < KERB && !street(i - 1, j)) || (fx > 1 - KERB && !street(i + 1, j))
        || (fz < KERB && !street(i, j - 1)) || (fz > 1 - KERB && !street(i, j + 1))
      surface[k + 3] = kerb ? 255 : 0
    }
  }

  // 2. Lane paint and zebra, per traffic segment, in the segment's own frame.
  let avenues = 0
  for (const seg of network.segments) {
    const a = network.nodes[seg.a]!
    const b = network.nodes[seg.b]!
    const len = seg.length
    const avenue = len >= AVENUE_LENGTH
    if (avenue) avenues++
    const ux = seg.ux
    const uz = seg.uz
    const ax = a.x
    const az = a.z
    const minX = Math.min(a.x, b.x) - 0.9
    const maxX = Math.max(a.x, b.x) + 0.9
    const minZ = Math.min(a.z, b.z) - 0.9
    const maxZ = Math.max(a.z, b.z) + 0.9
    const bx0 = Math.max(0, Math.floor(toPx(minX)))
    const bx1 = Math.min(width - 1, Math.ceil(toPx(maxX)))
    const bz0 = Math.max(0, Math.floor(toPy(minZ)))
    const bz1 = Math.min(width - 1, Math.ceil(toPy(maxZ)))
    const zebraA = isSignalNode(network, seg.a)
    const zebraB = isSignalNode(network, seg.b)
    for (let py = bz0; py <= bz1; py++) {
      const z = origin + (py + 0.5) / P
      for (let px = bx0; px <= bx1; px++) {
        const x = origin + (px + 0.5) / P
        // Along the segment (u) and across it (perp), measured from its a end.
        const u = (x - ax) * ux + (z - az) * uz
        const perp = -(x - ax) * uz + (z - az) * ux
        if (u < -0.6 || u > len + 0.6 || Math.abs(perp) > 0.6) continue
        // Avenue glow band: wide, soft, across the whole street.
        if (avenue && u >= 0 && u <= len && Math.abs(perp) <= 0.9) {
          put(glow, width, px, py, 2, 255 * Math.exp(-((perp / 0.3) ** 2)), false)
        }
        if (u < 0 || u > len) continue
        // Zebra: bars along the traffic, pitched across it, in the zone just before a signalled junction.
        const nearA = zebraA && u >= ZEBRA_NEAR && u <= ZEBRA_FAR
        const nearB = zebraB && len - u >= ZEBRA_NEAR && len - u <= ZEBRA_FAR
        if ((nearA || nearB) && Math.abs(perp) <= 0.42) {
          const phase = (((perp + 0.42) / ZEBRA_PITCH) % 1 + 1) % 1
          if (phase < 0.5) put(surface, width, px, py, 1, 255, false)
          continue
        }
        // Centre line: a yellow double line on avenues, white dashes elsewhere. Kept clear of junctions.
        if (Math.abs(perp) > 0.07 || u < 0.9 || len - u < 0.9) continue
        if (avenue) {
          if (Math.abs(Math.abs(perp) - 0.055) < 0.02 || Math.abs(perp) < 0.012) put(surface, width, px, py, 2, 255, false)
        } else {
          const along = ((u % DASH_PERIOD) + DASH_PERIOD) % DASH_PERIOD
          if (along < DASH_ON) put(surface, width, px, py, 1, 255, false)
        }
      }
    }
  }

  // 3. Junctions: a bright patch and a signal glow per signalled head, lamps as soft pools.
  let junctions = 0
  for (const node of network.nodes) {
    if (node.segments.length < 3) continue
    junctions++
    const r = 1.6
    const bx0 = Math.max(0, Math.floor(toPx(node.x - r)))
    const bx1 = Math.min(width - 1, Math.ceil(toPx(node.x + r)))
    const bz0 = Math.max(0, Math.floor(toPy(node.z - r)))
    const bz1 = Math.min(width - 1, Math.ceil(toPy(node.z + r)))
    for (let py = bz0; py <= bz1; py++) {
      const z = origin + (py + 0.5) / P
      for (let px = bx0; px <= bx1; px++) {
        const x = origin + (px + 0.5) / P
        const d = Math.hypot(x - node.x, z - node.z)
        if (d < r) put(glow, width, px, py, 3, 255 * Math.exp(-((d / 0.9) ** 2)), false)
      }
    }
    for (const sid of node.segments) {
      const seg = network.segments[sid]!
      const other = network.nodes[seg.a === node.id ? seg.b : seg.a]!
      const dx = Math.sign(other.x - node.x) * (seg.horizontal ? 1 : 0)
      const dz = Math.sign(other.z - node.z) * (seg.horizontal ? 0 : 1)
      stamp(glow, width, P, origin, node.x + dx * 0.45, node.z + dz * 0.45, 0.75, 1, 255 * 0.9)
    }
  }

  // 4. Lamp light pools (red channel) at each lamp head.
  for (const l of lamps) {
    const [ax, az] = lampArmDirection(l.rot)
    stamp(glow, width, P, origin, l.x + ax * LAMP_REACH, l.z + az * LAMP_REACH, 2.2, 0, 255 * 0.55)
  }

  return { width, pxPerUnit: P, size, origin, surface, glow, avenues, junctions }
}

/** Adds a soft gaussian of peak `amp` and radius `r` (world units) to channel c, around a world point. */
function stamp(buf: Uint8Array, w: number, P: number, origin: number, x: number, z: number, r: number, c: number, amp: number) {
  const px0 = Math.max(0, Math.floor((x - r - origin) * P))
  const px1 = Math.min(w - 1, Math.ceil((x + r - origin) * P))
  const py0 = Math.max(0, Math.floor((z - r - origin) * P))
  const py1 = Math.min(w - 1, Math.ceil((z + r - origin) * P))
  const s2 = 2 * (r / 2) ** 2
  for (let py = py0; py <= py1; py++) {
    const zz = origin + (py + 0.5) / P
    for (let px = px0; px <= px1; px++) {
      const xx = origin + (px + 0.5) / P
      const d2 = (xx - x) ** 2 + (zz - z) ** 2
      if (d2 > r * r) continue
      put(buf, w, px, py, c, amp * Math.exp(-d2 / s2), true)
    }
  }
}

/** The raster as three.js textures. The caller owns them and disposes them. */
export function roadTextures(r: RoadRaster): { surface: DataTexture; glow: DataTexture } {
  const make = (data: Uint8Array) => {
    const t = new DataTexture(data, r.width, r.width, RGBAFormat, UnsignedByteType)
    t.magFilter = LinearFilter
    t.minFilter = LinearFilter
    t.generateMipmaps = false
    t.wrapS = ClampToEdgeWrapping
    t.wrapT = ClampToEdgeWrapping
    t.needsUpdate = true
    return t
  }
  return { surface: make(r.surface), glow: make(r.glow) }
}

