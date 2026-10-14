#!/usr/bin/env node
// Measures every GLB under a directory: native bounds (after node transforms), triangle count,
// origin offset (distance from the file origin to the base-centre) and the contract class.
//   node scripts/measure-models.mjs [dir=src/renderer/src/city/assets/models] [--json]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify, measureGlb } from './lib/glb.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const dir = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(ROOT, 'src/renderer/src/city/assets/models'))

const rows = []
for (const pack of fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  for (const file of fs.readdirSync(path.join(dir, pack.name)).filter((f) => f.endsWith('.glb')).sort()) {
    const id = file.replace(/\.glb$/, '')
    const m = measureGlb(fs.readFileSync(path.join(dir, pack.name, file)))
    rows.push({ id, pack: pack.name, cls: classify(id, m.size.y, pack.name), ...m })
  }
}
if (asJson) {
  console.log(JSON.stringify(rows, null, 2))
} else {
  console.log('class      id                          pack        x       y       z      tris  origin(x,y,z)')
  for (const r of rows) {
    const { x, y, z } = r.size
    console.log(`${r.cls.padEnd(10)} ${r.id.padEnd(27)} ${r.pack.padEnd(10)} ${String(x).padEnd(7)} ${String(y).padEnd(7)} ${String(z).padEnd(7)} ${String(r.tris).padEnd(5)} (${r.origin.x},${r.origin.y},${r.origin.z})`)
  }
  console.log(`${rows.length} models`)
}
