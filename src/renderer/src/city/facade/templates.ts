// Massing templates for the 'real' style (City v4). Each template is a few axis-aligned boxes in a unit footprint and a
// unit height: x and z in [0, 1] (centred on the instance at render time, so the footprint is [-0.5, 0.5]), y in [0, 1]
// (the instance scales y to the rendered height, so tiers are fractions of the height). Every template reaches y = 1.
//
// The photographic facade material (facade/photo) needs its UVs in metres. They are not stored here: the shader derives
// them from the instance scale (see facade/massing.ts, massingUv), so one template serves every footprint and height.
// Pure: plain typed arrays, no three.js.
//
// Faces are emitted per box with no bottoms and no shared vertices. Boxes never overlap in a shared side plane with the
// same normal, so there is no z-fighting between tiers.

/** [x0, z0, x1, z1, y0, y1] in unit footprint and unit height. */
export type Box = readonly [x0: number, z0: number, x1: number, z1: number, y0: number, y1: number]

/**
 * Every template reaches y = 1 (its top is the rendered height, so picking and framing agree with the drawing).
 * What a template is for, which the placement uses to choose it: spire and tower for the top of the LOC ranking, mid for
 * the bulk of the city, plate for squat files, complex for the L, U, cross and twin shapes.
 */
export type TemplateTag = 'spire' | 'tower' | 'mid' | 'plate' | 'complex'

export interface Template {
  id: string;
  tags: readonly TemplateTag[];
  boxes: readonly Box[];
}

export const TEMPLATES: readonly Template[] = [
  // Mid-rise: slabs, parapets, mansards, setbacks, stepped crowns.
  { id: 'slab', tags: ['mid', 'plate'], boxes: [[0, 0, 1, 1, 0, 1]] },
  {
    id: 'slab-parapet', tags: ['mid', 'plate'],
    boxes: [[0, 0, 1, 1, 0, 0.96], [0, 0, 1, 0.04, 0.96, 1], [0, 0.96, 1, 1, 0.96, 1], [0, 0.04, 0.04, 0.96, 0.96, 1], [0.96, 0.04, 1, 0.96, 0.96, 1]]
  },
  { id: 'slab-mansard', tags: ['mid'], boxes: [[0, 0, 1, 1, 0, 0.9], [0.05, 0.05, 0.95, 0.95, 0.9, 1]] },
  { id: 'setback-2', tags: ['mid'], boxes: [[0, 0, 1, 1, 0, 0.6], [0.12, 0.12, 0.88, 0.88, 0.6, 1]] },
  { id: 'setback-side', tags: ['mid'], boxes: [[0, 0, 1, 1, 0, 0.7], [0, 0, 1, 0.6, 0.7, 1]] },
  { id: 'shoulder', tags: ['mid'], boxes: [[0, 0, 1, 1, 0, 0.75], [0.3, 0, 1, 1, 0.75, 1]] },
  { id: 'stepped-crown', tags: ['mid'], boxes: [[0, 0, 1, 1, 0, 0.8], [0.08, 0.08, 0.92, 0.92, 0.8, 0.9], [0.2, 0.2, 0.8, 0.8, 0.9, 1]] },
  { id: 'penthouse', tags: ['mid'], boxes: [[0, 0, 1, 1, 0, 0.92], [0.25, 0.25, 0.75, 0.75, 0.92, 1]] },
  // Plates: squat blocks for the low files.
  { id: 'plate-wide', tags: ['plate'], boxes: [[0, 0, 1, 0.5, 0, 1], [0, 0.5, 1, 1, 0, 0.6]] },
  { id: 'plate-low', tags: ['plate'], boxes: [[0, 0, 1, 1, 0, 0.8], [0, 0, 1, 0.12, 0.8, 1], [0, 0.88, 1, 1, 0.8, 1]] },
  // Art deco: wedding-cake setbacks, with and without a spire.
  { id: 'deco-2', tags: ['mid', 'tower'], boxes: [[0, 0, 1, 1, 0, 0.6], [0.12, 0.12, 0.88, 0.88, 0.6, 1]] },
  { id: 'deco-3', tags: ['tower', 'mid'], boxes: [[0, 0, 1, 1, 0, 0.42], [0.1, 0.1, 0.9, 0.9, 0.42, 0.74], [0.22, 0.22, 0.78, 0.78, 0.74, 1]] },
  {
    id: 'deco-3-spire', tags: ['spire'],
    boxes: [[0, 0, 1, 1, 0, 0.4], [0.1, 0.1, 0.9, 0.9, 0.4, 0.7], [0.2, 0.2, 0.8, 0.8, 0.7, 0.84], [0.42, 0.42, 0.58, 0.58, 0.84, 1]]
  },
  // Towers: podium and shaft, crowns, spires, slender and twin shafts.
  { id: 'podium-tower', tags: ['tower'], boxes: [[0, 0, 1, 1, 0, 0.28], [0.18, 0.18, 0.82, 0.82, 0.28, 1]] },
  { id: 'podium-tower-crown', tags: ['tower'], boxes: [[0, 0, 1, 1, 0, 0.22], [0.16, 0.16, 0.84, 0.84, 0.22, 0.86], [0.3, 0.3, 0.7, 0.7, 0.86, 1]] },
  { id: 'tower-crown', tags: ['tower', 'spire'], boxes: [[0.1, 0.1, 0.9, 0.9, 0, 0.9], [0.2, 0.2, 0.8, 0.8, 0.9, 1]] },
  { id: 'tower-spire', tags: ['spire'], boxes: [[0.14, 0.14, 0.86, 0.86, 0, 0.86], [0.42, 0.42, 0.58, 0.58, 0.86, 1]] },
  { id: 'tower-slender', tags: ['spire'], boxes: [[0.25, 0.25, 0.75, 0.75, 0, 0.9], [0.4, 0.4, 0.6, 0.6, 0.9, 1]] },
  { id: 'tower-twin', tags: ['tower', 'complex'], boxes: [[0.08, 0.08, 0.44, 0.92, 0, 1], [0.56, 0.08, 0.92, 0.92, 0, 1]] },
  { id: 'corner-tower', tags: ['tower', 'complex'], boxes: [[0, 0, 1, 1, 0, 0.3], [0, 0, 0.7, 0.7, 0.3, 1]] },
  // Complex plans: L, U with a courtyard, cross, twin blocks.
  { id: 'L-mid', tags: ['complex', 'mid'], boxes: [[0, 0, 1, 0.55, 0, 1], [0, 0.55, 0.45, 1, 0, 1]] },
  { id: 'U-court', tags: ['complex', 'mid'], boxes: [[0, 0, 1, 0.3, 0, 1], [0, 0.3, 0.3, 1, 0, 1], [0.7, 0.3, 1, 1, 0, 1]] },
  {
    id: 'U-court-low', tags: ['complex', 'plate'],
    boxes: [[0, 0, 1, 0.3, 0, 1], [0, 0.3, 0.3, 1, 0, 1], [0.7, 0.3, 1, 1, 0, 1], [0.3, 0.3, 0.7, 0.5, 0, 0.3]]
  },
  { id: 'cross', tags: ['complex'], boxes: [[0.3, 0, 0.7, 1, 0, 1], [0, 0.3, 1, 0.7, 0, 0.9]] },
  { id: 'twin-setback', tags: ['complex', 'mid'], boxes: [[0, 0, 0.46, 1, 0, 1], [0.54, 0, 1, 1, 0, 0.7]] }
]

export interface MassingMesh {
  /** xyz per vertex, centred footprint, base at y = 0. */
  position: Float32Array;
  normal: Float32Array;
  index: Uint16Array;
}

/** Face normals of a box, in the order the faces are emitted. */
type V3 = [number, number, number]

/** Faces of one box as quads, corners in a fixed order; the winding is fixed afterwards from the normal. */
function boxQuads(b: Box): { n: V3; verts: V3[] }[] {
  const [x0, z0, x1, z1, y0, y1] = b
  return [
    { n: [0, 0, 1], verts: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
    { n: [1, 0, 0], verts: [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]] },
    { n: [0, 0, -1], verts: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]] },
    { n: [-1, 0, 0], verts: [[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]] },
    { n: [0, 1, 0], verts: [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]] }
  ]
}

/**
 * Triangle mesh of a template, centred on x and z, base at y = 0, top at y = 1. Pure and deterministic. Each quad is
 * wound counter-clockwise seen from outside, checked against its stated normal.
 */
export function buildMassingMesh(t: Template): MassingMesh {
  const pos: number[] = []
  const nrm: number[] = []
  const idx: number[] = []
  for (const box of t.boxes) {
    for (const q of boxQuads(box)) {
      const base = pos.length / 3
      for (const [x, y, z] of q.verts) {
        pos.push(x - 0.5, y, z - 0.5)
        nrm.push(q.n[0], q.n[1], q.n[2])
      }
      const [a, b, c] = q.verts as [V3, V3, V3]
      const e1: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const e2: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      const cross: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
      const dot = cross[0] * q.n[0] + cross[1] * q.n[1] + cross[2] * q.n[2]
      if (dot >= 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
      else idx.push(base, base + 2, base + 1, base, base + 3, base + 2)
    }
  }
  return {
    position: Float32Array.from(pos),
    normal: Float32Array.from(nrm),
    index: Uint16Array.from(idx)
  }
}

/** Triangles of a template. */
export function templateTris(t: Template): number {
  return t.boxes.length * 10
}

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]))

export function templateById(id: string): Template | undefined {
  return BY_ID.get(id)
}

/** Templates carrying a tag, in declaration order. */
export function templatesWith(tag: TemplateTag): Template[] {
  return TEMPLATES.filter((t) => t.tags.includes(tag))
}
