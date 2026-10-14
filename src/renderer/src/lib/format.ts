// Pure formatting helpers for the HUD. No React, no DOM.

/** 12.4k, 1.2M, 3.4B. Values under 1000 are rounded integers. */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const a = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  const unit = (v: number, suffix: string): string => {
    const r = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10
    return `${sign}${r}${suffix}`
  }
  if (a < 1000) return `${sign}${Math.round(a)}`
  if (a < 999_950) return unit(a / 1e3, 'k')
  if (a < 999_950_000) return unit(a / 1e6, 'M')
  return unit(a / 1e9, 'B')
}

const usdFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

/** $0.42, $1,204.00 -> $1.2k, <$0.01 for tiny positive amounts. */
export function usd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0.00'
  if (n > 0 && n < 0.005) return '<$0.01'
  if (Math.abs(n) >= 10_000) return `$${compactNumber(n)}`
  return usdFmt.format(n)
}

/** "just now", "2m ago", "3h ago", "5d ago", then a short date. */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const d = now - ts
  if (d < 45_000) return 'just now'
  if (d < 3_600_000) return `${Math.max(1, Math.floor(d / 60_000))}m ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d ago`
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Keeps the start and end of a string: "src/renderer/…/Inspector.tsx". */
export function middleEllipsis(s: string, max = 40): string {
  if (s.length <= max) return s
  const keep = Math.max(2, max - 1)
  const head = Math.ceil(keep * 0.55)
  const tail = keep - head
  return `${s.slice(0, head)}…${tail > 0 ? s.slice(-tail) : ''}`
}

/** Keeps the end of a string, which holds the file name: "…renderer/src/hud/Inspector.tsx". */
export function tailEllipsis(s: string, max = 24): string {
  if (s.length <= max) return s
  return `…${s.slice(-(max - 1))}`
}

/** 45s, 3m 12s, 1h 04m. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  if (m < 60) return `${m}m ${pad2(total % 60)}s`
  const h = Math.floor(m / 60)
  return `${h}h ${pad2(m % 60)}m`
}

/** 512 B, 3.4 KB, 1.2 MB. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${Math.max(0, Math.round(n || 0))} B`
  if (n < 1024 * 1024) return `${n < 10 * 1024 ? (n / 1024).toFixed(1) : Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** 14:05 */
export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

/** Oct 13, 14:05 */
export function dateTime(ts: number): string {
  const d = new Date(ts)
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${date}, ${clockTime(ts)}`
}

/** Last path segment, for both "/" and "\" separators: "C:\dev\app" -> "app". */
export function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i < 0 ? '' : path.slice(0, i)
}

/** Shortens an absolute path to its last two segments for display. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length <= 2 ? parts.join('/') : `…/${parts.slice(-2).join('/')}`
}

/** Friendly model name: "claude-sonnet-4-5-20250929" -> "Sonnet 4.5", "gpt-5-codex" -> "GPT-5 Codex". */
export function modelShort(model?: string): string {
  if (!model) return 'Unknown model'
  const m = model.toLowerCase()
  const family = m.includes('opus') ? 'Opus' : m.includes('sonnet') ? 'Sonnet' : m.includes('haiku') ? 'Haiku' : null
  const ver = /(\d)[-.](\d)/.exec(m)
  if (family) return ver ? `${family} ${ver[1]}.${ver[2]}` : family
  if (m.includes('gpt-5')) return m.includes('codex') ? 'GPT-5 Codex' : 'GPT-5'
  if (m.includes('codex')) return 'Codex'
  return model.length > 22 ? `${model.slice(0, 21)}…` : model
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * Fuzzy score for file paths and labels. Basename matches rank above directory-only matches.
 * Returns -1 when the query does not match.
 */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const base = basename(text)
  const onBase = rawFuzzy(q, base.toLowerCase())
  if (onBase >= 0) return onBase + 20 + (base.toLowerCase().includes(q) ? 6 : 0)
  const onPath = rawFuzzy(q, text.toLowerCase())
  return onPath >= 0 ? onPath : -1
}

/** Subsequence match of lowercased `q` within lowercased `t`. -1 when not all of q appears in order. */
function rawFuzzy(q: string, t: string): number {
  if (!q) return 0
  let score = 0
  let ti = 0
  let streak = 0
  let last = -2
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    let found = -1
    for (let k = ti; k < t.length; k++) {
      if (t[k] === ch) {
        found = k
        break
      }
    }
    if (found < 0) return -1
    const boundary = found === 0 || '/._- '.includes(t[found - 1] ?? '')
    if (found === last + 1) streak++
    else streak = 0
    score += 1 + streak * 2 + (boundary ? 4 : 0) - Math.min(found, 12) * 0.05
    last = found
    ti = found + 1
  }
  // Prefer shorter targets.
  score -= t.length * 0.01
  return score
}
