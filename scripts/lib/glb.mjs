// Pure GLB helpers shared by scripts/import-kenney.mjs and scripts/measure-models.mjs.
// No dependencies: parses the binary container, reads POSITION data, measures bounds/tris,
// strips the external colormap reference and remaps TEXCOORD_0 into a stacked atlas.

const COMPONENT = { 5120: [1, 'Int8'], 5121: [1, 'Uint8'], 5122: [2, 'Int16'], 5123: [2, 'Uint16'], 5125: [4, 'Uint32'], 5126: [4, 'Float32'] }
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

export function parseGlb(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB (bad magic)')
  const total = buf.readUInt32LE(8)
  let off = 12
  let json = null
  let bin = null
  while (off < total) {
    const len = buf.readUInt32LE(off)
    const type = buf.readUInt32LE(off + 4)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 0x4e4f534a) json = JSON.parse(Buffer.from(data).toString('utf8'))
    else if (type === 0x004e4942) bin = Buffer.from(data)
    off += 8 + len
  }
  if (!json) throw new Error('GLB has no JSON chunk')
  return { json, bin: bin ?? Buffer.alloc(0) }
}

/** Encode a GLB from JSON + BIN chunk. */
export function writeGlb(json, bin) {
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8')
  const jpad = (4 - (jsonBuf.length % 4)) % 4
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jpad, 0x20)])
  const binPad = (4 - (bin.length % 4)) % 4
  const binBuf = Buffer.concat([bin, Buffer.alloc(binPad, 0)])
  const hasBin = binBuf.length > 0
  const total = 12 + 8 + jsonBuf.length + (hasBin ? 8 + binBuf.length : 0)
  const out = Buffer.alloc(total)
  out.writeUInt32LE(0x46546c67, 0)
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(total, 8)
  out.writeUInt32LE(jsonBuf.length, 12)
  out.writeUInt32LE(0x4e4f534a, 16)
  jsonBuf.copy(out, 20)
  if (hasBin) {
    const o = 20 + jsonBuf.length
    out.writeUInt32LE(binBuf.length, o)
    out.writeUInt32LE(0x004e4942, o + 4)
    binBuf.copy(out, o + 8)
  }
  return out
}

function accessorInfo(json, idx) {
  const acc = json.accessors[idx]
  const bv = json.bufferViews[acc.bufferView ?? 0]
  const [size, name] = COMPONENT[acc.componentType]
  const comps = TYPE_COUNT[acc.type]
  const stride = bv.byteStride ?? size * comps
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  return { acc, size, name, comps, stride, base, count: acc.count }
}

/** Read an accessor as an array of numeric tuples (flattened to Float64Array of count*comps). */
export function readAccessor(json, bin, idx) {
  const info = accessorInfo(json, idx)
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const out = new Float64Array(info.count * info.comps)
  const getter = { Int8: 'getInt8', Uint8: 'getUint8', Int16: 'getInt16', Uint16: 'getUint16', Uint32: 'getUint32', Float32: 'getFloat32' }[info.name]
  for (let i = 0; i < info.count; i++) {
    for (let c = 0; c < info.comps; c++) {
      out[i * info.comps + c] = dv[getter](info.base + i * info.stride + c * info.size, true)
    }
  }
  return out
}

// ---- 4x4 matrix helpers (column-major, like glTF) ----
const I16 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
export function nodeMatrix(node) {
  if (node.matrix) return node.matrix.slice()
  const [tx, ty, tz] = node.translation ?? [0, 0, 0]
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = node.scale ?? [1, 1, 1]
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1
  ]
}
export function mul4(a, b) {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
    o[c * 4 + r] = s
  }
  return o
}
export function xform(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14]
  ]
}

/** Walk the default scene, calling fn(meshIndex, worldMatrix) for every node with a mesh. */
export function forEachMeshInstance(json, fn) {
  const sceneIdx = json.scene ?? 0
  const roots = json.scenes?.[sceneIdx]?.nodes ?? json.nodes.map((_, i) => i)
  const visit = (i, parent) => {
    const node = json.nodes[i]
    const world = mul4(parent, nodeMatrix(node ?? {}))
    if (node?.mesh !== undefined) fn(node.mesh, world)
    for (const c of node?.children ?? []) visit(c, world)
  }
  for (const r of roots) visit(r, I16())
}

/**
 * Measure a GLB: native bounding box (after node transforms), triangle count, and the
 * origin offset (where the base-centre sits relative to the file's origin).
 */
export function measureGlb(buf) {
  const { json, bin } = parseGlb(buf)
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  let tris = 0
  let prims = 0
  forEachMeshInstance(json, (meshIdx, world) => {
    for (const p of json.meshes[meshIdx].primitives) {
      if (p.mode !== undefined && p.mode !== 4) throw new Error(`unsupported primitive mode ${p.mode}`)
      prims++
      const pos = readAccessor(json, bin, p.attributes.POSITION)
      for (let i = 0; i < pos.length; i += 3) {
        const [x, y, z] = xform(world, pos[i], pos[i + 1], pos[i + 2])
        min[0] = Math.min(min[0], x); max[0] = Math.max(max[0], x)
        min[1] = Math.min(min[1], y); max[1] = Math.max(max[1], y)
        min[2] = Math.min(min[2], z); max[2] = Math.max(max[2], z)
      }
      tris += (p.indices !== undefined ? json.accessors[p.indices].count : json.accessors[p.attributes.POSITION].count) / 3
    }
  })
  if (!isFinite(min[0])) throw new Error('GLB has no mesh geometry')
  const size = { x: round(max[0] - min[0]), y: round(max[1] - min[1]), z: round(max[2] - min[2]) }
  return {
    size,
    tris: Math.round(tris),
    primitives: prims,
    origin: {
      // where the native origin sits relative to the base-centre of the model (0,0,0 = centred already)
      x: round(-(min[0] + max[0]) / 2),
      y: round(-min[1]),
      z: round(-(min[2] + max[2]) / 2)
    },
    materials: json.materials?.map((m) => m.name ?? '') ?? []
  }
}

const round = (n) => Math.round(n * 10000) / 10000

/**
 * Strip every texture reference (the Kenney GLBs point at an external Textures/colormap.png that
 * GLTFLoader cannot resolve in the packaged app) and remap each TEXCOORD_0 v into a vertical atlas
 * slot: v' = (v + slot) / slots. Returns a new GLB buffer.
 */
export function rewriteGlbForAtlas(buf, { slot, slots }) {
  const { json, bin } = parseGlb(buf)
  const remapped = new Set()
  for (const mesh of json.meshes) {
    for (const p of mesh.primitives) {
      const ti = p.attributes.TEXCOORD_0
      if (ti === undefined || remapped.has(ti)) continue
      const acc = json.accessors[ti]
      if (acc.componentType !== 5126 || acc.type !== 'VEC2') throw new Error(`TEXCOORD_0 must be float VEC2 (got ${acc.componentType}/${acc.type})`)
      const users = json.accessors.filter((a) => a.bufferView === acc.bufferView).length
      if (users !== 1 && acc.bufferView !== undefined) {
        // shared views are safe only when the accessor's own byte range is exclusive; be strict instead
        throw new Error('TEXCOORD_0 bufferView is shared with another accessor')
      }
      const info = accessorInfo(json, ti)
      const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
      for (let i = 0; i < info.count; i++) {
        const at = info.base + i * info.stride + 4
        const v = dv.getFloat32(at, true)
        dv.setFloat32(at, (v + slot) / slots, true)
      }
      remapped.add(ti)
    }
  }
  for (const m of json.materials ?? []) {
    const pbr = m.pbrMetallicRoughness
    if (pbr) { delete pbr.baseColorTexture; delete pbr.metallicRoughnessTexture }
    for (const k of ['normalTexture', 'occlusionTexture', 'emissiveTexture']) delete m[k]
    if (m.extensions) for (const k of Object.keys(m.extensions)) if (/texture/i.test(k)) delete m.extensions[k]
  }
  delete json.textures
  delete json.images
  delete json.samplers
  json.extensionsUsed = (json.extensionsUsed ?? []).filter((e) => !/texture/i.test(e))
  if (json.extensionsUsed.length === 0) delete json.extensionsUsed
  return writeGlb(json, bin)
}

/** Map a Kenney model file name to the contract class. Heights decide commercial buildings. */
export function classify(id, height, pack) {
  if (pack === 'suburban') return 'house'
  if (pack === 'roads' && /^road-/.test(id) && !/^road-sign-/.test(id)) return 'road'
  if (/^building-skyscraper-/.test(id)) return 'skyscraper'
  if (/^low-detail-building-/.test(id)) return 'lowdetail'
  if (/^building-[a-z]$/.test(id)) {
    if (height <= 1.6) return 'lowrise'
    if (height <= 2.1) return 'midrise'
    return 'tower'
  }
  return 'prop'
}
