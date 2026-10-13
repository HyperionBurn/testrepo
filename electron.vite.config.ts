import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * Output layout (electron-vite build):
 *   out/main/index.js                  Electron main process (deps externalized)
 *   out/preload/index.js               preload script (deps externalized)
 *   out/renderer/renderer/index.html   the app (src/renderer/index.html)
 *
 * The renderer uses `root: 'src'`, so the HTML input keeps its path relative to src/.
 * Dev server URL: ELECTRON_RENDERER_URL + '/renderer/index.html'.
 */
const alias = { '@shared': resolve(__dirname, 'src/shared') }

/**
 * index.html ships a strict CSP. The vite dev server injects an inline React Refresh preamble,
 * which that CSP blocks, so dev-only builds allow inline scripts. Production is unchanged.
 */
const devCsp = {
  name: 'skyline-dev-csp',
  transformIndexHtml: {
    order: 'post' as const,
    handler(html: string, ctx: { server?: unknown }) {
      if (!ctx.server) return html
      return html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src',
    plugins: [react(), devCsp],
    resolve: { alias },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          app: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
