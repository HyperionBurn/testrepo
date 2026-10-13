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
  on(channel: 'digest', cb: (d: Digest) => void): () => void;          // a digest that finished after digest() had already answered with the heuristic
  on(channel: 'history', cb: (c: GitCommit[]) => void): () => void;    // after HEAD, a ref or the reflog moved (debounced 1s)
  window: { minimize(): void; maximize(): void; close(): void };
  platform: string;
  autoOpen(): Promise<string | null>;                         // repo path from SKYLINE_OPEN env, if set
  listSessions(): Promise<RecentSession[]>;                   // agent sessions from the last 7 days, all repos, newest first, max 200
}

/** A recent agent session found on this machine, for the Welcome screen. */
export interface RecentSession {
  kind: AgentKind;
  /** Session working directory. A Skyline worktree (.skyline/worktrees/<id>) is reported as its main checkout. */
  cwd: string;
  /** Modification time of the session file, ms. */
  lastActiveAt: number;
  /** Claude Code session id, or Codex session id. */
  id: string;
}
