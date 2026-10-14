// Renderer state for the city and HUD. Pure store: no three.js or React imports.
import { create } from 'zustand'
import type {
  AgentEvent,
  AgentEventType,
  AgentInfo,
  CityLayout,
  GitCommit,
  RepoSnapshot,
  SkylineAPI
} from '@shared/types'
import { buildLayout, neighborhoodIndex, type NeighborhoodIndex } from '@shared/layout'
import {
  buildColorPlan,
  DEFAULT_COLOR_MODE,
  isColorMode,
  nextColorMode,
  type ColorMode,
  type ColorPlan
} from '../lib/colorModes'
import { firstSeenByPath } from '../lib/firstSeen'
import { DEFAULT_TIME_OF_DAY, isTimeOfDay, nextTimeOfDay, type TimeOfDay } from '../city/skyPresets'

export type Mode = 'live' | 'replay' | 'git';
/** The building look: procedural New York facades (default) or the Kenney models. Toggled with B, saved per browser. */
export type BuildingStyle = 'real' | 'stylized';
/** A capture that stages the camera: the framed city for a snapshot, or the orbit for a flyover. */
export type CaptureMode = 'snapshot' | 'flyover';
export interface Heat { ts: number; agentId: string; kind: AgentEventType }

/** Events kept in memory (ascending ts). Older events are dropped from the front. */
export const MAX_EVENTS = 5000

const COLOR_MODE_KEY = 'skyline.colorMode'
const BUILDING_STYLE_KEY = 'skyline.buildingStyle'

/** The saved building style, or 'real'. Storage can be unavailable; the choice is only a convenience. */
function readBuildingStyle(): BuildingStyle {
  try {
    const v = typeof window === 'undefined' ? null : window.localStorage.getItem(BUILDING_STYLE_KEY)
    return v === 'stylized' ? 'stylized' : 'real'
  } catch {
    return 'real'
  }
}

function writeBuildingStyle(s: BuildingStyle): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(BUILDING_STYLE_KEY, s)
  } catch {
    // Not persisted; the style still applies for this session.
  }
}

/** The saved color mode, or the default. Storage can be unavailable (private windows); the choice is only a convenience. */
function readColorMode(): ColorMode {
  try {
    const v = typeof window === 'undefined' ? null : window.localStorage.getItem(COLOR_MODE_KEY)
    return isColorMode(v) ? v : DEFAULT_COLOR_MODE
  } catch {
    return DEFAULT_COLOR_MODE
  }
}

function writeColorMode(m: ColorMode): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(COLOR_MODE_KEY, m)
  } catch {
    // Not persisted; the mode still applies for this session.
  }
}

const TIME_OF_DAY_KEY = 'skyline.timeOfDay'

/** The saved time of day, or the default (blue hour). Storage can be unavailable; the choice is a convenience. */
function readTimeOfDay(): TimeOfDay {
  try {
    const v = typeof window === 'undefined' ? null : window.localStorage.getItem(TIME_OF_DAY_KEY)
    return isTimeOfDay(v) ? v : DEFAULT_TIME_OF_DAY
  } catch {
    return DEFAULT_TIME_OF_DAY
  }
}

function writeTimeOfDay(t: TimeOfDay): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(TIME_OF_DAY_KEY, t)
  } catch {
    // Not persisted; the sky still changes for this session.
  }
}

interface SkyState {
  repo: RepoSnapshot | null; layout: CityLayout | null;
  agents: AgentInfo[]; events: AgentEvent[];            // events capped at 5000, ascending ts
  heat: Record<string, Heat>;                            // last touch per file path (live)
  selectedPath: string | null; hoveredPath: string | null; focusAgentId: string | null;
  mode: Mode; replayTs: number | null;                   // replay: show state as of replayTs
  commits: GitCommit[]; firstSeen: Record<string, number>; gitTs: number | null; // git time-lapse
  showImports: boolean; reducedMotion: boolean;
  frameSeq: number;                                      // bumped to glide the camera to the framed pose (F, repo open)
  capture: CaptureMode | null;                           // set while the camera is staged for a capture (also hides the HUD for flyovers)
  captureDpr: number | null;                             // raised pixel ratio while a snapshot is rendered, so the image is large enough
  colorMode: ColorMode;                                  // what the buildings are colored by (persisted)
  buildingStyle: BuildingStyle;                          // real facades or the Kenney models (persisted)
  hoods: NeighborhoodIndex | null;                       // neighborhoods of the current layout (derived in setRepo)
  colorPlan: ColorPlan | null;                           // building colors and legend for colorMode (derived in setRepo / setColorMode)
  director: boolean;                                     // director camera (V): cuts between shots while the user is hands-off; never on with reduced motion
  setDirector(on: boolean): void; toggleDirector(): void;
  setRepo(s: RepoSnapshot): void;                        // recompute layout via buildLayout
  setAgents(a: AgentInfo[]): void; pushEvent(e: AgentEvent): void; setEvents(e: AgentEvent[]): void;
  select(path: string | null): void; hover(path: string | null): void; focusAgent(id: string | null): void;
  setMode(m: Mode): void; setReplayTs(ts: number | null): void;
  setCommits(c: GitCommit[]): void;                      // computes firstSeen (see lib/firstSeen.ts)
  setGitTs(ts: number | null): void; toggleImports(): void;
  requestFrame(): void; setCapture(m: CaptureMode | null): void; setCaptureDpr(d: number | null): void;
  setColorMode(m: ColorMode): void; cycleColorMode(): void;
  setBuildingStyle(s: BuildingStyle): void; toggleBuildingStyle(): void;
  timeOfDay: TimeOfDay;                                  // sky preset: blue hour, night or dawn (persisted, key T)
  setTimeOfDay(t: TimeOfDay): void; cycleTimeOfDay(): void;
}

/** Event types that count as touching a file for heat. */
function touches(type: AgentEventType): boolean {
  return type === 'read' || type === 'edit' || type === 'create' || type === 'delete'
}

function detectReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** Keeps events ascending by ts (inserting out-of-order arrivals) and capped at MAX_EVENTS. */
function insertSorted(list: readonly AgentEvent[], e: AgentEvent): AgentEvent[] {
  const last = list[list.length - 1]
  let next: AgentEvent[]
  if (!last || last.ts <= e.ts) {
    next = list.concat(e)
  } else {
    // Binary search for the first index whose ts is greater than e.ts.
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if ((list[mid]?.ts ?? 0) <= e.ts) lo = mid + 1
      else hi = mid
    }
    next = list.slice()
    next.splice(lo, 0, e)
  }
  return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next
}

/**
 * Heat as of `ts`: the last touch per file among events with e.ts <= ts.
 * Events are kept ascending, so this scans until the first event past ts.
 */
export function heatAt(state: Pick<SkyState, 'events'>, ts: number): Record<string, Heat> {
  const heat: Record<string, Heat> = {}
  for (const e of state.events) {
    if (e.ts > ts) break
    if (!e.file || !touches(e.type)) continue
    heat[e.file] = { ts: e.ts, agentId: e.agentId, kind: e.type }
  }
  return heat
}

/** Heat for the live view: derived from the events array, last touch per file. */
function heatFromEvents(events: readonly AgentEvent[]): Record<string, Heat> {
  const heat: Record<string, Heat> = {}
  for (const e of events) {
    if (!e.file || !touches(e.type)) continue
    const prev = heat[e.file]
    if (!prev || prev.ts <= e.ts) heat[e.file] = { ts: e.ts, agentId: e.agentId, kind: e.type }
  }
  return heat
}

export const useSky = create<SkyState>()((set, get) => ({
  repo: null,
  layout: null,
  agents: [],
  events: [],
  heat: {},
  selectedPath: null,
  hoveredPath: null,
  focusAgentId: null,
  mode: 'live',
  replayTs: null,
  commits: [],
  firstSeen: {},
  gitTs: null,
  showImports: false,
  reducedMotion: detectReducedMotion(),
  frameSeq: 0,
  capture: null,
  captureDpr: null,
  colorMode: readColorMode(),
  buildingStyle: readBuildingStyle(),
  timeOfDay: readTimeOfDay(),
  hoods: null,
  colorPlan: null,
  director: false,

  setDirector(on) {
    set({ director: on && !get().reducedMotion })
  },

  toggleDirector() {
    get().setDirector(!get().director)
  },

  setRepo(s) {
    const layout = buildLayout(s)
    const { selectedPath, colorMode } = get()
    const hoods = neighborhoodIndex(layout.buildings.map((b) => b.path))
    set({
      repo: s,
      layout,
      hoods,
      colorPlan: buildColorPlan(colorMode, layout.buildings, s.files, hoods),
      // Drop the selection if the file no longer exists after the rescan.
      selectedPath: selectedPath && layout.buildings.some((b) => b.path === selectedPath) ? selectedPath : null
    })
  },

  setAgents(a) {
    set({ agents: a })
  },

  pushEvent(e) {
    const events = insertSorted(get().events, e)
    const heat = get().heat
    if (e.file && touches(e.type)) {
      const prev = heat[e.file]
      if (!prev || prev.ts <= e.ts) {
        set({ events, heat: { ...heat, [e.file]: { ts: e.ts, agentId: e.agentId, kind: e.type } } })
        return
      }
    }
    set({ events })
  },

  setEvents(e) {
    const sorted = e.slice().sort((a, b) => a.ts - b.ts)
    const capped = sorted.length > MAX_EVENTS ? sorted.slice(sorted.length - MAX_EVENTS) : sorted
    set({ events: capped, heat: heatFromEvents(capped) })
  },

  select(path) {
    set({ selectedPath: path })
  },

  hover(path) {
    if (get().hoveredPath !== path) set({ hoveredPath: path })
  },

  focusAgent(id) {
    set({ focusAgentId: id })
  },

  setMode(m) {
    set({ mode: m })
  },

  setReplayTs(ts) {
    set({ replayTs: ts })
  },

  setCommits(c) {
    set({ commits: c, firstSeen: firstSeenByPath(c) })
  },

  setGitTs(ts) {
    set({ gitTs: ts })
  },

  toggleImports() {
    set({ showImports: !get().showImports })
  },

  requestFrame() {
    set({ frameSeq: get().frameSeq + 1 })
  },

  setCapture(m) {
    set({ capture: m })
  },

  setCaptureDpr(d) {
    set({ captureDpr: d })
  },

  setColorMode(m) {
    const { layout, repo, hoods } = get()
    writeColorMode(m)
    set({
      colorMode: m,
      colorPlan: layout && repo && hoods ? buildColorPlan(m, layout.buildings, repo.files, hoods) : null
    })
  },

  cycleColorMode() {
    get().setColorMode(nextColorMode(get().colorMode))
  },

  setBuildingStyle(s) {
    writeBuildingStyle(s)
    set({ buildingStyle: s })
  },

  toggleBuildingStyle() {
    get().setBuildingStyle(get().buildingStyle === 'real' ? 'stylized' : 'real')
  },

  setTimeOfDay(t) {
    writeTimeOfDay(t)
    set({ timeOfDay: t })
  },

  cycleTimeOfDay() {
    get().setTimeOfDay(nextTimeOfDay(get().timeOfDay))
  }
}))

/**
 * Wires main-process events into the store. Returns an unsubscribe that removes all three listeners.
 */
export function bootstrapSky(api: SkylineAPI): () => void {
  const offAgents = api.on('agents', (a) => useSky.getState().setAgents(a))
  const offEvent = api.on('event', (e) => useSky.getState().pushEvent(e))
  const offRepo = api.on('repo', (s) => useSky.getState().setRepo(s))
  // Git history after HEAD, a ref or the reflog moved: keeps the time-lapse current without a reopen.
  const offHistory = api.on('history', (c) => useSky.getState().setCommits(c))
  return () => {
    offAgents()
    offEvent()
    offRepo()
    offHistory()
  }
}
