import { it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { buildLayout } from '../../../shared/layout'
import { buildRoadPlan } from './streets'

const repos: [string, string][] = [
  ['testrepo', '/home/user/testrepo'],
  ['react', '/tmp/claude-0/-home-user-testrepo/626de28a-f1aa-5694-9a01-7b42b28fe62a/scratchpad/big/react'],
  ['vscode', '/tmp/claude-0/-home-user-testrepo/626de28a-f1aa-5694-9a01-7b42b28fe62a/scratchpad/big/vscode']
]
it('scratch stats', () => {
  for (const [name, dir] of repos) {
    const files = execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean)
    const layout = buildLayout({ root: dir, name, files: files.map((p) => ({ path: p, lang: 'ts', loc: 40, bytes: 1000, mtime: 0, imports: [] })), scannedAt: 0 })
    const t0 = performance.now()
    const plan = buildRoadPlan(layout)
    const ms = performance.now() - t0
    const counts: Record<string, number> = {}
    for (const t of plan.tiles) counts[t.model] = (counts[t.model] ?? 0) + 1
    console.log(`STATS ${name} files=${files.length} ms=${ms.toFixed(0)} scale=${plan.tiles[0]?.scale} tiles=${plan.tiles.length} lights=${plan.lights.length} ${JSON.stringify(counts)}`)
  }
}, 120000)
