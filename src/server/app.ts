import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import type { Env } from './env'
import { ApiError } from './http'
import { JobWorker } from './jobs/worker'
import { type AdapterMap, createAdapters } from './providers'
import { killAllRenders } from './providers/local'
import { createRunpodAdapter } from './providers/runpod/adapter'
import { ComfyInbox } from './providers/runpod/comfyInbox'
import { ComfyProxy } from './providers/runpod/comfyProxy'
import { GpuSession, type GpuSessionOptions } from './providers/runpod/session'
import { VolumeSetup, type VolumeSetupOptions } from './providers/runpod/setup'
import { RunpodState } from './providers/runpod/state'
import { assetRoutes } from './routes/assets'
import { directorRoutes } from './routes/director'
import { eventRoutes } from './routes/events'
import { exportRoutes } from './routes/exports'
import { generationRoutes } from './routes/generations'
import { integrationRoutes } from './routes/integrations'
import { gpuRoutes } from './routes/gpu'
import { klingRoutes } from './routes/kling'
import { mediaRoutes } from './routes/media'
import { openRouterRoutes } from './routes/openrouter'
import { projectRoutes } from './routes/projects'
import { sceneRoutes } from './routes/scenes'
import { settingsRoutes } from './routes/settings'
import { tempVoiceRoutes } from './routes/tempVoice'
import { toolRoutes } from './routes/tools'
import { voiceLabRoutes } from './routes/voiceLab'
import { voiceRoutes } from './routes/voices'
import { mcpRoutes } from './mcp/routes'
import { localOnly } from './security'
import { AppRequests } from './services/appRequests'
import { EventBus } from './services/events'
import { KeychainSecretStore, MemorySecretStore, type SecretStore } from './services/keychain'
import { MediaStore } from './services/mediaStore'
import { SettingsService } from './services/settings'
import { AppState } from './storage/appState'
import { DerivedCache } from './storage/derivedCache'
import { ProjectRegistry } from './storage/registry'

export interface AppDeps {
  env: Env
  appState: AppState
  registry: ProjectRegistry
  cache: DerivedCache
  events: EventBus
  secrets: SecretStore
  settings: SettingsService
  media: MediaStore
  adapters: AdapterMap
  worker: JobWorker
  /** The rented GPU (RunPod) for LTX-2.5 renders. */
  gpuSession: GpuSession
  /** Preparing the RunPod model volume. */
  volumeSetup: VolumeSetup
  runpodState: RunpodState
  /** The pod's ComfyUI on a local port (adds the access token), for the app's ComfyUI window and a browser tab. */
  comfyProxy: ComfyProxy
  /** Saves the outputs of prompts queued from that ComfyUI page into a project. */
  comfyInbox: ComfyInbox
  /** Requests to the app's window (open a project, export), for the MCP tools. */
  appRequests: AppRequests
  serverStart: string
}

export function createDeps(
  env: Env,
  opts: {
    secrets?: SecretStore
    adapters?: Partial<AdapterMap>
    appState?: AppState
    via?: string
    gpuSession?: GpuSessionOptions
    volumeSetup?: VolumeSetupOptions
  } = {},
): AppDeps {
  const events = new EventBus()
  const appState = opts.appState ?? new AppState(env)
  const registry = new ProjectRegistry({ env, appState, events, via: opts.via })
  const cache = new DerivedCache(env)
  const settings = new SettingsService(appState, env, events)
  const media = new MediaStore({ env, events, registry, cache })
  // STUDIO_NO_KEYCHAIN=1 starts with no saved keys, so a sandbox can't reach a paid provider.
  const secrets =
    opts.secrets ?? (process.env.STUDIO_NO_KEYCHAIN === '1' ? new MemorySecretStore() : new KeychainSecretStore())
  const runpodState = new RunpodState(env.appDataDir)
  // The session counts RunPod jobs through the worker and ComfyUI outputs still to be saved through the inbox, both
  // made below (they need the session first).
  let worker: JobWorker | undefined
  let comfyInbox: ComfyInbox | undefined
  // While the queue is paused nothing queued starts: only renders already on the GPU keep it on, so a paused queue
  // doesn't hold a ready (billing) GPU idle until the 8 h cap.
  const runpodJobs = () => {
    if (!worker) return 0
    if (!settings.get().queuePaused) return worker.countUnfinished('runpod')
    return worker.activeAll().filter((j) => j.provider === 'runpod' && j.status !== 'queued').length
  }
  const gpuSession = new GpuSession(
    {
      events,
      settings,
      secrets,
      state: runpodState,
      machineId: appState.machineId,
      pendingJobs: () => runpodJobs() + (comfyInbox?.pendingCount ?? 0),
      onReady: () => worker?.wake('runpod'),
    },
    opts.gpuSession,
  )
  const volumeSetup = new VolumeSetup({ events, settings, secrets, state: runpodState, machineId: appState.machineId }, opts.volumeSetup)
  const adapters = { ...createAdapters(env), runpod: createRunpodAdapter({ session: gpuSession }), ...opts.adapters } as AdapterMap
  worker = new JobWorker({ env, registry, events, media, adapters, secrets, settings })
  comfyInbox = new ComfyInbox({ session: gpuSession, state: runpodState, media, registry, events, tmpDir: env.tmpDir })
  const comfyProxy = new ComfyProxy({ session: gpuSession, inbox: comfyInbox, events }, { port: env.port + 1 })
  return {
    env,
    appState,
    registry,
    cache,
    events,
    secrets,
    settings,
    media,
    adapters,
    worker,
    gpuSession,
    volumeSetup,
    runpodState,
    comfyProxy,
    comfyInbox,
    appRequests: new AppRequests(events),
    serverStart: new Date().toISOString(),
  }
}

export function createApp(deps: AppDeps) {
  const app = new Hono()
  app.use('*', localOnly(deps.env))
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.message, details: err.details }, err.status)
    console.error('[api]', err)
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500)
  })

  const api = new Hono()
  api.get('/health', (c) =>
    c.json({
      ok: true,
      serverStart: deps.serverStart,
      projectsDir: deps.appState.projectsDir,
      appDataDir: deps.env.appDataDir,
      cacheDir: deps.env.cacheDir,
    }),
  )
  api.route('/projects', projectRoutes(deps))
  api.route('/', assetRoutes(deps))
  api.route('/', generationRoutes(deps))
  api.route('/', settingsRoutes(deps))
  const voices = voiceRoutes(deps)
  api.route('/', voices)
  api.route('/', voiceLabRoutes(deps, { onVoicesChanged: voices.clearCache }))
  api.route('/', eventRoutes(deps))
  api.route('/', exportRoutes(deps))
  api.route('/', directorRoutes(deps))
  api.route('/', openRouterRoutes())
  api.route('/', sceneRoutes(deps))
  api.route('/', klingRoutes(deps))
  api.route('/', toolRoutes(deps))
  api.route('/', tempVoiceRoutes(deps))
  api.route('/', gpuRoutes(deps))
  api.route('/', integrationRoutes(deps))
  app.route('/api', api)
  app.route('/mcp', mcpRoutes(deps, app))
  app.route('/media', mediaRoutes(deps))

  // Production: serve the built SPA (dev uses the Vite server with a proxy instead).
  const indexHtml = join(deps.env.clientDist, 'index.html')
  if (deps.env.isProd && existsSync(indexHtml)) {
    app.use('/*', serveStatic({ root: deps.env.clientDist }))
    const html = readFileSync(indexHtml, 'utf8')
    app.get('*', (c) => c.html(html))
  }
  return app
}

export async function closeDeps(deps: AppDeps) {
  // Local renders first: a server slow to quit is SIGKILLed by the desktop app, which would orphan them (10+ GB each).
  killAllRenders()
  await deps.worker.stop()
  // Leaves a running pod running (its watchdog stops it); quitting the app asks first (see electron/main.ts).
  deps.gpuSession.stop()
  await deps.comfyInbox.stop()
  await deps.comfyProxy.close()
  deps.volumeSetup.stop()
  await deps.media.close()
  deps.registry.closeAll()
}
