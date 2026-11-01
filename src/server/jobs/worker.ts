import { mkdirSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { nanoid } from 'nanoid'
import { assetParamKeys, parseParams } from '../../shared/models/params'
import { getModel } from '../../shared/models/registry'
import type { ModelSpec, ParamValues } from '../../shared/models/types'
import { flicksToSeconds } from '../../shared/time/flicks'
import type { CreateGenerationRequest } from '../../shared/types/api'
import { type GenerationDTO, type GenerationDetails, type JobError, type JobStatus, type ProviderId, isOwnLane } from '../../shared/types/jobs'
import type { Env } from '../env'
import { ApiError, badRequest, notFound, nowIso } from '../http'
import type { AdapterMap } from '../providers'
import { saveBody, summarizePayload } from '../providers/http'
import { type JobContext, type ProviderAdapter, ProviderError, type ProviderOutput, type SubmitGate, jobError } from '../providers/types'
import type { EventBus } from '../services/events'
import { type SecretStore, readCredentials } from '../services/keychain'
import type { MediaStore } from '../services/mediaStore'
import { runFfmpeg } from '../services/ffmpeg'
import { compactStill } from '../services/compactStill'
import type { SettingsService } from '../services/settings'
import type { ProjectStore } from '../storage/projectStore'
import type { GenerationRow } from '../storage/records'
import type { ProjectRegistry } from '../storage/registry'

export interface WorkerDeps {
  env: Env
  registry: ProjectRegistry
  events: EventBus
  media: MediaStore
  adapters: AdapterMap
  secrets: SecretStore
  settings: SettingsService
}

const ACTIVE_STATUSES: JobStatus[] = ['submitting', 'running', 'downloading', 'ingesting']
const TICK_MS = 400
const MAX_RUNNING_MS = 45 * 60_000
const MAX_POLL_FAILURE_MS = 20 * 60_000
const MAX_VARIANTS = 8
/** Finished jobs remembered for the shared queue panel after their project closes (this app run only). */
const RECENT_MAX = 100
/**
 * Jobs that cost nothing to send again (ProviderAdapter.billing) are resubmitted after a dropped connection or a lost
 * render — up to this many submits, so a render that keeps crashing a rented GPU can't keep it busy (and billing).
 */
const MAX_RESUBMITS = 5
/**
 * Saving a finished job's outputs failed this many times in a row: it needs the user. Each try downloads the results
 * again and keeps a rented GPU from idling out, and a full disk or a 404ing output URL fails the same way every time.
 */
const MAX_COMPLETE_FAILURES = 3
/** File errors that fail the same way on every try. */
const HOPELESS_FILE_ERRORS = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EDQUOT'])

type Patch = Partial<Omit<GenerationRow, 'id' | 'createdAt' | 'projectId'>>

const UNFINISHED_STATUSES: JobStatus[] = ['queued', ...ACTIVE_STATUSES]
/** Changes that must be on disk before the next side effect (a crash must never lose them). */
const DURABLE_FIELDS = new Set<string>([
  'status',
  'providerTaskId',
  'providerMetaJson',
  'attempts',
  'startedAt',
  'finishedAt',
  'errorJson',
  'outputAssetIdsJson',
  'costUsd',
  'queueOrder',
  'responseJson',
])

/** Machine-local fields that are never written to the bundle. */
const MEMORY_FIELDS = new Set<string>(['nextPollAt', 'statusDetail'])

function durabilityOf(patch: Patch): 'now' | 'soon' | 'memory' {
  const keys = Object.keys(patch)
  if (keys.some((k) => DURABLE_FIELDS.has(k))) return 'now'
  if (keys.every((k) => MEMORY_FIELDS.has(k))) return 'memory'
  return 'soon'
}

/**
 * Generation job engine. Jobs live in their project bundles (`Generations/<id>.json`); the engine runs one shared
 * queue over every open project. Every state change is persisted before the next side effect, so a crash or
 * restart never silently re-submits a paid request: unknown outcomes become `needs_attention`.
 */
export class JobWorker {
  private timer: NodeJS.Timeout | undefined
  private readonly inFlight = new Set<string>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly pollFailureSince = new Map<string, number>()
  /** Consecutive failures to save a job's outputs (see MAX_COMPLETE_FAILURES). */
  private readonly completeFailures = new Map<string, number>()
  /** Jobs that finished during this run, newest last — every project's, also after it closed. */
  private readonly finished = new Map<string, GenerationDTO>()
  private stopped = false

  constructor(private readonly deps: WorkerDeps) {
    // Jobs left unfinished by a previous run (or another machine) are settled as their project is opened.
    deps.registry.onMount((store) => this.resumeProject(store))
    deps.registry.addBusyCheck((projectId) => this.hasUnfinished(projectId))
  }

  start() {
    this.stopped = false
    this.timer = setInterval(() => {
      // A throw here would be an uncaught exception from a timer: the server process would die with every job.
      try {
        this.tick()
      } catch (err) {
        console.error('[worker] tick failed', err)
      }
    }, TICK_MS)
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    for (const controller of this.controllers.values()) controller.abort()
  }

  // ---------------------------------------------------------------- public API

  create(req: CreateGenerationRequest): GenerationDTO[] {
    const { settings, adapters, secrets, media, registry } = this.deps
    const store = registry.require(req.projectId)
    const model = getModel(req.modelId)
    if (!model) throw badRequest(`Unknown model ${req.modelId}`)
    if (model.demoOnly && !settings.get().demoMode) throw badRequest('Demo models are disabled (Settings → Demo mode)')
    const adapter = adapters[model.provider]
    if (!adapter) throw badRequest(`Provider ${model.provider} is not available`)
    const creds = readCredentials(secrets, model.provider, adapter.credentialFields)
    const missing = adapter.requiredFields.filter((f) => !creds[f])
    if (missing.length) throw badRequest(`${adapter.label} is not configured — add your key in Settings → Providers`)
    const local = adapter.status?.()
    if (local && !local.configured) throw badRequest(local.detail ?? `${adapter.label} is not ready`)
    const installed = local?.models?.[model.id]
    if (installed && !installed.ready) throw badRequest(installed.detail)

    const parsed = parseParams(model, req.params ?? {})
    if (!parsed.ok) throw badRequest(parsed.message, parsed.errors)
    for (const key of assetParamKeys(model)) {
      const value = parsed.values[key]
      const ids = value == null || value === '' ? [] : Array.isArray(value) ? value : [value]
      for (const id of ids) {
        const asset = media.get(String(id))
        if (!asset || asset.deletedAt) throw badRequest(`Input asset for "${key}" not found`)
        if (asset.projectId !== store.id) {
          throw badRequest(`Input asset "${asset.name}" belongs to another project — import it into this project first`)
        }
        if (asset.status !== 'ready') throw badRequest(`Input asset "${asset.name}" is still processing`)
      }
    }

    const variants = Math.max(1, Math.min(MAX_VARIANTS, Math.round(req.variants ?? 1)))
    const estimate = model.estimateCost(parsed.values)
    const batchId = variants > 1 ? nanoid(10) : null
    const label = typeof req.label === 'string' && req.label.trim() ? clampLabel(req.label, LABEL_MAX) : labelFor(parsed.values, model)
    // A project whose folder is gone (or another machine took over) can't keep the job: say so instead of a 201 for
    // a job that is never saved or run.
    store.ensureWritable()
    const created: GenerationDTO[] = []
    for (let variant = 0; variant < variants; variant++) {
      const params = { ...parsed.values }
      if (typeof params.seed === 'number' && variant > 0) params.seed = params.seed + variant
      const now = nowIso()
      const row: GenerationRow = {
        id: nanoid(12),
        projectId: store.id,
        modelId: model.id,
        provider: model.provider,
        kind: model.kind,
        status: 'queued',
        progress: null,
        label,
        paramsJson: JSON.stringify(params),
        providerTaskId: null,
        providerMetaJson: '{}',
        requestJson: null,
        responseJson: null,
        adapterVersion: adapter.version,
        errorJson: null,
        costEstimateUsd: estimate.usd,
        costUsd: null,
        outputAssetIdsJson: '[]',
        variant,
        batchId,
        queueOrder: Date.now() + variant,
        attempts: 0,
        ...store.machine,
        nextPollAt: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
      }
      if (!store.putGeneration(row, 'now')) {
        store.generations.delete(row.id)
        if (created.length) this.markActiveJobs(store.id, true)
        store.ensureWritable()
        throw new ApiError(500, 'Could not save the job into the project folder')
      }
      registry.indexGeneration(store, row.id)
      const dto = this.dto(row)
      created.push(dto)
      this.deps.events.publish({ type: 'generation.upserted', generation: dto })
    }
    if (created.length) this.markActiveJobs(store.id, true)
    return created
  }

  list(projectId: string, opts: { activeOnly?: boolean; limit?: number } = {}): GenerationDTO[] {
    const store = this.deps.registry.mounted(projectId)
    if (!store) return []
    return [...store.generations.values()]
      .filter((row) => !opts.activeOnly || UNFINISHED_STATUSES.includes(row.status as JobStatus))
      .sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, opts.limit ?? 300)
      .map((row) => this.dto(row))
  }

  /** Queued and running jobs of every open project, in queue order: the worker runs one shared queue. */
  activeAll(): GenerationDTO[] {
    return this.rows((row) => UNFINISHED_STATUSES.includes(row.status as JobStatus))
      .sort(byQueueOrder)
      .map((row) => this.dto(row))
  }

  /**
   * Jobs that finished lately in any project, newest first: those of this app run (kept after their project closes)
   * and the open projects' jobs that need attention.
   */
  recent(limit = 60): GenerationDTO[] {
    const out = new Map<string, GenerationDTO>()
    for (const job of this.finished.values()) {
      const row = this.row(job.id)
      out.set(job.id, row ? this.dto(row) : job)
    }
    for (const row of this.rows((r) => r.status === 'needs_attention')) out.set(row.id, this.dto(row))
    return [...out.values()]
      .filter((job) => !UNFINISHED_STATUSES.includes(job.status))
      .sort((a, b) => ((a.finishedAt ?? a.updatedAt) < (b.finishedAt ?? b.updatedAt) ? 1 : -1))
      .slice(0, limit)
  }

  /** The project has jobs that are queued or running (it stays open until they finish). */
  hasUnfinished(projectId: string): boolean {
    const store = this.deps.registry.mounted(projectId)
    if (!store) return false
    for (const row of store.generations.values()) if (UNFINISHED_STATUSES.includes(row.status as JobStatus)) return true
    return false
  }

  get(id: string): GenerationDTO {
    const row = this.row(id)
    if (!row) throw notFound('Generation')
    return this.dto(row)
  }

  /** The record with what the provider was sent and answered: "What was sent" on a generated asset. */
  details(id: string): GenerationDetails {
    const row = this.row(id)
    if (!row) throw notFound('Generation')
    const parsed = (json: string | null) => {
      if (!json) return undefined
      try {
        return JSON.parse(json) as unknown
      } catch {
        return json
      }
    }
    const meta = parsed(row.providerMetaJson)
    return {
      ...this.dto(row),
      request: parsed(row.requestJson),
      response: parsed(row.responseJson),
      ...(row.providerTaskId ? { providerTaskId: row.providerTaskId } : {}),
      ...(meta && typeof meta === 'object' && Object.keys(meta).length ? { providerMeta: meta as Record<string, unknown> } : {}),
    }
  }

  async cancel(id: string): Promise<GenerationDTO> {
    const row = this.row(id)
    if (!row) throw notFound('Generation')
    if (!['queued', ...ACTIVE_STATUSES].includes(row.status as JobStatus)) return this.dto(row)
    const wasSubmitted = row.status !== 'queued'
    this.controllers.get(id)?.abort()
    const adapter = this.deps.adapters[row.provider as ProviderId]
    // Held while the provider is asked: with its last job ended, the project would otherwise close under the request.
    return this.deps.registry.holdDuring(row.projectId, async () => {
      // Canceled before the provider is asked: a poll that lands while it answers must not complete (or fail) the
      // job, and the answer must not overwrite what such a poll did.
      const dto = this.save(id, {
        status: 'canceled',
        finishedAt: nowIso(),
        errorJson: wasSubmitted && !this.resubmitSafe(row.provider)
          ? JSON.stringify(jobError('canceled', 'Canceled after submission — the provider may still charge for it', { maybeCharged: true }))
          : null,
      })
      if (wasSubmitted && adapter?.cancel && row.providerTaskId) await this.cancelAtProvider(row, adapter)
      return dto
    })
  }

  /** Best effort: withdraws a submitted job at its provider (a rented GPU stays busy, and billing, until it is). */
  private async cancelAtProvider(row: GenerationRow, adapter: ProviderAdapter) {
    const model = getModel(row.modelId)
    if (!model || !adapter.cancel) return
    try {
      await adapter.cancel(this.buildContext(row, model, adapter, new AbortController().signal))
    } catch (err) {
      console.warn(`[worker] cancel ${row.id} at provider failed`, err)
    }
  }

  retry(id: string): GenerationDTO {
    const row = this.row(id)
    if (!row) throw notFound('Generation')
    // The label too: a story shot's render is named after its shot.
    const [dto] = this.create({ projectId: row.projectId, modelId: row.modelId, params: JSON.parse(row.paramsJson), variants: 1, label: row.label })
    return dto!
  }

  /**
   * Moves a queued job in the shared queue (every open project's jobs). The queued jobs keep the same set of order
   * values, reassigned in the new order, so jobs added later still land at the end.
   */
  move(id: string, to: 'top' | 'up' | 'down' | 'bottom'): GenerationDTO[] {
    const row = this.row(id)
    if (!row) throw notFound('Generation')
    if (row.status !== 'queued') throw badRequest('Only queued jobs can be moved')
    const queue = this.rows((r) => r.status === 'queued').sort(byQueueOrder)
    const from = queue.findIndex((r) => r.id === id)
    const target = { top: 0, up: from - 1, down: from + 1, bottom: queue.length - 1 }[to]
    const index = Math.max(0, Math.min(queue.length - 1, target))
    if (index === from) return []
    const values = queue.map((r) => r.queueOrder ?? Date.parse(r.createdAt)).sort((a, b) => a - b)
    for (let i = 1; i < values.length; i++) if (values[i]! <= values[i - 1]!) values[i] = values[i - 1]! + 0.001
    const reordered = [...queue]
    reordered.splice(index, 0, ...reordered.splice(from, 1))
    const changed: GenerationDTO[] = []
    reordered.forEach((r, i) => {
      if (r.queueOrder !== values[i]) changed.push(this.save(r.id, { queueOrder: values[i]! }))
    })
    return changed
  }

  /** How many of a provider's jobs are queued or running, in every open project. */
  countUnfinished(provider: ProviderId): number {
    return this.rows((row) => row.provider === provider && UNFINISHED_STATUSES.includes(row.status as JobStatus)).length
  }

  /** Makes a provider's waiting jobs due now (e.g. the GPU it was waiting for is ready). */
  wake(provider: ProviderId) {
    for (const row of this.rows((r) => r.provider === provider && r.status === 'queued' && r.nextPollAt !== null)) {
      this.update(row.id, { nextPollAt: null })
    }
  }

  // ---------------------------------------------------------------- engine

  private tick() {
    if (this.stopped) return
    const { adapters, settings } = this.deps
    const now = Date.now()
    const { queuePaused, cloudOneAtATime } = settings.get()
    const due = (row: GenerationRow) => row.nextPollAt === null || row.nextPollAt <= now
    // Paused: nothing new starts, but running jobs below are still polled to completion.
    const queued = queuePaused ? [] : this.rows((row) => row.status === 'queued' && due(row)).sort(byQueueOrder)
    for (const job of queued) {
      if (this.inFlight.has(job.id)) continue
      const adapter = adapters[job.provider as ProviderId]
      if (!adapter) {
        this.fail(job.id, jobError('internal', `Unknown provider ${job.provider}`))
        continue
      }
      const limit = settings.concurrencyFor(job.provider as ProviderId, adapter.defaultConcurrency)
      if (this.activeCount(job.provider) >= limit) continue
      // Own-hardware lanes (this Mac, a rented GPU) set their own pace; this makes the cloud lane go one at a time, in queue order.
      if (cloudOneAtATime && !isOwnLane(job.provider) && this.activeCloudCount() >= 1) continue
      const gate = adapter.beforeSubmit?.()
      if (gate && !gate.ready) {
        this.hold(job, gate)
        continue
      }
      this.runExclusive(job.id, () => this.submit(job, adapter))
    }
    for (const job of this.rows((row) => row.status === 'running' && due(row))) {
      if (this.inFlight.has(job.id)) continue
      const adapter = adapters[job.provider as ProviderId]
      if (adapter) this.runExclusive(job.id, () => this.poll(job, adapter))
    }
  }

  private runExclusive(id: string, fn: () => Promise<unknown>) {
    this.inFlight.add(id)
    fn()
      .catch((err) => {
        console.error(`[worker] job ${id} crashed`, err)
        try {
          this.fail(id, jobError('internal', err instanceof Error ? err.message : String(err), { maybeCharged: true }))
        } catch (failErr) {
          // Thrown from here it would be an unhandled rejection.
          console.error(`[worker] could not mark job ${id} failed`, failErr)
        }
      })
      .finally(() => {
        this.inFlight.delete(id)
        this.controllers.delete(id)
      })
  }

  private activeCount(provider: string): number {
    return this.rows((row) => row.provider === provider && ACTIVE_STATUSES.includes(row.status as JobStatus)).length
  }

  private activeCloudCount(): number {
    return this.rows((row) => !isOwnLane(row.provider) && ACTIVE_STATUSES.includes(row.status as JobStatus)).length
  }

  /** A queued job its provider can't take yet: check again later, telling the user why (only when that changes). */
  private hold(job: GenerationRow, gate: Exclude<SubmitGate, { ready: true }>) {
    if ('error' in gate) return this.fail(job.id, gate.error)
    const patch: Patch = { nextPollAt: Date.now() + gate.retryInMs, statusDetail: gate.detail }
    if (gate.detail !== (job.statusDetail ?? null)) this.save(job.id, patch)
    else this.update(job.id, patch)
  }

  /** Jobs of every open project that can still be written (a vanished bundle's jobs are left alone). */
  private rows(filter: (row: GenerationRow) => boolean): GenerationRow[] {
    const out: GenerationRow[] = []
    for (const store of this.deps.registry.all) {
      if (store.suspended) continue
      for (const row of store.generations.values()) if (filter(row)) out.push(row)
    }
    return out
  }

  /**
   * As a project is opened: settle jobs a previous run left unfinished — re-poll what can be re-polled, never
   * blindly re-submit. Unfinished jobs another machine queued are not run here (that machine may still be running
   * them, or would charge twice): they need the user's decision. Each job records its machine; for older records
   * without one, whoever saved project.json last stands in.
   */
  private resumeProject(store: ProjectStore) {
    const { machineId } = store.machine
    for (const row of store.generations.values()) {
      if (!UNFINISHED_STATUSES.includes(row.status as JobStatus)) continue
      const fromElsewhere = row.machineId ? row.machineId !== machineId : store.lastSavedElsewhere
      if (fromElsewhere) {
        const host = (row.machineId ? row.host : store.previousSavedBy?.host) ?? 'another computer'
        this.save(row.id, {
          status: 'needs_attention',
          finishedAt: nowIso(),
          nextPollAt: null,
          errorJson: JSON.stringify(
            jobError(
              'other_machine',
              row.status === 'queued'
                ? `Queued on ${host}. Retry to run it on this computer.`
                : `Started on ${host} — its result is saved there. Retry to run it again here.`,
              { maybeCharged: row.status !== 'queued', retryable: true },
            ),
          ),
        })
        continue
      }
      if (row.status === 'queued') continue
      const adapter = this.deps.adapters[row.provider as ProviderId]
      const canRepoll = Boolean(row.providerTaskId && adapter?.poll)
      if (adapter?.billing === 'free') {
        // Free jobs ran in this process (a local render dies with it): run them again, keeping their queue position.
        this.requeue(row.id)
      } else if (canRepoll && row.status !== 'submitting') {
        this.save(row.id, { status: 'running', nextPollAt: Date.now() })
      } else if (adapter?.billing === 'machine-time') {
        // Billed by machine time, not per request: running it again is cheaper than asking the user.
        this.requeue(row.id)
      } else if (row.status === 'submitting') {
        this.save(row.id, {
          status: 'needs_attention',
          errorJson: JSON.stringify(
            jobError('unknown_outcome', 'The app restarted while submitting. The provider may have received this request — check its dashboard before retrying.', { maybeCharged: true }),
          ),
        })
      } else {
        this.save(row.id, {
          status: 'needs_attention',
          errorJson: JSON.stringify(
            jobError('unknown_outcome', 'The app restarted before the result was saved. Retry if it is missing.', { maybeCharged: true }),
          ),
        })
      }
    }
  }

  /** Back to the queue as if never submitted, keeping its position. */
  private requeue(id: string, detail?: string) {
    this.completeFailures.delete(id)
    this.save(id, {
      status: 'queued',
      providerTaskId: null,
      providerMetaJson: '{}',
      progress: null,
      startedAt: null,
      nextPollAt: null,
      statusDetail: detail ?? null,
    })
  }

  private async submit(job: GenerationRow, adapter: ProviderAdapter) {
    const model = getModel(job.modelId)
    if (!model) return this.fail(job.id, jobError('internal', `Model ${job.modelId} no longer exists`))
    // Persist "submitting" BEFORE the request leaves, so a crash can be detected on restart.
    const durable = this.update(job.id, { status: 'submitting', attempts: job.attempts + 1, startedAt: job.startedAt ?? nowIso(), progress: null, statusDetail: null })
    if (!durable) {
      // The project folder can't be written (moved, deleted): don't submit something we couldn't track.
      this.update(job.id, { status: 'queued', nextPollAt: Date.now() + 60_000 })
      return
    }
    this.save(job.id, {})
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    let ctx: JobContext
    try {
      ctx = this.buildContext(job, model, adapter, controller.signal)
    } catch (err) {
      return this.fail(job.id, jobError('invalid_params', err instanceof Error ? err.message : String(err)))
    }
    let result: Awaited<ReturnType<ProviderAdapter['submit']>>
    try {
      result = await adapter.submit(ctx)
    } catch (err) {
      if (controller.signal.aborted) return
      if (err instanceof ProviderError) {
        // Rate limits wait; so do passing network errors where submitting again costs nothing extra (a few times).
        const transient =
          err.jobError.code === 'network' && err.jobError.retryable && this.resubmitSafe(job.provider) && job.attempts + 1 < MAX_RESUBMITS
        if (err.jobError.code === 'rate_limited' || transient) {
          this.save(job.id, { status: 'queued', nextPollAt: Date.now() + 15_000 * Math.min(8, job.attempts + 1) })
          return
        }
        return this.fail(job.id, err.jobError)
      }
      const message = err instanceof Error ? err.message : String(err)
      if (this.resubmitSafe(job.provider)) return this.fail(job.id, jobError('internal', message, { retryable: true }))
      return this.save(job.id, {
        status: 'needs_attention',
        finishedAt: nowIso(),
        errorJson: JSON.stringify(
          jobError('unknown_outcome', `Submission outcome unknown (${message}). Check the provider before retrying.`, { maybeCharged: true, retryable: true }),
        ),
      })
    }
    if (controller.signal.aborted) {
      // Canceled while it was being submitted: withdraw it at the provider instead of bringing the job back.
      if (result.type === 'async') {
        await adapter.cancel?.({ ...ctx, providerTaskId: result.taskId, providerMeta: { ...ctx.providerMeta, ...(result.meta ?? {}) } }).catch(() => {})
      }
      return
    }
    if (result.type === 'async') {
      this.save(job.id, {
        status: 'running',
        providerTaskId: result.taskId,
        providerMetaJson: JSON.stringify({ ...JSON.parse(job.providerMetaJson), ...(result.meta ?? {}) }),
        nextPollAt: Date.now() + adapter.pollIntervalMs,
      })
      return
    }
    await this.complete(job.id, model, adapter, result.outputs, result.costUsd, result.response, controller.signal)
  }

  private async poll(job: GenerationRow, adapter: ProviderAdapter) {
    const model = getModel(job.modelId)
    if (!model || !adapter.poll) return this.fail(job.id, jobError('internal', 'Provider cannot be polled'))
    const startedAt = job.startedAt ? Date.parse(job.startedAt) : Date.now()
    const maxRunMs = adapter.maxRunMs ?? MAX_RUNNING_MS
    if (Date.now() - startedAt > maxRunMs) {
      // Withdrawn at the provider first: a hung render keeps a rented GPU busy (and billing) until it is.
      await this.cancelAtProvider(job, adapter)
      if (this.row(job.id)?.status !== 'running') return // canceled meanwhile
      return this.save(job.id, {
        status: 'needs_attention',
        finishedAt: nowIso(),
        errorJson: JSON.stringify(jobError('timeout', `The provider has not finished after ${Math.round(maxRunMs / 60_000)} minutes.`, { maybeCharged: true, retryable: true })),
      })
    }
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    const ctx = this.buildContext(job, model, adapter, controller.signal)
    try {
      const result = await adapter.poll(ctx)
      // Canceled while the poll was in flight: its answer must not revive (or requeue) the job.
      if (controller.signal.aborted) return
      this.pollFailureSince.delete(job.id)
      if (result.type === 'running') {
        const elapsed = Date.now() - startedAt
        const backoff = elapsed > 5 * 60_000 ? 4 : elapsed > 60_000 ? 2 : 1
        const progress = result.progress ?? job.progress
        const detail = result.detail ?? null
        const patch: Patch = { nextPollAt: Date.now() + adapter.pollIntervalMs * backoff }
        if (progress !== job.progress || detail !== (job.statusDetail ?? null)) this.save(job.id, { ...patch, progress, statusDetail: detail })
        else this.update(job.id, patch)
        return
      }
      if (result.type === 'requeue') {
        // Every requeue renders it again from the start: stop after a few, so a render that keeps failing the machine ends.
        if (job.attempts >= MAX_RESUBMITS) {
          return this.fail(job.id, jobError('provider', `Gave up after ${job.attempts} tries — the machine kept losing this render`, { retryable: true }))
        }
        return this.requeue(job.id, result.detail)
      }
      if (result.type === 'failed') return this.fail(job.id, result.error)
      await this.complete(job.id, model, adapter, result.outputs, result.costUsd, result.response, controller.signal)
    } catch (err) {
      if (controller.signal.aborted) return
      if (err instanceof ProviderError && !err.jobError.retryable) {
        await adapter.release?.(ctx).catch(() => {})
        return this.fail(job.id, err.jobError)
      }
      const since = this.pollFailureSince.get(job.id) ?? Date.now()
      this.pollFailureSince.set(job.id, since)
      if (Date.now() - since > MAX_POLL_FAILURE_MS) {
        await adapter.release?.(ctx).catch(() => {})
        return this.save(job.id, {
          status: 'needs_attention',
          finishedAt: nowIso(),
          errorJson: JSON.stringify(
            jobError('network', `Lost contact with the provider (${err instanceof Error ? err.message : String(err)}).`, { maybeCharged: true, retryable: true }),
          ),
        })
      }
      this.update(job.id, { nextPollAt: Date.now() + 10_000 })
    }
  }

  private async complete(
    id: string,
    model: ModelSpec,
    adapter: ProviderAdapter,
    outputs: ProviderOutput[],
    costUsd: number | undefined,
    response: unknown,
    signal: AbortSignal,
  ) {
    const job = this.row(id)
    if (!job) return
    if (!outputs.length) return this.fail(id, jobError('provider', 'The provider returned no output', { maybeCharged: true }))
    this.save(id, { status: 'downloading', responseJson: response === undefined ? job.responseJson : redact(response) })
    const tmpDir = join(this.deps.env.tmpDir, 'jobs', id)
    mkdirSync(tmpDir, { recursive: true })
    const params = JSON.parse(job.paramsJson) as ParamValues
    // Outputs an earlier try already imported, in order (saved after each one): a retry after a failure on output k,
    // or after a restart while ingesting, must not import outputs 0…k-1 again.
    const assetIds: string[] = []
    for (const earlier of JSON.parse(job.outputAssetIdsJson) as unknown[]) {
      if (assetIds.length >= outputs.length || typeof earlier !== 'string' || !this.deps.media.get(earlier)) break
      assetIds.push(earlier)
    }
    try {
      const files: { path: string; output: ProviderOutput; index: number }[] = []
      for (const [index, output] of outputs.entries()) {
        if (index < assetIds.length) continue
        let path = await materialize(output, tmpDir, index, signal)
        // Some audio models (e.g. video→audio foley) return the source video with the new track muxed in.
        if (model.output === 'audio' && output.meta?.audioInVideoContainer) {
          const audioOnly = join(tmpDir, `output-${index}-audio.m4a`)
          await runFfmpeg(['-hide_banner', '-y', '-i', path, '-vn', '-c:a', 'aac', '-b:a', '256k', audioOnly], { signal })
          path = audioOnly
        }
        // Stills keep as JPEGs that look the same, a sixth of the size; a cut-out (or one asked to be) stays a PNG.
        if (model.output === 'image' && params.transparent !== true && params.background !== 'transparent') path = await compactStill(path, tmpDir, index, signal)
        files.push({ path, output, index })
      }
      this.save(id, { status: 'ingesting' })
      const cost = costUsd ?? job.costEstimateUsd ?? undefined
      for (const { path, output, index } of files) {
        const asset = await this.deps.media.importFile(path, {
          name:
            givenOutputName(model, params, job.variant, index, job.label) ??
            output.name ??
            toolOutputName(model, params, (aid) => this.deps.media.get(aid)?.name) ??
            defaultOutputName(model, params, job.variant, index),
          source: 'generation',
          projectId: job.projectId,
          generationId: id,
          generation: {
            generationId: id,
            modelId: model.id,
            modelLabel: output.modelLabel ?? model.label,
            provider: model.provider,
            prompt: typeof params.prompt === 'string' ? params.prompt : typeof params.text === 'string' ? params.text : undefined,
            params,
            costUsd: cost ?? undefined,
          },
          parentIds: inputAssetIds(model, params),
          role: model.defaultRole,
          meta: output.meta,
          move: output.kind !== 'file' || path.startsWith(tmpDir),
        })
        assetIds.push(asset.id)
        this.update(id, { outputAssetIdsJson: JSON.stringify(assetIds) })
      }
      this.save(id, {
        status: 'succeeded',
        progress: 1,
        costUsd: cost ?? null,
        outputAssetIdsJson: JSON.stringify(assetIds),
        finishedAt: nowIso(),
        errorJson: null,
      })
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    } catch (err) {
      if (signal.aborted) return
      const message = err instanceof Error ? err.message : String(err)
      const failures = (this.completeFailures.get(id) ?? 0) + 1
      const hopeless = HOPELESS_FILE_ERRORS.has((err as NodeJS.ErrnoException).code ?? '') || failures >= MAX_COMPLETE_FAILURES
      if (job.providerTaskId && adapter.poll && !hopeless) {
        // Results can be fetched again: go back to polling.
        this.completeFailures.set(id, failures)
        this.save(id, { status: 'running', nextPollAt: Date.now() + 10_000, errorJson: JSON.stringify(jobError('download', message, { retryable: true })) })
      } else {
        this.save(id, {
          status: 'needs_attention',
          finishedAt: nowIso(),
          errorJson: JSON.stringify(jobError('download', `Could not save the result: ${message}`, { maybeCharged: true, retryable: true })),
        })
      }
    }
  }

  private buildContext(job: GenerationRow, model: ModelSpec, adapter: ProviderAdapter, signal: AbortSignal): JobContext {
    const { media, secrets, env } = this.deps
    const params = JSON.parse(job.paramsJson) as ParamValues
    const inputs: JobContext['inputs'] = {}
    for (const key of assetParamKeys(model)) {
      const value = params[key]
      if (value == null || value === '') continue
      const ids = Array.isArray(value) ? value.map(String) : [String(value)]
      const resolved = ids.map((assetId) => {
        const asset = media.get(assetId)
        if (!asset) throw new Error(`Input asset ${assetId} is missing`)
        return {
          assetId,
          kind: asset.kind as 'video' | 'image' | 'audio',
          path: media.originalPath(asset),
          mime: asset.mime ?? 'application/octet-stream',
          width: asset.width ?? undefined,
          height: asset.height ?? undefined,
          durationSeconds: asset.durationFlicks ? flicksToSeconds(asset.durationFlicks) : undefined,
        }
      })
      inputs[key] = Array.isArray(value) ? resolved : resolved[0]!
    }
    const tmpDir = join(env.tmpDir, 'jobs', job.id)
    mkdirSync(tmpDir, { recursive: true })
    return {
      generationId: job.id,
      model,
      params,
      inputs,
      credentials: readCredentials(secrets, model.provider, adapter.credentialFields),
      providerTaskId: job.providerTaskId ?? undefined,
      providerMeta: JSON.parse(job.providerMetaJson) as Record<string, unknown>,
      variant: job.variant,
      tmpDir,
      signal,
      recordRequest: (payload) => this.update(job.id, { requestJson: redact(payload) }),
    }
  }

  // ---------------------------------------------------------------- persistence

  private row(id: string): GenerationRow | undefined {
    return this.deps.registry.generationOwner(id)?.generations.get(id)
  }

  /** Applies a patch; returns false when a change that had to be durable could not be written. */
  private update(id: string, patch: Patch): boolean {
    const store = this.deps.registry.generationOwner(id)
    const row = store?.generations.get(id)
    if (!store || !row) return false
    const next: GenerationRow = { ...row, ...patch, updatedAt: nowIso() }
    const persisted = store.putGeneration(next, durabilityOf(patch))
    if (patch.status) {
      const unfinished = this.hasUnfinished(store.id)
      this.markActiveJobs(store.id, unfinished)
      // After the caller has published the change: a project waiting to close can unmount now.
      if (!unfinished) queueMicrotask(() => this.deps.registry.idle(store.id))
    }
    return persisted
  }

  /**
   * Remembers in app.json whether the project has unfinished jobs here (so the next start mounts it again). Best
   * effort: failing to write app.json must never undo a job's state change, nor crash the process from a timer.
   */
  private markActiveJobs(projectId: string, active: boolean) {
    try {
      this.deps.registry.setActiveJobs(projectId, active)
    } catch (err) {
      console.error(`[worker] could not record the active jobs of project ${projectId}`, err)
    }
  }

  private save(id: string, patch: Patch): GenerationDTO {
    this.update(id, patch)
    const row = this.row(id)
    if (!row) throw notFound('Generation')
    const dto = this.dto(row)
    this.finished.delete(id)
    if (!UNFINISHED_STATUSES.includes(dto.status)) {
      this.completeFailures.delete(id)
      this.finished.set(id, dto)
      if (this.finished.size > RECENT_MAX) this.finished.delete(this.finished.keys().next().value!)
    }
    this.deps.events.publish({ type: 'generation.upserted', generation: dto })
    return dto
  }

  /** Sending it again costs (next to) nothing: see ProviderAdapter.billing. */
  private resubmitSafe(provider: string): boolean {
    return Boolean(this.deps.adapters[provider as ProviderId]?.billing)
  }

  private dto(row: GenerationRow): GenerationDTO {
    return { ...toGenerationDTO(row), projectName: this.deps.registry.mounted(row.projectId)?.name }
  }

  private fail(id: string, error: JobError) {
    if (!this.row(id)) return console.warn(`[worker] job ${id} failed after its project closed:`, error.message)
    this.save(id, { status: 'failed', errorJson: JSON.stringify(error), finishedAt: nowIso() })
  }
}

export function toGenerationDTO(row: GenerationRow): GenerationDTO {
  return {
    id: row.id,
    projectId: row.projectId,
    modelId: row.modelId,
    provider: row.provider as ProviderId,
    kind: row.kind as GenerationDTO['kind'],
    status: row.status as JobStatus,
    progress: row.progress,
    statusDetail: row.statusDetail ?? undefined,
    label: row.label,
    params: JSON.parse(row.paramsJson) as Record<string, unknown>,
    error: row.errorJson ? (JSON.parse(row.errorJson) as JobError) : undefined,
    costEstimateUsd: row.costEstimateUsd ?? undefined,
    costUsd: row.costUsd ?? undefined,
    outputAssetIds: JSON.parse(row.outputAssetIdsJson) as string[],
    variant: row.variant,
    batchId: row.batchId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
    queueOrder: row.queueOrder ?? undefined,
  }
}

/** Longest name a caller can give a render (CreateGenerationRequest.label). */
const LABEL_MAX = 120

function clampLabel(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : clean
}

function labelFor(values: ParamValues, model: ModelSpec): string {
  const text =
    typeof values.prompt === 'string'
      ? values.prompt
      : typeof values.text === 'string'
        ? values.text
        : Array.isArray(values.lines)
          ? (values.lines as { text?: string }[]).map((l) => l.text ?? '').join(' / ')
          : model.label
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 80 ? `${clean.slice(0, 77)}…` : clean || model.label
}

const TOOL_SUFFIX: Partial<Record<ModelSpec['kind'], string>> = { cutout: 'Cut out', vectorize: 'Vector', upscale: 'Upscaled' }

/** Image tools name their result after the source: "Logo – Cut out" reads better than the model's name. */
function toolOutputName(model: ModelSpec, params: ParamValues, nameOf: (assetId: string) => string | undefined): string | undefined {
  const suffix = TOOL_SUFFIX[model.kind]
  const source = typeof params.image === 'string' ? params.image : typeof params.video === 'string' ? params.video : undefined
  const name = suffix && source ? nameOf(source) : undefined
  if (!name) return undefined
  const base = name.replace(/\.[a-z0-9]{2,4}$/i, '')
  return `${base.length > 48 ? `${base.slice(0, 47)}…` : base} – ${suffix}`
}

const outputSuffix = (variant: number, index: number) => (variant > 0 || index > 0 ? ` (${variant + index + 1})` : '')

/** The name the render was given (CreateGenerationRequest.label), in full, for its media; undefined when it got none. */
function givenOutputName(model: ModelSpec, params: ParamValues, variant: number, index: number, label: string): string | undefined {
  return label !== labelFor(params, model) ? `${label}${outputSuffix(variant, index)}` : undefined
}

/** Media of a render without a given name: the start of its prompt. */
function defaultOutputName(model: ModelSpec, params: ParamValues, variant: number, index: number): string {
  const base = labelFor(params, model)
  return `${base.length > 48 ? `${base.slice(0, 47)}…` : base}${outputSuffix(variant, index)}`
}

function inputAssetIds(model: ModelSpec, params: ParamValues): string[] {
  const ids: string[] = []
  for (const key of assetParamKeys(model)) {
    const value = params[key]
    if (Array.isArray(value)) ids.push(...value.map(String))
    else if (typeof value === 'string' && value) ids.push(value)
  }
  return ids
}

/**
 * Strips obvious secrets and large blobs before persisting request/response payloads. Text stays whole up to 20 000
 * characters: cut at 2 000, a keyframe's prompt was stored as "<2185 chars>", and what was sent couldn't be read back.
 */
function redact(value: unknown): string {
  const json = JSON.stringify(value, (key, v: unknown) => {
    if (/key|secret|token|authorization/i.test(key)) return '<redacted>'
    if (typeof v === 'string' && v.length > 2000) {
      // Pictures and sound sent inline (data URLs, base64) become their size.
      const summarized = summarizePayload(v)
      if (summarized !== v) return summarized
      return v.length > 20_000 ? `${v.slice(0, 20_000)}… <${v.length} chars>` : v
    }
    return v
  })
  return (json ?? 'null').slice(0, 400_000)
}

async function materialize(output: ProviderOutput, dir: string, index: number, signal: AbortSignal): Promise<string> {
  if (output.kind === 'file') return output.path
  if (output.kind === 'buffer') {
    const path = join(dir, `output-${index}.${output.ext}`)
    await writeFile(path, output.data)
    return path
  }
  const res = await fetch(output.url, { headers: output.headers, signal })
  const ext = output.ext ?? (extname(new URL(output.url).pathname).slice(1) || extFromMime(res.headers.get('content-type')))
  const path = join(dir, `output-${index}.${ext || 'bin'}`)
  await saveBody(res, path)
  return path
}

function extFromMime(mime: string | null): string {
  if (!mime) return ''
  const map: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
  }
  return map[mime.split(';')[0]!.trim()] ?? ''
}

function byQueueOrder(a: GenerationRow, b: GenerationRow): number {
  const qa = a.queueOrder ?? Number.POSITIVE_INFINITY
  const qb = b.queueOrder ?? Number.POSITIVE_INFINITY
  if (qa !== qb) return qa < qb ? -1 : 1
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
}
