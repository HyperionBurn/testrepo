// UI-only state: overlays, scanning and dock preferences. Repo data lives in state/store.ts.
import { create } from 'zustand'

export type DockTab = 'agents' | 'activity';

const DOCK_KEY = 'skyline.dockCollapsed'

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(DOCK_KEY) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(v: boolean): void {
  try {
    window.localStorage.setItem(DOCK_KEY, v ? '1' : '0')
  } catch {
    // Storage can be unavailable (private windows). The preference is a convenience only.
  }
}

interface UiState {
  palette: boolean;
  dispatch: boolean;
  digest: boolean;
  digestSince: number;
  scanning: boolean;
  scanLabel: string;
  dockCollapsed: boolean;
  dockTab: DockTab;
  setPalette(open: boolean): void;
  setDispatch(open: boolean): void;
  openDigest(sinceTs: number): void;
  closeDigest(): void;
  setScanning(on: boolean, label?: string): void;
  toggleDock(): void;
  setDockTab(t: DockTab): void;
}

export const useUi = create<UiState>()((set, get) => ({
  palette: false,
  dispatch: false,
  digest: false,
  digestSince: 0,
  scanning: false,
  scanLabel: 'Surveying the city…',
  dockCollapsed: readCollapsed(),
  dockTab: 'agents',
  setPalette(open) {
    set({ palette: open })
  },
  setDispatch(open) {
    set({ dispatch: open })
  },
  openDigest(sinceTs) {
    set({ digest: true, digestSince: sinceTs })
  },
  closeDigest() {
    set({ digest: false })
  },
  setScanning(on, label) {
    set({ scanning: on, scanLabel: label ?? 'Surveying the city…' })
  },
  toggleDock() {
    const next = !get().dockCollapsed
    writeCollapsed(next)
    set({ dockCollapsed: next })
  },
  setDockTab(t) {
    set({ dockTab: t })
  }
}))
