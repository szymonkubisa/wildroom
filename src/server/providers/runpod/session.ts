import { randomBytes } from 'node:crypto'
import {
  type GpuAvailability,
  type GpuChoiceDTO,
  type GpuSessionDTO,
  type GpuSessionState,
  LTX_GPUS,
  idleText,
  ltxGpu,
  precisionFor,
} from '../../../shared/types/runpod'
import type { EventBus } from '../../services/events'
import type { SecretStore } from '../../services/keychain'
import type { SettingsService } from '../../services/settings'
import { type SubmitGate, jobError } from '../types'
import { RunpodApi, RunpodError } from './api'
import { ComfyClient, ComfyError } from './comfy'
import { modelPaths } from './graph'
import { MIN_CUDA, SETUP_VERSION, installTag, isOwnPod, podUrl, renderPodBody } from './pod'
import { type RunpodState, retirePod } from './state'

export interface GpuSessionDeps {
  events: EventBus
  settings: SettingsService
  secrets: SecretStore
  state: RunpodState
  machineId: string
  /** RunPod jobs queued or running, in every open project. */
  pendingJobs: () => number
  /** The GPU is ready: queued jobs can go now. */
  onReady?: () => void
}

/**
 * How long a rented machine may take to download and unpack the ComfyUI image (5.7 GB) before it is handed back. A
 * machine that has it cached starts in a minute or two; one that hasn't needs 10–15 min, and RunPod says nothing about
 * the progress — at 12 min the app used to throw away pulls that were most of the way there (2026-10-09: two in a row),
 * and the next machine starts from zero.
 */
const PULL_TIMEOUT_MS = 20 * 60_000
/** Longest a pod may take to answer at all (the pull plus loading ComfyUI). */
const BOOT_TIMEOUT_MS = 28 * 60_000
/** Size of COMFY_IMAGE compressed (Docker Hub), for the status line. */
const COMFY_IMAGE_GB = 5.7
/** Using ComfyUI (a click or key in its page) holds the GPU at least this long, even with a shorter idle stop. */
const COMFY_HOLD_SECONDS = 300

export interface GpuSessionOptions {
  api?: (apiKey: string) => RunpodApi
  comfy?: (baseUrl: string, token: string) => ComfyClient
  now?: () => number
  tickMs?: number
  bootTimeoutMs?: number
  /** No container yet after this long: the machine is stuck downloading or starting the image. */
  pullTimeoutMs?: number
  /** The container runs but ComfyUI has not answered for this long. */
  comfyTimeoutMs?: number
  heartbeatMs?: number
  queueCheckMs?: number
  /** ComfyUI unreachable this long while "ready": check whether the pod still exists. */
  lostAfterMs?: number
}

interface ActivePod {
  id: string
  gpuId: string
  startedAt: number
  /**
   * When this app run began waiting for it to come up: when it was rented, or when it was taken over after a restart
   * (a pod adopted mid-render may be hours old — the boot timeouts count from here, not from its creation).
   */
  bootSince: number
  /** Taken over after a restart (not rented by this app run). */
  adopted?: boolean
  costPerHr: number
  /** When its container started running (GraphQL uptime), once known. */
  containerAt?: number
  readyAt?: number
}

const WAIT_MS = 3000
/** After the user declines every offered GPU, queued RunPod jobs fail for this long (then a new job asks again). */
const DECLINE_MS = 15_000
const RETRY_AFTER_ERROR_MS = 60_000
/**
 * A fatal error (no credit, machines not starting) fails the renders queued with it; a render queued this long after it
 * is someone rendering again, and tries again (credit topped up meanwhile).
 */
const FATAL_RETRY_MS = 5 * 60_000
/** A failed pod delete is tried again this often. */
const DELETE_RETRY_MS = 15_000
/** A pod stuck while starting is handed back and another machine rented this many times before giving up. */
const MAX_SWAPS = 1
const LIVE_STOCK: GpuAvailability[] = ['HIGH', 'MEDIUM', 'LOW']

/**
 * The rented GPU: one RunPod pod at a time, started when RunPod jobs are queued (or by hand), stopped when nothing has
 * used it for a few minutes. The pod also stops itself (watchdog on the volume) when this app stops reaching it.
 */
export class GpuSession {
  private stateName: GpuSessionState = 'off'
  private detail: string | undefined
  private fatal = false
  /** The fatal error was a missing setting (key, volume): checked again on every job, it clears once fixed. */
  private missingSetup = false
  /** The fatal error needs the user (the volume prepared again): a new render does not rent a GPU just to fail again. */
  private needsUser = false
  private errorAt = 0
  private pod: ActivePod | undefined
  private tried = new Set<string>()
  private choices: GpuChoiceDTO[] | undefined
  /** Waiting for the first-choice GPU (its name) instead of offering others: see keepWaiting. */
  private holdOut: string | undefined
  private idleSince: number | undefined
  private keepUntil: number | undefined
  /** Someone used ComfyUI on the pod lately (see `touch`): it stays on until then. */
  private comfyUntil: number | undefined
  private declinedUntil = 0
  private comfyBusy = false
  private lastHeartbeat = 0
  private lastQueueCheck = 0
  private unreachableSince: number | undefined
  /**
   * Since when RunPod's proxy has said nothing listens on the pod's port (502/404, not a slow answer) while the pod is
   * up: ComfyUI died (a render ran it out of memory, say), and it does not come back by itself.
   */
  private notServingSince: number | undefined
  /** Pods stopped because ComfyUI died on them: the render running there failed with it (see `crashed`). */
  private crashedPods = new Set<string>()
  private volume: { id: string; name: string; dataCenter: string } | undefined
  private timer: NodeJS.Timeout | undefined
  private working = false
  /** Pods were listed since the app started (jobs from before a restart can tell whether their pod is still there). */
  private reconciledFlag = false
  private lastReconcileAttempt = 0
  private lastDeleteRetry = 0
  /** A pod handed back could not be deleted yet (it may still bill): shown until RunPod confirms. */
  private deleteFailing = false
  private lastPublished = ''
  /** Counts rents; Stop while renting bumps it, so the rent in progress hands its pod straight back. */
  private rent = 0
  /** Stuck pods replaced since the last start. */
  private swaps = 0
  /** The stop in progress (a second Stop, or the idle stop, joins it instead of deleting the pod twice). */
  private stopping: Promise<void> | undefined
  /** Why the pod is being stopped: a failed stop stays "stopping" and every tick tries again with this reason. */
  private stopReason = 'Stopped'
  private readonly install: string
  private readonly now: () => number

  constructor(
    private readonly deps: GpuSessionDeps,
    private readonly opts: GpuSessionOptions = {},
  ) {
    this.install = installTag(deps.machineId)
    this.now = opts.now ?? Date.now
    deps.events.subscribe((event) => {
      if (event.type !== 'settings.changed') return
      const volumeId = this.deps.settings.get().runpod.volumeId
      if (this.volume && this.volume.id !== volumeId) this.volume = undefined
      // New settings (key, volume, GPUs) may fix what failed.
      if (this.stateName === 'error') this.set('off', undefined)
      this.publish()
    })
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? WAIT_MS)
    this.timer.unref?.()
    void this.reconcile()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  // ---------------------------------------------------------------- for the job worker and the adapter

  /** Whether a queued RunPod job can be submitted now; starts the GPU when needed. */
  ensure(): SubmitGate {
    const wait = (detail: string): SubmitGate => ({ ready: false, retryInMs: WAIT_MS, detail })
    switch (this.stateName) {
      case 'ready':
        return { ready: true }
      case 'creating':
        return wait('Renting a GPU…')
      case 'booting':
        return wait(this.detail ?? 'Starting the GPU…')
      case 'needs_choice':
        return wait('Choose a GPU — your first choice is not available')
      case 'stopping':
        return wait('The GPU is stopping — it will start again')
      case 'error':
        if (this.fatal && (this.missingSetup || (!this.needsUser && this.now() - this.errorAt >= FATAL_RETRY_MS))) {
          this.begin()
          return this.fatalError() ?? wait('Renting a GPU…')
        }
        if (this.fatal) return { ready: false, error: jobError('gpu', this.detail ?? 'The GPU could not start', { retryable: true }) }
        if (this.now() - this.errorAt < RETRY_AFTER_ERROR_MS) return wait(`${this.detail ?? 'The GPU could not start'} — retrying soon`)
        this.begin()
        return wait('Renting a GPU…')
      case 'off':
        if (this.now() < this.declinedUntil) return { ready: false, error: jobError('gpu_declined', 'No GPU was rented for this render', { retryable: true }) }
        this.begin()
        // begin() may have failed straight away (no key, no prepared volume): fail the job with that reason.
        return this.fatalError() ?? wait('Renting a GPU…')
    }
  }

  private fatalError(): SubmitGate | undefined {
    const state: GpuSessionState = this.stateName
    return state === 'error' && this.fatal ? { ready: false, error: jobError('gpu', this.detail ?? 'The GPU could not start', { retryable: true }) } : undefined
  }

  /** ComfyUI on the running pod, once it answers. */
  client(): ComfyClient | undefined {
    return this.stateName === 'ready' && this.pod ? this.comfyFor(this.pod.id) : undefined
  }

  get podId(): string | undefined {
    return this.pod?.id
  }

  /** The pod was stopped because ComfyUI died on it (not stopped by hand or for idling). */
  crashed(podId: string): boolean {
    return this.crashedPods.has(podId)
  }

  /** False until this app run has looked for its pods on RunPod: until then a job's pod may still be adopted. */
  get reconciled(): boolean {
    return this.reconciledFlag
  }

  get state(): GpuSessionState {
    return this.stateName
  }

  get precision() {
    const gpu = this.pod ? ltxGpu(this.pod.gpuId) : undefined
    return gpu ? gpu.precision : 'bf16'
  }

  get costPerHr(): number | undefined {
    return this.pod?.costPerHr
  }

  // ---------------------------------------------------------------- user actions

  /** Start without a job (Start GPU, opening ComfyUI). */
  requestStart() {
    if (this.stateName === 'ready') this.idleSince ??= this.now()
    this.declinedUntil = 0
    if (this.stateName === 'off' || this.stateName === 'error') {
      this.fatal = false
      this.begin()
    }
    this.publish()
  }

  /** Stops the GPU now (terminates the pod; the volume stays). */
  stopNow(reason = 'Stopped'): Promise<void> {
    this.stopping ??= this.terminate(reason).finally(() => (this.stopping = undefined))
    return this.stopping
  }

  private async terminate(reason: string) {
    const pod = this.pod
    if (!pod) {
      if (this.stateName === 'needs_choice') this.decline()
      else if (this.stateName === 'creating') {
        this.rent++
        this.set('off', reason)
      }
      return
    }
    this.stopReason = reason
    this.set('stopping', 'Stopping the GPU…')
    // Written down first: if the app quits before RunPod confirms, the next run deletes it instead of taking it over.
    this.deps.state.addPendingDelete(pod.id)
    try {
      await this.api().deletePod(pod.id)
      this.deps.state.removePendingDelete(pod.id)
      if (this.pod === pod) this.end(reason)
    } catch (err) {
      // Still running and billing: say so loudly. It stays "stopping" (no renders go to it) and the next tick tries again.
      if (this.pod === pod) {
        this.set('stopping', `Could not stop the GPU (${err instanceof Error ? err.message : String(err)}) — retrying. Check the RunPod console if this persists.`)
      }
    }
    this.publish()
  }

  /** Keeps the GPU on for a while even without renders. */
  keep() {
    if (!this.pod) return
    const minutes = this.deps.settings.get().runpod.keepOnMinutes
    this.keepUntil = this.now() + minutes * 60_000
    this.publish()
  }

  /**
   * Someone clicked or typed in ComfyUI (the page reports it through the app's proxy): keep the GPU on for a while
   * even with nothing queued, so building a graph doesn't lose the pod. It still stops once nobody uses it.
   */
  touch() {
    if (this.stateName !== 'ready') return
    this.comfyUntil = this.now() + this.comfyHoldSeconds() * 1000
    this.publish()
  }

  /** How long one use of ComfyUI holds the GPU: at least the idle stop, at least COMFY_HOLD_SECONDS. */
  private comfyHoldSeconds(): number {
    return Math.max(this.deps.settings.get().runpod.idleSeconds, COMFY_HOLD_SECONDS)
  }

  /** The user picked one of the offered GPUs. */
  choose(gpuId: string) {
    if (this.stateName !== 'needs_choice' || !this.choices?.some((c) => c.id === gpuId)) return
    this.choices = undefined
    this.set('creating', 'Renting a GPU…')
    void this.create([gpuId])
  }

  /**
   * The user would rather wait for their first-choice GPU than rent another: the renders stay queued, the GPU is tried
   * again every minute, and no other is offered until one is rented or the session stops.
   */
  keepWaiting() {
    if (this.stateName !== 'needs_choice') return
    this.holdOut = ltxGpu(this.deps.settings.get().runpod.gpuIds[0] ?? '')?.name ?? 'your GPU'
    this.failWith(`Waiting for ${this.holdOut} — trying again every minute`, false)
  }

  /** Stops waiting for the first-choice GPU: the next try offers the free ones again (needs_choice). */
  offerOthers() {
    if (!this.holdOut) return
    this.holdOut = undefined
    this.errorAt = 0
    this.publish()
  }

  /** The user declined the offered GPUs: queued RunPod jobs fail instead of waiting. */
  decline() {
    this.holdOut = undefined
    this.choices = undefined
    this.declinedUntil = this.now() + DECLINE_MS
    this.set('off', 'No GPU rented')
  }

  dto(): GpuSessionDTO {
    const runpod = this.deps.settings.get().runpod
    const gpu = this.pod ? ltxGpu(this.pod.gpuId) : undefined
    const stopAt = this.stopAt()
    const volume = this.volume && this.volume.id === runpod.volumeId ? this.volume : undefined
    // A pod handed back is still billing until its delete goes through: say so while nothing else is shown about the GPU.
    const undeleted = this.deleteFailing && this.deps.state.pendingDeletes.some((id) => id !== this.pod?.id) && (this.stateName === 'off' || this.stateName === 'error')
    return {
      state: this.stateName,
      detail: undeleted ? `${this.detail ? `${this.detail} — ` : ''}a GPU could not be stopped yet, retrying (check the RunPod console if this persists)` : this.detail,
      fatal: this.stateName === 'error' ? this.fatal : undefined,
      podId: this.pod?.id,
      gpu: gpu ? { id: gpu.id, name: gpu.name, vramGb: gpu.vramGb, precision: precisionFor(gpu.vramGb) } : undefined,
      costPerHrUsd: this.pod?.costPerHr,
      startedAt: this.pod ? new Date(this.pod.startedAt).toISOString() : undefined,
      readyAt: this.pod?.readyAt ? new Date(this.pod.readyAt).toISOString() : undefined,
      costUsd: this.pod ? round2(((this.now() - this.pod.startedAt) / 3_600_000) * this.pod.costPerHr) : undefined,
      busy: this.deps.pendingJobs() > 0 || this.comfyBusy,
      idleStopAt: stopAt !== undefined && this.stateName === 'ready' ? new Date(stopAt).toISOString() : undefined,
      keepUntil: this.keepUntil && this.keepUntil > this.now() ? new Date(this.keepUntil).toISOString() : undefined,
      comfyUntil: this.comfyUntil && this.comfyUntil > this.now() ? new Date(this.comfyUntil).toISOString() : undefined,
      choices: this.stateName === 'needs_choice' ? this.choices : undefined,
      waitingFor: this.holdOut,
      volume: volume ? { ...volume, prepared: this.deps.state.preparedVersion(volume.id) >= SETUP_VERSION } : undefined,
    }
  }

  // ---------------------------------------------------------------- starting

  private begin() {
    const runpod = this.deps.settings.get().runpod
    const missing = !this.deps.secrets.get('runpod', 'apiKey')
      ? 'Add your RunPod API key in Settings → Providers'
      : !runpod.volumeId
        ? 'Choose the model volume in Settings → GPU'
        : this.deps.state.preparedVersion(runpod.volumeId) < SETUP_VERSION
          ? 'Prepare the model volume first (Settings → GPU)'
          : undefined
    if (missing) {
      this.failWith(missing, true)
      this.missingSetup = true
      return
    }
    this.tried.clear()
    this.swaps = 0
    this.fatal = false
    this.set('creating', 'Renting a GPU…')
    void this.create()
  }

  private async create(only?: string[]) {
    const rent = ++this.rent
    // Just started: take over a pod this app left running instead of renting a second one beside it.
    if (!this.reconciledFlag) {
      await this.reconcile()
      if (this.pod || rent !== this.rent) return
      if (!this.reconciledFlag) return this.failWith('Could not reach RunPod — retrying in a minute', false)
    }
    const settings = this.deps.settings.get().runpod
    let api: RunpodApi
    let volume: { id: string; name: string; dataCenter: string }
    try {
      api = this.api()
      volume = await this.volumeInfo(api, settings.volumeId)
    } catch (err) {
      return rent === this.rent ? this.failFrom(err) : undefined
    }
    // Unknown stock (catalog down): just try the chosen GPUs.
    const stock = await api.stockIn(volume.dataCenter, MIN_CUDA).catch(() => new Map<string, GpuAvailability>())
    if (rent !== this.rent) return
    const candidates = (only ?? settings.gpuIds).filter((id) => !this.tried.has(id) && stock.get(id) !== 'NONE')
    /** Why RunPod turned a GPU down when it wasn't just out of stock (shown if no GPU works). */
    let refused: RunpodError | undefined
    for (const gpuId of candidates) {
      this.tried.add(gpuId)
      const gpu = ltxGpu(gpuId)
      try {
        this.set('creating', `Renting ${gpu?.name ?? 'a GPU'} in ${volume.dataCenter}…`)
        const pod = await api.createPod(
          renderPodBody({
            install: this.install,
            gpuId,
            volumeId: volume.id,
            dataCenter: volume.dataCenter,
            token: this.token(),
            watchdogMinutes: Math.max(10, Math.ceil(settings.idleSeconds / 60) + 5),
            maxHours: settings.maxHours,
            preload: modelPaths(gpu?.precision ?? 'bf16'),
          }),
        )
        if (rent !== this.rent) {
          // Stopped while renting: give the pod straight back.
          await this.retire(pod.id)
          return
        }
        this.pod = { id: pod.id, gpuId, startedAt: this.now(), bootSince: this.now(), costPerHr: pod.cost || gpu?.priceUsdHr || 0 }
        this.deps.state.setPod({ id: pod.id, kind: 'render', gpuId, startedAt: new Date(this.pod.startedAt).toISOString(), costPerHrUsd: this.pod.costPerHr })
        this.resetActivity()
        this.set('booting', `${gpu?.name ?? 'GPU'} rented — starting ComfyUI…`)
        return
      } catch (err) {
        if (rent !== this.rent) return
        if (err instanceof RunpodError && ['rejected', 'forbidden', 'not_found'].includes(err.kind)) {
          if (err.kind !== 'rejected') refused = err
          continue
        }
        // No answer, or no clear one (a 5xx, a body without the pod): RunPod may have made the pod anyway — look for it
        // (and take it over) before renting another, instead of renting the next GPU beside it.
        if (err instanceof RunpodError && (err.kind === 'network' || err.kind === 'server')) this.reconciledFlag = false
        return this.failFrom(err)
      }
    }
    const choices = LTX_GPUS.filter((g) => !this.tried.has(g.id) && LIVE_STOCK.includes(stock.get(g.id) ?? 'NONE')).map(
      (g): GpuChoiceDTO => ({ id: g.id, name: g.name, vramGb: g.vramGb, precision: g.precision, priceUsdHr: g.priceUsdHr, availability: stock.get(g.id)!, note: g.note }),
    )
    if (this.holdOut) {
      this.failWith(`Waiting for ${this.holdOut}: still not free in ${volume.dataCenter} — trying again every minute`, false)
    } else if (choices.length) {
      this.choices = choices
      const wanted = ltxGpu(settings.gpuIds[0] ?? '')?.name ?? 'your GPU'
      this.set('needs_choice', `${wanted} is not available in ${volume.dataCenter} right now`)
    } else if (refused) {
      this.failWith(`${refused.message} — retrying in a minute`, false)
    } else {
      this.failWith(`No GPU that runs LTX-2.5 is free in ${volume.dataCenter} right now — retrying in a minute`, false)
    }
  }

  // ---------------------------------------------------------------- running

  private async tick() {
    if (this.working) return
    this.working = true
    try {
      if (!this.reconciledFlag && this.now() - this.lastReconcileAttempt > 15_000) await this.reconcile()
      if (this.stateName === 'booting') await this.checkBoot()
      else if (this.stateName === 'ready') await this.checkReady()
      // A stop that failed: the pod still bills, so keep trying.
      else if (this.stateName === 'stopping' && this.pod) await this.stopNow(this.stopReason)
      if (this.deps.state.pendingDeletes.length && this.now() - this.lastDeleteRetry >= DELETE_RETRY_MS) await this.retryDeletes()
    } catch (err) {
      console.warn('[runpod] session tick', err)
    } finally {
      this.working = false
      this.publish()
    }
  }

  private async checkBoot() {
    const pod = this.pod
    if (!pod) return this.set('off', undefined)
    // A Stop (or anything else) that came while this check was waiting on the network wins over what it found.
    const live = () => this.pod === pod && this.stateName === 'booting'
    const now = this.now()
    if (now - pod.bootSince > (this.opts.bootTimeoutMs ?? BOOT_TIMEOUT_MS)) return this.replaceStuck(pod, 'The GPU did not finish starting in time')
    let info
    try {
      info = await this.api().getPod(pod.id)
    } catch {
      return // RunPod unreachable for a moment
    }
    if (!live()) return
    if (!info || ['EXITED', 'TERMINATED', 'ERROR'].includes(info.status)) {
      // Ended before the delete is awaited: a Stop and Start meanwhile must not end the next pod in its place.
      const retired = info ? this.retire(pod.id) : undefined
      this.end('The GPU stopped while starting')
      this.failWith('The GPU stopped while starting — retrying in a minute', false)
      return retired
    }
    if (info.cost) pod.costPerHr = info.cost
    if (info.status !== 'RUNNING') return this.set('booting', 'Starting the GPU…')
    // Whether the container runs yet: until it does, the machine is downloading the ComfyUI image (unknown: undefined).
    let uptime: number | null | undefined
    try {
      uptime = await this.api().podUptime(pod.id)
    } catch {
      uptime = undefined
    }
    if (!live()) return
    if (uptime != null && pod.containerAt === undefined) {
      console.info(`[runpod] pod ${pod.id}: container running ${Math.round((now - uptime * 1000 - pod.startedAt) / 1000)} s after renting`)
      // A taken-over pod's container may have run for hours: ComfyUI's start timeout counts from the takeover.
      pod.containerAt = pod.adopted ? Math.max(now - uptime * 1000, pod.bootSince) : now - uptime * 1000
    }
    try {
      await this.comfyFor(pod.id).systemStats()
    } catch (err) {
      if (!live()) return
      if (err instanceof ComfyError && err.kind === 'unauthorized') {
        const retired = this.retire(pod.id)
        this.end('Stopped: the pod did not accept the access token')
        this.failWith('The GPU did not accept the app’s access token — prepare the volume again', true)
        // Every pod would refuse it until the volume is prepared again (that clears the error).
        this.needsUser = true
        return retired
      }
      const loading = err instanceof ComfyError && err.message === 'ComfyUI is loading'
      // The pod's token gate answered: its container runs whatever GraphQL said.
      if (loading) pod.containerAt ??= now
      if (pod.containerAt === undefined) {
        if (uptime === null && now - pod.bootSince > (this.opts.pullTimeoutMs ?? PULL_TIMEOUT_MS)) {
          return this.replaceStuck(pod, 'The rented machine did not start ComfyUI’s container')
        }
        // RunPod tells nothing about the download: the minutes show it is still going.
        const minutes = Math.floor((now - pod.bootSince) / 60_000)
        const waited = minutes >= 2 ? ` — ${minutes} min` : ''
        return this.set('booting', uptime === null ? `Setting up the machine (downloading ComfyUI, ${COMFY_IMAGE_GB} GB)${waited}…` : 'Starting ComfyUI…')
      }
      if (now - pod.containerAt > (this.opts.comfyTimeoutMs ?? 8 * 60_000)) {
        const why = err instanceof Error ? err.message : String(err)
        return this.replaceStuck(pod, `ComfyUI did not answer on the rented machine (${why})`)
      }
      return this.set('booting', loading ? 'Loading ComfyUI…' : 'Starting ComfyUI…')
    }
    if (!live()) return
    pod.readyAt = now
    console.info(`[runpod] pod ${pod.id}: ComfyUI ready ${Math.round((now - pod.startedAt) / 1000)} s after renting`)
    this.swaps = 0
    this.resetActivity()
    this.idleSince = this.deps.pendingJobs() > 0 ? undefined : now
    this.set('ready', undefined)
    this.deps.onReady?.()
  }

  /**
   * A pod that is not getting anywhere (some RunPod machines hang while pulling the image or starting the container):
   * hand it back and rent another machine once; a second stuck pod stops renting until the user starts the GPU again,
   * so a bad data center never bills pod after pod.
   */
  private async replaceStuck(pod: ActivePod, what: string) {
    // Called while the pod is still the session's (checked before any await): it is ended before the delete is awaited,
    // so a Stop meanwhile can't be answered with a replacement, and a failed delete is retried rather than forgotten.
    if (this.pod !== pod || this.stateName !== 'booting') return
    const retired = this.retire(pod.id)
    const retry = this.swaps < MAX_SWAPS
    console.warn(`[runpod] pod ${pod.id}: ${what} after ${Math.round((this.now() - pod.bootSince) / 60_000)} min — ${retry ? 'renting another machine' : 'giving up'}`)
    this.end(`Stopped: ${what}`)
    if (retry) {
      this.swaps++
      this.tried.clear()
      this.set('creating', `${what} — renting another machine…`)
      void this.create()
    } else {
      this.failWith(`${what}, twice in a row — RunPod machines are not starting right now. Try again later: Start GPU, or render again in a few minutes.`, true)
    }
    await retired
  }

  private async checkReady() {
    const pod = this.pod
    if (!pod) return this.set('off', undefined)
    const live = () => this.pod === pod && this.stateName === 'ready'
    const now = this.now()
    const comfy = this.comfyFor(pod.id)
    // Without the RunPod key the app cannot stop the pod: stop vouching for it, so the pod's own watchdog ends it.
    if (now - this.lastHeartbeat >= (this.opts.heartbeatMs ?? 60_000) && this.deps.secrets.get('runpod', 'apiKey')) {
      this.lastHeartbeat = now
      try {
        // Caddy on the pod answers the heartbeat itself, so it proves the pod is up, not that ComfyUI is: only the
        // queue check below may clear the lost/not-serving timers. Clearing them here kept a pod whose ComfyUI had
        // died (a 4K + camera-guide render, 2026-10-26) "ready" and billing for half an hour.
        await comfy.heartbeat()
      } catch (err) {
        this.unreachable(err, now)
      }
    }
    if (now - this.lastQueueCheck >= (this.opts.queueCheckMs ?? 15_000)) {
      this.lastQueueCheck = now
      try {
        const q = await comfy.queue()
        this.comfyBusy = q.running.length + q.pending.length > 0
        this.reachable()
      } catch (err) {
        this.unreachable(err, now)
      }
    }
    if (!live()) return
    const lostAfter = this.opts.lostAfterMs ?? 3 * 60_000
    if (this.unreachableSince !== undefined && now - this.unreachableSince > lostAfter) {
      const info = await this.api().getPod(pod.id).catch(() => 'unknown' as const)
      if (!live()) return
      if (info !== 'unknown' && (!info || info.status !== 'RUNNING')) {
        // Exited (or restarting) is not gone: it still holds the machine or its disk until deleted.
        const retired = info ? this.retire(pod.id) : undefined
        this.end('The GPU stopped unexpectedly')
        return retired
      }
      if (info !== 'unknown' && this.notServingSince !== undefined && now - this.notServingSince > lostAfter) {
        // Up on RunPod, yet nothing listens where ComfyUI was: it crashed, and the pod would bill on rendering nothing.
        this.crashedPods.add(pod.id)
        const retired = this.retire(pod.id)
        this.end('ComfyUI crashed on the GPU, so the GPU was stopped')
        return retired
      }
      this.unreachableSince = now
    }
    const busy = this.deps.pendingJobs() > 0 || this.comfyBusy
    if (busy) this.idleSince = undefined
    else this.idleSince ??= now
    const stopAt = this.stopAt()
    if (stopAt !== undefined && now >= stopAt) {
      const comfyLast = this.comfyUntil !== undefined && this.comfyUntil === stopAt
      await this.stopNow(
        comfyLast
          ? `Stopped ${idleText(this.comfyHoldSeconds())} after ComfyUI was last used`
          : `Stopped ${idleText(this.deps.settings.get().runpod.idleSeconds)} after the queue ran empty`,
      )
    }
  }

  /**
   * When an idle GPU stops: `idleSeconds` after the queue ran empty, or later while "Keep on" or recent use of ComfyUI
   * holds it.
   */
  private stopAt(): number | undefined {
    if (this.idleSince === undefined) return undefined
    const seconds = this.deps.settings.get().runpod.idleSeconds
    return Math.max(this.idleSince + seconds * 1000, this.keepUntil ?? 0, this.comfyUntil ?? 0)
  }

  /** After a restart: take over this app's pod if it still runs, remove leftovers. */
  private async reconcile() {
    this.lastReconcileAttempt = this.now()
    if (!this.deps.secrets.get('runpod', 'apiKey')) {
      this.reconciledFlag = true
      return
    }
    const toDelete = [...this.deps.state.pendingDeletes]
    let pods
    try {
      pods = await this.api().listPods()
    } catch (err) {
      // Tried again on a later tick: jobs keep waiting meanwhile instead of giving up their pod.
      console.warn('[runpod] could not list pods', err)
      return
    }
    // Pods waiting to be deleted that RunPod no longer lists are gone (or belong to another key): nothing left to delete.
    for (const id of toDelete) if (!pods.some((p) => p.id === id)) this.deps.state.removePendingDelete(id)
    const remembered = this.deps.state.pod
    const mine = pods.filter((p) => isOwnPod(p.name, this.install)?.kind === 'render')
    // One being deleted (handed back, or stopped just before the app quit) is not taken over.
    const alive = mine.filter((p) => ['PROVISIONING', 'STARTING', 'RUNNING'].includes(p.status) && !this.deps.state.pendingDeletes.includes(p.id))
    const keep = alive.find((p) => p.id === remembered?.id) ?? alive[0]
    for (const p of mine) if (p !== keep) await this.retire(p.id)
    if (remembered && remembered.kind === 'render' && remembered.id !== keep?.id) {
      this.logEnded({ id: remembered.id, gpuId: remembered.gpuId, startedAt: Date.parse(remembered.startedAt), costPerHr: remembered.costPerHrUsd }, this.now())
      this.deps.state.setPod(undefined)
    }
    if (keep && !this.pod) {
      const gpuId = keep.gpu?.id ?? remembered?.gpuId ?? ''
      const startedAt = Date.parse(keep.createdAt ?? '') || (remembered ? Date.parse(remembered.startedAt) : this.now())
      this.pod = { id: keep.id, gpuId, startedAt, bootSince: this.now(), adopted: true, costPerHr: keep.cost || ltxGpu(gpuId)?.priceUsdHr || 0 }
      this.deps.state.setPod({ id: keep.id, kind: 'render', gpuId, startedAt: new Date(startedAt).toISOString(), costPerHrUsd: this.pod.costPerHr })
      this.resetActivity()
      this.set('booting', 'Reconnecting to the GPU…')
    }
    this.reconciledFlag = true
    this.publish()
  }

  // ---------------------------------------------------------------- helpers

  /** Terminates a pod the session is done with; a failed delete is tried again every tick (see retirePod). */
  private reachable() {
    this.unreachableSince = undefined
    this.notServingSince = undefined
  }

  /** A failed check: a slow answer may be a busy ComfyUI or the network; "nothing listening" is a ComfyUI that is gone. */
  private unreachable(err: unknown, now: number) {
    this.unreachableSince ??= now
    if (err instanceof ComfyError && err.kind === 'starting') this.notServingSince ??= now
    else this.notServingSince = undefined
  }

  private async retire(podId: string) {
    if (await retirePod(this.deps.state, () => this.api(), podId)) return
    // Tried again in DELETE_RETRY_MS, not on this same tick.
    this.lastDeleteRetry = this.now()
    if (!this.deleteFailing) {
      this.deleteFailing = true
      this.publish()
    }
  }

  /** Pods handed back whose delete failed (an API blip, the app quit first): tried until RunPod confirms each. */
  private async retryDeletes() {
    this.lastDeleteRetry = this.now()
    if (!this.deps.secrets.get('runpod', 'apiKey')) return
    let failing = false
    // The session's own pod is being stopped: its stop retries the delete (and ends the session when it goes through).
    for (const id of this.deps.state.pendingDeletes) if (id !== this.pod?.id && !(await retirePod(this.deps.state, () => this.api(), id))) failing = true
    this.deleteFailing = failing
  }

  private end(reason: string) {
    if (this.pod) this.logEnded(this.pod, this.now())
    this.pod = undefined
    this.deps.state.setPod(undefined)
    this.resetActivity()
    this.keepUntil = undefined
    this.comfyUntil = undefined
    this.idleSince = undefined
    this.set('off', reason)
  }

  private logEnded(pod: Pick<ActivePod, 'id' | 'gpuId' | 'startedAt' | 'costPerHr'>, endedAt: number) {
    this.deps.state.logSession({
      podId: pod.id,
      gpuName: ltxGpu(pod.gpuId)?.name ?? pod.gpuId,
      startedAt: new Date(pod.startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      costPerHrUsd: pod.costPerHr,
      costUsd: round2(((endedAt - pod.startedAt) / 3_600_000) * pod.costPerHr),
    })
  }

  private resetActivity() {
    this.comfyBusy = false
    this.lastHeartbeat = 0
    this.lastQueueCheck = 0
    this.unreachableSince = undefined
    this.notServingSince = undefined
  }

  private failFrom(err: unknown) {
    if (err instanceof RunpodError) {
      if (err.kind === 'auth') return this.failWith('RunPod rejected the API key — check it in Settings → Providers', true)
      if (err.kind === 'balance') return this.failWith('Not enough RunPod credit: renting a GPU needs at least an hour of credit', true)
      if (err.kind === 'not_found') return this.failWith('The model volume no longer exists on RunPod — choose another in Settings', true)
      if (err.kind === 'invalid') return this.failWith(err.message, true)
      return this.failWith(`${err.message} — retrying in a minute`, false)
    }
    return this.failWith(err instanceof Error ? err.message : String(err), false)
  }

  private failWith(message: string, fatal: boolean) {
    this.fatal = fatal
    this.missingSetup = false
    this.needsUser = false
    this.errorAt = this.now()
    this.choices = undefined
    this.set('error', message)
  }

  private set(state: GpuSessionState, detail: string | undefined) {
    // Rented, or the session ended: the wait for the first-choice GPU is over.
    if (state === 'booting' || state === 'off') this.holdOut = undefined
    this.stateName = state
    this.detail = detail
    this.publish()
  }

  private publish() {
    const dto = this.dto()
    // The running cost changes every second: the client computes it; publish only real changes.
    const key = JSON.stringify({ ...dto, costUsd: undefined })
    if (key === this.lastPublished) return
    this.lastPublished = key
    this.deps.events.publish({ type: 'gpu.session', session: dto })
  }

  private async volumeInfo(api: RunpodApi, volumeId: string) {
    if (this.volume?.id === volumeId) return this.volume
    const v = await api.getVolume(volumeId)
    this.volume = { id: v.id, name: v.name, dataCenter: v.dataCenter }
    return this.volume
  }

  private api(): RunpodApi {
    const apiKey = this.deps.secrets.get('runpod', 'apiKey')
    if (!apiKey) throw new RunpodError('auth', 'Add your RunPod API key in Settings → Providers')
    return this.opts.api ? this.opts.api(apiKey) : new RunpodApi({ apiKey })
  }

  private comfyFor(podId: string): ComfyClient {
    const url = podUrl(podId)
    return this.opts.comfy ? this.opts.comfy(url, this.token()) : new ComfyClient({ baseUrl: url, token: this.token() })
  }

  /** The access token pods accept (made once, kept in the Keychain). */
  token(): string {
    let token = this.deps.secrets.get('comfyui', 'apiKey')
    if (!token) {
      token = randomBytes(32).toString('hex')
      this.deps.secrets.set('comfyui', 'apiKey', token)
    }
    return token
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100
