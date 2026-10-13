import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { eventChannel, IPC, type EventChannel } from '@shared/ipc'
import type {
  AgentEvent,
  AgentInfo,
  Digest,
  DispatchRequest,
  GitCommit,
  LlmStatus,
  RecentSession,
  RepoSnapshot,
  Settings,
  SkylineAPI
} from '@shared/types'

const call = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

const send = (channel: string): void => {
  void ipcRenderer.invoke(channel)
}

// Overloads in SkylineAPI.on are satisfied by one runtime function: subscribe to 'skyline:on:<channel>'.
const on = (channel: EventChannel, cb: (payload: unknown) => void): (() => void) => {
  const full = eventChannel(channel)
  const listener = (_event: IpcRendererEvent, payload: unknown) => cb(payload)
  ipcRenderer.on(full, listener)
  return () => {
    ipcRenderer.removeListener(full, listener)
  }
}

const api: SkylineAPI = {
  pickFolder: () => call<string | null>(IPC.pickFolder),
  openRepo: (root) => call<RepoSnapshot>(IPC.openRepo, root),
  getAgents: () => call<AgentInfo[]>(IPC.getAgents),
  getEvents: (sinceTs) => call<AgentEvent[]>(IPC.getEvents, sinceTs),
  getHistory: (limit) => call<GitCommit[]>(IPC.getHistory, limit),
  readFile: (path) => call<string>(IPC.readFile, path),
  dispatch: (req: DispatchRequest) => call<{ agentId: string }>(IPC.dispatch, req),
  stopAgent: (agentId) => call<void>(IPC.stopAgent, agentId),
  llmStatus: () => call<LlmStatus>(IPC.llmStatus),
  llmDownload: () => call<void>(IPC.llmDownload),
  digest: (sinceTs) => call<Digest>(IPC.digest, sinceTs),
  explain: (path) => call<string>(IPC.explain, path),
  getSettings: () => call<Settings>(IPC.getSettings),
  on: on as SkylineAPI['on'],
  window: {
    minimize: () => send(IPC.winMin),
    maximize: () => send(IPC.winMax),
    close: () => send(IPC.winClose)
  },
  platform: process.platform,
  autoOpen: () => call<string | null>(IPC.autoOpen),
  listSessions: () => call<RecentSession[]>(IPC.listSessions)
}

contextBridge.exposeInMainWorld('skyline', api)
