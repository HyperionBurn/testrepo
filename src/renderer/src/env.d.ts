import type { SkylineAPI } from '@shared/types'

declare global {
  interface Window {
    skyline: SkylineAPI
  }
}

export {}
