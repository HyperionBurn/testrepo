// Bottom-right glass chip: what the buildings are colored by, and the top entries of that mode.
// Click (or C) cycles the mode. Sits above the timeline band, and clears the inspector when one is open.
import { useSky } from '../state/store'
import { useNow } from '../lib/hooks'
import { relativeTime, tailEllipsis } from '../lib/format'
import { COLOR_MODE_LABEL, LEGEND_LIMIT, type ColorMode, type LegendEntry } from '../lib/colorModes'

function countText(mode: ColorMode, e: LegendEntry, now: number): string | null {
  if (mode === 'churn' && e.count !== undefined) return `${e.count} ${e.count === 1 ? 'commit' : 'commits'}`
  if (mode === 'age' && e.ts !== undefined && e.ts > 0) return relativeTime(e.ts, now)
  if (e.count !== undefined) return e.count.toLocaleString('en-US')
  return null
}

/** What the two ends of a churn or age ramp mean. */
const RAMP_ENDS: Partial<Record<ColorMode, [string, string]>> = {
  churn: ['Rarely changed', 'Most changed'],
  age: ['Older', 'Recent']
}

export function ColorLegend() {
  const repo = useSky((s) => s.repo)
  const plan = useSky((s) => s.colorPlan)
  const mode = useSky((s) => s.colorMode)
  const inspecting = useSky((s) => s.selectedPath !== null)
  const now = useNow(60_000)
  if (!repo || !plan) return null

  const cycle = () => useSky.getState().cycleColorMode()
  const entries = plan.legend.slice(0, LEGEND_LIMIT)
  const label = COLOR_MODE_LABEL[mode]
  const ramp = plan.ramp
  const ends = RAMP_ENDS[mode]
  const gradient = ramp
    ? `linear-gradient(90deg, ${ramp.map((c, i) => `${c} ${Math.round((i / Math.max(1, ramp.length - 1)) * 100)}%`).join(', ')})`
    : null

  return (
    <div
      className={`legend glass${inspecting ? ' legend--beside' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`Color by ${label}. Click to change.`}
      title="Change color (C)"
      onClick={cycle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          cycle()
        }
      }}
    >
      <div className="legend__head">
        <span className="legend__title">Color</span>
        <span className="legend__mode">{label}</span>
        <span className="legend__hint kbd">C</span>
      </div>
      {gradient && <div className="legend__ramp" style={{ background: gradient }} aria-hidden="true" />}
      {gradient && ends && (
        <div className="legend__scale" aria-hidden="true">
          <span>{ends[0]}</span>
          <span>{ends[1]}</span>
        </div>
      )}
      {plan.note && <div className="legend__note">{plan.note}</div>}
      {entries.length > 0 && (
        <ul className="legend__list">
          {entries.map((e) => {
            const extra = countText(mode, e, now)
            return (
              <li key={e.key} className="legend__row" title={e.label}>
                <span className="legend__dot" style={{ background: e.color, boxShadow: `0 0 8px ${e.color}` }} aria-hidden="true" />
                <span className="legend__label">{mode === 'churn' || mode === 'age' ? tailEllipsis(e.label, 18) : e.label}</span>
                {extra && <span className="legend__count">{extra}</span>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
