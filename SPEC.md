# Loupe — Product & Engineering Spec

> **Loupe** is a free, open-source, 100% offline AI photo culler for Windows.
> Drop in a shoot (or a messy camera roll). Loupe finds the blinks, the blur, the
> near-duplicates, picks the best frame of every burst, and writes star ratings
> that Lightroom / Capture One read instantly. Then lets you *search your shoot
> in plain English* — "bride laughing", "dog on the beach" — on your own machine.

## Why this exists (pain / market)
- Photographers spend 2–6 hours culling every wedding/event (2,000–6,000 frames).
- Paid tools do it with AI: Aftershoot ($15–45/mo), Narrative Select, FilterPixel, Imagen (cloud).
  No polished open-source local alternative exists.
- Consumer angle (bigger TAM): everyone has 20k+ photo camera-roll dumps full of
  bursts, blurry shots and duplicates.
- Viral hook: "Culled 3,000 wedding photos in 4 minutes. Offline. Free." + a
  shareable "Loupe saved you 2h 41m" summary card.

## Stack (fixed — do not change)
- Electron + **electron-vite** + React 18 + TypeScript (strict). Package manager: npm.
- Packaging: **electron-builder**, Windows target `nsis` (x64) + `portable`. Built by
  GitHub Actions on `windows-latest` (`.github/workflows/build.yml`).
- Native/heavy deps: `sharp` (decode/resize/pixels), `exiftool-vendored`
  (EXIF read, RAW embedded preview extraction, XMP sidecar writing).
- AI runs in a **hidden BrowserWindow** ("AI worker", `src/worker/`) so it gets
  WebGPU/WebGL/WASM acceleration on any GPU vendor:
  - `@mediapipe/tasks-vision` FaceLandmarker (with blendshapes → blink detection).
    Model `face_landmarker.task` + wasm files are **bundled** in `resources/models/` and
    copied wasm from the npm package at build time (no CDN at runtime).
  - `@huggingface/transformers` CLIP `Xenova/clip-vit-base-patch32` (image + text
    embeddings). Downloaded once on first run to `app.getPath('userData')/models`, with
    progress UI. After that, zero network.
- Tests: `vitest` for pure logic (`src/shared`, `src/main` utilities).

## Directory layout
```
src/
  shared/          # pure TS, no electron/node-only imports except types
    types.ts       # ALL cross-process types (contract below)
    ipc.ts         # channel name constants
    scoring.ts     # scoring, grouping, decisions, reasons (pure)
    search.ts      # cosine similarity + ranking (pure)
  main/            # Electron main process
    index.ts       # window creation (Win11 acrylic, hidden titlebar + overlay)
    ipc.ts         # ipcMain handlers wiring
    scanner.ts     # folder walk, file type detection
    preview.ts     # RAW preview extraction + sharp thumbnails (cache)
    metrics.ts     # sharpness (Laplacian variance), exposure stats
    exif.ts        # capture time, camera, lens, iso, shutter, aperture, orientation
    xmp.ts         # write XMP sidecars / ratings
    exporter.ts    # copy/move keepers, move rejects to _Rejected (never delete)
    project.ts     # per-folder cache at <folder>/.loupe/project.json
    pipeline.ts    # orchestrates analysis; talks to AI worker; emits progress
    aiBridge.ts    # creates hidden worker window, request/response over IPC
  preload/
    index.ts       # contextBridge exposing window.loupe (typed by LoupeAPI)
  worker/          # hidden AI window (renderer context)
    index.html
    main.ts        # receives jobs, runs faces + clip, replies
    faces.ts
    clip.ts
  renderer/        # the visible app
    index.html
    src/ (App.tsx, components/, screens/, styles/, lib/)
resources/
  models/          # face_landmarker.task (downloaded by scripts/fetch-models.mjs)
  icon.png / icon.ico
scripts/fetch-models.mjs
```

## Core types (`src/shared/types.ts`) — the contract
```ts
export type Verdict = 'keep' | 'maybe' | 'reject';
export type RejectReason =
  | 'eyes_closed' | 'blurry' | 'subject_soft' | 'overexposed' | 'underexposed'
  | 'duplicate' | 'weaker_in_burst';

export interface FaceInfo {
  box: { x: number; y: number; w: number; h: number }; // normalized 0..1
  eyeBlinkLeft: number;   // 0..1 (mediapipe blendshape)
  eyeBlinkRight: number;  // 0..1
  eyesOpen: boolean;      // both blinks < 0.45
  sharpness?: number;     // laplacian variance inside face box (filled by main)
  smile?: number;         // (mouthSmileLeft+Right)/2
}

export interface ExifInfo {
  captureTime?: number;  // ms epoch
  camera?: string; lens?: string;
  iso?: number; shutter?: string; aperture?: number; focalLength?: number;
  width?: number; height?: number; orientation?: number;
}

export interface PhotoMetrics {
  sharpness: number;      // laplacian variance on 512px grayscale (global)
  meanLuma: number;       // 0..255
  clipHigh: number;       // fraction of pixels >= 250
  clipLow: number;        // fraction of pixels <= 5
}

export interface Photo {
  id: string;             // stable hash of relative path
  path: string;           // absolute path of original
  relPath: string;
  name: string;
  isRaw: boolean;
  previewPath: string;    // cached JPEG ~1600px long edge (file path)
  thumbPath: string;      // cached JPEG ~400px long edge
  exif: ExifInfo;
  metrics?: PhotoMetrics;
  faces?: FaceInfo[];
  embedding?: number[];   // CLIP 512-d, L2 normalized (stored in project cache)
  aesthetic?: number;     // 0..1 zero-shot CLIP aesthetic
  // results of scoring:
  score?: number;         // 0..100
  verdict?: Verdict;
  reasons?: RejectReason[];
  groupId?: string;
  isGroupBest?: boolean;
  // user overrides (always win):
  userVerdict?: Verdict;
  rating?: number;        // 0..5
}

export interface Group { id: string; photoIds: string[]; bestId: string; }

export interface Project {
  version: 1;
  folder: string;
  createdAt: number;
  photos: Photo[];
  groups: Group[];
  settings: CullSettings;
  stats?: CullStats;
}

export interface CullSettings {
  strictness: 'gentle' | 'balanced' | 'ruthless';
  groupSimilarity: number;  // cosine threshold, default 0.92
  groupMaxGapSec: number;   // default 8
  rejectBlinks: boolean;    // default true
}

export interface CullStats {
  total: number; keep: number; maybe: number; reject: number;
  blinks: number; blurry: number; duplicates: number; groups: number;
  secondsSaved: number;     // total * 4s heuristic minus analysis time
  analysisMs: number;
}

export type AnalysisPhase = 'scanning' | 'previews' | 'models' | 'faces' | 'embeddings' | 'scoring' | 'done' | 'error';
export interface AnalysisProgress {
  phase: AnalysisPhase; done: number; total: number;
  current?: string;         // file name
  live: { blinks: number; blurry: number; duplicates: number; faces: number };
  message?: string;
}

export interface SearchHit { id: string; score: number; }

export type ExportMode = 'xmp' | 'copy_keepers' | 'move_rejects';

export interface LoupeAPI {
  pickFolder(): Promise<string | null>;
  openProject(folder: string): Promise<Project | null>;   // cached result if any
  analyze(folder: string, settings: CullSettings): Promise<Project>;
  cancel(): Promise<void>;
  onProgress(cb: (p: AnalysisProgress) => void): () => void;
  setVerdict(id: string, verdict: Verdict | null): Promise<void>;
  setRating(id: string, rating: number): Promise<void>;
  rescore(settings: CullSettings): Promise<Project>;
  search(query: string): Promise<SearchHit[]>;
  exportResults(mode: ExportMode, dest?: string): Promise<{ written: number; dest?: string }>;
  revealInExplorer(path: string): Promise<void>;
  fileUrl(path: string): string;  // -> 'loupe-file://...' custom protocol URL
  window: { minimize(): void; maximize(): void; close(): void };
}
```

## Scoring rules (`src/shared/scoring.ts`)
- Normalize sharpness per shoot (percentile within set) — absolute thresholds fail across cameras.
- Face-aware: if faces exist, subject sharpness = max face sharpness (bokeh is intentional).
- `blurry` if sharpness percentile < strictness cutoff (gentle 5%, balanced 12%, ruthless 20%)
  AND absolute laplacian below a floor.
- `eyes_closed` if any face with box area > 1.5% of frame has `eyesOpen === false`.
- Exposure: `overexposed` clipHigh > 0.25, `underexposed` meanLuma < 35 and clipLow > 0.4.
- Grouping: sort by captureTime (fallback name); consecutive photos join a group when
  cosine(embedding) ≥ groupSimilarity and gap ≤ groupMaxGapSec (or no time info).
- Score 0..100 = 40 sharpness pct + 25 eyes/face quality + 20 aesthetic + 15 exposure.
- Best in group = top score. Non-best in group → `maybe` (balanced) / `reject` with
  `weaker_in_burst` (ruthless) / `maybe` (gentle). Near-identical (cos ≥ 0.985) → `duplicate`.
- Verdict: any hard reason → reject; group best & score ≥ 55 → keep; else maybe/keep by score.
- `userVerdict` always overrides. Ratings: keep→ 3★ (best in group 4★, top 10% 5★), maybe→2, reject→1 (written only to XMP with label).

## XMP mapping
- `xmp:Rating` (reject = -1 per Lightroom convention, configurable later), `xmp:Label`
  ("Green" keep, "Yellow" maybe, "Red" reject). Sidecar `<name>.xmp` beside RAWs;
  for JPEGs also write a sidecar (never modify originals).

## Design language — "Liquid Glass" (Apple-inspired)
- Dark-first, also light. Window uses Win11 acrylic (`backgroundMaterial: 'acrylic'`) and
  the app paints a slow, blurred, colorful ambient mesh behind glass panes.
- Glass surfaces: `backdrop-filter: blur(28px) saturate(180%)`, translucent fill
  (`rgba(255,255,255,0.08)` dark / `0.55` light), 1px inner highlight
  (`inset 0 1px 0 rgba(255,255,255,0.25)`), specular gradient sheen top edge, soft
  long shadow, large radii (20–28px), capsule buttons, 8pt spacing grid.
- Typography: "Segoe UI Variable Display/Text" (native Windows), fallback Inter.
  Tight tracking on large titles. SF-like hierarchy: 34 / 22 / 17 / 13.
- Motion: spring easing `cubic-bezier(.2,.8,.2,1)`, 240–420ms; respect `prefers-reduced-motion`.
- Color: verdict tints — keep `#30D158`, maybe `#FFD60A`, reject `#FF453A`; accent `#0A84FF`.
- Floating glass toolbar (bottom center, capsule), glass sidebar, glass loupe HUD.

## Screens
1. **Welcome** — Ambient mesh, huge "Drop a shoot." title, glass drop zone, "Choose
   folder" capsule, recent projects, tagline "Private. Offline. Free."
2. **Analyzing** — Big progress ring, phase label, live counters (blinks caught, blurry,
   duplicates, faces), thumbnails streaming into a soft mosaic.
3. **Library** — Sidebar filters (All / Keepers / Maybe / Rejects + reason chips),
   semantic search field ("Search your shoot…"), grid with verdict tint dots, burst
   stacks (grouped cards with count badge), floating toolbar (strictness slider,
   Export).
4. **Loupe view** — Full image, filmstrip of the group, **Face strip**: zoomed crops of
   each face with eye status (Narrative-Select-style), reasons, EXIF HUD. Keys:
   ←/→ navigate, P keep, X reject, U maybe, 0–5 rating, Space toggle zoom 100%, Esc back.
5. **Summary / Export** — "Loupe saved you 2h 41m" share card (render to PNG), export
   options (XMP for Lightroom, copy keepers, move rejects to `_Rejected`).
