import type { AssetDTO } from '@shared/types/assets'
import type { GenerationDTO } from '@shared/types/jobs'
import { scoreAsset, tokenize } from '@/features/assets/search'

/**
 * Create's Feed, as data: which results show (kind, favourites, a search over name and prompt), how they group — one
 * batch per Generate, its takes side by side — and what an in-flight or failed render says about itself (how long it
 * has run against how long the model usually takes, whether a failure may have been charged).
 */
export type FeedFilter = 'all' | 'image' | 'video' | 'audio'
export type FeedLayout = 'batches' | 'grid'

export interface FeedQuery {
  kind: FeedFilter
  favourites?: boolean
  search?: string
}

/** Generated results that are still in the project and not hidden (rejected). */
export function generatedResults(list: readonly AssetDTO[]): AssetDTO[] {
  return list.filter((a) => a.source === 'generation' && a.status !== 'missing' && a.rating !== -1)
}

/** The Feed's results for a query, newest first (a search keeps that order: the Feed is a history, not a ranking). */
export function filterFeed(list: readonly AssetDTO[], q: FeedQuery): AssetDTO[] {
  const tokens = tokenize(q.search ?? '')
  return generatedResults(list)
    .filter((a) => q.kind === 'all' || a.kind === q.kind)
    .filter((a) => !q.favourites || a.rating === 1)
    .filter((a) => !tokens.length || scoreAsset(a, tokens) > 0)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

export interface FeedBatch {
  key: string
  assets: AssetDTO[]
  prompt: string
  modelId?: string
  modelLabel: string
  /** What the batch cost, summed over the takes that report it (undefined: none do). */
  costUsd?: number
  /** The newest take's time (batches sort by it). */
  createdAt: string
}

/**
 * Results grouped by the Generate they came from: takes of one request share the job's batch id; a result whose job
 * isn't known (an old project) is its own batch. Keeps the order of `results` (newest first) for batches and takes.
 */
export function groupBatches(results: readonly AssetDTO[], jobOf: (generationId: string) => GenerationDTO | undefined): FeedBatch[] {
  const out: FeedBatch[] = []
  const byKey = new Map<string, FeedBatch>()
  for (const a of results) {
    const gid = a.generation?.generationId
    const job = gid ? jobOf(gid) : undefined
    const key = job?.batchId ?? gid ?? a.id
    let batch = byKey.get(key)
    if (!batch) {
      batch = {
        key,
        assets: [],
        prompt: a.generation?.prompt ?? a.name,
        modelId: a.generation?.modelId,
        modelLabel: a.generation?.modelLabel ?? '',
        createdAt: a.createdAt,
      }
      byKey.set(key, batch)
      out.push(batch)
    }
    batch.assets.push(a)
  }
  for (const b of out) b.costUsd = totalCost(b.assets)
  return out
}

/**
 * What results cost together: each render once — a job that returned several pictures records its whole cost on each
 * of them. Undefined when none of them reports a cost.
 */
export function totalCost(results: readonly AssetDTO[]): number | undefined {
  const byJob = new Map<string, number>()
  for (const a of results) {
    const g = a.generation
    if (g?.costUsd != null) byJob.set(g.generationId, g.costUsd)
  }
  return byJob.size ? [...byJob.values()].reduce((sum, usd) => sum + usd, 0) : undefined
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
}

/**
 * The file name a result downloads as: its name, made safe for a file system and not too long, with the extension its
 * type has (the app saves it as named — without one, Finder can't open it).
 */
export function downloadName(asset: Pick<AssetDTO, 'name' | 'mime' | 'kind'>): string {
  const sub = asset.mime?.split('/')[1]?.split(';')[0]
  const ext = (asset.mime && EXT[asset.mime]) ?? (sub && /^[a-z0-9]+$/.test(sub) ? sub : asset.kind === 'image' ? 'png' : asset.kind === 'audio' ? 'wav' : 'mp4')
  const base =
    asset.name
      .replace(/[\\/:*?"<>|\n\r\t]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
      .trim() || 'result'
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`
}

/** Seconds a job has been at it: since it started on the provider, else since it was queued. */
export function elapsedSeconds(job: Pick<GenerationDTO, 'createdAt' | 'startedAt'>, now: number): number {
  const from = Date.parse(job.startedAt ?? job.createdAt)
  return Number.isFinite(from) ? Math.max(0, Math.round((now - from) / 1000)) : 0
}

/** "0:42", "12:05", "1:02:00". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export type PendingPhase = 'queued' | 'running' | 'slow'

/**
 * What a render on its way shows: queued, or running for how long against the usual time — "slow" once it is well
 * past it (twice the usual and a minute more), so a stuck job doesn't spin forever without a word.
 */
export function pendingState(job: Pick<GenerationDTO, 'status' | 'createdAt' | 'startedAt'>, now: number, typical?: number): { phase: PendingPhase; text: string } {
  if (job.status === 'queued') return { phase: 'queued', text: 'Queued' }
  const elapsed = elapsedSeconds(job, now)
  if (!typical) return { phase: 'running', text: clock(elapsed) }
  const usual = `usually ~${clock(typical)}`
  return elapsed > typical * 2 + 60 ? { phase: 'slow', text: `${clock(elapsed)} · slower than usual (${usual})` } : { phase: 'running', text: `${clock(elapsed)} · ${usual}` }
}

/** A failure in words, with whether it may have cost money (the provider's own say when it gave one). */
export function failureNote(job: Pick<GenerationDTO, 'error' | 'costUsd'>): { message: string; charge: string; retryable: boolean } {
  const e = job.error
  const charged = (job.costUsd ?? 0) > 0 || Boolean(e?.maybeCharged)
  return {
    message: e?.message ?? 'Failed',
    charge: charged ? 'May have been charged' : 'Not charged',
    retryable: e?.retryable ?? true,
  }
}
