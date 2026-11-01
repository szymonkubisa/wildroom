import type { AssetVariant, FilmstripInfo } from '../../shared/types/assets'
import type { ProjectKind } from '../../shared/projects/meta'
import type { ProjectDoc } from '../../shared/types/project-doc'

// ---------------------------------------------------------------------------------------------
// Project bundle layout
//
//   <Name>.wildroom/
//     project.json              ProjectFile — the timeline document and project metadata
//     Assets/<assetId>.json      AssetRecord — one file per asset
//     Generations/<id>.json      GenerationRecord — generation jobs and their history
//     Media/<sha256>.<ext>       original media (imports, generations, renders), content-addressed
//     Conflicts/                 versions of project.json replaced by a concurrent writer (sync)
//     .lock                      the server that has the project open (see lock.ts)
//
// One file per record so sync services (iCloud, Dropbox) merge folders file by file: imports and generations made
// on two machines add up instead of conflicting. Only machine-independent data goes into a bundle; derived media
// and ingest state live in the cache (DerivedCache) and are rebuilt on another machine.
// ---------------------------------------------------------------------------------------------

export const BUNDLE_EXT = '.wildroom'
export const PROJECT_FILE = 'project.json'
export const LOCK_FILE = '.lock'
export const ASSETS_DIR = 'Assets'
export const GENERATIONS_DIR = 'Generations'
export const MEDIA_DIR = 'Media'
export const CONFLICTS_DIR = 'Conflicts'
/** Bumped when the bundle layout changes incompatibly; newer bundles are refused, older ones upgraded. */
export const PROJECT_FORMAT = 1
export const BUNDLE_APP = 'wildroom'

export interface SavedBy {
  machineId: string
  host: string
  at: string
}

export interface ProjectSummaryInfo {
  /** Spine length in frames (project card). */
  durationFrames: number
  posterAssetId?: string
  /** Content hash + extension of the poster asset's original, so the card can be drawn without opening the project. */
  posterSha?: string
  posterExt?: string
}

export interface ProjectFile {
  app: typeof BUNDLE_APP
  format: number
  id: string
  name: string
  createdAt: string
  updatedAt: string
  /** Optimistic-concurrency counter of the document (autosave sends the revision it is based on). */
  revision: number
  savedBy?: SavedBy
  /** What the project was made as (Home's kind chips, New project); absent in older projects. */
  kind?: ProjectKind
  /** The user's tags for the Projects page (normalized: see normalizeTags); absent until the first one is added. */
  tags?: string[]
  summary: ProjectSummaryInfo
  doc: ProjectDoc
}

/** An asset as stored in the bundle: identity, probe facts and user data — no machine-local state. */
export interface AssetRecord {
  id: string
  sha256: string | null
  ext: string | null
  kind: string // video | image | audio
  name: string
  source: string // import | generation | render | derived
  role: string | null
  mime: string | null
  sizeBytes: number | null
  durationFlicks: number | null
  width: number | null
  height: number | null
  fps: number | null
  rotation: number | null
  hasVideo: boolean
  hasAudio: boolean
  sampleRate: number | null
  channels: number | null
  videoCodec: string | null
  audioCodec: string | null
  /** Seconds between the original's first video timestamp and t=0 of proxy/wav. */
  timeOffset: number | null
  generationId: string | null
  parentIds: string[]
  rating: number
  keywords: string[]
  /** Provider extras (e.g. TTS alignment), analysis results (beats, transcript, description), generation summary. */
  meta: Record<string, unknown>
  createdAt: string
  updatedAt?: string
  deletedAt: string | null
}

export type AssetStatusValue = 'processing' | 'ready' | 'error' | 'missing'

/** An asset as the server works with it: the record plus its project and this machine's ingest state. */
export interface AssetRow extends AssetRecord {
  projectId: string
  status: AssetStatusValue
  error: string | null
  variants: Partial<Record<AssetVariant, boolean>>
  filmstrip: FilmstripInfo | null
  waveformRate: number | null
  loudness: { integratedLufs: number; truePeakDb: number } | null
}

/** A generation job as stored in the bundle (the project is implied by the bundle). */
export interface GenerationRecord {
  id: string
  modelId: string
  provider: string
  kind: string
  status: string
  progress: number | null
  label: string
  params: Record<string, unknown>
  providerTaskId: string | null
  providerMeta: Record<string, unknown>
  /** Redacted request/response payloads as recorded (JSON text, possibly truncated). */
  requestJson: string | null
  responseJson: string | null
  adapterVersion: string | null
  error: unknown
  costEstimateUsd: number | null
  costUsd: number | null
  outputAssetIds: string[]
  variant: number
  batchId: string | null
  /** Position in the render queue (epoch ms when queued; reordering swaps values). */
  queueOrder: number | null
  attempts: number
  /** The machine that queued (and runs) the job: only it may submit or poll it. Missing in older records. */
  machineId?: string | null
  host?: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
}

/** A generation job as the worker works with it (JSON columns kept as text, like the job engine always had). */
export interface GenerationRow {
  id: string
  projectId: string
  modelId: string
  provider: string
  kind: string
  status: string
  progress: number | null
  label: string
  paramsJson: string
  providerTaskId: string | null
  providerMetaJson: string
  requestJson: string | null
  responseJson: string | null
  adapterVersion: string | null
  errorJson: string | null
  costEstimateUsd: number | null
  costUsd: number | null
  outputAssetIdsJson: string
  variant: number
  batchId: string | null
  queueOrder: number | null
  attempts: number
  machineId: string | null
  host: string | null
  /** When the job is next due (rate-limit backoff, polling). Machine-local, never persisted. */
  nextPollAt: number | null
  /** What the job is waiting on right now (e.g. "Starting GPU…"). Machine-local, never persisted. */
  statusDetail?: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
}

export function generationToRecord(row: GenerationRow): GenerationRecord {
  return {
    id: row.id,
    modelId: row.modelId,
    provider: row.provider,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    label: row.label,
    params: parseJson<Record<string, unknown>>(row.paramsJson, {}),
    providerTaskId: row.providerTaskId,
    providerMeta: parseJson<Record<string, unknown>>(row.providerMetaJson, {}),
    requestJson: row.requestJson,
    responseJson: row.responseJson,
    adapterVersion: row.adapterVersion,
    error: row.errorJson ? parseJson<unknown>(row.errorJson, null) : null,
    costEstimateUsd: row.costEstimateUsd,
    costUsd: row.costUsd,
    outputAssetIds: parseJson<string[]>(row.outputAssetIdsJson, []),
    variant: row.variant,
    batchId: row.batchId,
    queueOrder: row.queueOrder,
    attempts: row.attempts,
    machineId: row.machineId,
    host: row.host,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }
}

export function recordToGeneration(rec: GenerationRecord, projectId: string): GenerationRow {
  return {
    id: rec.id,
    projectId,
    modelId: rec.modelId,
    provider: rec.provider,
    kind: rec.kind,
    status: rec.status,
    progress: num(rec.progress),
    label: rec.label ?? '',
    paramsJson: JSON.stringify(rec.params ?? {}),
    providerTaskId: rec.providerTaskId ?? null,
    providerMetaJson: JSON.stringify(rec.providerMeta ?? {}),
    requestJson: rec.requestJson ?? null,
    responseJson: rec.responseJson ?? null,
    adapterVersion: rec.adapterVersion ?? null,
    errorJson: rec.error == null ? null : JSON.stringify(rec.error),
    costEstimateUsd: num(rec.costEstimateUsd),
    costUsd: num(rec.costUsd),
    outputAssetIdsJson: JSON.stringify(Array.isArray(rec.outputAssetIds) ? rec.outputAssetIds : []),
    variant: rec.variant ?? 0,
    batchId: rec.batchId ?? null,
    queueOrder: num(rec.queueOrder),
    attempts: rec.attempts ?? 0,
    machineId: typeof rec.machineId === 'string' ? rec.machineId : null,
    host: typeof rec.host === 'string' ? rec.host : null,
    nextPollAt: null,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt ?? rec.createdAt,
    startedAt: rec.startedAt ?? null,
    finishedAt: rec.finishedAt ?? null,
  }
}

/** Content hash of a media file (lowercase hex SHA-256): the only form allowed into a file path. */
export const SHA256_RE = /^[0-9a-f]{64}$/
/** File extension of a stored media file (no dot). */
export const EXT_RE = /^[a-z0-9]{1,8}$/i
/** Record ids double as file names (`Assets/<id>.json`). */
export const RECORD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export const isSafeSha = (v: unknown): v is string => typeof v === 'string' && SHA256_RE.test(v)
export const isSafeExt = (v: unknown): v is string => typeof v === 'string' && EXT_RE.test(v)

/**
 * Fills defaults and drops path parts that aren't what this app writes: a bundle is a folder anyone can hand you, and
 * `sha256`/`ext` become file paths (`Media/<sha256>.<ext>`). A record with a bad one reads as missing media.
 */
export function normalizeAssetRecord(rec: AssetRecord): AssetRecord {
  const meta = rec.meta && typeof rec.meta === 'object' ? { ...rec.meta } : {}
  const vector = meta.vector as { sha256?: unknown } | undefined
  if (vector && !isSafeSha(vector.sha256)) delete meta.vector
  return {
    ...rec,
    sha256: isSafeSha(rec.sha256) ? rec.sha256 : null,
    ext: isSafeExt(rec.ext) ? rec.ext : null,
    name: rec.name || 'Untitled',
    role: rec.role ?? null,
    mime: rec.mime ?? null,
    sizeBytes: num(rec.sizeBytes),
    durationFlicks: num(rec.durationFlicks),
    width: num(rec.width),
    height: num(rec.height),
    fps: num(rec.fps),
    rotation: num(rec.rotation),
    hasVideo: !!rec.hasVideo,
    hasAudio: !!rec.hasAudio,
    sampleRate: num(rec.sampleRate),
    channels: num(rec.channels),
    videoCodec: rec.videoCodec ?? null,
    audioCodec: rec.audioCodec ?? null,
    timeOffset: num(rec.timeOffset),
    generationId: rec.generationId ?? null,
    parentIds: Array.isArray(rec.parentIds) ? rec.parentIds : [],
    rating: rec.rating === 1 || rec.rating === -1 ? rec.rating : 0,
    keywords: Array.isArray(rec.keywords) ? rec.keywords : [],
    meta,
    deletedAt: rec.deletedAt ?? null,
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/** Folder-name-safe project name: no path separators or colons, no leading dot, at most 120 characters. */
export function safeBundleBaseName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
  return cleaned || 'Untitled Project'
}
