// Plain-JS GLB reader for the kit scripts (no dependencies, no three.js).
// Reads the JSON + BIN chunks, decodes accessors, and resolves each mesh node's world transform.
// Matrices are column-major Float64Array(16), as in glTF.

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

export function readGlb(input) {
  const buf = Buffer.from(input.buffer ?? input, input.byteOffset ?? 0, input.byteLength ?? input.length)
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB file')
  if (buf.readUInt32LE(4) !== 2) throw new Error('only glTF 2.0 is supported')
  let json = null
  let bin = null
  for (let off = 12; off + 8 <= buf.length;) {
    const len = buf.readUInt32LE(off)
    const type = buf.readUInt32LE(off + 4)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === CHUNK_JSON) json = JSON.parse(data.toString('utf8'))
    else if (type === CHUNK_BIN) bin = data
    off += 8 + len
  }
  if (!json) throw new Error('GLB has no JSON chunk')
  return { json, bin }
}

const COMPONENT = {
  5120: { size: 1, read: (dv, o) => dv.getInt8(o) },
  5121: { size: 1, read: (dv, o) => dv.getUint8(o) },
  5122: { size: 2, read: (dv, o) => dv.getInt16(o, true) },
  5123: { size: 2, read: (dv, o) => dv.getUint16(o, true) },
  5125: { size: 4, read: (dv, o) => dv.getUint32(o, true) },
  5126: { size: 4, read: (dv, o) => dv.getFloat32(o, true) }
}
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

/** Decodes one accessor into a plain Float64Array (count × components). Honours byteStride and byteOffset. */
export function readAccessor(json, bin, index) {
  const acc = json.accessors[index]
  if (acc.normalized) throw new Error(`normalized accessor ${index} is not supported`)
  const view = json.bufferViews[acc.bufferView]
  const comp = COMPONENT[acc.componentType]
  const width = WIDTH[acc.type]
  const stride = view.byteStride ?? comp.size * width
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const out = new Float64Array(acc.count * width)
  for (let i = 0; i < acc.count; i++) {
    for (let k = 0; k < width; k++) out[i * width + k] = comp.read(dv, base + i * stride + k * comp.size)
  }
  return out
}

// ---- 4x4 column-major matrix helpers ----
export const mat4Identity = () => Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

export function mat4Multiply(a, b) {
  const out = new Float64Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      out[c * 4 + r] = s
    }
  }
  return out
}

/** glTF node TRS (or explicit matrix) to a column-major matrix. */
export function nodeLocalMatrix(node) {
  if (node.matrix) return Float64Array.from(node.matrix)
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1]
  const [tx, ty, tz] = node.translation ?? [0, 0, 0]
  const [sx, sy, sz] = node.scale ?? [1, 1, 1]
  return Float64Array.from([
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1
  ])
}

/** World matrix of every node reachable from the default scene. */
export function worldMatrices(json) {
  const world = new Array(json.nodes.length).fill(null)
  const visit = (index, parent) => {
    const node = json.nodes[index]
    const m = mat4Multiply(parent, nodeLocalMatrix(node))
    world[index] = m
    for (const child of node.children ?? []) visit(child, m)
  }
  const scene = json.scenes[json.scene ?? 0]
  for (const root of scene.nodes ?? []) visit(root, mat4Identity())
  return world
}

export function mat3NormalOf(m) {
  // inverse-transpose of the upper 3x3 (for transforming normals); returns column-major 3x3
  const a = m
  const det = a[0] * (a[5] * a[10] - a[9] * a[6]) - a[4] * (a[1] * a[10] - a[9] * a[2]) + a[8] * (a[1] * a[6] - a[5] * a[2])
  const inv = [
    (a[5] * a[10] - a[9] * a[6]) / det, (a[8] * a[6] - a[4] * a[10]) / det, (a[4] * a[9] - a[8] * a[5]) / det,
    (a[9] * a[2] - a[1] * a[10]) / det, (a[0] * a[10] - a[8] * a[2]) / det, (a[8] * a[1] - a[0] * a[9]) / det,
    (a[1] * a[6] - a[5] * a[2]) / det, (a[4] * a[2] - a[0] * a[6]) / det, (a[0] * a[5] - a[4] * a[1]) / det
  ]
  return inv // column-major inverse; transpose applied by caller via index order
}

export function determinant3(m) {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2])
}

/**
 * Every mesh node in the default scene, with its world-space geometry (positions, normals, uv sets, triangles).
 * Triangles are reversed when the world transform mirrors (negative determinant), so winding stays outward.
 */
export function meshInstances(json, bin) {
  const world = worldMatrices(json)
  const out = []
  json.nodes.forEach((node, nodeIndex) => {
    if (node.mesh === undefined || !world[nodeIndex]) return
    const m = world[nodeIndex]
    const mirrored = determinant3(m) < 0
    const mesh = json.meshes[node.mesh]
    const prims = mesh.primitives.map((prim) => {
      if ((prim.mode ?? 4) !== 4) throw new Error(`${node.name}: only triangle primitives are supported`)
      const attrs = prim.attributes
      const pos = readAccessor(json, bin, attrs.POSITION)
      const count = pos.length / 3
      const wp = new Float64Array(count * 3)
      for (let i = 0; i < count; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
        wp[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12]
        wp[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]
        wp[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]
      }
      let idx
      if (prim.indices !== undefined) idx = readAccessor(json, bin, prim.indices)
      else idx = Float64Array.from({ length: count }, (_, i) => i)
      const tris = new Uint32Array(idx.length)
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t], b = idx[t + 1], c = idx[t + 2]
        if (mirrored) { tris[t] = a; tris[t + 1] = c; tris[t + 2] = b } else { tris[t] = a; tris[t + 1] = b; tris[t + 2] = c }
      }
      const uv = (name) => (attrs[name] === undefined ? null : readAccessor(json, bin, attrs[name]))
      return {
        material: prim.material ?? -1,
        positions: wp,
        triangles: tris,
        uv0: uv('TEXCOORD_0'),
        uv1: uv('TEXCOORD_1'),
        normalsLocal: uv('NORMAL') && readAccessor(json, bin, attrs.NORMAL)
      }
    })
    out.push({ nodeIndex, name: node.name ?? `node${nodeIndex}`, meshIndex: node.mesh, mirrored, world: m, prims })
  })
  return out
}

/** World-space bounding box of an instance (glTF units; the kit is authored in metres-like model units). */
export function instanceBounds(inst) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const p of inst.prims) {
    for (let i = 0; i < p.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = p.positions[i + k]
        if (v < min[k]) min[k] = v
        if (v > max[k]) max[k] = v
      }
    }
  }
  return { min, max }
}
