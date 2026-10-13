// Order of the agent dock's top level: most recently active first, with the filesystem pseudo-agent always last.
// Kept free of store and component imports so it can be unit-tested without a DOM or a store.
import type { AgentInfo } from '@shared/types'

/** Most recently active first. The agent with `fsId` (unattributed filesystem changes) sorts after every real agent. */
export function sortDockAgents(agents: readonly AgentInfo[], fsId: string): AgentInfo[] {
  return agents.slice().sort((a, b) => {
    const fsRank = Number(a.id === fsId) - Number(b.id === fsId)
    return fsRank || b.lastActiveAt - a.lastActiveAt
  })
}
