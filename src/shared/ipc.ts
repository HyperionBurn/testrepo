// IPC channel names shared by main, preload and renderer. Pure constants, no imports.
// Invoke channels are named after the SkylineAPI method they implement.
// Main -> renderer events are sent on ON_PREFIX + name (e.g. 'skyline:on:agents').
export const IPC = {
  pickFolder: 'skyline:pickFolder',
  openRepo: 'skyline:openRepo',
  getAgents: 'skyline:getAgents',
  getEvents: 'skyline:getEvents',
  getHistory: 'skyline:getHistory',
  readFile: 'skyline:readFile',
  dispatch: 'skyline:dispatch',
  stopAgent: 'skyline:stopAgent',
  llmStatus: 'skyline:llmStatus',
  llmDownload: 'skyline:llmDownload',
  digest: 'skyline:digest',
  explain: 'skyline:explain',
  getSettings: 'skyline:getSettings',
  winMin: 'skyline:window:minimize',
  winMax: 'skyline:window:maximize',
  winClose: 'skyline:window:close'
} as const

export type IpcInvokeChannel = (typeof IPC)[keyof typeof IPC]

/** Main -> renderer event channels accepted by SkylineAPI.on. */
export const EVENT_CHANNELS = ['agents', 'event', 'repo', 'llm'] as const
export type EventChannel = (typeof EVENT_CHANNELS)[number]

export const ON_PREFIX = 'skyline:on:'

export function eventChannel(name: EventChannel): string {
  return ON_PREFIX + name
}
