import { type GpuAvailability, LTX_GPUS, type VolumeSetupDTO } from '../../../shared/types/runpod'
import type { EventBus } from '../../services/events'
import type { SecretStore } from '../../services/keychain'
import type { SettingsService } from '../../services/settings'
import { RunpodApi, RunpodError, type RunpodPod } from './api'
import { MIN_CUDA, SETUP_VERSION, type SetupMachine, installTag, isOwnPod, podBundle, podUrl, setupPodBody } from './pod'
import { type RunpodState, retirePod } from './state'

export interface VolumeSetupDeps {
  events: EventBus
  settings: SettingsService
  secrets: SecretStore
  state: RunpodState
  machineId: string
}

export interface VolumeSetupOptions {
  api?: (apiKey: string) => RunpodApi
  fetchImpl?: typeof fetch
  now?: () => number
  pollMs?: number
  bundle?: () => string
}

const MAX_LINES = 14
/** vCPUs of a CPU setup pod (a power of two; ~10 GB RAM on most flavors). */
const SETUP_VCPUS = 4
const MAX_SETUP_MS = 3 * 60 * 60_000
/** How setup-volume.sh tags its progress lines ("[wildroom] step 2/7 …"). */
const PROGRESS_TAG = '[wildroom] '
const LIVE: GpuAvailability[] = ['HIGH', 'MEDIUM', 'LOW']

/**
 * Prepares the chosen network volume: rents the cheapest GPU available in its data center, runs
 * scripts/runpod/setup-volume.sh on it (ComfyUI, pinned nodes, ~113 GB of models, the token gate) and follows its
 * progress file until it is done, then terminates the pod. Run again to update a volume.
 */
export class VolumeSetup {
  private data: VolumeSetupDTO = { state: 'idle', lines: [] }
  /** The current setup runs on a CPU pod. */
  private onCpu = false
  /** A CPU pod could not install ComfyUI (step 1): the next attempt rents a GPU. */
  private cpuFailedEarly = false
  private startedAtMs = 0
  private timer: NodeJS.Timeout | undefined
  private polling = false
  private lastPodCheck = 0
  private readonly install: string
  private readonly now: () => number

  constructor(
    private readonly deps: VolumeSetupDeps,
    private readonly opts: VolumeSetupOptions = {},
  ) {
    this.install = installTag(deps.machineId)
    this.now = opts.now ?? Date.now
  }

  dto(): VolumeSetupDTO {
    return { ...this.data, lines: [...this.data.lines] }
  }

  /** Takes over a setup pod left running by a previous app run. */
  async reconcile() {
    if (!this.deps.secrets.get('runpod', 'apiKey')) return
    try {
      const pods = (await this.api().listPods()).filter((p) => isOwnPod(p.name, this.install)?.kind === 'setup')
      // One being deleted (a canceled or finished setup whose delete failed) is not taken over.
      const running = pods.find((p) => ['PROVISIONING', 'STARTING', 'RUNNING'].includes(p.status) && !this.deps.state.pendingDeletes.includes(p.id))
      for (const p of pods) if (p !== running) await this.retire(p.id)
      if (running && this.data.state === 'idle') {
        this.startedAtMs = Date.parse(running.createdAt ?? '') || this.now()
        this.update({
          state: 'running',
          podId: running.id,
          volumeId: this.deps.settings.get().runpod.volumeId,
          startedAt: new Date(this.startedAtMs).toISOString(),
          costPerHrUsd: running.cost,
          title: 'Reconnecting to the setup…',
          lines: [],
        })
        this.loop()
      }
    } catch (err) {
      console.warn('[runpod] setup reconcile failed', err)
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Starts preparing the chosen volume. The Hugging Face token is saved to the Keychain for next time. */
  async start(hfToken?: string): Promise<VolumeSetupDTO> {
    if (this.data.state === 'creating' || this.data.state === 'running') return this.dto()
    if (hfToken?.trim()) this.deps.secrets.set('hf', 'apiKey', hfToken.trim())
    const token = this.deps.secrets.get('hf', 'apiKey')
    const volumeId = this.deps.settings.get().runpod.volumeId
    if (!token) return this.failed('Add your Hugging Face token: the LTX-2.5 models are gated')
    if (!volumeId) return this.failed('Choose the model volume first')
    this.update({ state: 'creating', volumeId, title: 'Renting a small GPU for the setup…', lines: [], error: undefined, step: undefined, totalSteps: undefined, podId: undefined })
    try {
      const api = this.api()
      const volume = await api.getVolume(volumeId)
      // The setup only installs and downloads: a CPU pod first (cheaper, usually free); the cheapest free GPU after.
      const machines: { machine: SetupMachine; name: string; pricePerHr: number }[] = []
      if (!this.cpuFailedEarly) {
        const cpus = await api.cpuStockIn(volume.dataCenter, SETUP_VCPUS).catch(() => [])
        for (const c of cpus.filter((c) => LIVE.includes(c.availability) && c.vcpuMin <= SETUP_VCPUS && SETUP_VCPUS <= c.vcpuMax && c.ramGbPerVcpu * SETUP_VCPUS >= 8).sort((a, b) => a.pricePerVcpu - b.pricePerVcpu)) {
          machines.push({ machine: { cpuId: c.id, vcpuCount: SETUP_VCPUS }, name: `CPU ${c.name} (${SETUP_VCPUS} vCPU)`, pricePerHr: c.pricePerVcpu * SETUP_VCPUS })
        }
      }
      const stock = await api.stockIn(volume.dataCenter, MIN_CUDA)
      for (const g of [...LTX_GPUS].sort((a, b) => a.priceUsdHr - b.priceUsdHr)) {
        if (LIVE.includes(stock.get(g.id) ?? 'NONE')) machines.push({ machine: { gpuId: g.id }, name: g.name, pricePerHr: g.priceUsdHr })
      }
      const bundle = (this.opts.bundle ?? podBundle)()
      /** Why RunPod turned a machine down when it wasn't just out of stock (shown if none works). */
      let refused: RunpodError | undefined
      for (const m of machines) {
        // Canceled while renting: stop trying, and hand back a pod that arrives after the cancel.
        if (this.dto().state !== 'creating') return this.dto()
        const body = setupPodBody({ install: this.install, machine: m.machine, volumeId, dataCenter: volume.dataCenter, hfToken: token, bundle })
        let pod: RunpodPod | undefined
        try {
          pod = await api.createPod(body)
        } catch (err) {
          if (err instanceof RunpodError && ['rejected', 'forbidden', 'invalid'].includes(err.kind)) {
            if (err.kind !== 'rejected') refused = err
            continue
          }
          if (!(err instanceof RunpodError && (err.kind === 'server' || err.kind === 'network'))) throw err
          // No answer, or no clear one (a 5xx, a body without the pod): RunPod may have made it anyway. Follow it (the
          // name is this attempt's) rather than rent a second machine on the volume. The next machine is tried only when
          // RunPod answered and made none (a request that timed out may still make one later).
          const listed = await api.listPods().catch(() => undefined)
          pod = listed?.find((p) => p.name === body.name)
          if (!pod) {
            if (!listed || err.kind === 'network') throw err
            refused = err
            continue
          }
        }
        if (this.dto().state !== 'creating') {
          await retirePod(this.deps.state, () => api, pod.id)
          return this.dto()
        }
        this.startedAtMs = this.now()
        this.onCpu = 'cpuId' in m.machine
        this.update({
          state: 'running',
          podId: pod.id,
          gpuName: m.name,
          costPerHrUsd: pod.cost || m.pricePerHr,
          startedAt: new Date(this.startedAtMs).toISOString(),
          title: 'Starting the setup pod…',
        })
        this.loop()
        return this.dto()
      }
      if (refused) return this.failed(`${refused.message} — try again in a few minutes`)
      return this.failed(`No machine is free in ${volume.dataCenter} right now — try again in a few minutes`)
    } catch (err) {
      if (err instanceof RunpodError && err.kind === 'balance') return this.failed('Not enough RunPod credit to rent a GPU for the setup')
      return this.failed(err instanceof Error ? err.message : String(err))
    }
  }

  /** Stops the setup (terminates its pod). Run it again later: it continues where it stopped. */
  async cancel(): Promise<VolumeSetupDTO> {
    const podId = this.data.podId
    this.stop()
    if (podId) await this.retire(podId)
    this.update({ state: 'idle', podId: undefined, title: 'Canceled — run it again to continue', error: undefined })
    return this.dto()
  }

  // ---------------------------------------------------------------- following the pod

  private loop() {
    this.stop()
    this.timer = setInterval(() => void this.poll().catch((err) => console.warn('[runpod] setup poll', err)), this.opts.pollMs ?? 5000)
    this.timer.unref?.()
  }

  private async poll() {
    if (this.polling || this.data.state !== 'running' || !this.data.podId) return
    this.polling = true
    const podId = this.data.podId
    try {
      if (this.now() - this.startedAtMs > MAX_SETUP_MS) return await this.finish(podId, 'The setup took more than 3 hours and was stopped')
      const text = await this.fetchStatus(podId)
      if (text !== undefined) {
        const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(PROGRESS_TAG)).map((l) => l.slice(PROGRESS_TAG.length))
        const last = [...lines].reverse()
        const step = last.map((l) => /^step (\d+)\/(\d+) (.+)$/.exec(l)).find(Boolean)
        this.update({
          lines: lines.slice(-MAX_LINES),
          ...(step ? { step: Number(step[1]), totalSteps: Number(step[2]), title: step[3] } : {}),
        })
        const error = last.find((l) => l.startsWith('error '))
        if (lines.at(-1) === 'done') {
          this.deps.state.markPrepared(this.data.volumeId ?? '', SETUP_VERSION)
          this.deps.events.publish({ type: 'settings.changed' })
          return await this.finish(podId)
        }
        if (error) {
          if (this.onCpu && (this.data.step ?? 1) <= 1) {
            this.cpuFailedEarly = true
            return await this.finish(podId, `${error.slice(6)} — on a CPU machine; run it again to use a GPU`)
          }
          return await this.finish(podId, error.slice(6))
        }
      }
      // The pod itself: still there?
      if (this.now() - this.lastPodCheck > 30_000) {
        this.lastPodCheck = this.now()
        const pod = await this.call((api) => api.getPod(podId)).catch(() => 'unknown' as const)
        if (pod !== 'unknown' && (!pod || ['EXITED', 'TERMINATED', 'ERROR'].includes(pod.status))) {
          return await this.finish(podId, 'The setup pod stopped before finishing — run it again to continue')
        }
      }
    } finally {
      this.polling = false
    }
  }

  private async fetchStatus(podId: string): Promise<string | undefined> {
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(`${podUrl(podId)}/status.txt`, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return undefined
      return await res.text()
    } catch {
      return undefined
    }
  }

  private async finish(podId: string, error?: string) {
    this.stop()
    await this.retire(podId)
    if (error) this.update({ state: 'failed', error, podId: undefined })
    else this.update({ state: 'done', title: 'The volume is ready', podId: undefined, error: undefined })
  }

  private failed(error: string): VolumeSetupDTO {
    this.update({ state: 'failed', error })
    return this.dto()
  }

  private update(patch: Partial<VolumeSetupDTO>) {
    this.data = { ...this.data, ...patch }
    this.deps.events.publish({ type: 'gpu.setup', setup: this.dto() })
  }

  /** Terminates a setup pod; a failed delete is not forgotten: the GPU session's tick tries again (see retirePod). */
  private retire(podId: string): Promise<boolean> {
    return retirePod(this.deps.state, () => this.api(), podId)
  }

  /** A RunPod call whose failures all reject — also a missing key, which `api()` throws synchronously. */
  private async call<T>(fn: (api: RunpodApi) => Promise<T>): Promise<T> {
    return fn(this.api())
  }

  private api(): RunpodApi {
    const apiKey = this.deps.secrets.get('runpod', 'apiKey')
    if (!apiKey) throw new RunpodError('auth', 'Add your RunPod API key in Settings → Providers')
    return this.opts.api ? this.opts.api(apiKey) : new RunpodApi({ apiKey })
  }
}
