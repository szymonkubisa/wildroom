export type ProviderId = 'mock' | 'elevenlabs' | 'kling' | 'fal' | 'anthropic' | 'openrouter' | 'local' | 'runpod'

export type GenKind =
  | 'video'
  | 'image'
  | 'speech'
  | 'dialogue'
  | 'music'
  | 'sfx'
  | 'lipsync'
  | 'upscale'
  | 'foley'
  /** Background removal: the subject on a transparent background. */
  | 'cutout'
  /** Raster image → SVG. */
  | 'vectorize'

export type JobStatus =
  | 'queued'
  | 'submitting'
  | 'running'
  | 'downloading'
  | 'ingesting'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'needs_attention'

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'canceled', 'needs_attention']

/**
 * Providers that render on their own hardware (this Mac, a rented GPU): each is its own lane in the render queue,
 * outside the cloud lane's one-at-a-time rule.
 */
export const OWN_LANE_PROVIDERS: readonly ProviderId[] = ['local', 'runpod']

export const isOwnLane = (provider: string): boolean => (OWN_LANE_PROVIDERS as readonly string[]).includes(provider)

export interface JobError {
  code: string // 'auth' | 'insufficient_credits' | 'moderation' | 'invalid_params' | 'rate_limited' | 'timeout' | 'provider' | 'network' | 'internal'
  message: string
  retryable: boolean
  maybeCharged: boolean
}

export interface GenerationDTO {
  id: string
  projectId: string
  /** The project's name, for the queue shared by every project. */
  projectName?: string
  modelId: string
  provider: ProviderId
  kind: GenKind
  status: JobStatus
  progress: number | null // 0..1 when the provider reports it
  /** What a queued or running job is waiting on right now (e.g. "Starting GPU…", "In GPU queue (#2)"). Not saved. */
  statusDetail?: string
  label: string // short human label (prompt excerpt)
  params: Record<string, unknown>
  error?: JobError
  costEstimateUsd?: number
  costUsd?: number
  outputAssetIds: string[]
  /** Variant index when a request asked for several takes. */
  variant: number
  batchId?: string
  createdAt: string
  updatedAt: string
  /** When the provider started working on it, and when it finished: the render time shown in History. */
  startedAt?: string
  finishedAt?: string
  /** Position in the render queue: lower runs first. */
  queueOrder?: number
}

/** Everything recorded about one render: what was asked for, what the provider was sent, and what came back. */
export interface GenerationDetails extends GenerationDTO {
  /** What the provider was sent, as recorded (pictures sent inline appear as their size). */
  request?: unknown
  /** What it answered, as recorded. */
  response?: unknown
  providerTaskId?: string
  providerMeta?: Record<string, unknown>
}
