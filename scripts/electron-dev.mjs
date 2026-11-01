#!/usr/bin/env node
/**
 * `pnpm electron:dev`: starts `pnpm dev` (Vite + API server) unless it is already running, waits until the
 * app answers on STUDIO_DEV_URL (default http://127.0.0.1:5180), then opens it in Electron. Nothing runs
 * inside Electron: the API server is the regular dev server. Quitting Electron stops the dev servers this
 * script started (and the other way round).
 */
import { spawn } from 'node:child_process'
import { get } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import electronPath from 'electron'
import { bundleElectron, PRODUCT_NAME, ROOT } from './build-electron.mjs'

const DEV_URL = process.env.STUDIO_DEV_URL || 'http://127.0.0.1:5180'
const outdir = join(ROOT, 'dist-electron', 'dev')

await bundleElectron(outdir, { dev: true })
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
writeFileSync(join(outdir, 'package.json'), `${JSON.stringify({ name: 'wildroom-dev', productName: PRODUCT_NAME, version, main: 'main.cjs' }, null, 2)}\n`)

let devServer = null
let electron = null

if (!(await isUp())) {
  console.log('[electron:dev] starting pnpm dev …')
  // Own process group, so the whole tree (concurrently → vite, tsx) can be stopped together.
  devServer = spawn('pnpm', ['dev'], { cwd: ROOT, stdio: 'inherit', detached: true })
  devServer.on('exit', (code) => {
    console.log(`[electron:dev] pnpm dev exited (${code ?? 'signal'})`)
    electron?.kill()
    process.exit(code ?? 1)
  })
}

if (!(await waitUntilUp(120_000))) console.warn(`[electron:dev] ${DEV_URL}/api/health is not answering yet — opening anyway`)
console.log(`[electron:dev] opening ${DEV_URL} in Electron`)
electron = spawn(electronPath, [outdir], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, STUDIO_DEV_URL: DEV_URL } })
electron.on('exit', (code) => {
  stopDevServer()
  process.exit(code ?? 0)
})
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    electron?.kill(signal)
    stopDevServer()
  })
}

function stopDevServer() {
  if (!devServer || devServer.exitCode !== null) return
  devServer.removeAllListeners('exit')
  try {
    process.kill(-devServer.pid, 'SIGTERM')
  } catch {
    // already gone
  }
}

/** True once both Vite and the API server (through Vite's proxy) answer. */
function isUp() {
  return new Promise((resolve) => {
    const req = get(new URL('/api/health', DEV_URL), { timeout: 2000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
  })
}

async function waitUntilUp(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isUp()) return true
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}
