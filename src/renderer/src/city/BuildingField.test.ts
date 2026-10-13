import { describe, expect, it } from 'vitest'
import { Color, MeshStandardMaterial } from 'three'
import type { CityLayout } from '../../../shared/types'
import { BuildingField, COLOR_FADE_S } from './BuildingField'

const layout: CityLayout = {
  buildings: [
    { path: 'a.ts', x: 0, z: 0, w: 2, d: 2, h: 1, lang: 'ts', color: '#ff0000', district: '' },
    { path: 'b.ts', x: 4, z: 0, w: 2, d: 2, h: 1, lang: 'js', color: '#00ff00', district: '' }
  ],
  districts: [],
  size: 120
}
const gate = { mode: 'live' as const, gitTs: null, firstSeen: {} }

function colorOf(f: BuildingField, path: string): number[] {
  const i = f.indexOf(path)
  const arr = f.mesh.geometry.getAttribute('aLang').array as Float32Array
  return [arr[i * 3] ?? 0, arr[i * 3 + 1] ?? 0, arr[i * 3 + 2] ?? 0]
}

describe('BuildingField colors', () => {
  it('starts each building at its layout color', () => {
    const f = new BuildingField(layout, new MeshStandardMaterial(), null, gate)
    const red = new Color('#ff0000')
    expect(colorOf(f, 'a.ts')).toEqual([red.r, red.g, red.b])
  })

  it('eases a recolored building over COLOR_FADE_S and leaves unmapped ones alone', () => {
    const f = new BuildingField(layout, new MeshStandardMaterial(), null, gate)
    const red = new Color('#ff0000')
    const blue = new Color('#0000ff')
    f.setColors(new Map([['a.ts', '#0000ff']]))
    f.step(COLOR_FADE_S / 2)
    const mid = colorOf(f, 'a.ts')
    expect(mid[0]).toBeGreaterThan(0)
    expect(mid[0]).toBeLessThan(red.r)
    expect(mid[2]).toBeGreaterThan(0)
    expect(mid[2]).toBeLessThan(blue.b)

    f.step(COLOR_FADE_S)
    expect(colorOf(f, 'a.ts')).toEqual([blue.r, blue.g, blue.b])
    const green = new Color('#00ff00')
    expect(colorOf(f, 'b.ts')).toEqual([green.r, green.g, green.b])
  })

  it('applies colors at once when not animating', () => {
    const f = new BuildingField(layout, new MeshStandardMaterial(), null, gate)
    const blue = new Color('#0000ff')
    f.setColors(new Map([['a.ts', '#0000ff']]), false)
    expect(colorOf(f, 'a.ts')).toEqual([blue.r, blue.g, blue.b])
  })
})
