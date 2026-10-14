// CPU picking for the building field. The buildings are axis-aligned boxes (footprint x height), so a ray is
// tested against a uniform XZ grid of boxes by walking the cells the ray crosses (Amanatides-Woo DDA), and each
// box by a slab test. No THREE.Raycaster runs over the instances.

const EPS = 1e-9
const MIN_TOP = 1e-3

export interface PickBox { x: number; z: number; w: number; d: number }

/**
 * Boxes on a grid. Heights are live: setTop moves a box's top, the grid itself is XZ only and never rebuilt.
 * Slots that are not live (ghosts) are left out of the grid.
 */
export class BuildingPicker {
  /** Top of each box (its height). Zero or less: not pickable. */
  readonly top: Float32Array
  /** Parameter of the last hit along the ray given to pick (in units of the direction). Infinity on a miss. */
  lastT = Infinity

  private readonly minX: Float64Array
  private readonly maxX: Float64Array
  private readonly minZ: Float64Array
  private readonly maxZ: Float64Array
  private gx0 = 0
  private gz0 = 0
  private gx1 = 0
  private gz1 = 0
  private cs = 1
  private nx = 0
  private nz = 0
  private cellStart = new Int32Array(1)
  private cellItems = new Int32Array(0)
  private topMax = 0

  constructor(boxes: readonly PickBox[], live: readonly boolean[], tops?: ArrayLike<number>) {
    const n = boxes.length
    this.top = new Float32Array(n)
    this.minX = new Float64Array(n)
    this.maxX = new Float64Array(n)
    this.minZ = new Float64Array(n)
    this.maxZ = new Float64Array(n)
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
    let count = 0
    for (let i = 0; i < n; i++) {
      const b = boxes[i]!
      this.minX[i] = b.x
      this.maxX[i] = b.x + b.w
      this.minZ[i] = b.z
      this.maxZ[i] = b.z + b.d
      if (!live[i]) continue
      count++
      this.top[i] = tops ? tops[i]! : 0
      this.topMax = Math.max(this.topMax, this.top[i]!)
      x0 = Math.min(x0, b.x)
      z0 = Math.min(z0, b.z)
      x1 = Math.max(x1, b.x + b.w)
      z1 = Math.max(z1, b.z + b.d)
    }
    if (count === 0) return
    const span = Math.max(x1 - x0, z1 - z0, 1e-3)
    const dim = Math.min(512, Math.max(1, Math.ceil(Math.sqrt(count / 2))))
    this.cs = span / dim
    this.gx0 = x0
    this.gz0 = z0
    this.nx = Math.max(1, Math.ceil((x1 - x0) / this.cs + 1e-9))
    this.nz = Math.max(1, Math.ceil((z1 - z0) / this.cs + 1e-9))
    this.gx1 = x0 + this.nx * this.cs
    this.gz1 = z0 + this.nz * this.cs

    // Two passes: count the cells each box covers, then fill them (compressed rows of slot indices).
    const cells = this.nx * this.nz
    const counts = new Int32Array(cells + 1)
    const range = (i: number) => {
      const ix0 = this.clampX(Math.floor((this.minX[i]! - this.gx0) / this.cs))
      const ix1 = this.clampX(Math.floor((this.maxX[i]! - this.gx0) / this.cs))
      const iz0 = this.clampZ(Math.floor((this.minZ[i]! - this.gz0) / this.cs))
      const iz1 = this.clampZ(Math.floor((this.maxZ[i]! - this.gz0) / this.cs))
      return [ix0, ix1, iz0, iz1] as const
    }
    for (let i = 0; i < n; i++) {
      if (!live[i]) continue
      const [ix0, ix1, iz0, iz1] = range(i)
      for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) counts[iz * this.nx + ix + 1]!++
    }
    for (let c = 0; c < cells; c++) counts[c + 1]! += counts[c]!
    this.cellStart = counts
    this.cellItems = new Int32Array(counts[cells]!)
    const fill = counts.slice(0, cells)
    for (let i = 0; i < n; i++) {
      if (!live[i]) continue
      const [ix0, ix1, iz0, iz1] = range(i)
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const c = iz * this.nx + ix
          this.cellItems[fill[c]!++] = i
        }
      }
    }
  }

  private clampX(v: number): number {
    return v < 0 ? 0 : v >= this.nx ? this.nx - 1 : v
  }

  private clampZ(v: number): number {
    return v < 0 ? 0 : v >= this.nz ? this.nz - 1 : v
  }

  /** Sets a box's live height. */
  setTop(i: number, h: number): void {
    this.top[i] = h
    if (h > this.topMax) this.topMax = h
  }

  /**
   * Nearest box hit by the ray origin + t * dir, t >= 0. Returns the box index, or -1 on a miss; lastT is the hit's t.
   * dir need not be normalised.
   */
  pick(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    this.lastT = Infinity
    if (this.nx === 0 || this.topMax < MIN_TOP) return -1
    // Clip the ray to the grid's XZ extent and to the height range [0, topMax].
    let t0 = 0
    let t1 = Infinity
    if (Math.abs(dx) < EPS) {
      if (ox < this.gx0 || ox > this.gx1) return -1
    } else {
      let a = (this.gx0 - ox) / dx
      let b = (this.gx1 - ox) / dx
      if (a > b) [a, b] = [b, a]
      t0 = Math.max(t0, a)
      t1 = Math.min(t1, b)
    }
    if (Math.abs(dz) < EPS) {
      if (oz < this.gz0 || oz > this.gz1) return -1
    } else {
      let a = (this.gz0 - oz) / dz
      let b = (this.gz1 - oz) / dz
      if (a > b) [a, b] = [b, a]
      t0 = Math.max(t0, a)
      t1 = Math.min(t1, b)
    }
    if (Math.abs(dy) < EPS) {
      if (oy < 0 || oy > this.topMax) return -1
    } else {
      let a = (0 - oy) / dy
      let b = (this.topMax - oy) / dy
      if (a > b) [a, b] = [b, a]
      t0 = Math.max(t0, a)
      t1 = Math.min(t1, b)
    }
    if (t0 > t1) return -1

    // Walk the cells from where the ray enters the grid. tMX/tMZ: parameter of the next cell boundary on each axis.
    const px = ox + dx * t0
    const pz = oz + dz * t0
    let ix = this.clampX(Math.floor((px - this.gx0) / this.cs))
    let iz = this.clampZ(Math.floor((pz - this.gz0) / this.cs))
    const stepX = dx > EPS ? 1 : dx < -EPS ? -1 : 0
    const stepZ = dz > EPS ? 1 : dz < -EPS ? -1 : 0
    const tDX = stepX === 0 ? Infinity : this.cs / Math.abs(dx)
    const tDZ = stepZ === 0 ? Infinity : this.cs / Math.abs(dz)
    let tMX = stepX === 0 ? Infinity
      : stepX > 0 ? t0 + (this.gx0 + (ix + 1) * this.cs - px) / dx
        : t0 + (this.gx0 + ix * this.cs - px) / dx
    let tMZ = stepZ === 0 ? Infinity
      : stepZ > 0 ? t0 + (this.gz0 + (iz + 1) * this.cs - pz) / dz
        : t0 + (this.gz0 + iz * this.cs - pz) / dz

    let best = Infinity
    let bestI = -1
    const maxSteps = this.nx + this.nz + 2
    for (let step = 0; step < maxSteps; step++) {
      const c = iz * this.nx + ix
      const end = this.cellStart[c + 1]!
      for (let k = this.cellStart[c]!; k < end; k++) {
        const i = this.cellItems[k]!
        const t = this.hit(i, ox, oy, oz, dx, dy, dz)
        if (t < best) {
          best = t
          bestI = i
        }
      }
      // Nothing beyond this cell can be nearer than the cell's exit.
      const exit = Math.min(tMX, tMZ, t1)
      if (bestI >= 0 && best <= exit) break
      if (exit >= t1) break
      if (tMX < tMZ) {
        ix += stepX
        if (ix < 0 || ix >= this.nx) break
        tMX += tDX
      } else {
        iz += stepZ
        if (iz < 0 || iz >= this.nz) break
        tMZ += tDZ
      }
    }
    this.lastT = best
    return bestI
  }

  /** Slab test of box i against the ray: entry parameter (clamped to 0), or Infinity on a miss. */
  private hit(i: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    const top = this.top[i]!
    if (top < MIN_TOP) return Infinity
    let tmin = -Infinity
    let tmax = Infinity
    if (Math.abs(dx) < EPS) {
      if (ox < this.minX[i]! || ox > this.maxX[i]!) return Infinity
    } else {
      let a = (this.minX[i]! - ox) / dx
      let b = (this.maxX[i]! - ox) / dx
      if (a > b) [a, b] = [b, a]
      if (a > tmin) tmin = a
      if (b < tmax) tmax = b
    }
    if (Math.abs(dy) < EPS) {
      if (oy < 0 || oy > top) return Infinity
    } else {
      let a = (0 - oy) / dy
      let b = (top - oy) / dy
      if (a > b) [a, b] = [b, a]
      if (a > tmin) tmin = a
      if (b < tmax) tmax = b
    }
    if (Math.abs(dz) < EPS) {
      if (oz < this.minZ[i]! || oz > this.maxZ[i]!) return Infinity
    } else {
      let a = (this.minZ[i]! - oz) / dz
      let b = (this.maxZ[i]! - oz) / dz
      if (a > b) [a, b] = [b, a]
      if (a > tmin) tmin = a
      if (b < tmax) tmax = b
    }
    if (tmin > tmax || tmax < 0) return Infinity
    return tmin > 0 ? tmin : 0
  }
}

/**
 * Trailing-edge throttle with a leading call: fn runs at once when the last run is at least `ms` ago, otherwise the
 * latest arguments run when the window ends. cancel() drops a pending call.
 */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
  clock: () => number = () => performance.now()
): ((...args: A) => void) & { cancel(): void } {
  let last = -Infinity
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: A | null = null
  const run = (args: A) => {
    last = clock()
    pending = null
    fn(...args)
  }
  const call = (...args: A) => {
    const wait = ms - (clock() - last)
    if (wait <= 0) {
      if (timer !== null) clearTimeout(timer)
      timer = null
      run(args)
      return
    }
    pending = args
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null
        if (pending) run(pending)
      }, wait)
    }
  }
  call.cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    pending = null
  }
  return call
}
