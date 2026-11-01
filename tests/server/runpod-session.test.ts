import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type CreatePodBody, type RunpodApi, RunpodError, type RunpodPod } from '../../src/server/providers/runpod/api'
import { type ComfyClient, ComfyError } from '../../src/server/providers/runpod/comfy'
import { MODEL_FILES, modelPaths } from '../../src/server/providers/runpod/graph'
import { POD_FILES, SETUP_VERSION, installTag, podAssetsDir, podBundle, renderPodBody } from '../../src/server/providers/runpod/pod'
import { GpuSession } from '../../src/server/providers/runpod/session'
import { VolumeSetup } from '../../src/server/providers/runpod/setup'
import { RunpodState } from '../../src/server/providers/runpod/state'
import { EventBus } from '../../src/server/services/events'
import { MemorySecretStore } from '../../src/server/services/keychain'
import type { SettingsService } from '../../src/server/services/settings'
import type { ServerEvent } from '../../src/shared/types/events'
import { DEFAULT_RUNPOD_SETTINGS, LTX_GPUS, type RunpodSettings } from '../../src/shared/types/runpod'

const PRO6000 = LTX_GPUS[0]!.id
const H100NVL = LTX_GPUS.find((g) => g.name === 'H100 NVL')!.id
const A6000 = LTX_GPUS.find((g) => g.name === 'RTX A6000')!.id
const MACHINE = 'm_TestMachine1234'

/** A fake RunPod: pods live in a map; `reject` lists GPUs that answer "no instances available". */
class FakeRunpod {
  pods = new Map<string, RunpodPod>()
  created: CreatePodBody[] = []
  deleted: string[] = []
  reject = new Set<string>()
  /** Container uptime by pod (GraphQL); missing = no container yet. */
  uptime = new Map<string, number>()
  stock: Record<string, 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'> = { [PRO6000]: 'HIGH', [H100NVL]: 'MEDIUM', [A6000]: 'HIGH' }
  balanceError = false
  /** The next this-many pod deletions fail (RunPod answers 500). */
  deleteFailures = 0
  /** Deletions wait for this first (a slow answer). */
  deleteGate: Promise<void> | undefined
  /** The next this-many pod creations make the pod but answer unclearly (RunPod answers 500). */
  unclearCreates = 0
  /** The next this-many pod creations fail with a 500 without making a pod. */
  failedCreates = 0
  cpus: { id: string; name: string; vcpuMin: number; vcpuMax: number; ramGbPerVcpu: number; pricePerVcpu: number; availability: 'HIGH' | 'LOW' }[] = []
  private n = 0

  api(): RunpodApi {
    return {
      getVolume: async (id: string) => ({ id, name: 'ltx-models', size: 150, dataCenter: 'EU-RO-1' }),
      stockIn: async () => new Map(Object.entries(this.stock)),
      cpuStockIn: async () => this.cpus,
      createPod: async (body: CreatePodBody) => {
        if (this.balanceError) throw new RunpodError('balance', 'RunPod: not enough credit', 402)
        if (body.gpu && this.reject.has(body.gpu.id)) throw new RunpodError('rejected', 'RunPod: There are no longer any instances available', 400)
        if (this.failedCreates > 0) {
          this.failedCreates--
          throw new RunpodError('server', 'RunPod: internal error', 500)
        }
        this.created.push(body)
        const pod: RunpodPod = { id: `pod${++this.n}`, name: body.name, status: 'PROVISIONING', cost: body.gpu ? 2.09 : 0.16, gpu: body.gpu ? { id: body.gpu.id } : undefined, createdAt: new Date().toISOString() }
        this.pods.set(pod.id, pod)
        if (this.unclearCreates > 0) {
          this.unclearCreates--
          throw new RunpodError('server', 'RunPod: unexpected answer when creating the pod')
        }
        return pod
      },
      getPod: async (id: string) => this.pods.get(id),
      podUptime: async (id: string) => this.uptime.get(id) ?? null,
      deletePod: async (id: string) => {
        await this.deleteGate
        if (this.deleteFailures > 0) {
          this.deleteFailures--
          throw new RunpodError('server', 'RunPod: internal error', 500)
        }
        this.deleted.push(id)
        this.pods.delete(id)
      },
      listPods: async () => [...this.pods.values()],
      account: async () => ({ clientBalance: 15 }),
    } as unknown as RunpodApi
  }
}

/** A fake ComfyUI: `up` decides whether it answers. */
class FakeComfy {
  up = false
  /** How it fails while not up (default: the token gate answers, ComfyUI still loading). */
  failure: ComfyError | undefined
  queue = { running: [] as string[], pending: [] as string[] }
  heartbeats = 0
  client(): ComfyClient {
    const check = () => {
      if (!this.up) throw this.failure ?? new ComfyError('starting', 'ComfyUI is loading', 502)
    }
    return {
      systemStats: async () => (check(), { devices: [{ name: 'RTX PRO 6000' }] }),
      queue: async () => (check(), this.queue),
      // Caddy answers the heartbeat on a real pod even while ComfyUI is loading or dead: it fails only when the pod
      // itself can't be reached (an explicit failure).
      heartbeat: async () => {
        if (!this.up && this.failure) throw this.failure
        this.heartbeats++
      },
    } as unknown as ComfyClient
  }
}

let dir: string
let clock: number
let runpod: FakeRunpod
let comfy: FakeComfy
let secrets: MemorySecretStore
let state: RunpodState
let events: EventBus
let published: ServerEvent[]
let settingsValue: RunpodSettings
let pending: number
let readyCalls: number

const settings = { get: () => ({ runpod: settingsValue }) } as unknown as SettingsService
const flush = () => new Promise((r) => setTimeout(r, 0))

function makeSession() {
  return new GpuSession(
    { events, settings, secrets, state, machineId: MACHINE, pendingJobs: () => pending, onReady: () => readyCalls++ },
    { api: () => runpod.api(), comfy: () => comfy.client(), now: () => clock, tickMs: 60_000, heartbeatMs: 60_000, queueCheckMs: 15_000 },
  )
}
const tick = (s: GpuSession) => (s as unknown as { tick(): Promise<void> }).tick()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runpod-'))
  clock = Date.parse('2026-10-06T12:00:00Z')
  runpod = new FakeRunpod()
  comfy = new FakeComfy()
  secrets = new MemorySecretStore()
  state = new RunpodState(dir)
  events = new EventBus()
  published = []
  events.subscribe((e) => published.push(e))
  settingsValue = { ...DEFAULT_RUNPOD_SETTINGS, volumeId: 'vol1' }
  pending = 0
  readyCalls = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('GPU session', () => {
  it('fails RunPod jobs with a clear reason until the key and a prepared volume are set', () => {
    const session = makeSession()
    expect(session.ensure()).toMatchObject({ ready: false, error: { message: expect.stringContaining('API key') } })
    secrets.set('runpod', 'apiKey', 'rpa_x')
    expect(session.ensure()).toMatchObject({ ready: false, error: { message: expect.stringContaining('Prepare the model volume') } })
    expect(runpod.created).toHaveLength(0)
  })

  it('rents the first-choice GPU on the volume, waits for ComfyUI, then lets jobs through', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    state.markPrepared('vol1', SETUP_VERSION)
    const session = makeSession()
    pending = 2
    expect(session.ensure()).toMatchObject({ ready: false, detail: 'Renting a GPU…' })
    await flush()
    expect(session.state).toBe('booting')
    const body = runpod.created[0]!
    expect(body).toMatchObject({ gpu: { id: PRO6000, minCudaVersion: '12.8' }, dataCenterIds: ['EU-RO-1'], mounts: { network: [{ volumeId: 'vol1', path: '/workspace' }] } })
    expect(body.name.startsWith(`wildroom-render-${installTag(MACHINE)}-`)).toBe(true)
    // The pod gets the app's token (made once, kept in the Keychain), never the RunPod key.
    expect(body.env.COMFY_AUTH_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    expect(body.env.COMFY_AUTH_TOKEN).toBe(secrets.get('comfyui', 'apiKey'))
    expect(JSON.stringify(body)).not.toContain('rpa_x')
    // The pod reads this card's model set (bf16 on 96 GB) ahead while it boots.
    expect(body.env.WILDROOM_PRELOAD).toContain(`diffusion_models/${MODEL_FILES.bf16.unet}`)
    expect(body.env.WILDROOM_PRELOAD).not.toContain(MODEL_FILES.int8.unet)
    expect(body.env.WILDROOM_PRELOAD_SH).toContain('xargs -P')

    // Running but ComfyUI not answering yet: still booting.
    runpod.pods.get('pod1')!.status = 'RUNNING'
    await tick(session)
    expect(session.dto()).toMatchObject({ state: 'booting', detail: 'Loading ComfyUI…' })
    expect(session.ensure()).toMatchObject({ ready: false })

    comfy.up = true
    await tick(session)
    expect(session.state).toBe('ready')
    expect(readyCalls).toBe(1)
    expect(session.ensure()).toEqual({ ready: true })
    expect(session.dto()).toMatchObject({ gpu: { name: 'RTX PRO 6000', precision: 'bf16' }, costPerHrUsd: 2.09, busy: true })
    expect(published.some((e) => e.type === 'gpu.session' && e.session.state === 'ready')).toBe(true)
  })

  it('asks before renting another GPU when the chosen ones are taken, and rents the one picked', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    state.markPrepared('vol1', SETUP_VERSION)
    runpod.reject.add(PRO6000)
    const session = makeSession()
    session.ensure()
    await flush()
    const dto = session.dto()
    expect(dto.state).toBe('needs_choice')
    expect(dto.choices!.map((c) => c.id)).toEqual(expect.arrayContaining([H100NVL, A6000]))
    expect(dto.choices!.find((c) => c.id === A6000)).toMatchObject({ precision: 'int8', availability: 'HIGH' })
    expect(session.ensure()).toMatchObject({ ready: false, detail: expect.stringContaining('Choose a GPU') })

    session.choose(H100NVL)
    await flush()
    expect(session.state).toBe('booting')
    expect(runpod.created.at(-1)!.gpu?.id).toBe(H100NVL)
  })

  it('keeps waiting for the first-choice GPU when asked: renders stay queued, nothing else offered, rented once free', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    state.markPrepared('vol1', SETUP_VERSION)
    runpod.reject.add(PRO6000)
    const session = makeSession()
    session.ensure()
    await flush()
    expect(session.dto().state).toBe('needs_choice')
    session.keepWaiting()
    expect(session.dto()).toMatchObject({ waitingFor: 'RTX PRO 6000', choices: undefined })
    // Queued renders wait (no "declined" error).
    expect(session.ensure()).toMatchObject({ ready: false, detail: expect.stringContaining('Waiting for RTX PRO 6000') })
    // A minute later it tries again — still taken: no offer of another GPU, it keeps waiting.
    clock += 61_000
    session.ensure()
    await flush()
    expect(session.dto().state).toBe('error')
    expect(session.dto().choices).toBeUndefined()
    expect(session.dto().waitingFor).toBe('RTX PRO 6000')
    expect(runpod.created).toHaveLength(0)
    // Changing one's mind: the next try offers the free GPUs again.
    session.offerOthers()
    expect(session.dto().waitingFor).toBeUndefined()
    session.ensure()
    await flush()
    expect(session.dto().state).toBe('needs_choice')
    session.keepWaiting()
    // Free again: rented, and the wait is over.
    runpod.reject.delete(PRO6000)
    clock += 61_000
    session.ensure()
    await flush()
    expect(session.state).toBe('booting')
    expect(runpod.created.at(-1)!.gpu?.id).toBe(PRO6000)
    expect(session.dto().waitingFor).toBeUndefined()
  })

  it('fails queued jobs when the user declines every offered GPU', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    state.markPrepared('vol1', SETUP_VERSION)
    runpod.reject.add(PRO6000)
    const session = makeSession()
    session.ensure()
    await flush()
    session.decline()
    expect(session.ensure()).toMatchObject({ ready: false, error: { code: 'gpu_declined' } })
    expect(runpod.created).toHaveLength(0)
  })

  it('stops a fatal error early: no credit', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    state.markPrepared('vol1', SETUP_VERSION)
    runpod.balanceError = true
    const session = makeSession()
    session.ensure()
    await flush()
    expect(session.dto()).toMatchObject({ state: 'error', fatal: true, detail: expect.stringContaining('credit') })
    expect(session.ensure()).toMatchObject({ ready: false, error: { code: 'gpu' } })
  })

  async function readySession() {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    state.markPrepared('vol1', SETUP_VERSION)
    const session = makeSession()
    session.requestStart()
    await flush()
    runpod.pods.get('pod1')!.status = 'RUNNING'
    comfy.up = true
    await tick(session)
    expect(session.state).toBe('ready')
    return session
  }

  it('stops the GPU 30 s after the queue runs empty, and logs what it cost', async () => {
    const session = await readySession()
    const startedAt = clock
    clock += 20_000
    await tick(session)
    expect(session.state).toBe('ready')
    expect(session.dto().idleStopAt).toBe(new Date(startedAt + 30_000).toISOString())

    clock += 11_000
    await tick(session)
    expect(session.state).toBe('off')
    expect(session.dto().detail).toBe('Stopped 30 s after the queue ran empty')
    expect(runpod.deleted).toEqual(['pod1'])
    expect(state.pod).toBeUndefined()
    expect(state.sessions.at(-1)).toMatchObject({ podId: 'pod1', gpuName: 'RTX PRO 6000', costPerHrUsd: 2.09 })
    expect(state.sessions.at(-1)!.costUsd).toBeCloseTo((31 / 3600) * 2.09, 2)
  })

  it('does not stop while renders are queued or ComfyUI is busy, and "Keep on" holds it', async () => {
    const session = await readySession()
    pending = 1
    clock += 30 * 60_000
    await tick(session)
    expect(session.state).toBe('ready')

    pending = 0
    comfy.queue = { running: ['p1'], pending: [] }
    clock += 15_000
    await tick(session)
    clock += 30 * 60_000
    await tick(session)
    expect(session.state).toBe('ready')

    comfy.queue = { running: [], pending: [] }
    clock += 15_000
    await tick(session) // idle from now
    session.keep() // 30 min
    clock += 20 * 60_000
    await tick(session)
    expect(session.state).toBe('ready')
    clock += 11 * 60_000
    await tick(session)
    expect(session.state).toBe('off')
  })

  it('holds the GPU while ComfyUI is used, then stops 5 min after the last use', async () => {
    const session = await readySession()
    const readyAt = clock
    clock += 20_000
    session.touch() // a click in ComfyUI
    expect(session.dto().comfyUntil).toBe(new Date(readyAt + 320_000).toISOString())
    clock += 4 * 60_000
    await tick(session)
    expect(session.state).toBe('ready')
    expect(session.dto().idleStopAt).toBe(new Date(readyAt + 320_000).toISOString())

    clock += 61_000
    await tick(session)
    expect(session.state).toBe('off')
    expect(session.dto().detail).toBe('Stopped 5 min after ComfyUI was last used')
    expect(session.dto().comfyUntil).toBeUndefined()
  })

  it('ignores ComfyUI use while no GPU is ready', () => {
    const session = makeSession()
    session.touch()
    expect(session.dto().comfyUntil).toBeUndefined()
  })

  it('hands back a pod stuck while starting, rents another machine once, then stops renting', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    state.markPrepared('vol1', SETUP_VERSION)
    const session = makeSession()
    pending = 2
    session.ensure()
    await flush()
    // Rented, but the machine never gets its container running (nothing answers on the pod's port).
    runpod.pods.get('pod1')!.status = 'RUNNING'
    comfy.failure = new ComfyError('starting', 'The GPU is still starting', 404)
    await tick(session)
    expect(session.dto()).toMatchObject({ state: 'booting', detail: 'Setting up the machine (downloading ComfyUI, 5.7 GB)…' })
    // A slow download is left to finish: at 12 min (the old limit) it is still going.
    clock += 12 * 60_000
    await tick(session)
    expect(runpod.deleted).toEqual([])
    expect(session.dto()).toMatchObject({ state: 'booting', detail: 'Setting up the machine (downloading ComfyUI, 5.7 GB) — 12 min…' })
    clock += 7 * 60_000
    await tick(session)
    expect(runpod.deleted).toEqual([])

    clock += 2 * 60_000
    await tick(session)
    await flush()
    expect(runpod.deleted).toEqual(['pod1'])
    expect(state.sessions.at(-1)).toMatchObject({ podId: 'pod1' })
    expect(session.podId).toBe('pod2')
    expect(session.ensure()).toMatchObject({ ready: false })

    // The second machine runs its container, but ComfyUI never answers.
    runpod.pods.get('pod2')!.status = 'RUNNING'
    runpod.uptime.set('pod2', 30)
    await tick(session)
    expect(session.dto()).toMatchObject({ state: 'booting', detail: 'Starting ComfyUI…' })
    clock += 8 * 60_000
    await tick(session)
    await flush()
    expect(runpod.deleted).toEqual(['pod1', 'pod2'])
    expect(runpod.created).toHaveLength(2)
    expect(session.dto()).toMatchObject({ state: 'error', fatal: true, detail: expect.stringContaining('twice') })
    expect(session.ensure()).toMatchObject({ ready: false, error: { code: 'gpu' } })

    // Start GPU tries again from scratch.
    session.requestStart()
    await flush()
    expect(runpod.created).toHaveLength(3)
  })

  it('does not give up on a machine whose token gate answers while ComfyUI loads', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    state.markPrepared('vol1', SETUP_VERSION)
    const session = makeSession()
    session.ensure()
    await flush()
    runpod.pods.get('pod1')!.status = 'RUNNING'
    await tick(session)
    clock += 7 * 60_000
    await tick(session)
    expect(session.dto()).toMatchObject({ state: 'booting', detail: 'Loading ComfyUI…' })
    comfy.up = true
    await tick(session)
    expect(session.state).toBe('ready')
    expect(runpod.deleted).toEqual([])
  })

  it('takes over its own running pod after a restart and removes leftovers', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    state.markPrepared('vol1', SETUP_VERSION)
    const tag = installTag(MACHINE)
    runpod.pods.set('live', { id: 'live', name: `wildroom-render-${tag}-a`, status: 'RUNNING', cost: 2.09, gpu: { id: PRO6000 } })
    runpod.pods.set('old', { id: 'old', name: `wildroom-render-${tag}-b`, status: 'EXITED', gpu: { id: PRO6000 } })
    runpod.pods.set('theirs', { id: 'theirs', name: 'my-own-pod', status: 'RUNNING' })
    const session = makeSession()
    await (session as unknown as { reconcile(): Promise<void> }).reconcile()
    expect(session.podId).toBe('live')
    expect(runpod.deleted).toEqual(['old'])
    comfy.up = true
    await tick(session)
    expect(session.state).toBe('ready')
  })

  it('keeps a taken-over pod that has run longer than the start timeouts', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    state.markPrepared('vol1', SETUP_VERSION)
    const tag = installTag(MACHINE)
    // Rented an hour before this app run (e.g. the app crashed mid-render); its container has run as long.
    const createdAt = new Date(clock - 60 * 60_000).toISOString()
    runpod.pods.set('live', { id: 'live', name: `wildroom-render-${tag}-a`, status: 'RUNNING', cost: 2.09, gpu: { id: PRO6000 }, createdAt })
    runpod.uptime.set('live', 3600)
    const session = makeSession()
    await (session as unknown as { reconcile(): Promise<void> }).reconcile()
    // ComfyUI doesn't answer on the first look: still not a stuck boot.
    await tick(session)
    expect(runpod.deleted).toEqual([])
    expect(session.state).toBe('booting')
    comfy.up = true
    await tick(session)
    expect(session.state).toBe('ready')
    // Its cost still counts from when it was rented.
    expect(session.dto().startedAt).toBe(createdAt)
  })

  it('stays stopping (no renders go to it) and retries when stopping the pod fails', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    state.markPrepared('vol1', SETUP_VERSION)
    runpod.pods.set('live', { id: 'live', name: `wildroom-render-${installTag(MACHINE)}-a`, status: 'RUNNING', cost: 2.09, gpu: { id: PRO6000 } })
    const session = makeSession()
    await (session as unknown as { reconcile(): Promise<void> }).reconcile()
    comfy.up = true
    await tick(session)
    expect(session.state).toBe('ready')
    runpod.deleteFailures = 1
    await session.stopNow('Stopped')
    expect(session.state).toBe('stopping')
    expect(session.dto().detail).toContain('Could not stop the GPU')
    expect(session.client()).toBeUndefined()
    expect(session.ensure()).toMatchObject({ ready: false, retryInMs: expect.any(Number) })
    await tick(session)
    expect(runpod.deleted).toEqual(['live'])
    expect(session.state).toBe('off')
  })

  /** Rented, running, but the machine never starts the container: handed back after the pull timeout. */
  async function stuckPod() {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    state.markPrepared('vol1', SETUP_VERSION)
    const session = makeSession()
    pending = 1
    session.ensure()
    await flush()
    runpod.pods.get('pod1')!.status = 'RUNNING'
    comfy.failure = new ComfyError('starting', 'The GPU is still starting', 404)
    clock += 21 * 60_000
    return session
  }

  it('does not forget a pod it handed back while the delete fails: tried again until RunPod confirms', async () => {
    const session = await stuckPod()
    runpod.deleteFailures = 1 // an API blip
    await tick(session)
    await flush()
    // The replacement is rented; the stuck pod still runs, but is not forgotten.
    expect(session.podId).toBe('pod2')
    expect(runpod.pods.has('pod1')).toBe(true)
    expect(state.pendingDeletes).toEqual(['pod1'])
    // Kept on disk too: a restart would delete it rather than take it over.
    expect(new RunpodState(dir).pendingDeletes).toEqual(['pod1'])

    clock += 16_000
    await tick(session)
    expect(runpod.deleted).toEqual(['pod1'])
    expect(state.pendingDeletes).toEqual([])
    expect(session.podId).toBe('pod2')
  })

  it('reports an undeleted pod on the GPU chip until RunPod confirms', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    state.markPrepared('vol1', SETUP_VERSION)
    const session = makeSession()
    session.ensure()
    await flush()
    runpod.pods.get('pod1')!.status = 'EXITED'
    runpod.deleteFailures = 99
    await tick(session)
    expect(session.dto()).toMatchObject({ state: 'error', detail: expect.stringContaining('a GPU could not be stopped yet') })
    expect(state.pendingDeletes).toEqual(['pod1'])
    runpod.deleteFailures = 0
    clock += 16_000
    await tick(session)
    expect(runpod.deleted).toEqual(['pod1'])
    expect(session.dto().detail).not.toContain('could not be stopped')
  })

  it('after a restart, deletes a pod it was handing back instead of taking it over, and drops ones already gone', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    state.markPrepared('vol1', SETUP_VERSION)
    runpod.pods.set('stuck', { id: 'stuck', name: `wildroom-render-${installTag(MACHINE)}-a`, status: 'RUNNING', cost: 2.09, gpu: { id: PRO6000 } })
    state.addPendingDelete('stuck')
    state.addPendingDelete('gone')
    const session = makeSession()
    await (session as unknown as { reconcile(): Promise<void> }).reconcile()
    expect(session.podId).toBeUndefined()
    expect(runpod.deleted).toEqual(['stuck'])
    expect(state.pendingDeletes).toEqual([])
  })

  it('leaves a GPU started again alone while RunPod is slow to confirm the delete of the exited one before it', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    state.markPrepared('vol1', SETUP_VERSION)
    const session = makeSession()
    session.requestStart()
    await flush()
    runpod.pods.get('pod1')!.status = 'EXITED'
    let answer!: () => void
    runpod.deleteGate = new Promise((r) => (answer = r))
    const checking = tick(session)
    await flush()
    // RunPod is slow to confirm the delete: meanwhile the user starts the GPU again.
    session.requestStart()
    await flush()
    expect(session.podId).toBe('pod2')
    answer()
    runpod.deleteGate = undefined
    await checking
    expect(session.podId).toBe('pod2')
    expect(session.state).toBe('booting')
    expect(runpod.deleted).toEqual(['pod1'])
  })

  it('deletes a ready pod that RunPod reports exited (it still holds its disk), not just forgets it', async () => {
    const session = await readySession()
    pending = 1
    comfy.up = false
    clock += 1000
    await tick(session) // heartbeat fails: unreachable from now
    clock += 4 * 60_000
    runpod.pods.get('pod1')!.status = 'EXITED'
    await tick(session)
    expect(session.dto()).toMatchObject({ state: 'off', detail: 'The GPU stopped unexpectedly' })
    expect(runpod.deleted).toEqual(['pod1'])
  })

  it('stops a running pod whose ComfyUI died (nothing listens on its port), instead of billing on a render that hangs', async () => {
    const session = await readySession()
    pending = 1
    comfy.up = false // RunPod's proxy: 502, nothing listening
    clock += 1000
    await tick(session)
    clock += 2 * 60_000
    await tick(session)
    expect(session.state).toBe('ready') // not yet: under 3 min
    clock += 2 * 60_000
    await tick(session)
    expect(session.dto()).toMatchObject({ state: 'off', detail: expect.stringContaining('ComfyUI crashed') })
    expect(runpod.deleted).toEqual(['pod1'])
    expect(session.crashed('pod1')).toBe(true)
  })

  it('keeps a running pod whose ComfyUI is only slow to answer (busy, or the network)', async () => {
    const session = await readySession()
    pending = 1
    comfy.up = false
    comfy.failure = new ComfyError('unreachable', 'Cannot reach the GPU: no answer')
    for (let i = 0; i < 10; i++) {
      clock += 60_000
      await tick(session)
    }
    expect(session.state).toBe('ready')
    expect(runpod.deleted).toEqual([])
    expect(session.crashed('pod1')).toBe(false)
  })

  it('does not rent the next GPU after an unclear answer (500) to renting one: looks for the pod first and takes it over', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    state.markPrepared('vol1', SETUP_VERSION)
    runpod.unclearCreates = 1
    const session = makeSession()
    session.ensure()
    await flush()
    expect(runpod.created).toHaveLength(1)
    expect(session.dto()).toMatchObject({ state: 'error', fatal: false })
    expect(session.reconciled).toBe(false)
    // The next tick lists the pods and takes over the one RunPod made after all.
    clock += 16_000
    await tick(session)
    expect(session.podId).toBe('pod1')
    expect(session.state).toBe('booting')
    expect(runpod.created).toHaveLength(1)
  })

  it('lets a render queued well after a fatal error try again (credit topped up)', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    state.markPrepared('vol1', SETUP_VERSION)
    runpod.balanceError = true
    const session = makeSession()
    session.ensure()
    await flush()
    runpod.balanceError = false // topped up
    // The renders queued with the error fail with it, without renting.
    clock += 60_000
    expect(session.ensure()).toMatchObject({ ready: false, error: { code: 'gpu', message: expect.stringContaining('credit') } })
    // A render queued later (Render again) tries again.
    clock += 5 * 60_000
    expect(session.ensure()).toMatchObject({ ready: false, detail: 'Renting a GPU…' })
    await flush()
    expect(session.state).toBe('booting')
    expect(runpod.created).toHaveLength(1)
  })

  it('does not rent again by itself after the pod refused the token: that needs the volume prepared again', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    state.markPrepared('vol1', SETUP_VERSION)
    const session = makeSession()
    session.ensure()
    await flush()
    runpod.pods.get('pod1')!.status = 'RUNNING'
    comfy.failure = new ComfyError('unauthorized', 'The GPU rejected the access token', 401)
    await tick(session)
    expect(runpod.deleted).toEqual(['pod1'])
    expect(session.dto()).toMatchObject({ state: 'error', fatal: true, detail: expect.stringContaining('access token') })
    clock += 30 * 60_000
    expect(session.ensure()).toMatchObject({ ready: false, error: { code: 'gpu' } })
    await flush()
    expect(runpod.created).toHaveLength(1)
    // Preparing the volume again clears it.
    events.publish({ type: 'settings.changed' })
    comfy.failure = undefined
    session.ensure()
    await flush()
    expect(runpod.created).toHaveLength(2)
  })
})

describe('preparing the volume', () => {
  function makeSetup(status: () => string | undefined) {
    const fetchImpl = (async () => {
      const text = status()
      return text === undefined ? new Response('starting', { status: 502 }) : new Response(text)
    }) as typeof fetch
    return new VolumeSetup(
      { events, settings, secrets, state, machineId: MACHINE },
      { api: () => runpod.api(), fetchImpl, now: () => clock, pollMs: 60_000, bundle: () => 'BUNDLE' },
    )
  }
  const poll = (s: VolumeSetup) => (s as unknown as { poll(): Promise<void> }).poll()

  it('rents the cheapest free GPU, follows the progress file, marks the volume prepared and removes the pod', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    let status: string | undefined
    const setup = makeSetup(() => status)
    const started = await setup.start('hf_token')
    expect(started).toMatchObject({ state: 'running', gpuName: 'RTX A6000' })
    expect(secrets.get('hf', 'apiKey')).toBe('hf_token')
    expect(runpod.created[0]).toMatchObject({ env: { WILDROOM_BUNDLE: 'BUNDLE', HF_TOKEN: 'hf_token' }, gpu: { id: A6000 } })

    await poll(setup) // pod not serving yet
    expect(setup.dto().state).toBe('running')
    status = '[wildroom] step 1/7 Installing ComfyUI on the volume\n[wildroom] step 5/7 Downloading LTX-2.5 models (~113 GB)\n'
    await poll(setup)
    expect(setup.dto()).toMatchObject({ step: 5, totalSteps: 7, title: 'Downloading LTX-2.5 models (~113 GB)' })

    status += '[wildroom] step 7/7 Finishing\n[wildroom] done\n'
    await poll(setup)
    expect(setup.dto().state).toBe('done')
    expect(state.preparedVersion('vol1')).toBe(SETUP_VERSION)
    expect(runpod.deleted).toEqual(['pod1'])
  })

  it('keeps following the setup (without throwing) when the RunPod key is removed meanwhile', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    let status: string | undefined
    const setup = makeSetup(() => status)
    await setup.start('hf_token')
    secrets.delete('runpod', 'apiKey')
    clock += 60_000
    await expect(poll(setup)).resolves.toBeUndefined() // checks the pod: no key
    status = '[wildroom] error the download failed\n'
    await expect(poll(setup)).resolves.toBeUndefined()
    expect(setup.dto()).toMatchObject({ state: 'failed', error: 'the download failed' })
  })

  it('prepares on a CPU pod when one is free, and switches to a GPU after a CPU could not install ComfyUI', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    runpod.cpus = [
      { id: 'cpu5c', name: 'Compute-Optimized', vcpuMin: 2, vcpuMax: 32, ramGbPerVcpu: 2.5, pricePerVcpu: 0.04, availability: 'HIGH' },
      { id: 'cpu3g', name: 'General', vcpuMin: 2, vcpuMax: 32, ramGbPerVcpu: 4, pricePerVcpu: 0.06, availability: 'HIGH' },
    ]
    let status = '[wildroom] step 1/7 Installing ComfyUI on the volume\n[wildroom] error ComfyUI did not install\n'
    const setup = makeSetup(() => status)
    expect(await setup.start('hf_token')).toMatchObject({ state: 'running', gpuName: 'CPU Compute-Optimized (4 vCPU)' })
    expect(runpod.created[0]).toMatchObject({ cpu: { id: 'cpu5c', vcpuCount: 4 } })
    expect(runpod.created[0]!.gpu).toBeUndefined()
    await poll(setup)
    expect(setup.dto()).toMatchObject({ state: 'failed', error: expect.stringContaining('run it again to use a GPU') })

    status = ''
    expect(await setup.start()).toMatchObject({ state: 'running', gpuName: 'RTX A6000' })
    expect(runpod.created[1]!.gpu?.id).toBe(A6000)
  })

  it('reports the setup error and removes the pod', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    const setup = makeSetup(() => '[wildroom] step 5/7 Downloading\n[wildroom] error Hugging Face refused Lightricks/LTX-2.5: accept its licence\n')
    await setup.start('hf_token')
    await poll(setup)
    expect(setup.dto()).toMatchObject({ state: 'failed', error: expect.stringContaining('accept its licence') })
    expect(runpod.deleted).toEqual(['pod1'])
    expect(state.preparedVersion('vol1')).toBe(0)
  })

  it('keeps deleting a canceled setup pod until RunPod confirms (the GPU session retries it)', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    const setup = makeSetup(() => undefined)
    await setup.start('hf_token')
    runpod.deleteFailures = 1
    expect(await setup.cancel()).toMatchObject({ state: 'idle', podId: undefined })
    expect(runpod.pods.has('pod1')).toBe(true)
    expect(state.pendingDeletes).toEqual(['pod1'])
    // Not taken over again after a restart either.
    const next = makeSetup(() => undefined)
    await next.reconcile()
    expect(next.dto().state).toBe('idle')
    expect(runpod.deleted).toEqual(['pod1'])
    expect(state.pendingDeletes).toEqual([])

    // A setup pod whose delete failed: the GPU session's tick finishes the job.
    runpod.pods.set('pod9', { id: 'pod9', name: `wildroom-setup-${installTag(MACHINE)}-z`, status: 'RUNNING' })
    state.addPendingDelete('pod9')
    const session = makeSession()
    await tick(session)
    expect(runpod.deleted).toEqual(['pod1', 'pod9'])
    expect(state.pendingDeletes).toEqual([])
  })

  it('follows a setup pod RunPod made despite an unclear answer, instead of renting a second machine on the volume', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    runpod.unclearCreates = 1
    const setup = makeSetup(() => undefined)
    expect(await setup.start('hf_token')).toMatchObject({ state: 'running', podId: 'pod1', gpuName: 'RTX A6000' })
    expect(runpod.created).toHaveLength(1)

    // A 500 that made nothing: the next machine is tried.
    runpod.cpus = [{ id: 'cpu5c', name: 'Compute-Optimized', vcpuMin: 2, vcpuMax: 32, ramGbPerVcpu: 2.5, pricePerVcpu: 0.04, availability: 'HIGH' }]
    runpod.failedCreates = 1
    await setup.cancel()
    expect(await setup.start()).toMatchObject({ state: 'running', gpuName: 'RTX A6000' })
    expect(runpod.created.at(-1)!.gpu?.id).toBe(A6000)
  })

  it('needs a Hugging Face token', async () => {
    secrets.set('runpod', 'apiKey', 'rpa_x')
    expect(await makeSetup(() => undefined).start()).toMatchObject({ state: 'failed', error: expect.stringContaining('Hugging Face') })
    expect(runpod.created).toHaveLength(0)
  })
})

describe('pod scripts', () => {
  it('ships every script, unpacked as the setup entrypoint does', () => {
    const files = JSON.parse(gunzipSync(Buffer.from(podBundle(), 'base64')).toString()) as Record<string, string>
    expect(Object.keys(files).sort()).toEqual([...POD_FILES].sort())
    expect(files['setup-volume.sh']).toContain('#!/usr/bin/env bash')
  })

  it('reads ahead only files the volume setup downloads, and every shell script parses', () => {
    const setup = readFileSync(join(podAssetsDir(), 'setup-volume.sh'), 'utf8')
    for (const precision of ['bf16', 'int8'] as const) {
      for (const path of modelPaths(precision)) expect(setup).toContain(path)
    }
    const body = renderPodBody({ install: 'x', gpuId: PRO6000, volumeId: 'v', dataCenter: 'EU-RO-1', token: 't', watchdogMinutes: 10, maxHours: 8, preload: modelPaths('bf16') })
    for (const script of [body.cmd![0]!, body.env.WILDROOM_PRELOAD_SH!, ...['on_start.sh', 'watchdog.sh', 'setup-volume.sh'].map((f) => readFileSync(join(podAssetsDir(), f), 'utf8'))]) {
      expect(spawnSync('bash', ['-n', '-c', script]).status).toBe(0)
    }
  })

  it('keeps the setup version in the script and the app in step', () => {
    const script = readFileSync(join(podAssetsDir(), 'setup-volume.sh'), 'utf8')
    expect(script).toMatch(new RegExp(`^SETUP_VERSION=${SETUP_VERSION}$`, 'm'))
  })
})
