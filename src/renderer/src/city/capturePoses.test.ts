import { describe, expect, it } from 'vitest'
import type { AgentInfo, CityBuilding, CityLayout } from '../../../shared/types'
import { hudsonBlue, canyon, midtownAerial, poseFor } from './capturePoses'
import { hashName, metroCores, RIVER_INNER, RIVER_OUTER } from './metro'

const hashNameForTest = (name: string): number => hashName(name)

const ctx = { repoName: 'testrepo', layout: null, agents: [] as AgentInfo[] }

function building(path: string, x: number, z: number): CityBuilding {
  return { path, x, z, w: 6, d: 6, h: 0.5, lang: 'ts', color: '#fff', district: path.split('/')[0] ?? '' } as CityBuilding
}

describe('capture poses', () => {
  it('overview is the default framing, so it has no pinned pose', () => {
    expect(poseFor('overview', ctx)).toBeNull()
  })

  it('hudson-blue is low, over the Hudson band, looking east toward the repo district', () => {
    const p = hudsonBlue()
    expect(p.pos.x).toBeLessThan(-RIVER_INNER)
    expect(p.pos.x).toBeGreaterThan(-RIVER_OUTER)
    expect(p.pos.y).toBeLessThan(20)
    expect(p.look.x).toBeGreaterThan(p.pos.x)
    expect(poseFor('hudson-blue', ctx)).toEqual(p)
  })

  it('midtown-aerial is high, outside the repo square, and looks back toward it', () => {
    const p = poseFor('midtown-aerial', ctx)
    expect(p).not.toBeNull()
    expect(p!.pos.y).toBeGreaterThan(150)
    const core = metroCores(hashNameForTest('testrepo')).filter((c) => Math.hypot(c.x, c.z) > 320)
    expect(core.length).toBeGreaterThan(0)
    // The camera stands farther from the origin than the look point, so it looks inward.
    expect(Math.hypot(p!.pos.x, p!.pos.z)).toBeGreaterThan(Math.hypot(p!.look.x, p!.look.z))
  })

  it('midtown-aerial falls back to a fixed pose when no core lies outside the repo square', () => {
    const p = midtownAerial([])
    expect(p.pos.y).toBe(200)
  })

  it('canyon stands at street level beside the building an agent is editing', () => {
    const layout = { buildings: [building('src/a.ts', 0, 0), building('src/b.ts', 30, 10)], districts: [], size: 120 } as CityLayout
    const agents = [{ id: 's1', status: 'editing', currentFile: 'src/b.ts' } as AgentInfo]
    const p = canyon(layout, agents)
    expect(p).not.toBeNull()
    expect(p!.pos.y).toBeLessThan(2)
    expect(p!.pos.x).toBeGreaterThan(30)
    expect(Math.abs(p!.look.x - 33)).toBeLessThan(0.01)
  })

  it('canyon falls back to the first building with no active edit', () => {
    const layout = { buildings: [building('src/a.ts', 0, 0)], districts: [], size: 120 } as CityLayout
    const p = canyon(layout, [])
    expect(p).not.toBeNull()
    expect(p!.look.z).toBeCloseTo(3)
  })

  it('canyon has no pose without a layout', () => {
    expect(canyon(null, [])).toBeNull()
  })
})
