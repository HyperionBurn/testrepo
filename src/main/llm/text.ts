// Small pure text helpers shared by the heuristic digest, the prompts and the local LLM service.

/** Cut `s` to at most `max` characters, ending with an ellipsis when it was shortened. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s
  if (max <= 1) return s.slice(0, Math.max(0, max))
  return s.slice(0, max - 1) + '…'
}

/** Collapse all whitespace runs to single spaces, trim, then clip. */
export function squash(s: string, max: number): string {
  return clip(s.replace(/\s+/g, ' ').trim(), max)
}

/** "1 edit", "3 edits". Pass `pluralWord` for irregular plurals. */
export function plural(n: number, word: string, pluralWord: string = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`
}

/** Human duration: "<1m", "47m", "2h", "2h 14m", "3d 4h". */
export function formatDuration(ms: number): string {
  const totalMin = Math.floor(Math.max(0, ms) / 60_000)
  if (ms < 60_000) return '<1m'
  if (totalMin < 60) return `${totalMin}m`
  const hours = Math.floor(totalMin / 60)
  const mins = totalMin % 60
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`
}

/** Local wall-clock time as HH:MM. */
export function formatClock(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** USD with two decimals; tiny non-zero amounts show as "<$0.01". */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.005) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
