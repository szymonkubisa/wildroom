import type { CredentialField, ModelReadiness, ProviderTestResult } from '../../shared/types/api'
import type { AssetKind } from '../../shared/types/assets'
import type { JobError, ProviderId } from '../../shared/types/jobs'
import type { ModelSpec, ParamValues } from '../../shared/models/types'
import type { Credentials } from '../services/keychain'

/** An asset referenced by a param, resolved to a file on disk. */
export interface ResolvedInput {
  assetId: string
  kind: AssetKind
  path: string
  mime: string
  width?: number
  height?: number
  durationSeconds?: number
}

export interface JobContext {
  generationId: string
  model: ModelSpec
  params: ParamValues
  /** Asset-valued params resolved to files (arrays for multi-image params). */
  inputs: Record<string, ResolvedInput | ResolvedInput[]>
  credentials: Credentials
  /** Set once submit() returned an async task. */
  providerTaskId?: string
  /** Free-form data submit() wants back in poll() (e.g. fal endpoint id, Kling task type). */
  providerMeta: Record<string, unknown>
  variant: number
  tmpDir: string
  signal: AbortSignal
  /** Record the (redacted) request payload for debugging/remix. */
  recordRequest(payload: unknown): void
}

export type ProviderOutput = (
  | { kind: 'url'; url: string; ext?: string; headers?: Record<string, string> }
  | { kind: 'file'; path: string; ext: string }
  | { kind: 'buffer'; data: Buffer; ext: string }
) & {
  name?: string
  /** The model that actually made it, when the spec routes to many (e.g. "Any OpenRouter image model"). */
  modelLabel?: string
  /** Stored on the asset (e.g. TTS character alignment, dialogue voice segments). */
  meta?: Record<string, unknown>
}

export type SubmitResult =
  | { type: 'async'; taskId: string; meta?: Record<string, unknown> }
  | { type: 'done'; outputs: ProviderOutput[]; costUsd?: number; response?: unknown }

export type PollResult =
  | { type: 'running'; progress?: number; /** e.g. "In GPU queue (#2)" */ detail?: string }
  | { type: 'done'; outputs: ProviderOutput[]; costUsd?: number; response?: unknown }
  | { type: 'failed'; error: JobError }
  /** The machine running it went away (e.g. the GPU pod ended): queue the job again, nothing was delivered. */
  | { type: 'requeue'; detail?: string }

/**
 * Checked before a queued job is submitted. Waiting keeps the job queued without counting an attempt or writing to
 * disk; an error fails it.
 */
export type SubmitGate =
  | { ready: true }
  | { ready: false; retryInMs: number; detail: string }
  | { ready: false; error: JobError }

export interface ProviderAdapter {
  id: ProviderId
  label: string
  version: string
  credentialFields: CredentialField[]
  /** Which fields must be present for the provider to count as configured. */
  requiredFields: CredentialField[]
  /**
   * For providers without credentials (e.g. local models): whether they can run, and why not. `models` narrows it
   * per model when one provider serves several that are installed separately.
   */
  status?(): { configured: boolean; detail?: string; models?: Record<string, ModelReadiness> }
  defaultConcurrency: number
  pollIntervalMs: number
  /** How long a job may run before it needs attention (default 45 min). Local renders can take a night. */
  maxRunMs?: number
  /**
   * How it charges, when not per request. 'free': renders in this process (this Mac) — a restart kills the work, so it
   * simply runs again. 'machine-time': a rented machine billed by the hour — submitting again costs next to nothing, so
   * an unknown outcome is re-run instead of left for the user, and canceling never "may still charge".
   */
  billing?: 'free' | 'machine-time'
  test(credentials: Credentials): Promise<ProviderTestResult>
  /** For providers that need a machine brought up first (a rented GPU): whether a queued job can go now. */
  beforeSubmit?(): SubmitGate
  submit(ctx: JobContext): Promise<SubmitResult>
  poll?(ctx: JobContext): Promise<PollResult>
  cancel?(ctx: JobContext): Promise<void>
  /**
   * Frees what a job left in place for the provider (a file hosted for it to fetch) when the job ends without its
   * result — lost contact, a poll error it can't come back from. Best effort; the job itself is left alone.
   */
  release?(ctx: JobContext): Promise<void>
}

/** Throw from adapters to report a normalized error. */
export class ProviderError extends Error {
  constructor(public readonly jobError: JobError) {
    super(jobError.message)
    this.name = 'ProviderError'
  }
}

export function jobError(
  code: string,
  message: string,
  opts: { retryable?: boolean; maybeCharged?: boolean } = {},
): JobError {
  return { code, message, retryable: opts.retryable ?? false, maybeCharged: opts.maybeCharged ?? false }
}

const AUTHISH = /api.?key|\btoken\b|unauthori[sz]ed|authenticat|credential|permission|access denied|^forbidden$/i
const MODERATION = /moderat|flagged|content.?polic|safety|nsfw/i
/** A provider's error text that is about the key (not moderation, a plan limit or a spend cap). */
export const soundsLikeAuth = (detail: string) => AUTHISH.test(detail)
/** A provider's error text that says the input or output was blocked by moderation. */
export const soundsLikeModeration = (detail: string) => MODERATION.test(detail)

/** Maps an HTTP failure from any provider to a normalized error. */
export function httpError(status: number, body: string, providerLabel: string): ProviderError {
  const detail = extractMessage(body)
  // 403 is also moderation, plan limits and spend caps — only an auth-sounding one blames the key.
  if (status === 403 && detail && !AUTHISH.test(detail)) {
    if (MODERATION.test(detail)) return new ProviderError(jobError('moderation', `${providerLabel}: blocked by content moderation — ${detail}`))
    return new ProviderError(jobError('provider', `${providerLabel} refused the request: ${detail}`))
  }
  if (status === 401 || status === 403)
    return new ProviderError(jobError('auth', `${providerLabel}: invalid or missing API key${detail ? ` (${detail})` : ''}`))
  if (status === 402)
    return new ProviderError(jobError('insufficient_credits', `${providerLabel}: insufficient credits${detail ? ` (${detail})` : ''}`))
  if (status === 429)
    return new ProviderError(jobError('rate_limited', `${providerLabel}: rate limited${detail ? ` (${detail})` : ''}`, { retryable: true }))
  if (status === 400 || status === 422)
    return new ProviderError(jobError('invalid_params', `${providerLabel}: ${detail || 'request rejected'}`))
  if (status >= 500)
    return new ProviderError(jobError('provider', `${providerLabel}: server error ${status}${detail ? ` (${detail})` : ''}`, { retryable: true }))
  return new ProviderError(jobError('provider', `${providerLabel}: HTTP ${status}${detail ? ` (${detail})` : ''}`))
}

function extractMessage(body: string): string {
  if (!body) return ''
  try {
    const json = JSON.parse(body) as Record<string, unknown>
    const detail = json.detail as Record<string, unknown> | string | undefined
    const candidates = [
      json.message,
      json.error && typeof json.error === 'object' ? (json.error as Record<string, unknown>).message : json.error,
      typeof detail === 'string' ? detail : detail?.message,
      Array.isArray(json.detail) ? (json.detail[0] as Record<string, unknown>)?.msg : undefined,
    ]
    const found = candidates.find((c) => typeof c === 'string' && c.length > 0)
    return typeof found === 'string' ? found.slice(0, 300) : body.slice(0, 300)
  } catch {
    return body.slice(0, 300)
  }
}
