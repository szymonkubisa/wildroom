import { createHash, createHmac } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { type KlingVariant, klingAudioOn, klingElementIds, klingElementRef, klingVariant } from '../../shared/models/catalog/kling'
import {
  type MultiShotMeta,
  expectedCuts,
  multiShotProblem,
  parseMultiShot,
  resolveShotDurations,
  toKlingMultiShotPrompt,
} from '../../shared/models/multishot'
import type { ParamValues } from '../../shared/models/types'
import type { ProviderTestResult } from '../../shared/types/api'
import type { KlingElementInfo } from '../../shared/types/kling'
import type { Credentials } from '../services/keychain'
import {
  type JsonRecord,
  asNumber,
  base64Placeholder,
  compact,
  fetchJson,
  fileToBase64,
  firstString,
  httpFetch,
  isRecord,
  parseJson,
  readText,
  summarizePayload,
} from './http'
import {
  type JobContext,
  type PollResult,
  type ProviderAdapter,
  type ProviderOutput,
  ProviderError,
  type ResolvedInput,
  type SubmitResult,
  httpError,
  jobError,
} from './types'

/**
 * Kling official API. Video models use the new request format (`Authorization: Bearer <API key>`,
 * `prompt`/`contents` + `settings` + `options` bodies). The element library (legacy request format) takes the
 * access/secret-key JWT, or the API key. Response shapes are parsed defensively.
 *
 * Docs checked 2026-09-29 (pages render client-side only):
 *  - https://kling.ai/document-api/api/video/3-0-omni/text-to-video  (POST /text-to-video/{model}: top-level `prompt`)
 *  - https://kling.ai/document-api/api/video/3-0-omni/image-to-video (POST /image-to-video/{model}: `contents` with
 *    `{ type: 'first_frame' | 'last_frame', url }` (URL or raw base64) and `{ type: 'element', element_id, id }`)
 *  - https://kling.ai/document-api/api/video/3-0-omni/video-omni     (POST /omni-video/kling-3.0-omni)
 *  - https://kling.ai/document-api/api/video/3-0-omni/elements       (element library)
 *  - https://kling.ai/document-api/api/get-started/authentication    (API key "for all models"; AK/SK JWT for
 *    legacy-format endpoints)
 */

export const KLING_BASE_URL = 'https://api-singapore.klingai.com'
const LABEL = 'Kling'
/** Kling deletes generated files after 30 days; the worker downloads them right away. */
const RESULT_TTL_MS = 30 * 24 * 60 * 60_000

// ------------------------------------------------------------------------------------ legacy auth

const b64url = (value: string) => Buffer.from(value).toString('base64url')

/**
 * Legacy-format bearer token: HS256 JWT `{ iss: accessKey, exp: now + 1800, nbf: now - 5 }` signed with
 * the secret key. `now` is unix seconds (a millisecond timestamp is detected and converted).
 */
export function klingJwt(accessKey: string, secretKey: string, now?: number): string {
  const seconds = now === undefined ? Math.floor(Date.now() / 1000) : now > 1e11 ? Math.floor(now / 1000) : Math.floor(now)
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iss: accessKey, exp: seconds + 1800, nbf: seconds - 5 }))
  const signature = createHmac('sha256', secretKey).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

const tokenCache = new Map<string, { token: string; renewAt: number }>()

/** Cached legacy token: tokens live 30 min and are renewed after 25. */
export function klingLegacyToken(accessKey: string, secretKey: string, nowMs = Date.now()): string {
  const cacheKey = `${accessKey}:${createHash('sha256').update(secretKey).digest('hex').slice(0, 16)}`
  const hit = tokenCache.get(cacheKey)
  if (hit && hit.renewAt > nowMs) return hit.token
  const token = klingJwt(accessKey, secretKey, Math.floor(nowMs / 1000))
  tokenCache.set(cacheKey, { token, renewAt: nowMs + 25 * 60_000 })
  return token
}

/** `Authorization` header value for the new (API key) or legacy (access/secret key JWT) format. */
export function klingAuthorization(credentials: Credentials, format: 'new' | 'legacy' = 'new'): string {
  if (format === 'new') {
    if (!credentials.apiKey) throw new ProviderError(jobError('auth', `${LABEL}: missing API key — add it in Settings → Providers`))
    return `Bearer ${credentials.apiKey}`
  }
  if (!credentials.accessKey || !credentials.secretKey)
    throw new ProviderError(jobError('auth', `${LABEL}: this feature needs the legacy Access Key and Secret Key — add them in Settings → Providers`))
  return `Bearer ${klingLegacyToken(credentials.accessKey, credentials.secretKey)}`
}

// ------------------------------------------------------------------------------------ adapter

export function createKlingAdapter(): ProviderAdapter {
  return {
    id: 'kling',
    label: LABEL,
    version: '2026-09-29.1',
    credentialFields: ['apiKey', 'accessKey', 'secretKey'],
    requiredFields: ['apiKey'],
    defaultConcurrency: 3,
    pollIntervalMs: 5000,

    async test(credentials: Credentials): Promise<ProviderTestResult> {
      const parts: string[] = []
      let ok = true
      if (credentials.apiKey) {
        const verdict = await probe(`${KLING_BASE_URL}/tasks?task_ids=connection-test`, `Bearer ${credentials.apiKey}`)
        ok &&= verdict.ok
        parts.push(verdict.ok ? 'API key OK (new format)' : `API key rejected${verdict.detail ? ` — ${verdict.detail}` : ''}`)
      } else {
        ok = false
        parts.push('No API key — video generation needs the new-format API key')
      }
      if (credentials.accessKey && credentials.secretKey) {
        const token = klingLegacyToken(credentials.accessKey, credentials.secretKey)
        const verdict = await probe(`${KLING_BASE_URL}/v1/videos/text2video?pageNum=1&pageSize=1`, `Bearer ${token}`)
        ok &&= verdict.ok
        parts.push(verdict.ok ? 'access/secret key OK (legacy format)' : `access/secret key rejected${verdict.detail ? ` — ${verdict.detail}` : ''}`)
      } else if (credentials.accessKey || credentials.secretKey) {
        parts.push('legacy key incomplete (needs both access key and secret key)')
      }
      return { ok, message: parts.join(' · ') }
    },

    async submit(ctx: JobContext): Promise<SubmitResult> {
      const variant = klingVariant(ctx.model.id)
      if (!variant) throw new ProviderError(jobError('internal', `${LABEL}: unknown model ${ctx.model.id}`))
      const authorization = klingAuthorization(ctx.credentials)
      const { task, body, multiShot } = await buildKlingRequest(ctx, variant)
      const path = `/${task}/${variant.slug}`
      ctx.recordRequest({ endpoint: `POST ${path}`, body: redactImages(body) })
      const json = await fetchJson<unknown>(
        `${KLING_BASE_URL}${path}`,
        {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        },
        { label: LABEL, signal: ctx.signal, timeoutMs: 180_000, mapError: klingHttpError },
      )
      const envelope = envelopeError(json)
      if (envelope) throw envelope
      const taskId = extractTaskId(json)
      if (!taskId) {
        throw new ProviderError(
          jobError('provider', `${LABEL} accepted the request but returned no task id: ${JSON.stringify(json).slice(0, 300)}`, {
            maybeCharged: true,
          }),
        )
      }
      return { type: 'async', taskId, meta: { endpoint: path, externalTaskId: ctx.generationId, ...(multiShot ? { multiShot } : {}) } }
    },

    async poll(ctx: JobContext): Promise<PollResult> {
      const taskId = ctx.providerTaskId
      if (!taskId) return { type: 'failed', error: jobError('internal', `${LABEL}: no task id to poll`) }
      const json = await fetchJson<unknown>(
        `${KLING_BASE_URL}/tasks?task_ids=${encodeURIComponent(taskId)}`,
        { headers: { authorization: klingAuthorization(ctx.credentials), accept: 'application/json' } },
        {
          label: LABEL,
          signal: ctx.signal,
          timeoutMs: 30_000,
          mapError: (status, body) => keepPolling(klingHttpError(status, body), status),
        },
      )
      const envelope = envelopeError(json)
      if (envelope) throw keepPolling(envelope)
      const task = findTask(json, taskId)
      // Not listed yet (eventual consistency right after submit): keep polling; the worker times out eventually.
      if (!task) return { type: 'running' }
      return parseKlingTask(task, taskId, multiShotOf(ctx))
    },
  }
}

export type KlingTask = 'text-to-video' | 'image-to-video' | 'omni-video'

/**
 * The prompt Kling receives, plus the multi-shot plan. With Multi-shot on and the prompt written as a shot list
 * ("Shot 1 (3s): …", see shared/models/multishot) it becomes Kling's native `shot n, m, words;` storyboard
 * syntax (≤ 6 shots, whole seconds adding up to the duration); Multi-shot on with a plain prompt lets Kling plan
 * the cuts itself (`auto`). Kling reports no shot boundaries, so the plan is stored on the output asset.
 */
export function klingPromptPlan(variant: KlingVariant, params: ParamValues): { prompt: string; multiShot?: MultiShotMeta } {
  const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : ''
  if (!variant.multiShot || params.multiShot !== true || !prompt) return { prompt }
  const parsed = parseMultiShot(prompt)
  if (!parsed) return { prompt, multiShot: { shots: [], expectedCuts: [], auto: true } }
  const duration = Math.round(Number(params.duration ?? variant.defaultDuration))
  const problem = multiShotProblem(parsed.shots, duration)
  if (problem) throw new ProviderError(jobError('invalid_params', problem))
  const shots = resolveShotDurations(parsed.shots, duration)
  return { prompt: toKlingMultiShotPrompt(shots), multiShot: { shots, expectedCuts: expectedCuts(shots, duration) } }
}

/**
 * Endpoint + body for a video request (new format):
 *  - text-to-video: `{ prompt, settings, options }`;
 *  - image-to-video / omni-video: `{ contents: [prompt, first_frame, last_frame, element…], settings, options }`.
 * Frames go inline as raw base64 in `url`; elements get the prompt handles `element_1`, `element_2`… in order.
 * `multi_shot` is always sent for multi-shot models because Kling defaults it to true.
 */
export async function buildKlingRequest(
  ctx: Pick<JobContext, 'params' | 'inputs' | 'generationId'>,
  variant: KlingVariant,
): Promise<{ task: KlingTask; body: JsonRecord; multiShot?: MultiShotMeta }> {
  const { params } = ctx
  const { prompt, multiShot } = klingPromptPlan(variant, params)
  if (!prompt) throw new ProviderError(jobError('invalid_params', 'Prompt is required'))
  const first = variant.firstFrame ? singleInput(ctx.inputs, 'firstFrame') : undefined
  const last = variant.lastFrame ? singleInput(ctx.inputs, 'lastFrame') : undefined
  if (last && !first) throw new ProviderError(jobError('invalid_params', 'An end frame needs a start frame'))

  const elements = variant.elements ? klingElementIds(params) : []
  if (variant.elements && elements.length) {
    if (variant.elements.needsFirstFrame && !first)
      throw new ProviderError(jobError('invalid_params', `${variant.label} uses characters (Kling elements) only together with a start frame`))
    const max = first ? variant.elements.withFrames : variant.elements.max
    if (elements.length > max)
      throw new ProviderError(jobError('invalid_params', `${variant.label} takes up to ${max} characters${first ? ' with a start frame' : ''}`))
  }

  const task: KlingTask = variant.family === 'omni' ? 'omni-video' : first ? 'image-to-video' : 'text-to-video'
  const duration = Math.round(Number(params.duration ?? variant.defaultDuration))
  const settings = compact({
    resolution: typeof params.resolution === 'string' ? params.resolution : variant.defaultResolution,
    duration,
    audio: variant.audio === 'none' ? undefined : klingAudioOn(variant, params) ? 'native' : 'off',
    aspect_ratio: first ? undefined : typeof params.aspectRatio === 'string' ? params.aspectRatio : '16:9',
    multi_shot: variant.multiShot ? params.multiShot === true : undefined,
  })
  const options = { external_task_id: ctx.generationId }
  if (task === 'text-to-video') return { task, body: { prompt, settings, options }, multiShot }

  const contents: JsonRecord[] = [{ type: 'prompt', text: prompt }]
  if (first) contents.push({ type: 'first_frame', url: await readFrame(first) })
  if (last) contents.push({ type: 'last_frame', url: await readFrame(last) })
  elements.forEach((elementId, i) => contents.push({ type: 'element', element_id: elementId, id: klingElementRef(i) }))
  return { task, body: { contents, settings, options }, multiShot }
}

const isMultiShotMeta = (value: unknown): value is MultiShotMeta =>
  isRecord(value) && Array.isArray(value.shots) && Array.isArray(value.expectedCuts)

/** Multi-shot plan of a job: what submit() stored, else recomputed from the params (older tasks). */
function multiShotOf(ctx: JobContext): MultiShotMeta | undefined {
  if (isMultiShotMeta(ctx.providerMeta.multiShot)) return ctx.providerMeta.multiShot
  const variant = klingVariant(ctx.model.id)
  if (!variant) return undefined
  try {
    return klingPromptPlan(variant, ctx.params).multiShot
  } catch {
    return undefined
  }
}

// ------------------------------------------------------------------------------------ responses

const RUNNING = new Set(['submitted', 'queued', 'queueing', 'queuing', 'pending', 'processing', 'running', 'in_progress', 'created'])
const SUCCEEDED = new Set(['succeeded', 'succeed', 'success', 'successful', 'completed', 'complete', 'done', 'finished'])
const FAILED = new Set(['failed', 'fail', 'failure', 'error', 'canceled', 'cancelled', 'rejected', 'timeout', 'expired'])
const MODERATION_RE = /risk|safety|sensitive|polic|moderat|violat|inappropriate|censor|nsfw|content security|prohibited/i

/** Maps one task object to a poll result; `multiShot` is added to every output's meta (stored on the asset). */
export function parseKlingTask(task: JsonRecord, taskId?: string, multiShot?: MultiShotMeta): PollResult {
  const status = (firstString(task.status, task.task_status, task.state) ?? '').toLowerCase()
  if (SUCCEEDED.has(status)) {
    const outputs = videoOutputs(task, taskId ?? firstString(task.task_id, task.id), multiShot)
    if (!outputs.length)
      return { type: 'failed', error: jobError('provider', `${LABEL} reported success but returned no video`, { maybeCharged: true }) }
    return { type: 'done', outputs, response: summarizePayload(task) }
  }
  if (FAILED.has(status)) {
    const message = failureMessage(task)
    const moderation = MODERATION_RE.test(message) || asNumber(task.status_code ?? task.error_code ?? task.code) === 1301
    return { type: 'failed', error: jobError(moderation ? 'moderation' : 'provider', `${LABEL}: ${message}`) }
  }
  if (status && !RUNNING.has(status)) console.warn(`[kling] unknown task status "${status}" — still polling`)
  const progress = asNumber(task.progress ?? task.task_progress ?? task.percent)
  return { type: 'running', progress: progress === undefined ? undefined : Math.max(0, Math.min(1, progress > 1 ? progress / 100 : progress)) }
}

function videoOutputs(task: JsonRecord, taskId: string | undefined, multiShot?: MultiShotMeta): ProviderOutput[] {
  const result = isRecord(task.task_result) ? task.task_result : isRecord(task.result) ? task.result : undefined
  const candidates = [task.outputs, task.output, result?.videos, result?.outputs, task.videos]
  const list = candidates.find(Array.isArray) ?? candidates.filter(isRecord)
  const expiresAt = new Date(Date.now() + RESULT_TTL_MS).toISOString()
  return (list as unknown[]).filter(isRecord).flatMap((o): ProviderOutput[] => {
    const type = typeof o.type === 'string' ? o.type.toLowerCase() : 'video'
    const url = firstString(o.url, o.video_url, o.uri)
    if (type !== 'video' || !url) return []
    return [{ kind: 'url', url, ext: 'mp4', meta: compact({ klingTaskId: taskId, durationSeconds: asNumber(o.duration), expiresAt, multiShot }) }]
  })
}

function failureMessage(task: JsonRecord): string {
  const error = task.error
  return (
    firstString(
      task.status_msg,
      task.task_status_msg,
      task.status_message,
      task.fail_reason,
      task.failure_reason,
      task.message,
      task.msg,
      isRecord(error) ? error.message : error,
    ) ?? 'the task failed without a reason'
  )
}

/** Candidate task objects in a `/tasks` response, whatever the envelope. */
function tasksIn(json: unknown): JsonRecord[] {
  if (!isRecord(json)) return Array.isArray(json) ? json.filter(isRecord) : []
  const data = json.data
  const lists = [
    isRecord(data) ? data.tasks : undefined,
    isRecord(data) ? data.items : undefined,
    isRecord(data) ? data.list : undefined,
    Array.isArray(data) ? data : undefined,
    json.tasks,
    json.items,
  ]
  for (const list of lists) if (Array.isArray(list)) return list.filter(isRecord)
  if (isRecord(data) && (data.task_id || data.id || data.status || data.task_status)) return [data]
  if (json.task_id || json.status || json.task_status) return [json]
  return []
}

const taskIdOf = (t: JsonRecord) => firstString(t.task_id, t.id, t.taskId)

function findTask(json: unknown, taskId: string): JsonRecord | undefined {
  const tasks = tasksIn(json)
  return tasks.find((t) => taskIdOf(t) === taskId) ?? (tasks.length === 1 ? tasks[0] : undefined)
}

function extractTaskId(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined
  const data = json.data
  if (isRecord(data)) {
    const direct = firstString(data.task_id, data.id, data.taskId)
    if (direct) return direct
    if (Array.isArray(data.tasks) && isRecord(data.tasks[0])) return taskIdOf(data.tasks[0])
  }
  if (Array.isArray(data) && isRecord(data[0])) return taskIdOf(data[0])
  return firstString(json.task_id, json.id, json.taskId)
}

// ------------------------------------------------------------------------------------ errors

/**
 * Kling business error codes (shared by both request formats as far as documented):
 * 1000–1004 auth, 1100–1103 account / balance, 1200–1203 parameters, 1300–1304 platform policy,
 * 5000+ server. Kling returns HTTP 429 for depleted balances, so codes win over the HTTP status.
 */
export function klingCodeError(code: number, message: string, status?: number): ProviderError {
  const detail = message || `error code ${code}`
  if (code >= 1000 && code <= 1004) return new ProviderError(jobError('auth', `${LABEL}: authentication failed (${detail})`))
  if (code === 1101 || code === 1102)
    return new ProviderError(jobError('insufficient_credits', `${LABEL}: ${code === 1102 ? 'resource package used up or expired' : 'account in arrears'} (${detail})`))
  if (code === 1100 || code === 1103) return new ProviderError(jobError('auth', `${LABEL}: account not allowed to do this (${detail})`))
  if (code >= 1200 && code <= 1299) return new ProviderError(jobError('invalid_params', `${LABEL}: ${detail}`))
  if (code === 1301) return new ProviderError(jobError('moderation', `${LABEL}: blocked by content safety (${detail})`))
  if (code === 1302 || code === 1303) return new ProviderError(jobError('rate_limited', `${LABEL}: ${detail}`, { retryable: true }))
  if (code >= 1300 && code <= 1399) return new ProviderError(jobError('provider', `${LABEL}: ${detail}`))
  if (code >= 5000) return new ProviderError(jobError('provider', `${LABEL}: server error (${detail})`, { retryable: true }))
  return textualError(detail, status)
}

function textualError(message: string, status?: number): ProviderError {
  if (/balance|arrear|insufficient|quota|resource pack|credit/i.test(message))
    return new ProviderError(jobError('insufficient_credits', `${LABEL}: ${message}`))
  if (MODERATION_RE.test(message)) return new ProviderError(jobError('moderation', `${LABEL}: ${message}`))
  if (/concurren|too many|rate limit|qps/i.test(message)) return new ProviderError(jobError('rate_limited', `${LABEL}: ${message}`, { retryable: true }))
  if (status) return httpError(status, JSON.stringify({ message }), LABEL)
  return new ProviderError(jobError('provider', `${LABEL}: ${message}`))
}

/** Error mapper for non-2xx responses. */
export function klingHttpError(status: number, body: string): ProviderError {
  const json = parseJson(body)
  if (isRecord(json)) {
    const code = asNumber(json.code)
    const message = firstString(json.message, json.msg, isRecord(json.error) ? json.error.message : json.error, json.detail) ?? ''
    if (code !== undefined && code >= 1000) return klingCodeError(code, message, status)
    if (message && status !== 401 && status !== 403) return textualError(message, status)
  }
  return httpError(status, body, LABEL)
}

/**
 * While polling, "not found"/parameter errors can be eventual consistency right after submit: make them
 * retryable so the worker keeps polling (it gives up with `needs_attention` after a while) instead of
 * failing a task that may be running and billed.
 */
function keepPolling(error: ProviderError, status?: number): ProviderError {
  if (status === 404 || error.jobError.code === 'invalid_params') return new ProviderError({ ...error.jobError, retryable: true })
  return error
}

/** A 200 response can still carry a business error code. */
function envelopeError(json: unknown): ProviderError | undefined {
  if (!isRecord(json)) return undefined
  const code = asNumber(json.code)
  if (code === undefined || code === 0 || (code >= 200 && code < 300)) return undefined
  const message = firstString(json.message, json.msg, isRecord(json.error) ? json.error.message : json.error) ?? ''
  return klingCodeError(code, message)
}

// ------------------------------------------------------------------------------------ helpers

const isInlineData = (value: unknown): value is string => typeof value === 'string' && !/^https?:\/\//.test(value)

/** Request body for the job record: inline frame images (`url`/`image` holding base64) become `<base64 N bytes>`. */
function redactImages(body: JsonRecord): unknown {
  if (!Array.isArray(body.contents)) return summarizePayload(body)
  const contents = body.contents.map((item) => {
    if (!isRecord(item)) return item
    const out = { ...item }
    for (const key of ['url', 'image'] as const) {
      const value = out[key]
      if (isInlineData(value)) out[key] = base64Placeholder(value)
    }
    return out
  })
  return summarizePayload({ ...body, contents })
}

/** Nothing has been sent yet, so a missing file is a clean parameter failure (never "unknown outcome"). */
async function readFrame(input: ResolvedInput): Promise<string> {
  try {
    return await fileToBase64(input.path)
  } catch (err) {
    throw new ProviderError(
      jobError('invalid_params', `Could not read input image ${input.assetId}: ${err instanceof Error ? err.message : String(err)}`),
    )
  }
}

function singleInput(inputs: JobContext['inputs'], key: string): ResolvedInput | undefined {
  const value = inputs[key]
  return Array.isArray(value) ? value[0] : value
}

/** Auth verdict for `test()`: 401/403 or an auth business code = rejected; anything else reachable = OK. */
async function probe(url: string, authorization: string): Promise<{ ok: boolean; detail?: string }> {
  const res = await httpFetch(url, { headers: { authorization, accept: 'application/json' } }, { label: LABEL, timeoutMs: 20_000 })
  const body = await readText(res)
  const json = parseJson(body)
  const code = isRecord(json) ? asNumber(json.code) : undefined
  const message = isRecord(json) ? firstString(json.message, json.msg) : undefined
  if (res.status === 401 || res.status === 403 || (code !== undefined && code >= 1000 && code <= 1004)) {
    return { ok: false, detail: message ?? `HTTP ${res.status}` }
  }
  return { ok: true }
}

// ------------------------------------------------------------------------------------ element library

/*
 * Kling element library ("advanced custom elements", legacy request format).
 * Docs (checked 2026-09-29): https://kling.ai/document-api/api/video/3-0-omni/elements
 *  - POST /v1/general/advanced-custom-elements
 *      { element_name (≤ 20), element_description (≤ 100), reference_type: 'image_refer',
 *        element_image_list: { frontal_image, refer_images: [{ image_url }] (1–3) }, element_voice_id?, tag_list?,
 *        callback_url?, external_task_id? }  →  { code, data: { task_id, task_status } } — asynchronous.
 *  - GET /v1/general/advanced-custom-elements/{task_id}  →  data.task_status (submitted|processing|succeed|failed),
 *      data.task_status_msg, data.task_result.elements[0].element_id (a number).
 *  - GET /v1/general/advanced-custom-elements?pageNum&pageSize (list), GET /v1/general/advanced-presets-elements.
 *  - POST /v1/general/delete-advanced-elements { element_id }.
 * Images: raw base64 (no data: prefix) or URL; jpg/jpeg/png, ≤ 10 MB, ≥ 300 px, aspect 1:2.5–2.5:1.
 * These ids are what video requests take (`{ type: 'element', element_id }` in the new format, `element_list` in the
 * legacy one): the new-format pages link element ids to "the element related API", i.e. this library. Creating an
 * element is free (https://kling.ai/quickstart/klingai-element-library-3-user-guide).
 * Auth: AK/SK JWT (legacy-format endpoint); the API key is documented as valid "for all models", so it is the
 * fallback when no AK/SK is stored (https://kling.ai/document-api/api/get-started/authentication).
 */

export const KLING_ELEMENTS_PATH = '/v1/general/advanced-custom-elements'
export const KLING_PRESET_ELEMENTS_PATH = '/v1/general/advanced-presets-elements'
export const KLING_DELETE_ELEMENT_PATH = '/v1/general/delete-advanced-elements'
export const KLING_ELEMENT_NAME_MAX = 20
export const KLING_ELEMENT_DESCRIPTION_MAX = 100
export const KLING_ELEMENT_MAX_REFERENCES = 3
const ELEMENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024
const ELEMENT_IMAGE_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png'])
/** Tag "Character" from the documented tag table (o_101 Hottest, o_102 Character, o_103 Animal…). */
const CHARACTER_TAG = 'o_102'
const DUPLICATE_NAME_RE = /(name.*(exist|duplicat|repeat|already|taken|in use))|((exist|duplicat|repeat|already).*name)/i

export interface KlingElementInput {
  name: string
  description: string
  /** Front-facing reference image. */
  frontal: ResolvedInput
  /** 1–3 other angles / close-ups. */
  references: ResolvedInput[]
}

type ElementAuth = { authorization: string; via: 'legacy' | 'apiKey' }

/** Element-library authorization: the AK/SK JWT when stored (legacy-format endpoint), else the API key. */
export function klingElementsAuthorization(credentials: Credentials): ElementAuth {
  if (credentials.accessKey && credentials.secretKey) return { authorization: klingAuthorization(credentials, 'legacy'), via: 'legacy' }
  if (credentials.apiKey) return { authorization: `Bearer ${credentials.apiKey}`, via: 'apiKey' }
  throw new ProviderError(
    jobError(
      'auth',
      `${LABEL}: the element library needs your Kling keys — add the legacy Access Key + Secret Key (or the API key) in Settings → Providers`,
    ),
  )
}

/** With the API key, an auth failure may mean the endpoint wants the legacy keys: say so. */
function withElementsAuthHint(error: ProviderError, via: ElementAuth['via']): ProviderError {
  if (error.jobError.code !== 'auth' || via !== 'apiKey') return error
  return new ProviderError({
    ...error.jobError,
    message: `${error.jobError.message} — the element library may need the legacy Access Key + Secret Key: add them in Settings → Providers`,
  })
}

async function elementCall(
  url: string,
  init: RequestInit,
  auth: ElementAuth,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  mapError: (status: number, body: string) => ProviderError = klingHttpError,
): Promise<JsonRecord> {
  try {
    const json = await fetchJson<unknown>(
      url,
      { ...init, headers: { authorization: auth.authorization, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) } },
      { label: LABEL, signal, timeoutMs, mapError },
    )
    const envelope = envelopeError(json)
    if (envelope) throw envelope
    return isRecord(json) ? json : { data: json }
  } catch (err) {
    throw err instanceof ProviderError ? withElementsAuthHint(err, auth.via) : err
  }
}

/** Nothing is sent before every image is read: a bad image is a clean parameter error. */
async function readElementImage(input: ResolvedInput): Promise<string> {
  if (input.mime && !ELEMENT_IMAGE_MIMES.has(input.mime.toLowerCase()))
    throw new ProviderError(jobError('invalid_params', `Kling elements take JPEG or PNG images (${input.assetId} is ${input.mime})`))
  try {
    const { size } = await stat(input.path)
    if (size > ELEMENT_IMAGE_MAX_BYTES)
      throw new ProviderError(jobError('invalid_params', `Reference image ${input.assetId} is larger than 10 MB (Kling's limit for elements)`))
    return await fileToBase64(input.path)
  } catch (err) {
    if (err instanceof ProviderError) throw err
    throw new ProviderError(
      jobError('invalid_params', `Could not read reference image ${input.assetId}: ${err instanceof Error ? err.message : String(err)}`),
    )
  }
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim()
}

/** Element id in a creation task / list entry, whatever the envelope (legacy `task_result.elements`, new `outputs`). */
function elementIdIn(task: JsonRecord): string | undefined {
  const result = isRecord(task.task_result) ? task.task_result : undefined
  const lists = [result?.elements, task.elements, task.outputs]
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (!isRecord(item)) continue
      if (typeof item.type === 'string' && item.type !== 'element') continue
      const id = firstString(item.element_id, item.id)
      if (id) return id
    }
  }
  return firstString(result?.element_id, task.element_id)
}

const ELEMENT_DONE = new Set(['succeed', 'succeeded', 'success', 'completed', 'done'])
const ELEMENT_FAILED = new Set(['failed', 'fail', 'failure', 'error', 'canceled', 'cancelled', 'rejected'])

/**
 * Creates an image-based ("multi-image") element and waits for Kling to finish it (polling, ~2 min max).
 * Returns the element id as a string (Kling reports a number; video requests take a string).
 */
export async function createKlingElement(
  credentials: Credentials,
  input: KlingElementInput,
  signal?: AbortSignal,
  opts: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<{ elementId: string; taskId?: string }> {
  const auth = klingElementsAuthorization(credentials)
  const name = truncate(input.name, KLING_ELEMENT_NAME_MAX)
  if (!name) throw new ProviderError(jobError('invalid_params', 'The element needs a name'))
  const references = input.references.slice(0, KLING_ELEMENT_MAX_REFERENCES)
  if (!references.length)
    throw new ProviderError(
      jobError('invalid_params', 'Kling elements need a front image plus 1–3 more reference images (other angles or close-ups)'),
    )
  const [frontal, ...refs] = await Promise.all([input.frontal, ...references].map(readElementImage))
  const body: JsonRecord = {
    element_name: name,
    element_description: truncate(input.description, KLING_ELEMENT_DESCRIPTION_MAX) || name,
    reference_type: 'image_refer',
    element_image_list: { frontal_image: frontal, refer_images: refs.map((image_url) => ({ image_url })) },
    tag_list: [{ tag_id: CHARACTER_TAG }],
  }
  const create = (payload: JsonRecord) =>
    elementCall(`${KLING_BASE_URL}${KLING_ELEMENTS_PATH}`, { method: 'POST', body: JSON.stringify(payload) }, auth, signal, 60_000)

  let created: JsonRecord
  try {
    created = await create(body)
  } catch (err) {
    // Names are unique per library: retry once with a suffix instead of failing a re-sync.
    if (!(err instanceof ProviderError) || !DUPLICATE_NAME_RE.test(err.message)) throw err
    const suffix = Math.random().toString(36).slice(2, 6)
    created = await create({ ...body, element_name: `${truncate(name, KLING_ELEMENT_NAME_MAX - 5)} ${suffix}` })
  }

  const data = isRecord(created.data) ? created.data : created
  const taskId = firstString(data.task_id, data.taskId, data.id)
  const immediate = elementIdIn(data)
  if (immediate && (!taskId || ELEMENT_DONE.has((firstString(data.task_status, data.status) ?? 'succeed').toLowerCase())))
    return { elementId: immediate, taskId }
  if (!taskId)
    throw new ProviderError(jobError('provider', `${LABEL} accepted the element but returned no task id: ${JSON.stringify(created).slice(0, 300)}`))

  const interval = opts.pollIntervalMs ?? 2000
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000)
  const notFoundIsPending = (status: number, text: string) => keepPolling(klingHttpError(status, text), status)
  for (;;) {
    await delay(interval, undefined, signal ? { signal } : undefined)
    let task: JsonRecord | undefined
    try {
      const json = await elementCall(
        `${KLING_BASE_URL}${KLING_ELEMENTS_PATH}/${encodeURIComponent(taskId)}`,
        { method: 'GET' },
        auth,
        signal,
        30_000,
        notFoundIsPending,
      )
      task = isRecord(json.data) ? json.data : Array.isArray(json.data) && isRecord(json.data[0]) ? json.data[0] : json
    } catch (err) {
      // Right after creation the task can be briefly unknown, and servers/networks hiccup: retry until the deadline.
      const retryable = err instanceof ProviderError ? err.jobError.retryable : !(err instanceof Error && err.name === 'AbortError')
      if (!retryable || Date.now() >= deadline) throw err
    }
    if (task) {
      const status = (firstString(task.task_status, task.status) ?? '').toLowerCase()
      if (ELEMENT_DONE.has(status)) {
        const elementId = elementIdIn(task)
        if (elementId) return { elementId, taskId }
        throw new ProviderError(jobError('provider', `${LABEL} finished the element but returned no element id (task ${taskId})`))
      }
      if (ELEMENT_FAILED.has(status)) {
        const message = firstString(task.task_status_msg, task.status_msg, task.message) ?? 'element creation failed'
        throw new ProviderError(jobError(MODERATION_RE.test(message) ? 'moderation' : 'provider', `${LABEL}: ${message}`))
      }
    }
    if (Date.now() >= deadline)
      throw new ProviderError(
        jobError('provider', `${LABEL} is still creating the element (task ${taskId}) — try again in a minute`, { retryable: true }),
      )
  }
}

function elementInfo(item: JsonRecord, task: JsonRecord): KlingElementInfo | undefined {
  const elementId = firstString(item.element_id, item.id)
  if (!elementId) return undefined
  const images = isRecord(item.element_image_list) ? item.element_image_list : undefined
  const references = Array.isArray(item.references) ? item.references.filter(isRecord) : []
  const frontalRef = references.find((r) => r.role === 'frontal')
  const createdMs = asNumber(task.created_at ?? task.create_time ?? item.created_at)
  return {
    elementId,
    name: firstString(item.element_name, item.name) ?? elementId,
    description: firstString(item.element_description, item.description),
    referenceType: firstString(item.reference_type, item.element_type),
    status: firstString(item.status),
    ownedBy: firstString(item.owned_by),
    frontalImageUrl: firstString(images?.frontal_image, frontalRef?.url),
    createdAt: createdMs ? new Date(createdMs).toISOString() : undefined,
  }
}

/** Custom elements of the account (or Kling's presets), newest first as returned; deleted ones are skipped. */
export async function listKlingElements(
  credentials: Credentials,
  opts: { presets?: boolean; pageSize?: number; signal?: AbortSignal } = {},
): Promise<KlingElementInfo[]> {
  const auth = klingElementsAuthorization(credentials)
  const path = opts.presets ? KLING_PRESET_ELEMENTS_PATH : KLING_ELEMENTS_PATH
  const query = new URLSearchParams({ pageNum: '1', pageSize: String(Math.min(500, Math.max(1, opts.pageSize ?? 500))) })
  const json = await elementCall(`${KLING_BASE_URL}${path}?${query}`, { method: 'GET' }, auth, opts.signal, 30_000)
  const data = json.data
  const tasks = (Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.list) ? data.list : []).filter(isRecord)
  const out: KlingElementInfo[] = []
  for (const task of tasks) {
    const status = (firstString(task.task_status) ?? 'succeed').toLowerCase()
    if (!ELEMENT_DONE.has(status)) continue
    const listed = isRecord(task.task_result) ? task.task_result.elements : task.elements
    const items = (Array.isArray(listed) ? listed : [task]).filter(isRecord)
    for (const item of items) {
      const info = elementInfo(item, task)
      if (info && info.status?.toLowerCase() !== 'deleted') out.push(info)
    }
  }
  return out
}

/** Removes a custom element from the library (asynchronous on Kling's side; not awaited). */
export async function deleteKlingElement(credentials: Credentials, elementId: string, signal?: AbortSignal): Promise<void> {
  const auth = klingElementsAuthorization(credentials)
  await elementCall(
    `${KLING_BASE_URL}${KLING_DELETE_ELEMENT_PATH}`,
    { method: 'POST', body: JSON.stringify({ element_id: elementId }) },
    auth,
    signal,
    30_000,
  )
}
