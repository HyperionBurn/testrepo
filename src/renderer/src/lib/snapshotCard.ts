// The branded stats card for snapshots, drawn on a 2D canvas over the city frame. Pure drawing: the
// caller supplies the grabbed frame and the stats.
import type { AgentInfo } from '@shared/types'
import { compactNumber, usd } from './format'

export interface CardStats {
  repo: string;
  agents: number;
  edits: number;
  files: number;
  cost: number;
  legend: { name: string; color: string }[];
  more: number;
}

const LEGEND_MAX = 5

/** Stats for the card, from the agents of the open repo. */
export function cardStats(agents: readonly AgentInfo[], repo: string): CardStats {
  const touched = new Set<string>()
  let edits = 0
  let cost = 0
  for (const a of agents) {
    edits += a.edits
    cost += a.costUsd
    for (const f of a.filesTouched) touched.add(f)
  }
  const recent = [...agents].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  return {
    repo,
    agents: agents.length,
    edits,
    files: touched.size,
    cost,
    legend: recent.slice(0, LEGEND_MAX).map((a) => ({ name: a.name, color: a.color })),
    more: Math.max(0, agents.length - LEGEND_MAX)
  }
}

const FONT_DISPLAY = '"Segoe UI Variable Display", "Segoe UI", Inter, system-ui, -apple-system, sans-serif'
const FONT_TEXT = '"Segoe UI Variable Text", "Segoe UI", Inter, system-ui, -apple-system, sans-serif'

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Shortens text with an ellipsis until it fits maxW. */
function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1)
  return `${t}…`
}

/** The three-bar glyph of the title bar, scaled to size px tall. */
function glyph(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const bw = size * 0.22
  const gap = size * 0.14
  const heights = [0.55, 1, 0.75]
  const grad = ctx.createLinearGradient(x, y, x, y + size)
  grad.addColorStop(0, '#7cc0ff')
  grad.addColorStop(1, '#0a84ff')
  ctx.fillStyle = grad
  heights.forEach((hf, i) => {
    const h = size * hf
    roundRect(ctx, x + i * (bw + gap), y + size - h, bw, h, bw * 0.3)
    ctx.fill()
  })
}

/**
 * Composes the snapshot: the grabbed frame, a frosted glass card bottom-left with the repo, the session stats
 * and a legend of agent colours, and the Skyline wordmark bottom-right. Returns a new canvas.
 */
export async function composeSnapshot(src: HTMLCanvasElement, stats: CardStats): Promise<HTMLCanvasElement> {
  try {
    await document.fonts?.ready
  } catch {
    // Fonts are cosmetic; draw with whatever is available.
  }
  const W = src.width
  const H = src.height
  const out = document.createElement('canvas')
  out.width = W
  out.height = H
  const ctx = out.getContext('2d')
  if (!ctx) return src
  ctx.drawImage(src, 0, 0)

  // Every size below is in units of s, so the card keeps its proportions at any resolution.
  const s = Math.min(2.4, Math.max(0.6, H / 1080))
  const margin = 44 * s
  const pad = 24 * s
  const cardW = Math.round(Math.min(600 * s, Math.max(420 * s, W * 0.3)))
  // Baselines: repo name, stats line, legend. The card ends a pad below the legend.
  const titleBase = pad + 30 * s
  const statsBase = titleBase + 25 * s
  const legendBase = statsBase + 26 * s
  const cardH = Math.round(legendBase + pad - 2 * s)
  const x = margin
  const y = H - margin - cardH
  const r = 22 * s

  // Shadow under the card.
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
  ctx.shadowBlur = 40 * s
  ctx.shadowOffsetY = 12 * s
  roundRect(ctx, x, y, cardW, cardH, r)
  ctx.fillStyle = 'rgba(18, 22, 36, 0.6)'
  ctx.fill()
  ctx.restore()

  // Frosted glass: the frame, blurred and clipped to the card, under a tinted gradient and a soft sheen.
  ctx.save()
  roundRect(ctx, x, y, cardW, cardH, r)
  ctx.clip()
  ctx.filter = `blur(${Math.round(18 * s)}px) saturate(170%)`
  ctx.drawImage(src, 0, 0, W, H)
  ctx.filter = 'none'
  const tint = ctx.createLinearGradient(0, y, 0, y + cardH)
  tint.addColorStop(0, 'rgba(26, 31, 50, 0.52)')
  tint.addColorStop(1, 'rgba(10, 12, 22, 0.74)')
  ctx.fillStyle = tint
  ctx.fillRect(x, y, cardW, cardH)
  const sheen = ctx.createLinearGradient(x, y, x + cardW * 0.6, y + cardH * 0.6)
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.09)')
  sheen.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = sheen
  ctx.fillRect(x, y, cardW, cardH)
  ctx.restore()

  // Hairline border, brighter along the top edge like a lit glass rim.
  ctx.save()
  roundRect(ctx, x + 0.5 * s, y + 0.5 * s, cardW - s, cardH - s, r)
  const rim = ctx.createLinearGradient(0, y, 0, y + cardH)
  rim.addColorStop(0, 'rgba(255, 255, 255, 0.30)')
  rim.addColorStop(0.3, 'rgba(255, 255, 255, 0.12)')
  rim.addColorStop(1, 'rgba(255, 255, 255, 0.07)')
  ctx.strokeStyle = rim
  ctx.lineWidth = Math.max(1, s)
  ctx.stroke()
  ctx.restore()

  // Text: repo, stats, legend.
  const tx = x + pad
  const tw = cardW - pad * 2
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = 'rgba(255, 255, 255, 0.96)'
  ctx.font = `600 ${30 * s}px ${FONT_DISPLAY}`
  ctx.fillText(fit(ctx, stats.repo, tw), tx, y + titleBase)

  const parts: [string, string][] = [
    [compactNumber(stats.agents), stats.agents === 1 ? 'agent' : 'agents'],
    [compactNumber(stats.edits), stats.edits === 1 ? 'edit' : 'edits'],
    [compactNumber(stats.files), stats.files === 1 ? 'file' : 'files'],
    [usd(stats.cost), '']
  ]
  let cx = tx
  const sep = 9 * s
  parts.forEach(([value, label], i) => {
    if (i > 0) {
      cx += sep
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)'
      ctx.font = `400 ${15 * s}px ${FONT_TEXT}`
      ctx.fillText('·', cx, y + statsBase)
      cx += ctx.measureText('·').width + sep
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.96)'
    ctx.font = `600 ${15 * s}px ${FONT_TEXT}`
    ctx.fillText(value, cx, y + statsBase)
    cx += ctx.measureText(value).width
    if (label) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)'
      ctx.font = `400 ${15 * s}px ${FONT_TEXT}`
      cx += 5 * s
      ctx.fillText(label, cx, y + statsBase)
      cx += ctx.measureText(label).width
    }
  })

  ctx.font = `500 ${13 * s}px ${FONT_TEXT}`
  const dot = 4 * s
  let lx = tx
  if (stats.legend.length === 0) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)'
    ctx.fillText('No agent activity yet', lx, y + legendBase)
  }
  for (const item of stats.legend) {
    const label = fit(ctx, item.name, Math.min(150 * s, tw * 0.4))
    const w = dot * 2 + 6 * s + ctx.measureText(label).width
    if (lx + w > x + cardW - pad) break
    const dy = y + legendBase - 4.5 * s
    ctx.beginPath()
    ctx.arc(lx + dot, dy, dot, 0, Math.PI * 2)
    ctx.fillStyle = item.color
    ctx.shadowColor = item.color
    ctx.shadowBlur = 8 * s
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.fillStyle = 'rgba(255, 255, 255, 0.72)'
    ctx.fillText(label, lx + dot * 2 + 6 * s, y + legendBase)
    lx += w + 16 * s
  }
  if (stats.more > 0 && lx < x + cardW - pad - 30 * s) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)'
    ctx.fillText(`+${stats.more}`, lx, y + legendBase)
  }

  // Wordmark, bottom-right, with a shadow so it reads over bright towers.
  const mark = 'Skyline'
  const site = ' · skyline.dev'
  const gs = 17 * s
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.7)'
  ctx.shadowBlur = 12 * s
  ctx.font = `600 ${gs}px ${FONT_DISPLAY}`
  const markW = ctx.measureText(mark).width
  ctx.font = `400 ${gs}px ${FONT_TEXT}`
  const siteW = ctx.measureText(site).width
  const total = gs * 0.9 + 8 * s + markW + siteW
  const baseY = H - margin - 2 * s
  let wx = W - margin - total
  glyph(ctx, wx, baseY - gs * 0.92, gs * 0.9)
  wx += gs * 0.9 + 8 * s
  ctx.font = `600 ${gs}px ${FONT_DISPLAY}`
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)'
  ctx.fillText(mark, wx, baseY)
  wx += markW
  ctx.font = `400 ${gs}px ${FONT_TEXT}`
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)'
  ctx.fillText(site, wx, baseY)
  ctx.restore()

  return out
}
