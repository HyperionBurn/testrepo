// Color modes for the city's buildings. Pure: no three.js, no DOM.
//   area      one hue per neighborhood (see neighborhoodIndex in shared/layout.ts); root files stay silver
//   language  the extension palette from shared/lang.ts
//   churn     commit count, cool to hot (indigo, cyan, amber, magenta) by percentile
//   age       last modification, dim slate (old) to bright mint (fresh) by percentile
// Relative imports (not @shared) so the vitest run, which has no alias, can load this module.
import type { CityBuilding, FileNode, Lang } from '../../../shared/types'
import { LANG_COLORS, LANG_LABEL } from '../../../shared/lang'
import { hexToRgb } from '../../../shared/color'
import type { NeighborhoodIndex } from '../../../shared/layout'

export const COLOR_MODES = ['area', 'language', 'churn', 'age'] as const
export type ColorMode = (typeof COLOR_MODES)[number]
export const DEFAULT_COLOR_MODE: ColorMode = 'area'
export const COLOR_MODE_LABEL: Readonly<Record<ColorMode, string>> = {
  area: 'Area',
  language: 'Language',
  churn: 'Churn',
  age: 'Age'
}

/**
 * Ten luminous hues on navy, spaced by the golden angle (137.5 degrees) from 60 degrees. Neighborhoods take them
 * in size order, so the largest, which covers the most ground, is gold rather than blue-on-navy.
 */
export const AREA_PALETTE: readonly string[] = [
  '#F4D452', '#52C5F4', '#F45296', '#67F452', '#6D52F4',
  '#F3923F', '#52F4CC', '#F452ED', '#ADE935', '#528FF4'
]
export const ROOT_SILVER = '#C4CDD9'

type Stop = readonly [position: number, color: string];
const CHURN_RAMP: readonly Stop[] = [
  [0, '#4338CA'],   // indigo: rarely touched
  [1 / 3, '#22D3EE'], // cyan
  [2 / 3, '#FBBF24'], // amber
  [1, '#E879F9']    // magenta: the hottest files
]
const AGE_RAMP: readonly Stop[] = [
  [0, '#2B3648'],   // dim slate: untouched for longest
  [1, '#6CFFC2']    // bright mint: modified most recently
]

export const LEGEND_LIMIT = 6

export function isColorMode(v: unknown): v is ColorMode {
  return typeof v === 'string' && (COLOR_MODES as readonly string[]).includes(v)
}

export function nextColorMode(m: ColorMode): ColorMode {
  const i = COLOR_MODES.indexOf(m)
  return COLOR_MODES[(i + 1) % COLOR_MODES.length] ?? DEFAULT_COLOR_MODE
}

export interface LegendEntry {
  key: string;
  label: string;
  color: string;
  /** Commit count (churn) or last-modified time in ms (age). */
  count?: number;
  ts?: number;
}

export interface ColorPlan {
  mode: ColorMode;
  /** Building color by repo-relative path, for the current mode. */
  colors: Map<string, string>;
  /** Hue of each neighborhood key (always computed). Labels glow in these. */
  areaColors: Map<string, string>;
  /** Top entries for the legend chip. */
  legend: LegendEntry[];
  /** Evenly spaced gradient stops for the chip's ramp bar (churn, age), otherwise null. */
  ramp: string[] | null;
  /** Shown instead of the entries when the mode cannot be computed (e.g. no git history). */
  note: string | null;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

function toHex(r: number, g: number, b: number): string {
  const to2 = (v: number): string => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')
  return `#${to2(r)}${to2(g)}${to2(b)}`.toUpperCase()
}

/** Color at position t along a ramp, interpolated in sRGB. */
export function rampAt(stops: readonly Stop[], t: number): string {
  const x = clamp01(t)
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i] ?? [1, '#ffffff']
    const [t0, c0] = stops[i - 1] ?? [0, '#000000']
    if (x <= t1) {
      const k = t1 === t0 ? 0 : (x - t0) / (t1 - t0)
      const a = hexToRgb(c0)
      const b = hexToRgb(c1)
      return toHex(a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k)
    }
  }
  return stops[stops.length - 1]?.[1] ?? '#ffffff'
}

/**
 * Percentile rank of each value in [0, 1]: the smallest value maps to 0, the largest to 1, and ties share
 * the mean of their positions. A single value maps to 0.5.
 */
export function percentileRanks(values: readonly number[]): number[] {
  const n = values.length
  if (n <= 1) return values.map(() => 0.5)
  const sorted = Float64Array.from(values).sort()
  return values.map((v) => {
    let lo = 0
    let hi = n
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if ((sorted[mid] ?? 0) < v) lo = mid + 1
      else hi = mid
    }
    const first = lo
    hi = n
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if ((sorted[mid] ?? 0) <= v) lo = mid + 1
      else hi = mid
    }
    const meanIndex = (first + lo - 1) / 2
    return clamp01(meanIndex / (n - 1))
  })
}

/** Top `limit` indexes by value, descending, ties by index (stable). */
function topIndexes(values: readonly number[], limit: number, keep: (v: number) => boolean): number[] {
  const idx = values.map((_, i) => i).filter((i) => keep(values[i] ?? 0))
  idx.sort((a, b) => (values[b] ?? 0) - (values[a] ?? 0) || a - b)
  return idx.slice(0, limit)
}

function areaPlan(buildings: readonly CityBuilding[], hoods: NeighborhoodIndex): ColorPlan {
  const areaColors = new Map<string, string>()
  let hue = 0
  for (const g of hoods.groups) {
    if (g.key === '') {
      areaColors.set('', ROOT_SILVER)
    } else {
      areaColors.set(g.key, AREA_PALETTE[hue % AREA_PALETTE.length] ?? ROOT_SILVER)
      hue++
    }
  }
  const colors = new Map<string, string>()
  for (const b of buildings) {
    const key = hoods.keyOf.get(b.path) ?? ''
    colors.set(b.path, areaColors.get(key) ?? ROOT_SILVER)
  }
  const legend = hoods.groups.slice(0, LEGEND_LIMIT).map((g) => ({
    key: g.key,
    label: g.key === '' ? 'Root files' : g.key,
    color: areaColors.get(g.key) ?? ROOT_SILVER,
    count: g.count
  }))
  return { mode: 'area', colors, areaColors, legend, ramp: null, note: null }
}

function languagePlan(buildings: readonly CityBuilding[], areaColors: Map<string, string>): ColorPlan {
  const colors = new Map<string, string>()
  const counts = new Map<Lang, number>()
  for (const b of buildings) {
    colors.set(b.path, LANG_COLORS[b.lang])
    counts.set(b.lang, (counts.get(b.lang) ?? 0) + 1)
  }
  const legend = [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, LEGEND_LIMIT)
    .map(([lang, n]) => ({ key: lang, label: LANG_LABEL[lang], color: LANG_COLORS[lang], count: n }))
  return { mode: 'language', colors, areaColors, legend, ramp: null, note: null }
}

/** Shared shape of churn and age: one value per building, percentile-ranked onto a ramp. */
function rampPlan(
  mode: 'churn' | 'age',
  buildings: readonly CityBuilding[],
  values: readonly number[],
  stops: readonly Stop[],
  areaColors: Map<string, string>,
  note: string | null,
  legendFor: (i: number, ranks: readonly number[]) => LegendEntry
): ColorPlan {
  // Without the data every building sits at the cold end (ties would otherwise land mid-ramp).
  const ranks = note ? values.map(() => 0) : percentileRanks(values)
  const colors = new Map<string, string>()
  buildings.forEach((b, i) => colors.set(b.path, rampAt(stops, ranks[i] ?? 0)))
  const legend = note
    ? []
    : topIndexes(values, LEGEND_LIMIT, (v) => v > 0 || mode === 'age').map((i) => legendFor(i, ranks))
  return {
    mode,
    colors,
    areaColors,
    legend,
    ramp: stops.map((s) => s[1]),
    note
  }
}

/** Colors and legend for one mode. `buildings` and `files` describe the same repo; `hoods` covers the buildings. */
export function buildColorPlan(
  mode: ColorMode,
  buildings: readonly CityBuilding[],
  files: readonly FileNode[],
  hoods: NeighborhoodIndex
): ColorPlan {
  const area = areaPlan(buildings, hoods)
  if (mode === 'area') return area
  if (mode === 'language') return languagePlan(buildings, area.areaColors)

  const byPath = new Map<string, FileNode>()
  for (const f of files) byPath.set(f.path, f)

  if (mode === 'churn') {
    const known = files.some((f) => f.commits !== undefined)
    const values = buildings.map((b) => byPath.get(b.path)?.commits ?? 0)
    const note = known ? null : 'No git history, so churn is unknown'
    return rampPlan('churn', buildings, values, CHURN_RAMP, area.areaColors, note, (i, ranks) => {
      const b = buildings[i]
      const commits = values[i] ?? 0
      return {
        key: b?.path ?? '',
        label: b?.path ?? '',
        color: rampAt(CHURN_RAMP, ranks[i] ?? 0),
        count: commits
      }
    })
  }

  // age
  const values = buildings.map((b) => byPath.get(b.path)?.mtime ?? 0)
  return rampPlan('age', buildings, values, AGE_RAMP, area.areaColors, null, (i, ranks) => {
    const b = buildings[i]
    return {
      key: b?.path ?? '',
      label: b?.path ?? '',
      color: rampAt(AGE_RAMP, ranks[i] ?? 0),
      ts: values[i] ?? 0
    }
  })
}
