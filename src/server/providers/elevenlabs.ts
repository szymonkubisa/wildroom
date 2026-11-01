import {
  type DialogueLine,
  ELEVENLABS_DIALOGUE_MODEL,
  ELEVENLABS_MUSIC_MODEL,
  ELEVENLABS_SFX_MODEL,
  type ElevenLabsTtsVariant,
  elevenLabsTtsVariant,
} from '../../shared/models/catalog/elevenlabs'
import type { ParamValues } from '../../shared/models/types'
import type { ProviderTestResult } from '../../shared/types/api'
import { VOICE_LAB_LIMITS } from '../../shared/types/voiceLab'
import type { Credentials } from '../services/keychain'
import {
  type ErrorMapper,
  type JsonRecord,
  asNumber,
  asString,
  compact,
  fetchJson,
  fileToBlob,
  firstString,
  httpFetch,
  isRecord,
  parseJson,
  readText,
} from './http'
import { type JobContext, type ProviderAdapter, type ProviderOutput, ProviderError, type SubmitResult, httpError, jobError } from './types'

/**
 * ElevenLabs: text-to-speech, text-to-dialogue, sound effects and music. All calls are synchronous —
 * `submit` returns the finished audio. Speech/dialogue outputs carry word timings in `meta.alignment`.
 */

export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io'
const LABEL = 'ElevenLabs'
const PREFERRED_FORMAT = 'mp3_44100_192'
/** Used when the account's plan does not allow 192 kbps (Free/Starter). */
const FALLBACK_FORMAT = 'mp3_44100_128'

const TIMEOUTS = {
  speech: 5 * 60_000,
  dialogue: 5 * 60_000,
  sfx: 3 * 60_000,
  music: 15 * 60_000,
  alignment: 2 * 60_000,
  meta: 20_000,
  voiceDesign: 3 * 60_000,
  voiceSave: 60_000,
  voiceClone: 5 * 60_000,
}

export interface AlignedWord {
  text: string
  /** Seconds from the start of the audio. */
  start: number
  end: number
  /** Dialogue only: speaker voice and 0-based line index. */
  voiceId?: string
  line?: number
}

export interface AudioAlignment {
  words: AlignedWord[]
  source: 'with-timestamps' | 'forced-alignment'
}

export interface VoiceSegment {
  voiceId: string
  start: number
  end: number
  line: number
  charStart: number
  charEnd: number
}

export interface ElevenLabsVoice {
  id: string
  name: string
  category?: string
  labels: Record<string, string>
  previewUrl?: string
  description?: string
}

// ------------------------------------------------------------------------------------------ voices

/** One page of the account's voices for the voice picker (`GET /v2/voices`). */
export async function listElevenLabsVoices(
  credentials: Credentials,
  opts: { search?: string; pageToken?: string; pageSize?: number; signal?: AbortSignal } = {},
): Promise<{ voices: ElevenLabsVoice[]; nextPageToken?: string }> {
  const apiKey = requireKey(credentials)
  const query = new URLSearchParams({ page_size: String(opts.pageSize ?? 100) })
  if (opts.search) query.set('search', opts.search)
  if (opts.pageToken) query.set('next_page_token', opts.pageToken)
  const json = await fetchJson<JsonRecord>(
    `${ELEVENLABS_BASE_URL}/v2/voices?${query}`,
    { headers: { 'xi-api-key': apiKey, accept: 'application/json' } },
    { label: LABEL, signal: opts.signal, timeoutMs: TIMEOUTS.meta, mapError: elevenLabsError },
  )
  const voices = (Array.isArray(json.voices) ? json.voices : []).filter(isRecord).flatMap((v): ElevenLabsVoice[] => {
    const id = asString(v.voice_id)
    if (!id) return []
    const labels: Record<string, string> = {}
    if (isRecord(v.labels)) for (const [k, value] of Object.entries(v.labels)) if (typeof value === 'string' && value) labels[k] = value
    return [
      {
        id,
        name: asString(v.name) ?? id,
        category: asString(v.category),
        labels,
        previewUrl: asString(v.preview_url),
        description: asString(v.description),
      },
    ]
  })
  const nextPageToken = json.has_more === false ? undefined : asString(json.next_page_token)
  return { voices, nextPageToken }
}

// ------------------------------------------------------------------------------------------ voice lab

/** Voice Design model: v3 is the more expressive one (the API's default is eleven_multilingual_ttv_v2). */
export const ELEVENLABS_VOICE_DESIGN_MODEL = 'eleven_ttv_v3'

export interface VoiceDesignPreview {
  /** Pass to `createDesignedVoice` to keep this voice. */
  generatedVoiceId: string
  audioBase64: string
  mediaType: string
  durationSeconds?: number
  language?: string
}

/** An audio file on disk to upload as a cloning sample. */
export interface VoiceSampleFile {
  path: string
  filename: string
  mime: string
}

export type VoiceLabAction = 'design' | 'save' | 'clone'

/**
 * Voice Design (`POST /v1/text-to-voice/design`): voice previews for a description. Without sample text ElevenLabs
 * writes a line that suits the voice. Nothing is added to the account until `createDesignedVoice`.
 */
export async function designVoicePreviews(
  credentials: Credentials,
  input: { description: string; text?: string; model?: string },
  signal?: AbortSignal,
): Promise<{ previews: VoiceDesignPreview[]; text?: string }> {
  requireKey(credentials)
  const description = checkLength(input.description, VOICE_LAB_LIMITS.descriptionMin, VOICE_LAB_LIMITS.descriptionMax, 'The voice description')
  const text = input.text?.trim()
    ? checkLength(input.text, VOICE_LAB_LIMITS.sampleTextMin, VOICE_LAB_LIMITS.sampleTextMax, 'The sample text')
    : undefined
  const body = {
    voice_description: description,
    model_id: input.model ?? ELEVENLABS_VOICE_DESIGN_MODEL,
    ...(text ? { text, auto_generate_text: false } : { auto_generate_text: true }),
  }
  // Previews don't need 192 kbps — the endpoint's default, which lower plans can't use.
  const json = await voiceLabRequest(credentials, `/v1/text-to-voice/design?output_format=${FALLBACK_FORMAT}`, body, {
    action: 'design',
    timeoutMs: TIMEOUTS.voiceDesign,
    signal,
  })
  const previews = (Array.isArray(json.previews) ? json.previews : []).filter(isRecord).flatMap((p): VoiceDesignPreview[] => {
    const generatedVoiceId = asString(p.generated_voice_id)
    const audioBase64 = asString(p.audio_base_64)
    if (!generatedVoiceId || !audioBase64) return []
    return [
      {
        generatedVoiceId,
        audioBase64,
        mediaType: audioMediaType(p.media_type),
        durationSeconds: asNumber(p.duration_secs),
        language: asString(p.language),
      },
    ]
  })
  if (!previews.length) {
    throw new ProviderError(jobError('provider', `${LABEL}: Voice Design returned no previews — try again or describe the voice in more detail`, { retryable: true }))
  }
  return { previews, text: asString(json.text) }
}

/** Keeps a designed preview as a voice in the account (`POST /v1/text-to-voice`). */
export async function createDesignedVoice(
  credentials: Credentials,
  input: { name: string; description: string; generatedVoiceId: string },
  signal?: AbortSignal,
): Promise<{ voiceId: string; name: string }> {
  requireKey(credentials)
  const name = voiceName(input.name)
  const description = checkLength(input.description, VOICE_LAB_LIMITS.descriptionMin, VOICE_LAB_LIMITS.descriptionMax, 'The voice description')
  const generatedVoiceId = requireString(input.generatedVoiceId, 'Pick one of the previews first').trim()
  const json = await voiceLabRequest(
    credentials,
    '/v1/text-to-voice',
    { voice_name: name, voice_description: description, generated_voice_id: generatedVoiceId },
    { action: 'save', timeoutMs: TIMEOUTS.voiceSave, signal },
  )
  return { voiceId: createdVoiceId(json), name: asString(json.name) ?? name }
}

/** Instant Voice Clone (`POST /v1/voices/add`, multipart) from audio files on disk. */
export async function cloneVoice(
  credentials: Credentials,
  input: { name: string; description?: string; files: VoiceSampleFile[]; removeBackgroundNoise?: boolean },
  signal?: AbortSignal,
): Promise<{ voiceId: string; name: string; requiresVerification: boolean }> {
  requireKey(credentials)
  const name = voiceName(input.name)
  if (!input.files.length) throw new ProviderError(jobError('invalid_params', 'Add at least one voice sample'))
  if (input.files.length > VOICE_LAB_LIMITS.cloneFilesMax) {
    throw new ProviderError(jobError('invalid_params', `Use at most ${VOICE_LAB_LIMITS.cloneFilesMax} voice samples`))
  }
  const form = new FormData()
  form.append('name', name)
  const description = input.description?.trim()
  if (description) form.append('description', description)
  form.append('remove_background_noise', input.removeBackgroundNoise ? 'true' : 'false')
  for (const file of input.files) {
    let blob: Blob
    try {
      blob = await fileToBlob(file.path, file.mime)
    } catch {
      throw new ProviderError(jobError('invalid_params', `Voice sample file is missing: ${file.filename}`))
    }
    form.append('files', blob, file.filename)
  }
  const json = await voiceLabRequest(credentials, '/v1/voices/add', form, { action: 'clone', timeoutMs: TIMEOUTS.voiceClone, signal })
  return { voiceId: createdVoiceId(json), name, requiresVerification: json.requires_verification === true }
}

/** POSTs JSON (or multipart for FormData) and reads the JSON reply uncapped — design previews carry base64 audio. */
async function voiceLabRequest(
  credentials: Credentials,
  path: string,
  body: Record<string, unknown> | FormData,
  opts: { action: VoiceLabAction; timeoutMs: number; signal?: AbortSignal },
): Promise<JsonRecord> {
  const form = body instanceof FormData
  const headers: Record<string, string> = { 'xi-api-key': requireKey(credentials), accept: 'application/json' }
  if (!form) headers['content-type'] = 'application/json'
  const res = await httpFetch(
    `${ELEVENLABS_BASE_URL}${path}`,
    { method: 'POST', headers, body: form ? body : JSON.stringify(body) },
    { label: LABEL, signal: opts.signal, timeoutMs: opts.timeoutMs },
  )
  if (!res.ok) throw voiceLabError(opts.action)(res.status, await readText(res))
  return readJson(res)
}

function createdVoiceId(json: JsonRecord): string {
  const voiceId = asString(json.voice_id)
  if (!voiceId) {
    throw new ProviderError(
      jobError('provider', `${LABEL}: the voice may have been created, but no voice id came back — check your voices on elevenlabs.io`, {
        maybeCharged: true,
      }),
    )
  }
  return voiceId
}

function voiceName(value: string): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) throw new ProviderError(jobError('invalid_params', 'Give the voice a name'))
  if ([...name].length > VOICE_LAB_LIMITS.nameMax) {
    throw new ProviderError(jobError('invalid_params', `Voice names can be at most ${VOICE_LAB_LIMITS.nameMax} characters`))
  }
  return name
}

/** Trimmed text within ElevenLabs' character limits (counted in code points, like the API). */
function checkLength(value: string, min: number, max: number, what: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  const length = [...text].length
  if (length < min) throw new ProviderError(jobError('invalid_params', `${what} needs at least ${min} characters (it has ${length})`))
  if (length > max) throw new ProviderError(jobError('invalid_params', `${what} can be at most ${max.toLocaleString('en-US')} characters`))
  return text
}

/** Browser-playable MIME type for a preview (`media_type` is normally "audio/mpeg"). */
function audioMediaType(value: unknown): string {
  const type = asString(value)?.trim().toLowerCase()
  if (type?.includes('/')) return type
  if (type?.includes('wav')) return 'audio/wav'
  return 'audio/mpeg'
}

// ------------------------------------------------------------------------------------------ adapter

export function createElevenLabsAdapter(): ProviderAdapter {
  /** Models for which `/with-timestamps` was rejected — go straight to plain TTS + forced alignment. */
  const noTimestamps = new Set<string>()
  let outputFormat = PREFERRED_FORMAT

  /**
   * POSTs JSON to an audio-producing endpoint (recording it first). Retries once at 128 kbps if the plan
   * rejects 192 kbps — a rejected request is not billed. Returns the raw response; callers check status.
   */
  async function postAudio(
    ctx: JobContext,
    path: string,
    body: unknown,
    opts: { accept: string; timeoutMs: number; note?: string },
  ): Promise<Response> {
    const apiKey = requireKey(ctx.credentials)
    const send = (format: string) => {
      ctx.recordRequest(compact({ endpoint: `POST ${path}`, outputFormat: format, body, note: opts.note }))
      return httpFetch(
        `${ELEVENLABS_BASE_URL}${path}?output_format=${format}`,
        {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: opts.accept },
          body: JSON.stringify(body),
        },
        { label: LABEL, signal: ctx.signal, timeoutMs: opts.timeoutMs },
      )
    }
    const res = await send(outputFormat)
    if (res.ok || outputFormat === FALLBACK_FORMAT) return res
    const text = await readText(res)
    if (!outputFormatRejected(res.status, text)) return new Response(text, { status: res.status, headers: res.headers })
    outputFormat = FALLBACK_FORMAT
    return send(outputFormat)
  }

  async function speech(ctx: JobContext, variant: ElevenLabsTtsVariant): Promise<SubmitResult> {
    const voiceId = requireString(ctx.params.voiceId, 'Pick a voice')
    const text = requireString(ctx.params.text, 'Text is required')
    const body = compact({
      text,
      model_id: variant.apiModelId,
      voice_settings: voiceSettings(variant, ctx.params),
      seed: seedOf(ctx.params),
    })
    const path = `/v1/text-to-speech/${encodeURIComponent(voiceId)}`

    if (!noTimestamps.has(variant.apiModelId)) {
      const res = await postAudio(ctx, `${path}/with-timestamps`, body, { accept: 'application/json', timeoutMs: TIMEOUTS.speech })
      if (res.ok) {
        const json = await readJson(res)
        const audio = decodeAudio(json.audio_base64)
        const words = wordsFromAlignment(json.alignment ?? json.normalized_alignment)
        return done(audio, compact({ alignment: { words, source: 'with-timestamps' }, voiceId, elevenLabsModel: variant.apiModelId }), res)
      }
      const errorBody = await readText(res)
      if (!timestampsUnsupported(res.status, errorBody)) throw elevenLabsError(res.status, errorBody)
      noTimestamps.add(variant.apiModelId)
    }

    // Plain TTS, then forced alignment for word timings.
    const res = await postAudio(ctx, path, body, {
      accept: 'audio/mpeg',
      timeoutMs: TIMEOUTS.speech,
      note: 'timestamps endpoint unsupported for this model — word timings via POST /v1/forced-alignment',
    })
    if (!res.ok) throw elevenLabsError(res.status, await readText(res))
    const audio = await audioBytes(res)
    let alignment: AudioAlignment | undefined
    let alignmentError: string | undefined
    try {
      alignment = await forcedAlignment(ctx, audio, text)
    } catch (err) {
      if (ctx.signal.aborted) throw err
      // The audio is paid for — keep it and report the missing timings instead of failing the job.
      alignmentError = err instanceof Error ? err.message : String(err)
    }
    return done(audio, compact({ alignment, alignmentError, voiceId, elevenLabsModel: variant.apiModelId }), res)
  }

  async function forcedAlignment(ctx: JobContext, audio: Buffer, text: string): Promise<AudioAlignment> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), 'speech.mp3')
    form.append('text', stripAudioTags(text))
    const json = await fetchJson<JsonRecord>(
      `${ELEVENLABS_BASE_URL}/v1/forced-alignment`,
      { method: 'POST', headers: { 'xi-api-key': requireKey(ctx.credentials), accept: 'application/json' }, body: form },
      { label: `${LABEL} forced alignment`, signal: ctx.signal, timeoutMs: TIMEOUTS.alignment, mapError: elevenLabsError },
    )
    const words = (Array.isArray(json.words) ? json.words : []).filter(isRecord).flatMap((w): AlignedWord[] => {
      const text = asString(w.text)?.trim()
      const start = asNumber(w.start)
      const end = asNumber(w.end)
      if (!text || start === undefined || end === undefined || isAudioTag(text)) return []
      return [{ text, start: ms(start), end: ms(end) }]
    })
    return { words, source: 'forced-alignment' }
  }

  async function dialogue(ctx: JobContext): Promise<SubmitResult> {
    const lines = (Array.isArray(ctx.params.lines) ? (ctx.params.lines as DialogueLine[]) : []).filter(
      (l) => typeof l?.text === 'string' && l.text.trim() && typeof l.voiceId === 'string' && l.voiceId,
    )
    if (!lines.length) throw new ProviderError(jobError('invalid_params', 'Dialogue needs at least one line with a voice'))
    const body = compact({
      inputs: lines.map((l) => ({ text: l.text, voice_id: l.voiceId })),
      model_id: ELEVENLABS_DIALOGUE_MODEL,
      settings: typeof ctx.params.stability === 'number' ? { stability: ctx.params.stability } : undefined,
      seed: seedOf(ctx.params),
    })
    const res = await postAudio(ctx, '/v1/text-to-dialogue/with-timestamps', body, { accept: 'application/json', timeoutMs: TIMEOUTS.dialogue })
    if (!res.ok) throw elevenLabsError(res.status, await readText(res))
    const json = await readJson(res)
    const audio = decodeAudio(json.audio_base64)
    const voiceSegments = parseVoiceSegments(json.voice_segments)
    const words = wordsFromAlignment(json.alignment ?? json.normalized_alignment, voiceSegments)
    return done(audio, { alignment: { words, source: 'with-timestamps' }, voiceSegments, elevenLabsModel: ELEVENLABS_DIALOGUE_MODEL }, res)
  }

  async function soundEffect(ctx: JobContext): Promise<SubmitResult> {
    const prompt = requireString(ctx.params.prompt, 'Describe the sound')
    const duration = ctx.params.autoDuration === false ? asNumber(ctx.params.durationSeconds) : undefined
    const body = compact({
      text: prompt,
      model_id: ELEVENLABS_SFX_MODEL,
      duration_seconds: duration === undefined ? undefined : clamp(duration, 0.5, 30),
      loop: ctx.params.loop === true,
      prompt_influence: asNumber(ctx.params.promptInfluence),
    })
    const res = await postAudio(ctx, '/v1/sound-generation', body, { accept: 'audio/mpeg', timeoutMs: TIMEOUTS.sfx })
    if (!res.ok) throw elevenLabsError(res.status, await readText(res))
    return done(await audioBytes(res), compact({ loop: body.loop || undefined, elevenLabsModel: ELEVENLABS_SFX_MODEL }), res)
  }

  async function music(ctx: JobContext): Promise<SubmitResult> {
    const prompt = requireString(ctx.params.prompt, 'Describe the music')
    const seconds = asNumber(ctx.params.durationSeconds) ?? 30
    const body = {
      prompt,
      music_length_ms: Math.round(clamp(seconds, 3, 600) * 1000),
      model_id: ELEVENLABS_MUSIC_MODEL,
      force_instrumental: ctx.params.instrumental === true,
    }
    const res = await postAudio(ctx, '/v1/music', body, { accept: 'audio/mpeg', timeoutMs: TIMEOUTS.music })
    if (!res.ok) throw elevenLabsError(res.status, await readText(res))
    return done(await audioBytes(res), { elevenLabsModel: ELEVENLABS_MUSIC_MODEL }, res)
  }

  return {
    id: 'elevenlabs',
    label: LABEL,
    version: '2026-09-28.1',
    credentialFields: ['apiKey'],
    requiredFields: ['apiKey'],
    defaultConcurrency: 3,
    pollIntervalMs: 2000,

    async test(credentials: Credentials): Promise<ProviderTestResult> {
      const apiKey = credentials.apiKey
      if (!apiKey) return { ok: false, message: 'Missing API key' }
      const headers = { 'xi-api-key': apiKey, accept: 'application/json' }
      const res = await httpFetch(`${ELEVENLABS_BASE_URL}/v1/user/subscription`, { headers }, { label: LABEL, timeoutMs: TIMEOUTS.meta })
      if (res.ok) {
        const json = (parseJson(await readText(res)) ?? {}) as JsonRecord
        const limit = asNumber(json.character_limit)
        const used = asNumber(json.character_count) ?? 0
        const reset = asNumber(json.next_character_count_reset_unix)
        const tier = asString(json.tier)
        return {
          ok: true,
          message: `Connected${tier ? ` — ${tier.charAt(0).toUpperCase()}${tier.slice(1).replace(/_/g, ' ')} plan` : ''}`,
          credits:
            limit === undefined
              ? undefined
              : {
                  label: 'ElevenLabs credits',
                  remaining: Math.max(0, limit - used),
                  limit,
                  unit: 'credits',
                  resetsAt: reset ? new Date(reset * 1000).toISOString() : undefined,
                },
        }
      }
      const body = await readText(res)
      const error = elevenLabsError(res.status, body)
      if (error.jobError.code === 'auth' && /permission/i.test(body)) {
        // Restricted keys may lack "User: read" but still generate; confirm with a voices call.
        const probe = await httpFetch(`${ELEVENLABS_BASE_URL}/v2/voices?page_size=1`, { headers }, { label: LABEL, timeoutMs: TIMEOUTS.meta })
        if (probe.ok) return { ok: true, message: 'Connected — this key can’t read subscription info, so remaining credits aren’t shown' }
      }
      return { ok: false, message: error.message }
    },

    async submit(ctx: JobContext): Promise<SubmitResult> {
      const variant = elevenLabsTtsVariant(ctx.model.id)
      if (variant) return speech(ctx, variant)
      switch (ctx.model.kind) {
        case 'dialogue':
          return dialogue(ctx)
        case 'sfx':
          return soundEffect(ctx)
        case 'music':
          return music(ctx)
        default:
          throw new ProviderError(jobError('internal', `${LABEL}: model ${ctx.model.id} is not supported by this adapter`))
      }
    },
  }
}

// ------------------------------------------------------------------------------------------ errors

interface ElevenErrorInfo {
  code: string
  type: string
  message: string
  detail: unknown
  data?: JsonRecord
}

function errorInfo(body: string): ElevenErrorInfo {
  const json = parseJson(body)
  const detail = isRecord(json) ? json.detail : undefined
  const d = isRecord(detail) ? detail : {}
  const firstIssue = Array.isArray(detail) && isRecord(detail[0]) ? detail[0] : undefined
  return {
    code: (firstString(d.code, d.status, isRecord(json) ? json.code : undefined) ?? '').toLowerCase(),
    type: (asString(d.type) ?? '').toLowerCase(),
    message:
      firstString(d.message, typeof detail === 'string' ? detail : undefined, firstIssue?.msg, isRecord(json) ? json.message : undefined) ??
      body.slice(0, 300),
    detail,
    data: isRecord(d.data) ? d.data : undefined,
  }
}

/** Maps an ElevenLabs error response to a normalized provider error. */
export function elevenLabsError(status: number, body: string): ProviderError {
  const { code, type, message, data } = errorInfo(body)
  const say = (fallback: string) => message || fallback
  if (['quota_exceeded', 'insufficient_credits', 'payment_required'].includes(code) || type === 'payment_required' || status === 402)
    return new ProviderError(jobError('insufficient_credits', `${LABEL}: not enough credits — ${say('top up or upgrade your plan')}`))
  if (code.includes('bad_prompt')) {
    const suggestion = data ? asString(data.prompt_suggestion) : undefined
    return new ProviderError(
      jobError('invalid_params', `${LABEL} rejected the prompt: ${say('it may reference an artist or copyrighted work')}${suggestion ? ` — try: “${suggestion}”` : ''}`),
    )
  }
  if (/moderat|content_policy|policy_violation|safety|flagged|blocked_content|tos_violation/.test(code) || /content polic|moderation|terms of service/i.test(message))
    return new ProviderError(jobError('moderation', `${LABEL} blocked the request: ${say('content policy')}`))
  if (code === 'voice_not_found')
    return new ProviderError(jobError('invalid_params', `${LABEL}: voice not found — pick another voice (${say('unknown voice id')})`))
  if (['rate_limit_exceeded', 'concurrent_limit_exceeded', 'too_many_concurrent_requests', 'system_busy'].includes(code) || status === 429)
    return new ProviderError(jobError('rate_limited', `${LABEL}: ${say('rate limited')}`, { retryable: true }))
  if (status === 401 || status === 403) {
    const authish = /key|auth|permission|unusual_activity/.test(code) || /api key|permission|unauthori|authenticat/i.test(message)
    if (status === 403 && !authish) return new ProviderError(jobError('provider', `${LABEL}: ${say('request not allowed on this plan')}`))
    return new ProviderError(jobError('auth', `${LABEL}: ${say('invalid API key')}`))
  }
  return httpError(status, body, LABEL)
}

/**
 * Voice Lab errors: full custom-voice slots, plan limits (Instant Voice Cloning needs the Starter plan or above), a busy
 * design queue and expired previews get actionable messages; everything else maps like generation errors.
 */
export function voiceLabError(action: VoiceLabAction): ErrorMapper {
  return (status, body) => {
    const base = elevenLabsError(status, body)
    if (['insufficient_credits', 'rate_limited', 'moderation'].includes(base.jobError.code)) return base
    const { code, message, detail } = errorInfo(body)
    const said = `${code} ${message}`
    const quoted = message ? ` (${message})` : ''
    if (/voice_limit|maximum (amount|number) of (custom )?voices|custom voice (slots?|limit)/i.test(said)) {
      return new ProviderError(
        jobError('provider', `${LABEL}: all your custom voice slots are in use — remove a voice on elevenlabs.io or upgrade your plan${quoted}`),
      )
    }
    if (status === 409) {
      return new ProviderError(jobError('rate_limited', `${LABEL}: a voice generation is already running — try again in a moment`, { retryable: true }))
    }
    const authish = /invalid_api_key|api[ _]key|permission|unauthori[sz]ed|authenticat/i.test(said)
    if (!authish && /can_?not_use|instant_voice_clon|subscription|upgrade|your plan|\btier\b/i.test(said)) {
      return new ProviderError(
        jobError(
          'provider',
          action === 'clone'
            ? `${LABEL}: your plan doesn’t include Instant Voice Cloning — it needs the Starter plan or above${quoted}`
            : `${LABEL}: not available on your plan${quoted}`,
        ),
      )
    }
    if (action === 'save' && !authish && (status === 404 || /not_found|not found|expired/i.test(said))) {
      return new ProviderError(jobError('invalid_params', `${LABEL}: this preview is no longer available — generate new previews${quoted}`))
    }
    const issue = Array.isArray(detail) && isRecord(detail[0]) ? detail[0] : undefined
    const field = issue && Array.isArray(issue.loc) ? issue.loc.filter((part) => part !== 'body').join('.') : ''
    if (base.jobError.code === 'invalid_params' && field && message && !message.includes(field)) {
      return new ProviderError(jobError('invalid_params', `${LABEL}: ${field}: ${message}`))
    }
    return base
  }
}

/** True when `/with-timestamps` rejected the model/endpoint (not the text, voice or account). */
export function timestampsUnsupported(status: number, body: string): boolean {
  if (![400, 404, 405, 422].includes(status)) return false
  const { code, message, detail } = errorInfo(body)
  if (/voice|quota|credit|text_too_long/.test(code) || /\bvoice\b/i.test(message)) return false
  if (/model|not_supported|unsupported/.test(code)) return true
  if (/\bmodel|timestamp|alignment|not (yet )?supported|endpoint/i.test(message)) return true
  if (Array.isArray(detail) && detail.some((e) => isRecord(e) && Array.isArray(e.loc) && e.loc.includes('model_id'))) return true
  return status === 404 || status === 405
}

function outputFormatRejected(status: number, body: string): boolean {
  if (![400, 401, 403, 422].includes(status)) return false
  const { code, message } = errorInfo(body)
  return /output_format|format_not_allowed/.test(code) || /output[_ ]format|44100_192|192 ?kbps/i.test(message)
}

// ------------------------------------------------------------------------------------------ alignment

/** Strips inline audio tags ([whispering], [laughs softly]) — they are not spoken. */
export function stripAudioTags(text: string): string {
  return text
    .replace(/\[[^\]\n]{0,80}\]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

const isAudioTag = (word: string) => /^\[.*\]$/.test(word)

/**
 * Word timings from ElevenLabs' character alignment. Audio tags are skipped; for dialogue, words never
 * span two voice segments and carry the segment's voice and line.
 */
export function wordsFromAlignment(alignment: unknown, segments: VoiceSegment[] = []): AlignedWord[] {
  if (!isRecord(alignment)) return []
  const chars = Array.isArray(alignment.characters) ? alignment.characters.map((c) => (typeof c === 'string' ? c : '')) : []
  const starts = Array.isArray(alignment.character_start_times_seconds) ? alignment.character_start_times_seconds : []
  const ends = Array.isArray(alignment.character_end_times_seconds) ? alignment.character_end_times_seconds : []
  const boundaries = new Set(segments.map((s) => s.charStart))
  const segmentAt = (index: number) => {
    let found: VoiceSegment | undefined
    for (const s of segments) if (s.charStart <= index) found = s
    return found
  }
  const words: AlignedWord[] = []
  let text = ''
  let first = -1
  let start = 0
  let end = 0
  let tagDepth = 0
  const flush = () => {
    if (text.trim()) {
      const seg = segments.length ? segmentAt(first) : undefined
      words.push(compact({ text, start: ms(start), end: ms(end), voiceId: seg?.voiceId, line: seg?.line }) as AlignedWord)
    }
    text = ''
    first = -1
  }
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!
    if (boundaries.has(i)) flush()
    if (ch === '[') {
      flush()
      tagDepth++
      continue
    }
    if (ch === ']' && tagDepth > 0) {
      tagDepth--
      continue
    }
    if (tagDepth > 0) continue
    if (!ch.trim()) {
      flush()
      continue
    }
    if (first < 0) {
      first = i
      start = asNumber(starts[i]) ?? end
    }
    text += ch
    end = asNumber(ends[i]) ?? start
  }
  flush()
  return words
}

function parseVoiceSegments(value: unknown): VoiceSegment[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).flatMap((s): VoiceSegment[] => {
    const voiceId = asString(s.voice_id)
    const start = asNumber(s.start_time_seconds)
    const end = asNumber(s.end_time_seconds)
    if (!voiceId || start === undefined || end === undefined) return []
    return [
      {
        voiceId,
        start: ms(start),
        end: ms(end),
        line: asNumber(s.dialogue_input_index) ?? 0,
        charStart: asNumber(s.character_start_index) ?? 0,
        charEnd: asNumber(s.character_end_index) ?? 0,
      },
    ]
  })
}

// ------------------------------------------------------------------------------------------ helpers

function voiceSettings(variant: ElevenLabsTtsVariant, params: ParamValues): Record<string, number | boolean> | undefined {
  const settings: Record<string, number | boolean> = {}
  const stability = asNumber(params.stability)
  if (stability !== undefined) settings.stability = stability
  const similarity = asNumber(params.similarity)
  if (variant.settings.similarity && similarity !== undefined) settings.similarity_boost = similarity
  const style = asNumber(params.style)
  if (variant.settings.style && style !== undefined) settings.style = style
  const speed = asNumber(params.speed)
  if (variant.settings.speed && speed !== undefined) settings.speed = speed
  if (variant.settings.speakerBoost) settings.use_speaker_boost = true
  return Object.keys(settings).length ? settings : undefined
}

function done(audio: Buffer, meta: Record<string, unknown>, res: Response): SubmitResult {
  const output: ProviderOutput = { kind: 'buffer', data: audio, ext: 'mp3', meta }
  const alignment = meta.alignment as AudioAlignment | undefined
  return {
    type: 'done',
    outputs: [output],
    response: compact({
      requestId: res.headers.get('request-id') ?? undefined,
      characterCost: res.headers.get('character-cost') ?? undefined,
      bytes: audio.length,
      words: alignment?.words.length,
      alignment: alignment?.source,
      alignmentError: meta.alignmentError,
    }),
  }
}

async function readJson(res: Response): Promise<JsonRecord> {
  const text = await readText(res, Number.POSITIVE_INFINITY)
  const json = parseJson(text)
  if (!isRecord(json)) throw new Error(`${LABEL}: unexpected response (${text.slice(0, 200) || 'empty body'})`)
  return json
}

async function audioBytes(res: Response): Promise<Buffer> {
  const audio = Buffer.from(await res.arrayBuffer())
  if (!audio.length) throw new Error(`${LABEL}: empty audio response`)
  return audio
}

function decodeAudio(value: unknown): Buffer {
  const b64 = asString(value)
  const audio = b64 ? Buffer.from(b64, 'base64') : Buffer.alloc(0)
  if (!audio.length) throw new Error(`${LABEL}: response contained no audio`)
  return audio
}

function requireKey(credentials: Credentials): string {
  if (!credentials.apiKey) throw new ProviderError(jobError('auth', `${LABEL}: missing API key — add it in Settings → Providers`))
  return credentials.apiKey
}

function requireString(value: unknown, message: string): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new ProviderError(jobError('invalid_params', message))
}

function seedOf(params: ParamValues): number | undefined {
  const seed = asNumber(params.seed)
  return seed === undefined ? undefined : Math.trunc(seed)
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const ms = (seconds: number) => Math.round(seconds * 1000) / 1000
