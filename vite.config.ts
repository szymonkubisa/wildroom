import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type ProxyOptions } from 'vite'

// A second instance (a sandbox with its own STUDIO_HOME and STUDIO_PORT) points these elsewhere.
const SERVER = process.env.STUDIO_SERVER ?? 'http://127.0.0.1:7777'
const WEB_PORT = Number(process.env.STUDIO_WEB_PORT ?? 5180)

/**
 * The API server going away mid-answer (stopped, crashed, or restarting after an edit) must reach the browser: the
 * proxy keeps a streamed answer — the app's event stream — open forever otherwise, so the page never notices, never
 * reconnects, and misses every job update after the restart.
 */
const toServer: ProxyOptions = {
  target: SERVER,
  configure: (proxy) => {
    proxy.on('proxyRes', (proxyRes, _req, res) => {
      proxyRes.on('close', () => {
        if (!res.writableEnded) res.destroy()
      })
    })
  },
}

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/client', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: WEB_PORT,
    strictPort: true,
    // Same-origin in dev: the browser only ever talks to :5180.
    proxy: {
      '/api': toServer,
      '/media': toServer,
    },
  },
  worker: { format: 'es' },
  build: { outDir: 'dist/client', emptyOutDir: true, target: 'es2023' },
})
