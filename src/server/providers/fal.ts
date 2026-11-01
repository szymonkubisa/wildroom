import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { createFalClient } from '@fal-ai/client'
import {
  type FalAspect,
  FLUX2_SIZES,
  RECRAFT_SIZES,
  SEEDREAM5_SIZES,
  gptImageSize,
  ideogramSize,
  klingFalTier,
  sizeForArea,
} from '../../shared/models/catalog/fal'
import type { ParamValues } from '../../shared/models/types'
import type { ProviderTestResult } from '../../shared/types/api'
import type { Credentials } from '../services/keychain'
import {
  type JsonRecord,
  asNumber,
  asString,
  compact,
  extFrom,
  fileToBlob,
  firstString,
  httpFetch,
  isRecord,
  parseJson,
  readText,
  summarizePayload,
} from './http'
import { type ImageInputLimits, fitImageInput } from './imageInput'

/** Kept here for callers that import it with the fal adapter. */
export { inputScale } from './imageInput'
import {
  type JobContext,
  type PollResult,
  type ProviderAdapter,
  type ProviderOutput,
  ProviderError,
  type ResolvedInput,
  type SubmitResult,
  jobError,
} from './types'

/**
 * Generic fal.ai adapter. Every model is a row in FAL_ROUTES: which endpoint to call for the given
 * params/inputs, how to build its input and where the files are in its result — new models are data only.
 * Input assets are uploaded to fal storage; results are polled (webhooks can't reach localhost).
 */

const LABEL = 'fal'

// ------------------------------------------------------------------------------------ client

/** The slice of `@fal-ai/client` the adapter uses (injectable for tests). */
export interface FalClientLike {
  queue: {
    submit(endpointId: string, options: { input: Record<string, unknown>; abortSignal?: AbortSignal }): Promise<{ request_id: string }>
    status(
      endpointId: string,
      options: { requestId: string; logs?: boolean; abortSignal?: AbortSignal },
    ): Promise<{ status: string; queue_position?: number }>
    result(endpointId: string, options: { requestId: string; abortSignal?: AbortSignal }): Promise<{ data: unknown; requestId?: string }>
    cancel(endpointId: string, options: { requestId: string; abortSignal?: AbortSignal }): Promise<void>
  }
  storage: { upload(file: Blob): Promise<string> }
}

export type FalClientFactory = (apiKey: string) => FalClientLike

/** One client per API key — never the global `fal.config`. */
const defaultClientFactory: FalClientFactory = (apiKey) => createFalClient({ credentials: apiKey, fetch: submitOnce() }) as unknown as FalClientLike

const FAL_QUEUE_HOST = 'queue.fal.run'
/** Transport failures before any connection was made: the request never reached fal, sending it again is safe. */
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])

/**
 * The fetch the fal client uses. The client retries a queue submit by itself on 502/503/504 and on dropped connections
 * (its QUEUE_RETRY_CONFIG overrides any `retry` option): when fal had already queued the first request, every retry is
 * a second billed generation and the first is orphaned. For submits (POST to the queue) this turns those failures into
 * an error the client does not retry (no ApiError status, no transport code), so the job comes back as "outcome
 * unknown" for the user to check instead of being paid twice. 429 and a connection that never opened are refusals:
 * still retried. Everything else passes through untouched.
 */
export function submitOnce(inner?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const send = inner ?? globalThis.fetch
    const request = input instanceof Request ? input : undefined
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    if (method !== 'POST' || new URL(request ? request.url : String(input)).hostname !== FAL_QUEUE_HOST) return send(input, init)
    let res: Response | undefined
    let text: string
    try {
      res = await send(input, init)
      // Read here: an answer cut off halfway fails in the client otherwise, which retries that too.
      text = await res.text()
    } catch (err) {
      if (init?.signal?.aborted || request?.signal.aborted || (!res && errorCodes(err).some((code) => NEVER_SENT.has(code)))) throw err
      const why = err instanceof Error ? (errorCodes(err)[0] ?? err.message) : String(err)
      throw new Error(`${LABEL}: the connection dropped while submitting (${why}) — fal may have queued it anyway`)
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new Error(`${LABEL}: HTTP ${res.status} while submitting${text ? ` (${errorText(text) || text.slice(0, 120)})` : ''} — fal may have queued it anyway`)
    }
    return new Response(text || null, { status: res.status, statusText: res.statusText, headers: res.headers })
  }
}

/** Error codes along an error's cause chain (Node's fetch wraps the socket error: TypeError('fetch failed').cause). */
function errorCodes(err: unknown): string[] {
  const codes: string[] = []
  const seen = new Set<unknown>()
  const visit = (e: unknown) => {
    if (!e || typeof e !== 'object' || seen.has(e)) return
    seen.add(e)
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string') codes.push(code)
    visit((e as { cause?: unknown }).cause)
    const errors = (e as { errors?: unknown }).errors
    if (Array.isArray(errors)) errors.forEach(visit)
  }
  visit(err)
  return codes
}

// ------------------------------------------------------------------------------------ routes

/** Uploaded input URLs by param key (arrays for multi-image params). */
export type FalInputUrls = Record<string, string | string[] | undefined>

export interface FalRoute {
  /** fal endpoint id for these params and uploaded inputs. */
  endpoint(params: ParamValues, urls: FalInputUrls): string
  /** Request input for that endpoint (undefined fields are dropped). */
  toInput(params: ParamValues, urls: FalInputUrls, endpointId: string): Record<string, unknown>
  /** Files in the endpoint's result payload. */
  extractOutputs(data: unknown, params: ParamValues): ProviderOutput[]
  /** Size limits of the endpoint's image inputs: larger images are scaled down (PNG) before upload. */
  input?: ImageInputLimits
}

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined)
const int = (v: unknown, fallback: number) => Math.round(asNumber(v) ?? fallback)
const seedOf = (p: ParamValues) => {
  const seed = asNumber(p.seed)
  return seed === undefined ? undefined : Math.trunc(seed)
}
const one = (urls: FalInputUrls, key: string) => {
  const u = urls[key]
  return Array.isArray(u) ? u[0] : u
}
const many = (urls: FalInputUrls, key: string) => {
  const u = urls[key]
  return Array.isArray(u) ? u : u ? [u] : []
}

function frames(urls: FalInputUrls, opts: { lastNeedsFirst?: boolean } = { lastNeedsFirst: true }) {
  const first = one(urls, 'firstFrame')
  const last = one(urls, 'lastFrame')
  if (last && !first && opts.lastNeedsFirst) throw new ProviderError(jobError('invalid_params', 'An end frame needs a start frame'))
  return { first, last }
}

function required(url: string | undefined, what: string): string {
  if (!url) throw new ProviderError(jobError('invalid_params', `${what} is required`))
  return url
}

function fileOutputs(file: unknown, fallbackExt: string, meta?: Record<string, unknown>): ProviderOutput[] {
  if (typeof file === 'string' && file) return [{ kind: 'url', url: file, ext: extFrom(undefined, file) ?? fallbackExt }]
  if (!isRecord(file)) return []
  const url = asString(file.url)
  if (!url) return []
  const m = compact({ ...meta, width: asNumber(file.width), height: asNumber(file.height) })
  return [{ kind: 'url', url, ext: extFrom(file.content_type, url) ?? fallbackExt, ...(Object.keys(m).length ? { meta: m } : {}) }]
}

/** Seed / rewritten prompt some models report back — kept on the asset. */
const resultMeta = (data: unknown) =>
  isRecord(data) ? compact({ seed: asNumber(data.seed), expandedPrompt: firstString(data.expanded_prompt, data.actual_prompt) }) : {}

const videoOut = (data: unknown) => fileOutputs(isRecord(data) ? data.video : undefined, 'mp4', resultMeta(data))
const audioOut = (data: unknown) => fileOutputs(isRecord(data) ? data.audio : undefined, 'wav', resultMeta(data))
/** Single-image results (`image: File`), e.g. upscalers. */
const imageOut = (data: unknown) => fileOutputs(isRecord(data) ? data.image : undefined, 'png', resultMeta(data))

const upscaleFactor = (p: ParamValues) => asNumber(p.scale) ?? 2
/** Topaz frame-interpolation target; 0 / unset keeps the source rate. */
const targetFps = (p: ParamValues) => {
  const fps = asNumber(p.targetFps)
  return fps && fps > 0 ? Math.round(fps) : undefined
}
const imagesOut = (data: unknown) =>
  (isRecord(data) && Array.isArray(data.images) ? data.images : []).flatMap((img) => fileOutputs(img, 'png', resultMeta(data)))

function nanoBanana(base: string): FalRoute {
  return {
    endpoint: (_p, urls) => (many(urls, 'referenceImages').length ? `${base}/edit` : base),
    toInput: (p, urls) => {
      const refs = many(urls, 'referenceImages')
      return compact({
        prompt: p.prompt,
        image_urls: refs.length ? refs : undefined,
        aspect_ratio: str(p.aspectRatio),
        resolution: str(p.resolution),
        seed: seedOf(p),
        num_images: 1,
        output_format: 'png',
      })
    },
    extractOutputs: imagesOut,
  }
}

function imageSize<T extends Record<FalAspect, { width: number; height: number }>>(table: T, aspect: unknown) {
  return typeof aspect === 'string' && aspect in table ? table[aspect as FalAspect] : undefined
}

/**
 * Veo 3.1 at `fal-ai/veo3.1[/fast]/…`: reference images ("ingredients") → reference-to-video (no frames, no negative
 * prompt or seed, always 8 s); start + end frame → first-last-frame-to-video; a start frame → image-to-video.
 */
function veo(base: string): FalRoute {
  return {
    endpoint: (_p, urls) => {
      if (many(urls, 'referenceImages').length) return `${base}/reference-to-video`
      const { first, last } = frames(urls)
      return first && last ? `${base}/first-last-frame-to-video` : first ? `${base}/image-to-video` : base
    },
    toInput: (p, urls) => {
      const refs = many(urls, 'referenceImages')
      if (refs.length) {
        return compact({
          prompt: p.prompt,
          image_urls: refs,
          duration: '8s',
          aspect_ratio: str(p.aspectRatio),
          resolution: str(p.resolution),
          generate_audio: p.audio !== false,
        })
      }
      const { first, last } = frames(urls)
      return compact({
        prompt: p.prompt,
        negative_prompt: str(p.negativePrompt),
        ...(first && last ? { first_frame_url: first, last_frame_url: last } : { image_url: first }),
        duration: `${int(p.duration, 8)}s`,
        aspect_ratio: first ? undefined : str(p.aspectRatio),
        resolution: str(p.resolution),
        generate_audio: p.audio !== false,
        seed: seedOf(p),
      })
    },
    extractOutputs: videoOut,
  }
}

/**
 * fal's Kling `elements` from the storyboard's flat lists (catalog: elementImages + elementCounts): each element's
 * front view, then its other angles — @Element1, @Element2… in the prompt. Undefined without element images.
 */
function klingElements(p: ParamValues, urls: FalInputUrls): { frontal_image_url: string; reference_image_urls: string[] }[] | undefined {
  const images = many(urls, 'elementImages')
  if (!images.length) return undefined
  const counts = Array.isArray(p.elementCounts) ? p.elementCounts.map((n) => Math.round(Number(n))) : []
  if (counts.reduce((a, b) => a + b, 0) !== images.length || counts.some((n) => !(n >= 2)))
    throw new ProviderError(jobError('invalid_params', 'Each Kling element needs a front view and 1–3 more angles'))
  let at = 0
  return counts.map((n) => {
    const views = images.slice(at, (at += n))
    return { frontal_image_url: views[0]!, reference_image_urls: views.slice(1) }
  })
}

/** Kling's own shot list (catalog: multiPrompt), with fal's string durations ("1"…"15"); undefined without one. */
function klingMultiPrompt(p: ParamValues): { prompt: string; duration: string }[] | undefined {
  const shots = Array.isArray(p.multiPrompt) ? p.multiPrompt.filter(isRecord) : []
  return shots.length ? shots.map((s) => ({ prompt: String(s.prompt ?? ''), duration: String(int(s.duration, 1)) })) : undefined
}

/**
 * Kling O3 at `fal-ai/kling-video/o3/{tier}/…`: elements or reference images → reference-to-video (a start and end
 * frame allowed there), a start frame alone → image-to-video, else text-to-video.
 */
function klingO3(tier: (p: ParamValues) => string): FalRoute {
  const toReference = (urls: FalInputUrls) => many(urls, 'referenceImages').length > 0 || many(urls, 'elementImages').length > 0
  return {
    endpoint: (p, urls) =>
      `fal-ai/kling-video/o3/${tier(p)}/${toReference(urls) ? 'reference-to-video' : frames(urls).first ? 'image-to-video' : 'text-to-video'}`,
    toInput: (p, urls) => {
      const refs = many(urls, 'referenceImages')
      const { first, last } = frames(urls)
      const base = { prompt: p.prompt, duration: String(int(p.duration, 5)), generate_audio: p.audio === true }
      if (toReference(urls)) {
        return compact({
          ...base,
          image_urls: refs.length ? refs : undefined,
          elements: klingElements(p, urls),
          start_image_url: first,
          end_image_url: last,
          aspect_ratio: str(p.aspectRatio),
        })
      }
      return compact({ ...base, image_url: first, end_image_url: last, aspect_ratio: first ? undefined : str(p.aspectRatio) })
    },
    extractOutputs: videoOut,
  }
}

function custom(fallbackExt: string): FalRoute {
  return {
    endpoint: (p) => {
      const id = str(p.endpointId)?.trim()
      if (!id) throw new ProviderError(jobError('invalid_params', 'Endpoint id is required'))
      return id
    },
    toInput: (p, urls) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(p.inputJson ?? '{}'))
      } catch (err) {
        throw new ProviderError(jobError('invalid_params', `Input JSON is not valid: ${err instanceof Error ? err.message : String(err)}`))
      }
      if (!isRecord(parsed)) throw new ProviderError(jobError('invalid_params', 'Input JSON must be an object'))
      return fillPlaceholders(parsed, {
        prompt: str(p.prompt),
        image: one(urls, 'image'),
        video: one(urls, 'video'),
        audio: one(urls, 'audioClip'),
      }) as Record<string, unknown>
    },
    extractOutputs: (data, p) => outputsAtPath(data, String(p.outputPath ?? ''), fallbackExt),
  }
}

/** Model id → fal endpoint mapping. Field names follow each endpoint's OpenAPI schema (2026-09-28). */
export const FAL_ROUTES: Record<string, FalRoute> = {
  'fal-nano-banana-pro': nanoBanana('fal-ai/nano-banana-pro'),
  'fal-nano-banana-2': nanoBanana('fal-ai/nano-banana-2'),

  'fal-seedream-5-pro': {
    endpoint: (_p, urls) =>
      many(urls, 'referenceImages').length ? 'bytedance/seedream/v5/pro/edit' : 'bytedance/seedream/v5/pro/text-to-image',
    toInput: (p, urls) => {
      const refs = many(urls, 'referenceImages')
      const tier = p.resolution === 'standard' ? 'standard' : 'high'
      return compact({
        prompt: p.prompt,
        image_urls: refs.length ? refs : undefined,
        image_size: imageSize(SEEDREAM5_SIZES[tier], p.aspectRatio) ?? (tier === 'standard' ? 'auto_1K' : 'auto_2K'),
        num_images: 1,
        output_format: 'png',
      })
    },
    extractOutputs: imagesOut,
  },

  'fal-flux-2-pro': {
    endpoint: (_p, urls) => (many(urls, 'referenceImages').length ? 'fal-ai/flux-2-pro/edit' : 'fal-ai/flux-2-pro'),
    toInput: (p, urls) => {
      const refs = many(urls, 'referenceImages')
      const tier = (str(p.resolution) ?? '2MP') as keyof typeof FLUX2_SIZES
      return compact({
        prompt: p.prompt,
        image_urls: refs.length ? refs : undefined,
        image_size: imageSize(FLUX2_SIZES[tier] ?? FLUX2_SIZES['2MP'], p.aspectRatio) ?? 'auto',
        seed: seedOf(p),
        output_format: 'png',
      })
    },
    extractOutputs: imagesOut,
  },

  // Image models added 2026-10-02 (schemas checked that day).
  'fal-gpt-image-2.5': {
    endpoint: (p, urls) =>
      `openai/gpt-image-2.5/${p.tier === 'sunburst' ? 'sunburst' : 'flare'}/${many(urls, 'referenceImages').length ? 'edit' : 'text-to-image'}`,
    toInput: (p, urls) => {
      const refs = many(urls, 'referenceImages')
      return compact({
        prompt: p.prompt,
        image_urls: refs.length ? refs : undefined,
        image_size: gptImageSize(p.aspectRatio, p.resolution) ?? 'auto',
        quality: str(p.quality) ?? 'high',
        background: p.transparent === true ? 'transparent' : undefined,
        num_images: 1,
        output_format: 'png',
      })
    },
    extractOutputs: imagesOut,
  },

  'fal-recraft-v3': {
    endpoint: () => 'fal-ai/recraft/v3/text-to-image',
    toInput: (p) => compact({ prompt: p.prompt, style: str(p.style), image_size: RECRAFT_SIZES[String(p.aspectRatio)] ?? 'landscape_16_9' }),
    extractOutputs: imagesOut,
  },

  'fal-recraft-v4.1-vector': {
    endpoint: (p) => (p.pro === true ? 'fal-ai/recraft/v4.1/pro/text-to-vector' : 'fal-ai/recraft/v4.1/text-to-vector'),
    toInput: (p) => compact({ prompt: p.prompt, image_size: RECRAFT_SIZES[String(p.aspectRatio)] ?? 'square_hd' }),
    extractOutputs: (data) =>
      (isRecord(data) && Array.isArray(data.images) ? data.images : []).flatMap((img) => fileOutputs(img, 'svg', resultMeta(data))),
  },

  'fal-ideogram-v4': {
    endpoint: (_p, urls) => (one(urls, 'referenceImages') ? 'ideogram/v4/image-to-image' : 'ideogram/v4'),
    toInput: (p, urls) => {
      const image = one(urls, 'referenceImages')
      return compact({
        prompt: p.prompt,
        image_url: image,
        strength: image ? asNumber(p.strength) : undefined,
        image_size: ideogramSize(p.aspectRatio, p.resolution) ?? 'auto',
        rendering_speed: (str(p.speed) ?? 'balanced').toUpperCase(),
        expansion_model: p.promptExpansion === true ? 'Medium' : 'None',
        seed: seedOf(p),
        num_images: 1,
        output_format: 'png',
      })
    },
    extractOutputs: imagesOut,
  },

  'fal-krea-2': {
    endpoint: (p) => (p.tier === 'turbo' ? 'fal-ai/krea-2/turbo' : `krea/v2/${p.tier === 'large' ? 'large' : 'medium'}/text-to-image`),
    toInput: (p, urls) => {
      if (p.tier === 'turbo') {
        return compact({ prompt: p.prompt, image_size: sizeForArea(p.aspectRatio, 2 ** 20), seed: seedOf(p), num_images: 1, output_format: 'png' })
      }
      const refs = many(urls, 'referenceImages')
      return compact({
        prompt: p.prompt,
        aspect_ratio: str(p.aspectRatio),
        creativity: str(p.creativity),
        image_style_references: refs.length ? refs.map((url) => ({ image_url: url, strength: 1 })) : undefined,
        seed: seedOf(p),
      })
    },
    extractOutputs: imagesOut,
  },

  'fal-mai-image-2.5': {
    endpoint: (_p, urls) => (one(urls, 'referenceImages') ? 'microsoft/mai-image-2.5/edit' : 'microsoft/mai-image-2.5'),
    toInput: (p, urls) => {
      const image = one(urls, 'referenceImages')
      return compact({ prompt: p.prompt, image_urls: image ? [image] : undefined, aspect_ratio: str(p.aspectRatio), num_images: 1, output_format: 'png' })
    },
    extractOutputs: imagesOut,
  },

  'fal-veo3.1': veo('fal-ai/veo3.1'),
  'fal-veo3.1-fast': veo('fal-ai/veo3.1/fast'),

  'fal-seedance-2.5': {
    endpoint: (_p, urls) =>
      many(urls, 'referenceImages').length
        ? 'bytedance/seedance-2.5/reference-to-video'
        : frames(urls).first
          ? 'bytedance/seedance-2.5/image-to-video'
          : 'bytedance/seedance-2.5/text-to-video',
    toInput: (p, urls) => {
      const refs = many(urls, 'referenceImages')
      if (refs.length) {
        return compact({
          prompt: p.prompt,
          image_urls: refs,
          duration: String(int(p.duration, 5)),
          resolution: str(p.resolution),
          aspect_ratio: str(p.aspectRatio),
          generate_audio: p.audio !== false,
        })
      }
      const { first, last } = frames(urls)
      return compact({
        prompt: p.prompt,
        image_url: first,
        end_image_url: last,
        duration: String(int(p.duration, 5)),
        resolution: str(p.resolution),
        aspect_ratio: first ? undefined : str(p.aspectRatio),
        generate_audio: p.audio !== false,
      })
    },
    extractOutputs: videoOut,
  },

  'fal-wan-3.0': {
    endpoint: (_p, urls) => (frames(urls).first ? 'alibaba/wan-3.0/image-to-video' : 'alibaba/wan-3.0/text-to-video'),
    toInput: (p, urls) => {
      const { first, last } = frames(urls)
      return compact({
        prompt: p.prompt,
        start_image_url: first,
        end_image_url: last,
        duration: int(p.duration, 5),
        resolution: str(p.resolution),
        aspect_ratio: first ? undefined : str(p.aspectRatio),
        audio: p.audio !== false,
        seed: seedOf(p),
      })
    },
    extractOutputs: videoOut,
  },

  'fal-minimax-h3-max': {
    endpoint: (_p, urls) => {
      const { first, last } = frames(urls, { lastNeedsFirst: false })
      return first || last ? 'minimax/h3-max/image-to-video' : 'minimax/h3-max/text-to-video'
    },
    toInput: (p, urls) => {
      const { first, last } = frames(urls, { lastNeedsFirst: false })
      return compact({
        prompt: p.prompt,
        image_url: first,
        end_image_url: last,
        duration: int(p.duration, 5),
        resolution: (str(p.resolution) ?? '768p').toUpperCase(),
        aspect_ratio: first || last ? undefined : str(p.aspectRatio),
        prompt_expansion_mode: str(p.promptExpansion) ?? 'balanced',
        seed: seedOf(p),
      })
    },
    extractOutputs: videoOut,
  },

  'fal-pixverse-v6': {
    endpoint: (_p, urls) => (one(urls, 'firstFrame') ? 'fal-ai/pixverse/v6/image-to-video' : 'fal-ai/pixverse/v6/text-to-video'),
    toInput: (p, urls) => {
      const first = one(urls, 'firstFrame')
      return compact({
        prompt: p.prompt,
        negative_prompt: str(p.negativePrompt),
        image_url: first,
        duration: int(p.duration, 5),
        resolution: str(p.resolution),
        aspect_ratio: first ? undefined : str(p.aspectRatio),
        generate_audio_switch: p.audio !== false,
        generate_multi_clip_switch: p.multiClip === true,
        seed: seedOf(p),
      })
    },
    extractOutputs: videoOut,
  },

  'fal-ltx-2.5-pro': {
    endpoint: (_p, urls) =>
      frames(urls).first ? 'lightricks/ltx-2.5/image-to-video/pro' : 'lightricks/ltx-2.5/text-to-video/pro',
    toInput: (p, urls) => {
      const { first, last } = frames(urls)
      return compact({
        prompt: p.prompt,
        image_url: first,
        end_image_url: last,
        duration: int(p.duration, 6),
        resolution: str(p.resolution),
        aspect_ratio: first ? undefined : str(p.aspectRatio),
        fps: asNumber(p.fps),
        generate_audio: p.audio !== false,
        camera_motion: p.cameraMotion === 'none' ? undefined : str(p.cameraMotion),
      })
    },
    extractOutputs: videoOut,
  },

  // Video models added 2026-10-02 (schemas checked that day).
  'fal-happy-horse-1.1': {
    endpoint: (_p, urls) =>
      many(urls, 'referenceImages').length
        ? 'alibaba/happy-horse/v1.1/reference-to-video'
        : one(urls, 'firstFrame')
          ? 'alibaba/happy-horse/v1.1/image-to-video'
          : 'alibaba/happy-horse/v1.1/text-to-video',
    toInput: (p, urls) => {
      const refs = many(urls, 'referenceImages')
      const first = refs.length ? undefined : one(urls, 'firstFrame')
      return compact({
        prompt: p.prompt,
        image_url: first,
        image_urls: refs.length ? refs : undefined,
        duration: int(p.duration, 5),
        aspect_ratio: first ? undefined : str(p.aspectRatio),
        resolution: str(p.resolution),
        seed: seedOf(p),
      })
    },
    extractOutputs: videoOut,
  },

  'fal-gemini-omni-flash': {
    endpoint: (_p, urls) =>
      frames(urls).first ? 'google/gemini-omni-flash/v1.1/image-to-video' : 'google/gemini-omni-flash/v1.1/text-to-video',
    toInput: (p, urls) => {
      const { first, last } = frames(urls)
      return compact({
        prompt: p.prompt,
        image_url: first,
        end_image_url: last,
        duration: int(p.duration, 8),
        aspect_ratio: str(p.aspectRatio),
        resolution: str(p.resolution),
      })
    },
    extractOutputs: videoOut,
  },

  'fal-luma-ray-3.2': {
    endpoint: (_p, urls) => {
      const { first, last } = frames(urls, { lastNeedsFirst: false })
      return first || last ? 'luma/agent/ray/v3.2/image-to-video' : 'luma/agent/ray/v3.2/text-to-video'
    },
    toInput: (p, urls) => {
      const { first, last } = frames(urls, { lastNeedsFirst: false })
      return compact({
        prompt: p.prompt,
        image_url: first,
        end_image_url: last,
        duration: `${int(p.duration, 5)}s`,
        aspect_ratio: str(p.aspectRatio),
        resolution: str(p.resolution),
        loop: p.loop === true ? true : undefined,
      })
    },
    extractOutputs: videoOut,
  },

  // Elements go to image-to-video only (text-to-video has none). A shot list (multi_prompt) replaces the prompt — fal
  // takes one or the other — with shot 1 carrying the shared scene setup.
  'fal-kling-3.0': {
    endpoint: (p, urls) => `fal-ai/kling-video/v3/${klingFalTier(p.resolution)}/${frames(urls).first ? 'image-to-video' : 'text-to-video'}`,
    toInput: (p, urls) => {
      const { first, last } = frames(urls)
      const elements = klingElements(p, urls)
      if (elements && !first) throw new ProviderError(jobError('invalid_params', 'Kling elements need a start frame'))
      const shots = klingMultiPrompt(p)
      return compact({
        ...(shots ? { multi_prompt: shots, shot_type: 'customize' } : { prompt: p.prompt }),
        negative_prompt: str(p.negativePrompt),
        start_image_url: first,
        end_image_url: last,
        elements,
        duration: String(int(p.duration, 5)),
        aspect_ratio: first ? undefined : str(p.aspectRatio),
        generate_audio: p.audio !== false,
      })
    },
    extractOutputs: videoOut,
  },
  'fal-kling-o3': klingO3((p) => klingFalTier(p.resolution)),
  'fal-kling-o3-4k': klingO3(() => '4k'),

  'fal-veo3.1-extend': {
    endpoint: (p) => (p.tier === 'standard' ? 'fal-ai/veo3.1/extend-video' : 'fal-ai/veo3.1/fast/extend-video'),
    toInput: (p, urls) =>
      compact({ prompt: p.prompt, video_url: required(one(urls, 'video'), 'Clip to extend'), generate_audio: p.audio !== false }),
    extractOutputs: videoOut,
  },

  'fal-sync-lipsync-v3': {
    endpoint: () => 'fal-ai/sync-lipsync/v3',
    toInput: (p, urls) =>
      compact({
        video_url: required(one(urls, 'video'), 'Video'),
        audio_url: required(one(urls, 'audioClip'), 'Speech audio'),
        sync_mode: str(p.syncMode),
      }),
    extractOutputs: videoOut,
  },

  'fal-mmaudio-v2': {
    endpoint: () => 'fal-ai/mmaudio-v2',
    toInput: (p, urls) =>
      compact({
        video_url: required(one(urls, 'video'), 'Video'),
        prompt: p.prompt,
        negative_prompt: str(p.negativePrompt),
        duration: asNumber(p.durationSeconds),
        seed: seedOf(p),
      }),
    // MMAudio returns the source video with the generated track muxed in; the audio stream is the result.
    extractOutputs: (data) => fileOutputs(isRecord(data) ? data.video : undefined, 'mp4', { ...resultMeta(data), audioInVideoContainer: true }),
  },

  'fal-stable-audio-2.5': {
    endpoint: () => 'fal-ai/stable-audio-25/text-to-audio',
    toInput: (p) => compact({ prompt: p.prompt, seconds_total: int(p.durationSeconds, 30), seed: seedOf(p) }),
    extractOutputs: audioOut,
  },

  // Upscalers (schemas checked 2026-09-29).
  'fal-topaz-upscale-video': {
    endpoint: () => 'fal-ai/topaz/upscale/video',
    toInput: (p, urls) =>
      compact({
        video_url: required(one(urls, 'video'), 'Video'),
        // The API default, pinned so results and the catalog's rate card stay stable.
        model: 'Proteus',
        upscale_factor: upscaleFactor(p),
        target_fps: targetFps(p),
        // fal defaults to H.265; the viewer/export decode originals in the browser, where H.264 is the safe choice.
        H264_output: true,
      }),
    extractOutputs: videoOut,
  },

  'fal-seedvr2-upscale-video': {
    endpoint: () => 'fal-ai/seedvr/upscale/video',
    toInput: (p, urls) =>
      compact({
        video_url: required(one(urls, 'video'), 'Video'),
        upscale_mode: 'factor',
        upscale_factor: upscaleFactor(p),
        seed: seedOf(p),
        output_format: 'X264 (.mp4)',
        output_quality: 'high',
      }),
    extractOutputs: videoOut,
  },

  'fal-topaz-upscale-image': {
    endpoint: () => 'fal-ai/topaz/upscale/image',
    toInput: (p, urls) =>
      compact({
        image_url: required(one(urls, 'image'), 'Image'),
        model: 'Standard V2',
        upscale_factor: upscaleFactor(p),
        face_enhancement: p.faceEnhancement !== false,
        output_format: 'png',
      }),
    extractOutputs: imageOut,
  },

  'fal-bria-rmbg': {
    endpoint: () => 'fal-ai/bria/background/remove',
    toInput: (_p, urls) => ({ image_url: required(one(urls, 'image'), 'Image') }),
    extractOutputs: imageOut,
  },

  'fal-birefnet-v2': {
    endpoint: () => 'fal-ai/birefnet/v2',
    toInput: (p, urls) =>
      compact({
        image_url: required(one(urls, 'image'), 'Image'),
        model: asString(p.mode) ?? 'General Use (Light 2K)',
        operating_resolution: asString(p.resolution) ?? '2048x2048',
        refine_foreground: true,
        output_format: 'png',
      }),
    extractOutputs: imageOut,
  },

  'fal-recraft-vectorize': {
    endpoint: () => 'fal-ai/recraft/vectorize',
    // Recraft takes PNG/JPG/WebP under 5 MB, 256–4096 px.
    input: { maxEdge: 4096, maxBytes: 5_000_000, minEdge: 256 },
    toInput: (_p, urls) => ({ image_url: required(one(urls, 'image'), 'Image') }),
    extractOutputs: (data) => fileOutputs(isRecord(data) ? data.image : undefined, 'svg', resultMeta(data)),
  },

  'fal-custom': custom('mp4'),
  'fal-custom-image': custom('png'),
  'fal-custom-audio': custom('wav'),
}

// ------------------------------------------------------------------------------------ adapter

export interface FalAdapterOptions {
  /** Client factory — tests inject a fake. */
  createClient?: FalClientFactory
  /** Route table override (defaults to FAL_ROUTES). */
  routes?: Record<string, FalRoute>
}

const UPLOAD_TTL_MS = 60 * 60_000
export function createFalAdapter(opts: FalAdapterOptions = {}): ProviderAdapter {
  const makeClient = opts.createClient ?? defaultClientFactory
  const routes = opts.routes ?? FAL_ROUTES
  const clients = new Map<string, FalClientLike>()
  /** Re-use uploads of the same file (e.g. the same start frame for several takes) for an hour. */
  const uploads = new Map<string, { url: string; at: number }>()

  function clientFor(credentials: Credentials): FalClientLike {
    const apiKey = credentials.apiKey
    if (!apiKey) throw new ProviderError(jobError('auth', `${LABEL}: missing API key — add it in Settings → Providers`))
    let client = clients.get(apiKey)
    if (!client) {
      client = makeClient(apiKey)
      clients.set(apiKey, client)
    }
    return client
  }

  function routeFor(modelId: string): FalRoute {
    const route = routes[modelId]
    if (!route) throw new ProviderError(jobError('internal', `${LABEL}: no endpoint mapping for model ${modelId}`))
    return route
  }

  async function upload(client: FalClientLike, input: ResolvedInput, signal: AbortSignal, limits?: FalRoute['input']): Promise<string> {
    let cacheKey: string | undefined
    try {
      const info = await stat(input.path)
      cacheKey = `${input.path}:${info.size}:${info.mtimeMs}${limits && input.kind === 'image' ? `:${limits.maxEdge}/${limits.maxBytes}` : ''}`
    } catch {
      throw new ProviderError(jobError('invalid_params', `Input file is missing: ${basename(input.path)}`))
    }
    const hit = uploads.get(cacheKey)
    if (hit && Date.now() - hit.at < UPLOAD_TTL_MS) return hit.url
    signal.throwIfAborted()
    const file = limits && input.kind === 'image' ? await fitImageInput(input, limits, signal) : undefined
    try {
      const url = await client.storage.upload(await fileToBlob(file?.path ?? input.path, file?.mime ?? input.mime))
      uploads.set(cacheKey, { url, at: Date.now() })
      return url
    } catch (err) {
      if (signal.aborted) throw err
      const mapped = falApiError(err)
      if (mapped && ['auth', 'insufficient_credits'].includes(mapped.jobError.code)) throw mapped
      // Nothing was submitted yet, so nothing was charged.
      throw new ProviderError(
        jobError('network', `${LABEL}: could not upload ${basename(input.path)} — ${err instanceof Error ? err.message : String(err)}`, {
          retryable: true,
        }),
      )
    } finally {
      await file?.cleanup()
    }
  }

  async function uploadInputs(ctx: JobContext, client: FalClientLike, limits?: FalRoute['input']): Promise<FalInputUrls> {
    const urls: FalInputUrls = {}
    for (const [key, value] of Object.entries(ctx.inputs)) {
      if (Array.isArray(value)) {
        const list: string[] = []
        for (const input of value) list.push(await upload(client, input, ctx.signal, limits))
        urls[key] = list
      } else {
        urls[key] = await upload(client, value, ctx.signal, limits)
      }
    }
    return urls
  }

  return {
    id: 'fal',
    label: LABEL,
    version: '2026-10-09.1',
    credentialFields: ['apiKey'],
    requiredFields: ['apiKey'],
    defaultConcurrency: 4,
    pollIntervalMs: 3000,

    test: (credentials) => testFalKey(credentials),

    async submit(ctx: JobContext): Promise<SubmitResult> {
      const route = routeFor(ctx.model.id)
      const client = clientFor(ctx.credentials)
      const urls = await uploadInputs(ctx, client, route.input)
      const endpointId = route.endpoint(ctx.params, urls)
      const input = route.toInput(ctx.params, urls, endpointId)
      ctx.recordRequest({ endpointId, input: summarizePayload(input) })
      let queued: { request_id: string }
      try {
        queued = await client.queue.submit(endpointId, { input, abortSignal: ctx.signal })
      } catch (err) {
        if (ctx.signal.aborted) throw err
        // HTTP errors are definitive; network errors propagate as an unknown outcome.
        throw falApiError(err) ?? err
      }
      if (!queued?.request_id) {
        throw new ProviderError(jobError('provider', `${LABEL}: ${endpointId} accepted the request without a request id`, { maybeCharged: true }))
      }
      return { type: 'async', taskId: queued.request_id, meta: { endpointId } }
    },

    async poll(ctx: JobContext): Promise<PollResult> {
      const endpointId = typeof ctx.providerMeta.endpointId === 'string' ? ctx.providerMeta.endpointId : ''
      const requestId = ctx.providerTaskId
      if (!endpointId || !requestId) return { type: 'failed', error: jobError('internal', `${LABEL}: missing endpoint or request id to poll`) }
      const route = routeFor(ctx.model.id)
      const client = clientFor(ctx.credentials)
      let status: { status: string; queue_position?: number }
      try {
        status = await client.queue.status(endpointId, { requestId, logs: true, abortSignal: ctx.signal })
      } catch (err) {
        if (ctx.signal.aborted) throw err
        throw falApiError(err) ?? err
      }
      if (status.status !== 'COMPLETED') return { type: 'running' }
      try {
        const result = await client.queue.result(endpointId, { requestId, abortSignal: ctx.signal })
        const outputs = route.extractOutputs(result.data, ctx.params)
        if (!outputs.length) {
          const where = typeof ctx.params.outputPath === 'string' ? ` at "${ctx.params.outputPath}"` : ''
          return {
            type: 'failed',
            error: jobError('provider', `${LABEL}: ${endpointId} finished but no file was found${where}`, { maybeCharged: true }),
          }
        }
        return { type: 'done', outputs, response: summarizePayload(result.data) }
      } catch (err) {
        if (ctx.signal.aborted) throw err
        const mapped = falApiError(err)
        if (!mapped) throw err
        // The request finished: an error with a body is the model's final answer, not a hiccup.
        if (isFinalResultError(err)) return { type: 'failed', error: mapped.jobError }
        throw mapped
      }
    },

    async cancel(ctx: JobContext): Promise<void> {
      const endpointId = typeof ctx.providerMeta.endpointId === 'string' ? ctx.providerMeta.endpointId : ''
      if (!endpointId || !ctx.providerTaskId) return
      await clientFor(ctx.credentials).queue.cancel(endpointId, { requestId: ctx.providerTaskId })
    },
  }
}

// ------------------------------------------------------------------------------------ test()

const FAL_BILLING_URL = 'https://api.fal.ai/v1/account/billing?expand=credits'
const FAL_QUEUE_PROBE_URL = 'https://queue.fal.run/fal-ai/flux/requests/00000000-0000-0000-0000-000000000000/status'

async function testFalKey(credentials: Credentials): Promise<ProviderTestResult> {
  const apiKey = credentials.apiKey
  if (!apiKey) return { ok: false, message: 'Missing API key' }
  const headers = { authorization: `Key ${apiKey}`, accept: 'application/json' }
  const res = await httpFetch(FAL_BILLING_URL, { headers }, { label: LABEL, timeoutMs: 20_000 })
  const body = await readText(res)
  if (res.ok) {
    const json = parseJson(body)
    const credits = isRecord(json) && isRecord(json.credits) ? json.credits : undefined
    const balance = asNumber(credits?.current_balance)
    const username = isRecord(json) ? asString(json.username) : undefined
    return {
      ok: true,
      message: `Connected${username ? ` as ${username}` : ''}`,
      credits: balance === undefined ? undefined : { label: 'fal balance', remaining: balance, unit: asString(credits?.currency) ?? 'USD' },
    }
  }
  const message = errorText(body)
  if (res.status === 401) return { ok: false, message: `${LABEL}: invalid API key${message ? ` (${message})` : ''}` }
  if (/balance|locked|billing|top up/i.test(message)) return { ok: false, message: `${LABEL}: ${message}` }
  // 403 = a working key without ADMIN scope (can't read billing): confirm it authenticates on the queue.
  const probe = await httpFetch(FAL_QUEUE_PROBE_URL, { headers }, { label: LABEL, timeoutMs: 20_000 })
  const probeBody = await readText(probe)
  if (probe.status === 401 || probe.status === 403) {
    const detail = errorText(probeBody)
    return { ok: false, message: `${LABEL}: API key rejected${detail ? ` (${detail})` : ''}` }
  }
  return { ok: true, message: 'Connected — the balance is only visible to ADMIN-scoped keys' }
}

function errorText(body: string): string {
  const json = parseJson(body)
  if (!isRecord(json)) return body.slice(0, 200)
  const detail = json.detail
  return (
    firstString(
      typeof detail === 'string' ? detail : undefined,
      Array.isArray(detail) && isRecord(detail[0]) ? detail[0].msg : undefined,
      json.message,
      isRecord(json.error) ? json.error.message : json.error,
    ) ?? ''
  )
}

// ------------------------------------------------------------------------------------ errors

function errorStatus(err: unknown): number | undefined {
  if (err instanceof ProviderError) return undefined
  const status = isRecord(err) || err instanceof Error ? (err as { status?: unknown }).status : undefined
  return typeof status === 'number' ? status : undefined
}

function errorBody(err: unknown): unknown {
  return isRecord(err) || err instanceof Error ? (err as { body?: unknown }).body : undefined
}

/** After COMPLETED, 4xx or a structured error body is final; bare gateway 5xx/429 are worth re-polling. */
function isFinalResultError(err: unknown): boolean {
  const status = errorStatus(err)
  if (status === undefined) return err instanceof ProviderError
  if (status === 429) return false
  const body = errorBody(err)
  const hasDetail = isRecord(body) && body.detail !== undefined
  return (status >= 400 && status < 500) || hasDetail
}

/** Maps a `@fal-ai/client` ApiError (status + parsed body) to a normalized provider error. */
export function falApiError(err: unknown): ProviderError | undefined {
  if (err instanceof ProviderError) return err
  const status = errorStatus(err)
  if (status === undefined) return undefined
  const body = errorBody(err)
  const detail = isRecord(body) ? body.detail : undefined
  const issues = Array.isArray(detail) ? detail.filter(isRecord) : []
  const types = issues.map((i) => asString(i.type) ?? '')
  const first = issues[0]
  const field = first && Array.isArray(first.loc) ? first.loc.filter((part) => part !== 'body').join('.') : ''
  const message =
    firstString(
      first?.msg,
      typeof detail === 'string' ? detail : undefined,
      isRecord(body) ? body.message : undefined,
      isRecord(body) && isRecord(body.error) ? body.error.message : undefined,
      err instanceof Error ? err.message : undefined,
    ) ?? `HTTP ${status}`
  const withField = field && !message.includes(field) ? `${field}: ${message}` : message

  if (types.includes('content_policy_violation') || /content (policy|checker)|nsfw|flagged|safety/i.test(message))
    return new ProviderError(jobError('moderation', `${LABEL}: blocked by content moderation — ${message}`))
  if (status === 402 || /exhausted balance|insufficient (balance|credit|fund)|top up|user is locked/i.test(message))
    return new ProviderError(jobError('insufficient_credits', `${LABEL}: ${message}`))
  if (status === 401 || status === 403) return new ProviderError(jobError('auth', `${LABEL}: invalid API key or no access (${message})`))
  if (status === 429) return new ProviderError(jobError('rate_limited', `${LABEL}: rate limited (${message})`, { retryable: true }))
  if (types.includes('generation_timeout') || status === 504)
    return new ProviderError(jobError('timeout', `${LABEL}: generation timed out (${message})`, { retryable: true }))
  if (types.includes('no_media_generated')) return new ProviderError(jobError('provider', `${LABEL}: the model produced no output (${message})`, { retryable: true }))
  if (status === 400 || status === 404 || status === 422) return new ProviderError(jobError('invalid_params', `${LABEL}: ${withField}`))
  if (status >= 500) return new ProviderError(jobError('provider', `${LABEL}: server error ${status} (${message})`, { retryable: true }))
  return new ProviderError(jobError('provider', `${LABEL}: HTTP ${status} (${message})`))
}

// ------------------------------------------------------------------------------------ custom endpoint

/** Replaces {{prompt}} / {{image}} / {{video}} / {{audio}} in every string of a JSON value. */
export function fillPlaceholders(value: unknown, vars: Record<string, string | undefined>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => (name in vars ? (vars[name] ?? '') : match))
  }
  if (Array.isArray(value)) return value.map((v) => fillPlaceholders(v, vars))
  if (isRecord(value)) {
    const out: JsonRecord = {}
    for (const [k, v] of Object.entries(value)) out[k] = fillPlaceholders(v, vars)
    return out
  }
  return value
}

/** Resolves a path like `video.url`, `images[0].url` or `images[*].url` to output files. */
export function outputsAtPath(data: unknown, path: string, fallbackExt: string): ProviderOutput[] {
  const tokens: (string | number | '*')[] = []
  for (const match of path.matchAll(/([A-Za-z_]\w*)|\[(\d+|\*)\]/g)) {
    if (match[1] !== undefined) tokens.push(match[1])
    else tokens.push(match[2] === '*' ? '*' : Number(match[2]))
  }
  let nodes: unknown[] = [data]
  for (const token of tokens) {
    const next: unknown[] = []
    for (const node of nodes) {
      if (token === '*') {
        if (Array.isArray(node)) next.push(...node)
      } else if (typeof token === 'number') {
        if (Array.isArray(node) && token < node.length) next.push(node[token])
      } else if (isRecord(node) && token in node) {
        next.push(node[token])
      }
    }
    nodes = next
  }
  return nodes.flatMap((node) => (Array.isArray(node) ? node.flatMap((n) => fileOutputs(n, fallbackExt)) : fileOutputs(node, fallbackExt)))
}
