# Skyline — Product & Engineering Spec

> **Skyline is mission control for your AI coding agents — rendered as a living city.**
> Point it at a repo. Every file becomes a building, every folder a district.
> Claude Code, Codex and friends appear as glowing builder drones that fly to the
> files they touch; buildings rise, glow and get scaffolding as agents edit them.
> Watch token burn and cost per agent in real time, replay what happened while you
> were away, scrub through git history to watch the city grow from the first commit,
> and get a plain-English digest written by a **local** LLM. 100% offline. Open source.

## Why
- Devs now run several AI agents at once (Claude Code, Codex CLI, Cursor, Gemini CLI)
  across many terminals. Nobody can see what they're doing, where, or what it costs.
- Paid/closed analogs cover slices only (cloud agent dashboards, Conductor (macOS),
  CodeSee/Swimm/DeepWiki for code maps). Nothing local, cross-agent and visual.
- Viral hook: a 20-second screen capture of drones building a glowing city is the demo.
  Story: "Skyline watched the 6 AI agents that built Skyline."

## Stack (fixed)
- Electron 33 + electron-vite + React 18 + TypeScript strict, npm.
- 3D: three + @react-three/fiber 8 + @react-three/drei 9 + @react-three/postprocessing 2.
- Main: chokidar 4 (watch), `git` CLI via child_process (no native git libs),
  node-llama-cpp 3 (optional local LLM; model downloaded on demand to userData).
- Packaging: electron-builder → Windows nsis + portable via GitHub Actions windows-latest.
- Tests: vitest for pure logic in `src/shared` and parsers in `src/main`.

## Layout
```
src/shared/    types.ts (contract below), ipc.ts (channels), layout.ts (city layout, pure),
               pricing.ts (token → $), lang.ts (extension → language + color)
src/main/      index.ts, ipc.ts, repo/scan.ts (files, LOC, imports), repo/git.ts (history),
               repo/watch.ts, agents/claude.ts, agents/codex.ts, agents/hub.ts (merges sources,
               emits AgentEvents), agents/dispatch.ts (spawn agents), llm/local.ts (node-llama-cpp),
               store.ts (recent repos, settings in userData/settings.json)
src/preload/   index.ts  → window.skyline (SkylineAPI)
src/renderer/src/
               App.tsx, state/ (zustand store), city/ (three scene: City.tsx, Buildings.tsx,
               Drones.tsx, Trails.tsx, Ground.tsx, Effects.tsx, CameraRig.tsx),
               city/labelLayout.ts (neighborhood label placement), lib/colorModes.ts (color modes),
               lib/capture.ts + lib/snapshotCard.ts (snapshot and flyover),
               hud/ (glass UI: TitleBar, AgentDock, ActivityFeed, Timeline, Inspector,
               DigestCard, DispatchSheet, CommandBar, Welcome, ColorLegend, Capture), styles/glass.css
```

## Contract — `src/shared/types.ts`
```ts
export type Lang = 'ts'|'js'|'py'|'rs'|'go'|'java'|'cs'|'cpp'|'c'|'rb'|'php'|'swift'|'kt'
  |'css'|'html'|'md'|'json'|'yaml'|'sh'|'sql'|'other';

export interface FileNode {
  path: string;          // repo-relative, forward slashes
  lang: Lang;
  loc: number;           // lines of code
  bytes: number;
  mtime: number;         // ms
  imports: string[];     // repo-relative paths this file imports (resolved, best-effort)
  commits?: number;      // churn: number of commits touching it
}
export interface RepoSnapshot {
  root: string; name: string; branch?: string;
  files: FileNode[];     // excludes .git, node_modules, dist, build, out, .next, venv, binary/large files (>1MB)
  scannedAt: number;
}

export interface CityBuilding {
  path: string; x: number; z: number; w: number; d: number; h: number; // world units, y-up
  lang: Lang; color: string; district: string;    // district = top-level dir ('' = root)
}
export interface CityDistrict { name: string; x: number; z: number; w: number; d: number; depth: number; }
export interface CityLayout { buildings: CityBuilding[]; districts: CityDistrict[]; size: number; }

export type AgentKind = 'claude-code' | 'codex' | 'unknown';
export type AgentStatus = 'thinking' | 'editing' | 'reading' | 'running' | 'idle' | 'done';

export interface AgentInfo {
  id: string;               // session id
  kind: AgentKind;
  name: string;             // friendly: 'Claude · a81457' or subagent description
  model?: string;
  parentId?: string;        // subagent → parent session
  cwd: string;
  startedAt: number; lastActiveAt: number;
  status: AgentStatus;
  currentFile?: string;     // repo-relative
  lastAction?: string;      // short human text e.g. 'Edit src/main/index.ts', 'Bash: npm test'
  lastMessage?: string;     // last assistant text (truncated 280 chars)
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  filesTouched: string[];   // repo-relative, unique
  edits: number; reads: number; commands: number;
  color: string;            // stable hue from id
}

export type AgentEventType = 'read' | 'edit' | 'create' | 'delete' | 'command' | 'message' | 'thinking' | 'tokens' | 'spawn' | 'end';
export interface AgentEvent {
  id: string;               // unique (e.g. message uuid + index)
  agentId: string;          // 'fs' for unattributed filesystem changes
  type: AgentEventType;
  ts: number;
  file?: string;            // repo-relative
  text?: string;            // command / message snippet
  linesAdded?: number; linesRemoved?: number;
}

export interface GitCommit { hash: string; ts: number; author: string; subject: string;
  files: { path: string; added: number; removed: number }[]; }

export interface Digest { generatedAt: number; text: string; model: string; requestId?: string; }

export interface DispatchRequest { kind: 'claude-code' | 'codex'; prompt: string; worktree: boolean; }

export interface LlmStatus { state: 'absent'|'downloading'|'loading'|'ready'|'error'; progress?: number; model?: string; error?: string; }

export interface Settings { recentRepos: string[]; claudeDir?: string; codexDir?: string; llmModel: string; }

export interface SkylineAPI {
  pickFolder(): Promise<string | null>;
  openRepo(root: string): Promise<RepoSnapshot>;              // scans + starts watching + starts agent hub
  getAgents(): Promise<AgentInfo[]>;
  getEvents(sinceTs?: number): Promise<AgentEvent[]>;         // history for replay (current repo)
  getHistory(limit?: number): Promise<GitCommit[]>;           // newest first
  readFile(path: string): Promise<string>;                    // repo-relative, first 200KB
  dispatch(req: DispatchRequest): Promise<{ agentId: string }>;
  stopAgent(agentId: string): Promise<void>;                  // only for dispatched ones
  llmStatus(): Promise<LlmStatus>;
  llmDownload(): Promise<void>;
  digest(sinceTs: number): Promise<Digest>;                   // summary of agent events since ts; heuristic first, model later (see Digest)
  explain(path: string): Promise<string>;                     // LLM explanation of a file
  getSettings(): Promise<Settings>;
  on(channel: 'agents', cb: (a: AgentInfo[]) => void): () => void;
  on(channel: 'event', cb: (e: AgentEvent) => void): () => void;
  on(channel: 'repo', cb: (s: RepoSnapshot) => void): () => void;   // after fs changes (debounced 500ms)
  on(channel: 'llm', cb: (s: LlmStatus) => void): () => void;
  on(channel: 'digest', cb: (d: Digest) => void): () => void;       // late model digest; requestId says which digest() call it answers
  on(channel: 'history', cb: (c: GitCommit[]) => void): () => void; // after HEAD, a ref or the reflog moved (debounced 1s)
  saveCapture(data: Uint8Array, suggestedName: string, copy?: boolean): Promise<string | null>; // save dialog, or SKYLINE_CAPTURE_DIR; copy: also put a PNG on the clipboard; resolves with the saved path, null if cancelled
  flyoverSeconds?: number;                                    // SKYLINE_FLYOVER_SECONDS (test hook); undefined in normal runs
  window: { minimize(): void; maximize(): void; close(): void };
  platform: string;
  autoOpen(): Promise<string | null>;                         // repo path from the SKYLINE_OPEN env var, if set; the renderer opens it at start
  listSessions(): Promise<RecentSession[]>;                   // agent sessions from the last 7 days, all repos, newest first, max 200
}

/** A recent agent session found on this machine, for the Welcome screen. */
export interface RecentSession {
  kind: AgentKind;
  cwd: string;              // a Skyline worktree (.skyline/worktrees/<id>) is reported as its main checkout
  lastActiveAt: number;     // modification time of the session file, ms
  id: string;               // Claude Code or Codex session id
}
```

## Agent sources
- **Claude Code**: `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl` and subagents at
  `~/.claude/projects/<encoded cwd>/<sessionId>/subagents/*.jsonl`. Encoded cwd = cwd with
  every non-alphanumeric char replaced by `-` (Windows `C:\dev\app` → `C--dev-app`).
  Lines: `{type:'assistant', message:{model, content:[{type:'text'|'tool_use'|'thinking'...}],
  usage:{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}},
  cwd, sessionId, timestamp, uuid}` and `{type:'user', message:{content:[{type:'tool_result'}]}}`.
  Tools → events: Read/Grep/Glob → read; Edit/MultiEdit → edit; Write → create/edit;
  Bash → command; Task/Agent → spawn. `input.file_path` is absolute → make repo-relative.
  Note: assistant messages are streamed as several lines sharing `message.id` — count usage once per message id.
- **Codex CLI**: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, lines
  `{timestamp, type, payload}`; `session_meta.payload.cwd`; `response_item` payload
  `function_call` (name 'shell', arguments JSON with command[]) / `custom_tool_call`
  name 'apply_patch' (input contains `*** Update File: <path>` / `*** Add File:`);
  `event_msg` payload type `token_count` with `info.total_token_usage`. Parse defensively.
- **Unattributed** (Cursor, humans, others): chokidar changes not explained by an agent
  event within ±3 s → agentId `'fs'`.
- Tail files incrementally (remember byte offsets), poll every 1 s + fs.watch hints.
- Only sessions whose cwd is the repo root or inside it count.

## Dispatch (`src/main/agents/dispatch.ts`)
- Starts a Claude Code (`claude`) or Codex (`codex`) CLI run in the repo root, or in a fresh git
  worktree at `.skyline/worktrees/<shortid>` on branch `skyline/<shortid>` when `worktree` is set.
- Output never goes to a pipe. Each run appends to `dispatch-<shortid>.log` in
  `os.tmpdir()/skyline-logs` (the log directory is an option for tests). The child gets the log
  file as stdout and stderr, so it keeps running after Skyline quits. Processes are detached and
  unref'd. Skyline reads the log only to find the session id (first 64 KB) and, for a failed start,
  the first 2000 characters of the error text.
- Claude Code: resolves with its real session id once the log shows it (polled every 200 ms). After
  20 s it resolves with `pending-<shortid>`, and keeps polling the log at 1 Hz for up to 5 minutes
  to link the real id.
- Codex: resolves as soon as the process spawns with `codex-<shortid>`. Its own session id is
  registered as an alias once its rollout file appears (polled every 500 ms, up to 60 s).
- `stopAgent` accepts either id. Stopping kills the whole process tree: SIGTERM to the process group,
  then SIGKILL after 3 s on POSIX; `taskkill /T /F` on Windows.
- Limits: prompts up to 100,000 characters, and about 7,000 on Windows (the cmd.exe command-line limit).

## Digest (`src/main/llm/local.ts`, `src/renderer/src/hud/DigestCard.tsx`)
- `digest(sinceTs)` returns at once with a summary of agent events since the timestamp. The totals
  line (time span, agents, edits, files, commands, cost) is always computed, never generated.
- While the local model is on disk and free, it writes the bullets. If it has not finished within
  **20 s** (`DIGEST_WAIT_MS`), the caller gets the heuristic digest now, with model
  `heuristic (LLM still thinking)`. When the model finishes, the main process emits the refined
  digest on the `digest` channel and the card replaces the heuristic in place. If generation fails,
  the late event carries the heuristic with model `heuristic`, so the card drops "still thinking".
- Each `digest` call gets a fresh `requestId` (UUID, made in the IPC handler). It is echoed on the
  immediate answer and on the late `digest` event. The card accepts a pushed digest only when its
  `requestId` matches the latest request, so a late answer to an earlier request, such as one from
  before Regenerate, never overwrites a newer digest.

## Pricing (`src/shared/pricing.ts`) per 1M tokens (input / output / cache read / cache write)
opus 15/75/1.5/18.75 · sonnet 3/15/0.3/3.75 · haiku 1/5/0.1/1.25 · gpt-5/codex 1.25/10/0.125/0 · default sonnet. Match by substring of model id.

## City layout (`src/shared/layout.ts`, pure + tested)
- Squarified treemap of the directory tree, weight = max(loc, 8). Streets separate sibling
  districts: 2.4 units between top-level districts (depth 1), 1.2 units between nested ones
  (depth 2+). Each district plate is its cell minus half a street per side, so sibling plates
  are a full street apart. Buildings inset 15% (plazas between).
- Building height h = 0.6 + 2.2·log2(1 + loc/20). Footprint from treemap cell.
- Deterministic: same snapshot → same layout. Sort children by name for stability.
- Total city ~ 120×120 units regardless of repo size (scale treemap).
- Naming: each district plate is named by its full repo-relative directory (`src/renderer`). A building's
  `district` field is the top-level directory (`src`), or `''` for root files. Neighborhood labels use the
  plate names, so they are not the same as `district` (see Neighborhoods and Labels below).

## Neighborhoods (`src/shared/layout.ts`, pure + tested)
A neighborhood is the directory that groups files for coloring and labeling, so a repo that keeps everything under
`src/` still reads as several areas.
- `neighborhoodChain(paths)` finds the directory chain that defines them. Starting at the root, it descends into the
  largest subdirectory while that directory holds more than `NEIGHBORHOOD_SHARE` (0.7) of all files, for at most
  `NEIGHBORHOOD_LEVELS` (3) levels. A descent is kept only if it splits the files into at least two neighborhoods;
  trailing levels that do not are dropped.
- `neighborhoodOf(path, chain)` keys a file to the next directory below the deepest chain entry above it. A file
  sitting directly in the deepest chain directory keys to that directory. Root files key to `''`.
- `neighborhoodIndex(paths)` returns `{ chain, keyOf, groups }`. Groups are sorted by file count, largest first, ties by key.
- Example from the tests: with `src/main/*`, `src/renderer/*`, `src/shared/*`, `src/index.ts`, `docs/a.md` and
  `README.md`, `src` holds 6 of 8 files, so the chain is `['src']`. The neighborhoods are `src/main`,
  `src/renderer`, `src/shared`, `src`, `docs` and `''`. A flat folder with five files has an empty chain and
  stays one neighborhood.

## Labels on the ground (`src/renderer/src/city/labelLayout.ts`, `Ground.tsx`)
- Each label is a neighborhood's full path, for example `src/renderer` and not the top-level name `src`. It is
  canvas-rendered flat on the neighborhood's plate, glowing in its area hue. Root files have no plate, so no label.
- Placement goes largest plate first. A neighborhood whose plate contains another neighborhood is skipped (its center
  belongs to the children). Label height is `clamp(0.08 · √plateArea, 1.4, 8)` world units, capped at half the plate
  depth, and the label is at most 80% of the plate width. A label under 0.8 units is skipped, and so is one that
  overlaps a label already placed (0.6-unit gap). At most 30 labels.
- Labels ignore depth, so towers in front do not hide them. They fade with distance and with on-screen size.

## Color modes (`src/renderer/src/lib/colorModes.ts`)
- Four modes in `C` cycle order: `area` (default), `language`, `churn`, `age`. The Command bar has a
  "Color by …" action for each. The choice is kept in `localStorage` (`skyline.colorMode`), a per-viewer convenience.
- **Area:** one hue per neighborhood from `AREA_PALETTE` (ten hues). Hues go to neighborhoods in size order, so the
  largest is gold. Root files stay silver (`#C4CDD9`). Neighborhood labels use these hues in every mode.
- **Language:** each building takes its `LANG_COLORS` entry from `shared/lang.ts`.
- **Churn:** `FileNode.commits`, percentile-ranked from indigo through cyan and amber to magenta. Without git history
  every building sits at the cold end, and the legend reads "No git history, so churn is unknown".
- **Age:** `FileNode.mtime`, percentile-ranked from dim slate (untouched longest) to bright mint (changed most recently).
- Percentile rank: the smallest value maps to 0, the largest to 1, ties share the mean of their positions, and a
  single value maps to 0.5.
- Legend (`hud/ColorLegend.tsx`): a bottom-right chip with the top six entries of the mode. Those are neighborhoods
  by file count, languages by file count, or the most committed or most recently changed files. Clicking the chip
  cycles the mode, as `C` does.

## Capture (`src/renderer/src/lib/capture.ts`, `src/main/ipc.ts`)
Capture needs an open repo. It starts from `S` (snapshot), `Shift`+`S` (flyover) or the title bar's Capture menu. A
progress pill shows while it runs. `Esc` cancels a flyover, and other keys are ignored until the capture finishes.
- **Snapshot:** frames the whole city and renders it at a pixel ratio that makes the image at least 1920 px wide
  (capped at 2.5). It waits for the camera to settle, then composes a frosted stats card bottom-left: repo name,
  agents, edits, files touched, cost, and up to five agent color chips with "+N" for the rest. The Skyline wordmark
  sits bottom-right. The PNG is saved as `Skyline-<repo>-<YYYY-MM-DD>.png` and copied to the clipboard. A grab that
  does not render within 8 s fails with a toast.
- **Flyover:** records the city canvas with `MediaRecorder` at 60 fps and 8 Mbps, as VP9 WebM (VP8 if VP9 is
  unavailable). The camera orbits once, from a high shot down into the framed view, for `FLYOVER_SECONDS` (10). The
  file is `Skyline-<repo>-<YYYY-MM-DD>.webm`.
- **Save:** the renderer sends the bytes over IPC to `saveCapture(data, suggestedName, copy?)`. The main process caps
  captures at 256 MB, sanitizes the name and, for a PNG with `copy`, puts it on the clipboard. Otherwise a save dialog
  opens (default folder Pictures or Videos), and the saved file is revealed in its folder. It resolves with the saved
  path, or `null` if the dialog was cancelled.
- **Test hooks:** `SKYLINE_CAPTURE_DIR` writes the capture straight into that directory, with no dialog and no reveal
  (the clipboard copy still happens). `SKYLINE_FLYOVER_SECONDS` takes a positive number, which the preload reads and
  exposes as `flyoverSeconds` to shorten or lengthen the flyover. The Capture menu label still says 10 s. Both are
  unset in normal runs.

## City v2 (`src/renderer/src/city/`)
The full design brief is [docs/EPIC_CITY.md](docs/EPIC_CITY.md). v2 replaces the procedural boxes with CC0 Kenney
models (`scripts/import-kenney.mjs` generates `city/assets/manifest.ts`), and adds roads and street lamps, live
traffic, atmosphere, drone FX and the Director camera. Each model is one InstancedMesh, and the triangle total stays
under 3M (`modelPicker.ts`). The module map is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#renderer-v2).
- **Keys:** `V` toggles the Director camera (needs an open repo; off with reduced motion). Every other key is unchanged.
- **Director:** `shots.ts` picks among reveal, orbit, follow, crane and flythrough, and `Director.tsx` runs it. Camera
  input makes it step aside for `PAUSE_S`, and it runs only after `IDLE_S` (3 s) without input.
- **Test hooks** (window globals, present in every build): `__skylineStats()` (draw calls, triangles, geometries,
  textures), `__skylineFxStep(seconds)`, `__skylineTrafficStep(seconds)`, `__skylineDirectorStep(dt)`. They let the
  e2e harness fast-forward animation, since software GL runs at about 1 fps.

## Design — "Liquid Glass"
- The 3D city fills the window edge-to-edge; all UI floats above it as glass.
- Night-time city: deep navy→black gradient sky, faint fog, ground with subtle grid,
  buildings dark glassy with emissive edges tinted by language color; edited buildings
  pulse bright with scaffolding wireframe + rising particles; drones = glowing orbs with
  a soft halo + light trail, colored per agent; light beam from drone to target building.
  Bloom postprocessing, gentle auto-orbit when idle.
- Glass panels: `backdrop-filter: blur(30px) saturate(180%)`; fill rgba(20,24,38,.45);
  1px border rgba(255,255,255,.12); inner top highlight; radius 22–28; capsule buttons.
- Type: Segoe UI Variable (Windows), Inter fallback; tabular numbers for meters.
- Motion: springs, 240–420ms; reduced-motion respected.
- Layout: custom 44px title bar (drag region, repo name, branch, live dot);
  left **Agent Dock** (cards per agent: color dot, name, status pill, current file, tokens,
  $ cost, sparkline); right **Inspector** (selected building: path, LOC, lang, agents who
  touched it, recent events, "Explain" via local LLM, file preview);
  bottom **Timeline** capsule (Live ⟷ replay scrubber over agent events; toggle Git time-lapse);
  top-center **Command bar** (⌘K/Ctrl+K: jump to file, dispatch agent, digest);
  **Digest card** ("While you were away…"); bottom-right **color legend** chip (see Color modes); a **capture pill**
  with progress while a snapshot or flyover runs. The title bar's **Capture** menu starts both (see Capture).
- Welcome screen (no repo): city silhouette idling in background, "Open a repository",
  "Recent agent activity" (one row per working directory from `listSessions`, newest first, max 6),
  and "Recent" (saved repos). A repo already in "Recent agent activity" is not repeated under
  "Recent"; comparison ignores trailing slashes, separator style and drive-letter case. Each
  Recent row shows its full parent folder with the separators kept and a middle ellipsis
  (`/home/user`, `C:\dev`), via `lib/recent.ts`.
