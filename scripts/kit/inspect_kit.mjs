#!/usr/bin/env node
// Inspects the city kit GLB (Low-poly City Buildings, CC-BY-4.0, smooth998) and writes
// src/renderer/src/city/kit/kitManifest.ts: one KitBuilding per real building, plus KIT_GROUND.
//
//   node scripts/kit/inspect_kit.mjs            # write kitManifest.ts
//   node scripts/kit/inspect_kit.mjs --report   # print the table only
//
// Style and tier are curated (see CLASSES below). The per-building colour statistics quoted there were
// measured on each building's own wall texels of the 1024 atlas (scripts/kit/build_night.py sheet), then
// checked by eye on the facade sheets. tier follows height in metres (rules in tierFor).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readGlb, meshInstances, instanceBounds } from './glb.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const KIT_DIR = path.join(ROOT, 'src/renderer/src/city/kit')
const GLB = path.join(KIT_DIR, 'models/city-kit.glb')
const OUT = path.join(KIT_DIR, 'kitManifest.ts')

export const METERS_PER_UNIT = 160 // 1 model unit ~ 160 m (the tallest tower is ~2.69 units, ~430 m)

// node -> curated classification. blue/warm/dark/white = share of the building's wall texels.
const CLASSES = {
  Object_4: { style: 'stone', note: 'beige punched-window stone, neutral 155/151/148, dark 0.19' },
  Object_6: { style: 'glass', note: 'blue curtain wall, blue 0.58' },
  Object_10: { style: 'glass', note: 'blue curtain wall, blue 0.56' },
  Object_12: { style: 'glass', note: 'blue curtain wall, blue 0.71' },
  Object_14: { style: 'glass', note: 'dark blue glass, blue 0.61' },
  Object_16: { style: 'concrete', note: 'grey office slab, white 0.27' },
  Object_18: { style: 'concrete', note: 'pale grey office slab, white 0.27' },
  Object_20: { style: 'glass', note: 'pale green-grey glazed office, white 0.45' },
  Object_22: { style: 'glass', note: 'light glazed office, blue 0.33' },
  Object_24: { style: 'deco', note: 'tan art-deco setback spire, warm 0.50' },
  Object_26: { style: 'concrete', note: 'grey concrete strip windows, dark 0.16' },
  Object_28: { style: 'glass', note: 'blue glass tower, blue 0.87' },
  Object_30: { style: 'glass', note: 'blue glass, blue 0.71' },
  Object_32: { style: 'concrete', note: 'white and black striped tower, white 0.36' },
  Object_34: { style: 'glass', note: 'duplicate of Object_20' },
  Object_36: { style: 'concrete', note: 'white and black striped tower, white 0.39' },
  Object_38: { style: 'concrete', note: 'grey office, dark 0.18' },
  Object_40: { style: 'concrete', note: 'white and black striped tower, white 0.52' },
  Object_42: { style: 'stone', note: 'duplicate of Object_4' },
  Object_46: { style: 'concrete', note: 'duplicate of Object_36' }
}
const SKIP = {
  Object_8: 'ground (flat aerial-photo plane) -> KIT_GROUND',
  Object_44: 'sliver: 0.03 units tall, floating at y 0.72 (not a building)'
}

export function tierFor(heightM) {
  if (heightM >= 300) return 'supertall'
  if (heightM >= 150) return 'tower'
  if (heightM >= 70) return 'midrise'
  return 'lowrise'
}

const round1 = (v) => Math.round(v * 10) / 10

export function collect(glbPath = GLB) {
  const { json, bin } = readGlb(fs.readFileSync(glbPath))
  const buildings = []
  let ground = null
  const skipped = []
  for (const inst of meshInstances(json, bin)) {
    const b = instanceBounds(inst)
    const size = { x: b.max[0] - b.min[0], y: b.max[1] - b.min[1], z: b.max[2] - b.min[2] }
    const tris = inst.prims.reduce((n, p) => n + p.triangles.length / 3, 0)
    if (SKIP[inst.name]) {
      if (inst.name === GROUND_NODE) ground = { node: inst.name, size, tris }
      else skipped.push({ node: inst.name, reason: SKIP[inst.name], size, tris })
      continue
    }
    const cls = CLASSES[inst.name]
    if (!cls) throw new Error(`${inst.name}: not classified (add it to CLASSES or SKIP)`)
    const heightM = round1(size.y * METERS_PER_UNIT)
    buildings.push({
      id: `${cls.style}-${inst.name.replace('Object_', '')}`,
      node: inst.name,
      size: { x: round(size.x), y: round(size.y), z: round(size.z) },
      heightM,
      footprintM: { w: round1(size.x * METERS_PER_UNIT), d: round1(size.z * METERS_PER_UNIT) },
      style: cls.style,
      tier: tierFor(heightM),
      tris,
      note: cls.note
    })
  }
  if (!ground) throw new Error('ground node Object_8 not found')
  return { buildings, ground, skipped }
}

const GROUND_NODE = 'Object_8'
const round = (v) => Math.round(v * 10000) / 10000

function table({ buildings, ground, skipped }) {
  const lines = []
  lines.push('node      id              style     tier       heightM  footprint(m)   tris  note')
  for (const b of buildings) {
    lines.push(`${b.node.padEnd(9)} ${b.id.padEnd(15)} ${b.style.padEnd(9)} ${b.tier.padEnd(10)} ${String(b.heightM).padStart(7)}  ${(b.footprintM.w + 'x' + b.footprintM.d).padEnd(13)} ${String(b.tris).padStart(5)}  ${b.note}`)
  }
  lines.push(`ground    KIT_GROUND  ${'-'.padEnd(9)} ${'-'.padEnd(10)} ${String(round1(ground.size.y * METERS_PER_UNIT)).padStart(7)}  ${round1(ground.size.x * METERS_PER_UNIT)}x${round1(ground.size.z * METERS_PER_UNIT)}  ${String(ground.tris).padStart(5)}`)
  for (const s of skipped) lines.push(`skipped   ${s.node}: ${s.reason}`)
  return lines.join('\n')
}

function manifestSource({ buildings, ground, skipped }) {
  const L = []
  L.push('// GENERATED by scripts/kit/inspect_kit.mjs from models/city-kit.glb (CC-BY-4.0, smooth998, sketchfab.com).')
  L.push('// Do not edit by hand: re-run `node scripts/kit/inspect_kit.mjs`.')
  L.push('')
  L.push("export type KitStyle = 'deco' | 'glass' | 'stone' | 'concrete' | 'brick' | 'slab'")
  L.push("export type KitTier = 'supertall' | 'tower' | 'midrise' | 'lowrise'")
  L.push('')
  L.push('export interface KitBuilding {')
  L.push('  id: string')
  L.push('  /** Mesh node name in city-kit.glb. */')
  L.push('  node: string')
  L.push('  /** Native bounding box in model units (1 unit = 160 m). */')
  L.push('  size: { x: number; y: number; z: number }')
  L.push('  heightM: number')
  L.push('  footprintM: { w: number; d: number }')
  L.push('  style: KitStyle')
  L.push('  tier: KitTier')
  L.push('  tris: number')
  L.push('}')
  L.push('')
  L.push(`export const KIT_METERS_PER_UNIT = ${METERS_PER_UNIT}`)
  L.push('')
  L.push('export const KIT_BUILDINGS: KitBuilding[] = [')
  for (const b of buildings) {
    L.push(`  { id: '${b.id}', node: '${b.node}', size: { x: ${b.size.x}, y: ${b.size.y}, z: ${b.size.z} }, heightM: ${b.heightM}, footprintM: { w: ${b.footprintM.w}, d: ${b.footprintM.d} }, style: '${b.style}', tier: '${b.tier}', tris: ${b.tris} },`)
  }
  L.push(']')
  L.push('')
  L.push('/** The flat aerial-photo ground plane (material 1, textured from the ground photo). Not a building. */')
  L.push(`export const KIT_GROUND = { node: '${ground.node}', size: { x: ${round(ground.size.x)}, y: ${round(ground.size.y)}, z: ${round(ground.size.z)} }, tris: ${ground.tris} } as const`)
  L.push('')
  L.push('/** Source nodes left out of KIT_BUILDINGS, with the reason. */')
  L.push('export const KIT_EXCLUDED: { node: string; reason: string }[] = [')
  for (const s of skipped) L.push(`  { node: '${s.node}', reason: '${s.reason}' },`)
  L.push(']')
  L.push('')
  return L.join('\n')
}

// Only run when executed directly (the tests import tierFor / collect).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const data = collect()
  console.log(table(data))
  if (!process.argv.includes('--report')) {
    fs.writeFileSync(OUT, manifestSource(data))
    console.log(`\nwrote ${path.relative(ROOT, OUT)} (${data.buildings.length} buildings)`)
  }
}
