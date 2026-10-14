// Dev/e2e hook: lets the Playwright smoke test call the loader in the built app.
// Harmless in production (just a window property).
import { loadModel, loadModels, MODELS } from './loader'
import { loadEmissiveAtlas } from './colormap'

declare global {
  interface Window {
    __skylineModels?: {
      loadModel: typeof loadModel
      loadModels: typeof loadModels
      loadEmissiveAtlas: typeof loadEmissiveAtlas
      MODELS: typeof MODELS
    }
  }
}

if (typeof window !== 'undefined') {
  window.__skylineModels = { loadModel, loadModels, loadEmissiveAtlas, MODELS }
}
