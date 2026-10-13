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
               hud/ (glass UI: TitleBar, AgentDock, ActivityFeed, Timeline, Inspector,
               DigestCard, DispatchSheet, CommandBar, Welcome), styles/glass.css
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

export interface Digest { generatedAt: number; text: string; model: string; }

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
  digest(sinceTs: number): Promise<Digest>;                   // summary of agent events since ts
  explain(path: string): Promise<string>;                     // LLM explanation of a file
  getSettings(): Promise<Settings>;
  on(channel: 'agents', cb: (a: AgentInfo[]) => void): () => void;
  on(channel: 'event', cb: (e: AgentEvent) => void): () => void;
  on(channel: 'repo', cb: (s: RepoSnapshot) => void): () => void;   // after fs changes (debounced 500ms)
  on(channel: 'llm', cb: (s: LlmStatus) => void): () => void;
  window: { minimize(): void; maximize(): void; close(): void };
  platform: string;
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

## Pricing (`src/shared/pricing.ts`) per 1M tokens (input / output / cache read / cache write)
opus 15/75/1.5/18.75 · sonnet 3/15/0.3/3.75 · haiku 1/5/0.1/1.25 · gpt-5/codex 1.25/10/0.125/0 · default sonnet. Match by substring of model id.

## City layout (`src/shared/layout.ts`, pure + tested)
- Squarified treemap of the directory tree, weight = max(loc, 8). Districts recursively
  nested with 1.2-unit streets (padding) per depth; buildings inset 15% (plazas between).
- Building height h = 0.6 + 2.2·log2(1 + loc/20). Footprint from treemap cell.
- Deterministic: same snapshot → same layout. Sort children by name for stability.
- Total city ~ 120×120 units regardless of repo size (scale treemap).

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
  **Digest card** ("While you were away…").
- Welcome screen (no repo): city silhouette idling in background, "Open a repository",
  recent repos, detected agent sessions list ("3 Claude Code sessions found").
