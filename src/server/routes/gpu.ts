import { Hono } from 'hono'
import {
  COMFY_IMPORT_MODES,
  type ComfyImportMode,
  type ComfyViewDTO,
  type CreateVolumeRequest,
  type GpuAvailability,
  HP_VOLUME_USD_PER_GB_MONTH,
  LTX_GPUS,
  type RunpodAccountDTO,
  type RunpodDatacenterDTO,
  type RunpodVolumeDTO,
  VOLUME_USD_PER_GB_MONTH,
} from '../../shared/types/runpod'
import type { AppDeps } from '../app'
import { ApiError, badRequest, readJson } from '../http'
import { RunpodApi, RunpodError } from '../providers/runpod/api'
import { MIN_CUDA, SETUP_VERSION } from '../providers/runpod/pod'
import { type SecretStore, secretHint } from '../services/keychain'

const VOLUME_NAME = /^[\w .-]{1,64}$/
const DATA_CENTER = /^[A-Z0-9-]{2,32}$/i

/** A RunPod client with the key from the Keychain, or a clear error telling where to add it. */
export function runpodApiFrom(secrets: SecretStore): RunpodApi {
  const apiKey = secrets.get('runpod', 'apiKey')
  if (!apiKey) throw badRequest('Add your RunPod API key in Settings → Providers first')
  return new RunpodApi({ apiKey })
}

/** RunPod failures as API errors the Settings page can show as they are. */
export function runpodApiError(err: unknown): never {
  if (err instanceof RunpodError) {
    if (err.kind === 'auth') throw badRequest('RunPod rejected the API key — check it in Settings → Providers')
    if (err.kind === 'network' || err.kind === 'server') throw new ApiError(502, err.message)
    if (err.kind === 'rate_limited') throw new ApiError(429, err.message)
    throw badRequest(err.message)
  }
  throw err
}

export function gpuRoutes(deps: AppDeps) {
  const r = new Hono()

  r.get('/gpu/volumes', async (c) => {
    try {
      const volumes = await runpodApiFrom(deps.secrets).listVolumes()
      return c.json(
        volumes.map((v): RunpodVolumeDTO => ({
          id: v.id,
          name: v.name,
          sizeGb: v.size,
          dataCenter: v.dataCenter,
          prepared: deps.runpodState.preparedVersion(v.id) >= SETUP_VERSION,
        })),
      )
    } catch (err) {
      return runpodApiError(err)
    }
  })

  /** Creates a network volume (billed monthly from now on: the page confirms the price first). */
  r.post('/gpu/volumes', async (c) => {
    const body = await readJson<Partial<CreateVolumeRequest>>(c)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const sizeGb = typeof body.sizeGb === 'number' ? Math.round(body.sizeGb) : NaN
    const dataCenter = typeof body.dataCenter === 'string' ? body.dataCenter.trim() : ''
    if (!VOLUME_NAME.test(name)) throw badRequest('Name the volume with letters, numbers, spaces, dots or dashes')
    if (!(sizeGb >= 10 && sizeGb <= 4096)) throw badRequest('Volume size must be 10–4096 GB')
    if (!DATA_CENTER.test(dataCenter)) throw badRequest('Choose a data center')
    const type = body.type === 'HIGH_PERFORMANCE' ? 'HIGH_PERFORMANCE' : 'STANDARD'
    try {
      const v = await runpodApiFrom(deps.secrets).createVolume({ name, size: sizeGb, dataCenter, type })
      return c.json({ id: v.id, name: v.name, sizeGb: v.size || sizeGb, dataCenter: v.dataCenter || dataCenter } satisfies RunpodVolumeDTO)
    } catch (err) {
      return runpodApiError(err)
    }
  })

  /** Data centers with how well each LTX-capable GPU is stocked, best GPUs first. */
  r.get('/gpu/datacenters', async (c) => {
    try {
      const api = runpodApiFrom(deps.secrets)
      const all = await api.datacenters()
      // Stock on hosts that can run the pod image (CUDA 13), when RunPod reports it; else the data center's own view.
      const minCuda = /^\d+(\.\d+)?$/.test(c.req.query('minCuda') ?? '') ? c.req.query('minCuda')! : MIN_CUDA
      const stock = await api.gpuStock(minCuda).catch(() => undefined)
      const availabilityIn = (dcId: string, gpuId: string, fallback?: GpuAvailability): GpuAvailability | undefined =>
        stock ? stock.find((g) => g.id === gpuId)?.dataCenters.find((d) => d.id === dcId)?.availability : fallback
      // Only data centers that offer network volumes; standard volumes where offered (half the price).
      const out: RunpodDatacenterDTO[] = all
        .filter((dc) => dc.networkVolumeTypes.length > 0)
        .map((dc) => {
          const volumeType = dc.networkVolumeTypes.includes('STANDARD') ? 'STANDARD' : 'HIGH_PERFORMANCE'
          return {
            id: dc.id,
            name: dc.name,
            region: dc.region,
            gpus: LTX_GPUS.flatMap((g) => {
              const availability = availabilityIn(dc.id, g.id, dc.gpuAvailability.find((a) => a.id === g.id)?.availability)
              return availability && availability !== 'NONE' ? [{ id: g.id, name: g.name, availability }] : []
            }),
            volumeType,
            volumeUsdPerGbMonth: volumeType === 'STANDARD' ? VOLUME_USD_PER_GB_MONTH : HP_VOLUME_USD_PER_GB_MONTH,
          }
        })
      return c.json(out)
    } catch (err) {
      return runpodApiError(err)
    }
  })

  r.get('/gpu/account', async (c) => {
    try {
      const account = await runpodApiFrom(deps.secrets).account()
      return c.json({ balanceUsd: account.clientBalance, spendPerHrUsd: account.currentSpendPerHr } satisfies RunpodAccountDTO)
    } catch (err) {
      return runpodApiError(err)
    }
  })

  // ---------------------------------------------------------------- the GPU session

  r.get('/gpu/session', (c) => c.json(deps.gpuSession.dto()))
  r.post('/gpu/session/start', (c) => {
    deps.gpuSession.requestStart()
    return c.json(deps.gpuSession.dto())
  })
  r.post('/gpu/session/stop', async (c) => {
    await deps.gpuSession.stopNow('Stopped')
    return c.json(deps.gpuSession.dto())
  })
  r.post('/gpu/session/keep', (c) => {
    deps.gpuSession.keep()
    return c.json(deps.gpuSession.dto())
  })
  r.post('/gpu/session/choose', async (c) => {
    const { gpuId } = await readJson<{ gpuId?: string }>(c)
    if (typeof gpuId !== 'string') throw badRequest('Choose a GPU')
    deps.gpuSession.choose(gpuId)
    return c.json(deps.gpuSession.dto())
  })
  /** Keep the renders queued and wait for the first-choice GPU instead of renting another. */
  r.post('/gpu/session/wait', (c) => {
    deps.gpuSession.keepWaiting()
    return c.json(deps.gpuSession.dto())
  })

  /** Stop waiting for the first-choice GPU: the next try offers the free ones again. */
  r.post('/gpu/session/offer-others', (c) => {
    deps.gpuSession.offerOthers()
    return c.json(deps.gpuSession.dto())
  })

  r.post('/gpu/session/decline', (c) => {
    deps.gpuSession.decline()
    return c.json(deps.gpuSession.dto())
  })

  // ---------------------------------------------------------------- preparing the volume

  r.get('/gpu/setup', (c) => {
    const hf = deps.secrets.get('hf', 'apiKey')
    return c.json({ ...deps.volumeSetup.dto(), hfToken: { set: Boolean(hf), hint: secretHint(hf) } })
  })
  /** Rents a small GPU that installs ComfyUI and downloads the models onto the volume (the page confirms first). */
  r.post('/gpu/setup', async (c) => {
    const { hfToken } = await readJson<{ hfToken?: string }>(c)
    return c.json(await deps.volumeSetup.start(typeof hfToken === 'string' ? hfToken : undefined))
  })
  r.post('/gpu/setup/cancel', async (c) => c.json(await deps.volumeSetup.cancel()))

  // ---------------------------------------------------------------- ComfyUI on the GPU

  /** Where the app's ComfyUI window (or a browser tab) opens the pod's ComfyUI, and where its outputs go. */
  r.get('/gpu/comfy', async (c) => c.json(await comfyView(deps)))
  r.put('/gpu/comfy/target', async (c) => {
    const { projectId, mode } = await readJson<{ projectId?: unknown; mode?: unknown }>(c)
    if (!COMFY_IMPORT_MODES.includes(mode as ComfyImportMode)) throw badRequest('Choose what happens to the outputs')
    if (projectId != null && projectId !== deps.comfyInbox.target.projectId && !projectExists(deps, projectId)) {
      throw badRequest('That project no longer exists')
    }
    deps.comfyInbox.setTarget({ mode: mode as ComfyImportMode, ...(typeof projectId === 'string' ? { projectId } : {}) })
    return c.json(await comfyView(deps))
  })

  return r
}

/** Open or recent first; only an unknown id costs a look through the projects folder. */
function projectExists(deps: AppDeps, projectId: unknown): boolean {
  if (typeof projectId !== 'string' || !projectId) return false
  if (deps.registry.mounted(projectId) || deps.appState.recentById(projectId)) return true
  return deps.registry.list().some((p) => p.id === projectId)
}

async function comfyView(deps: AppDeps): Promise<ComfyViewDTO> {
  const url = await deps.comfyProxy.ensureListening()
  return { url, target: deps.comfyInbox.target, pendingImports: deps.comfyInbox.pendingCount }
}
