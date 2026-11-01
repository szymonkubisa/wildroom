import { serve } from '@hono/node-server'
import { nanoid } from 'nanoid'
import { closeDeps, createApp, createDeps } from './app'
import { sweepUploadTemp } from './routes/assets'
import { loadEnv } from './env'
import { setDesktopTrash } from './services/desktopBridge'
import { mcpToken, removeServerInfo, writeServerInfo } from './services/mcpAccess'
import { AppState } from './storage/appState'
import { acquireLock, LockedError } from './storage/lock'

/**
 * Present when the server runs inside the desktop app (an Electron utilityProcess): startup success or
 * failure is reported to the app, and the app asks for a clean shutdown with `{ type: 'shutdown' }`.
 */
interface ParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort

/** Reports a startup error (console + desktop app) and exits with code 1 once output is flushed. */
function fail(message: string) {
  console.error(`[studio] ${message}`)
  parentPort?.postMessage({ type: 'error', message })
  process.exitCode = 1
  setTimeout(() => process.exit(1), 200).unref()
}

/** Inside the desktop app, Electron moves files to the Trash (`shell.trashItem`). */
function installDesktopTrash(port: ParentPort) {
  const pending = new Map<string, { resolve: () => void; reject: (err: Error) => void }>()
  port.on('message', ({ data }) => {
    const msg = data as { type?: string; id?: string; error?: string } | null
    if (msg?.type !== 'trash-result' || !msg.id) return
    const waiter = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) waiter?.reject(new Error(msg.error))
    else waiter?.resolve()
  })
  setDesktopTrash(
    (path) =>
      new Promise<void>((resolve, reject) => {
        const id = nanoid(8)
        pending.set(id, { resolve, reject })
        port.postMessage({ type: 'trash', id, path })
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error('Moving to the Trash timed out'))
        }, 60_000).unref()
      }),
  )
}

/**
 * A promise nobody waited for failed. Logged, not fatal: Node's default would end the process, and with it every
 * running job, export and import, over one stray error.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[studio] unhandled rejection:', reason)
})

async function main() {
  const env = loadEnv()
  const appState = new AppState(env)
  if (appState.file.modelsDir && !process.env.STUDIO_MODELS_DIR) env.modelsDir = appState.file.modelsDir
  const via = parentPort ? 'desktop' : 'server'
  try {
    // One server per user: two would both run the job worker and could submit the same paid generation twice.
    acquireLock(env.appDataDir, {
      file: '.studio.lock',
      machineId: appState.machineId,
      via,
      describe: (owner) => {
        const who = owner.via === 'desktop' ? 'the Wildroom desktop app' : 'another Wildroom server'
        return (
          `Wildroom is already running (${who}, PID ${owner.pid}, since ${owner.startedAt}). ` +
          `Only one instance can run at a time — quit the other one (web server or desktop app) and try again.`
        )
      },
    })
  } catch (err) {
    if (err instanceof LockedError) return fail(err.message)
    throw err
  }

  if (parentPort) installDesktopTrash(parentPort)
  // This process holds the app lock now: leftovers of interrupted uploads, exports and jobs belong to nobody.
  const swept = sweepUploadTemp(env.tmpDir)
  if (swept) console.log(`[studio] removed ${swept} leftover temp file${swept === 1 ? '' : 's'}`)
  const deps = createDeps(env, { appState, via })
  const app = createApp(deps)

  const server = serve({ fetch: app.fetch, hostname: env.host, port: env.port }, (info) => {
    // Jobs only start once this process owns the app data and is actually listening.
    deps.worker.start()
    deps.gpuSession.start()
    deps.comfyInbox.start()
    deps.comfyProxy.ensureListening().then(
      (url) => console.log(`[studio] ComfyUI on the GPU: ${url}`),
      (err: unknown) => console.warn('[studio] the ComfyUI proxy could not listen', err),
    )
    void deps.volumeSetup.reconcile()
    deps.registry.autoMount()
    // Where MCP clients find this server and its token (the stdio bridge reads both: the desktop app may not be on 7777).
    try {
      mcpToken(env)
      writeServerInfo(env, info.port)
    } catch (err) {
      console.warn('[studio] could not write server.json for MCP clients', err)
    }
    console.log(`[studio] server http://${env.host}:${info.port}  projects: ${appState.projectsDir}`)
    parentPort?.postMessage({ type: 'ready', port: info.port, projectsDir: appState.projectsDir, cacheDir: env.cacheDir })
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    const reason = err.code === 'EADDRINUSE' ? `port ${env.port} is already in use` : err.message
    fail(`Could not listen on http://${env.host}:${env.port}: ${reason}`)
    void closeDeps(deps)
  })

  let shuttingDown = false
  async function shutdown(reason: string) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[studio] ${reason} — shutting down`)
    server.close()
    removeServerInfo(env)
    await closeDeps(deps)
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGHUP', () => void shutdown('SIGHUP'))
  parentPort?.on('message', ({ data }) => {
    if ((data as { type?: unknown } | null)?.type === 'shutdown') void shutdown('app quit')
  })
}

main().catch((err: unknown) => {
  console.error(err)
  fail(`Could not start: ${err instanceof Error ? err.message : String(err)}`)
})
