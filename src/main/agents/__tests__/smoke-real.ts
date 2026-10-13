// Manual smoke check against live transcripts on this machine. Not a test file.
// Run: npx tsx src/main/agents/__tests__/smoke-real.ts
import { AgentHub } from '../hub'
import type { AgentEvent } from '../../../shared/types'

async function main(): Promise<void> {
  const repoRoot = '/home/user/testrepo'
  const hub = new AgentHub({ repoRoot })
  let liveEvents = 0
  hub.on('event', (_e: AgentEvent) => liveEvents++)
  const t0 = Date.now()
  await hub.start()
  const loadMs = Date.now() - t0
  await new Promise((r) => setTimeout(r, 2000))

  const agents = hub.getAgents()
  const events = hub.getEvents()
  console.log(`repo ${repoRoot}: ${agents.length} agents, ${events.length} events buffered (initial load ${loadMs} ms, live events ${liveEvents})`)
  for (const a of agents) {
    const t = a.tokens
    console.log(
      [
        `- ${a.name}`,
        `kind=${a.kind}`,
        `status=${a.status}`,
        a.parentId ? `parent=${a.parentId.slice(0, 6)}` : '',
        `tokens in=${t.input} out=${t.output} cacheR=${t.cacheRead} cacheW=${t.cacheWrite}`,
        `cost=$${a.costUsd.toFixed(4)}`,
        `files=${a.filesTouched.length}`,
        `edits=${a.edits} reads=${a.reads} cmds=${a.commands}`
      ]
        .filter(Boolean)
        .join(' | ')
    )
  }
  hub.stop()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
