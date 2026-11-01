import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { aspectValue } from '../../shared/canvas/geometry'
import { OPENROUTER_MODEL_ID_RE, OR_SEEDANCE_MAX_IMAGES, type OpenRouterImageModel } from '../../shared/models/catalog/openrouter'
import { closestAspect } from '../../shared/models/fit'
import type { ParamValues } from '../../shared/models/types'
import type { ProviderTestResult } from '../../shared/types/api'
import { ApiError } from '../http'
import { cachedList } from '../services/cachedList'
import type { Credentials } from '../services/keychain'
import { asNumber, asString, base64Placeholder, extFrom, httpFetch, isRecord, readText, summarizePayload } from './http'
import { runFfmpeg } from '../services/ffmpeg'
import { fitImageInput } from './imageInput'
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
  soundsLikeModeration,
} from './types'

export const OPENROUTER_API = 'https://openrouter.ai/api/v1'

/** Sent with every OpenRouter request so usage shows up under the app's name in the OpenRouter dashboard. */
export const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://szymonkubisa.com/work/wildroom', 'X-Title': 'Wildroom' }

const LABEL = 'OpenRouter'
const CATALOGUE_TTL_MS = 6 * 60 * 60_000

interface KeyInfo {
  data?: { label?: string; limit?: number | null; limit_remaining?: number | null; usage?: number; is_free_tier?: boolean }
}

// ------------------------------------------------------------------------------------ image model catalogue

type ParamSpec = { type?: string; values?: unknown[]; min?: number; max?: number }

interface CatalogueEntry {
  id?: string
  name?: string
  description?: string
  architecture?: { input_modalities?: string[] }
  supported_parameters?: Record<string, ParamSpec | undefined>
}

const enumValues = (spec: ParamSpec | undefined) =>
  spec?.type === 'enum' && Array.isArray(spec.values) ? spec.values.filter((v): v is string => typeof v === 'string') : undefined

/** OpenRouter's catalogue entry (GET /images/models) → what we support of it. */
export function toImageModel(m: CatalogueEntry): OpenRouterImageModel | undefined {
  if (!m.id || !OPENROUTER_MODEL_ID_RE.test(m.id)) return undefined
  const params = m.supported_parameters ?? {}
  const refs = params.input_references
  const formats = enumValues(params.output_format)
  // No `input_references` entry: text-only models take none; image-in models haven't said, so OpenRouter's limit.
  const takesImages = (m.architecture?.input_modalities ?? []).includes('image')
  return {
    id: m.id,
    name: (m.name ?? m.id).replace(/^[^:]{1,40}:\s*/, ''),
    ...(m.description ? { description: m.description.slice(0, 300) } : {}),
    refs: refs?.type === 'range' ? { min: refs.min ?? 0, max: refs.max ?? 0 } : { min: 0, max: takesImages ? 16 : 0 },
    aspects: enumValues(params.aspect_ratio),
    resolutions: enumValues(params.resolution),
    qualities: enumValues(params.quality),
    transparent: enumValues(params.background)?.includes('transparent') ?? false,
    seed: params.seed?.type === 'boolean',
    formats,
    svg: Boolean(formats?.length && formats.every((f) => f === 'svg')),
  }
}

const imageModels = cachedList<OpenRouterImageModel>(CATALOGUE_TTL_MS)

/** OpenRouter's image models (public list, cached for 6 hours; the last good list survives a failed refresh). */
export function listImageModels(fetchImpl: typeof fetch = fetch): Promise<OpenRouterImageModel[]> {
  return imageModels.get(async () => {
    try {
      const res = await fetchImpl(`${OPENROUTER_API}/images/models`, { headers: OPENROUTER_HEADERS, signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { data?: CatalogueEntry[] }
      return (body.data ?? []).flatMap((m) => toImageModel(m) ?? [])
    } catch (err) {
      throw new ApiError(502, `Could not load OpenRouter's image models: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

interface EndpointPrice {
  billable?: string
  unit?: string
  cost_usd?: number
  variant?: string
}

/** $0.045, $0.0075, $30 — enough decimals to be exact for per-image prices. */
const usd = (n: number) => `$${n >= 1 ? n.toFixed(2).replace(/\.00$/, '') : n.toFixed(4).replace(/0{1,2}$/, '')}`

/** One endpoint's price list in words: "$0.045 per image", "$0.09 per image (high resolution)", "$30 per 1M image tokens". */
export function describePricing(prices: EndpointPrice[]): string[] {
  const lines: string[] = []
  // What an image costs first, then what inputs add.
  const ordered = [...prices].sort((a, b) => Number(a.billable === 'input_image') - Number(b.billable === 'input_image'))
  for (const p of ordered) {
    const cost = asNumber(p.cost_usd)
    if (cost === undefined || p.billable === 'input_text') continue
    const input = p.billable === 'input_image'
    if (input && cost === 0) continue
    const price =
      p.unit === 'token'
        ? `${usd(cost * 1e6)} per 1M ${input ? 'input image' : 'image'} tokens`
        : p.unit === 'megapixel'
          ? `${usd(cost)} per ${input ? 'input' : 'output'} megapixel`
          : cost === 0
            ? 'free'
            : `${usd(cost)} per ${input ? 'input image' : 'image'}`
    lines.push(p.variant ? `${price} (${p.variant.replaceAll('_', ' ')})` : price)
  }
  return lines
}

const pricingCache = new Map<string, { at: number; lines: string[] }>()

/** What one image model costs, from its first (default) endpoint. */
export async function imageModelPricing(id: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  if (!OPENROUTER_MODEL_ID_RE.test(id)) throw new ApiError(400, 'Not an OpenRouter model id')
  const hit = pricingCache.get(id)
  if (hit && Date.now() - hit.at < CATALOGUE_TTL_MS) return hit.lines
  const path = id.split('/').map(encodeURIComponent).join('/')
  const res = await fetchImpl(`${OPENROUTER_API}/images/models/${path}/endpoints`, { headers: OPENROUTER_HEADERS, signal: AbortSignal.timeout(15_000) }).catch(
    (err: unknown) => {
      throw new ApiError(502, `Could not load the price: ${err instanceof Error ? err.message : String(err)}`)
    },
  )
  if (res.status === 404) throw new ApiError(404, `OpenRouter has no image model “${id}”`)
  if (!res.ok) throw new ApiError(502, `Could not load the price: HTTP ${res.status}`)
  const body = (await res.json()) as { endpoints?: { pricing?: EndpointPrice[] }[] }
  const lines = describePricing(body.endpoints?.[0]?.pricing ?? [])
  pricingCache.set(id, { at: Date.now(), lines })
  return lines
}

/** For tests: forget the cached catalogue and prices. */
export function resetImageCatalogue() {
  imageModels.reset()
  pricingCache.clear()
}

// ------------------------------------------------------------------------------------ image requests

export interface OpenRouterImageRoute {
  /** OpenRouter's model id for the form's values (tier / Pro toggles pick a sibling model). */
  model: (p: ParamValues) => string
  /** Ask for SVG output. */
  svg?: boolean
}

/** Each OpenRouter image model in the catalog (src/shared/models/catalog/openrouter.ts) → OpenRouter's model id. */
export const OPENROUTER_IMAGE_ROUTES: Record<string, OpenRouterImageRoute> = {
  'or-gpt-image-2.5': { model: (p) => `openai/gpt-image-2.5-${p.tier === 'sunburst' ? 'sunburst' : 'flare'}` },
  'or-nano-banana-pro': { model: () => 'google/gemini-3-pro-image' },
  'or-nano-banana-2': { model: () => 'google/gemini-3.1-flash-image' },
  'or-seedream-5-pro': { model: () => 'bytedance-seed/seedream-5-0-pro' },
  'or-seedream-5-lite': { model: () => 'bytedance-seed/seedream-5-0-lite' },
  'or-flux-3': { model: () => 'black-forest-labs/flux-3-image' },
  'or-recraft-v4.1': { model: (p) => (p.pro === true ? 'recraft/recraft-v4.1-pro' : 'recraft/recraft-v4.1') },
  'or-recraft-v4.1-vector': { model: (p) => (p.pro === true ? 'recraft/recraft-v4.1-pro-vector' : 'recraft/recraft-v4.1-vector'), svg: true },
  'or-grok-imagine-2': { model: () => 'x-ai/grok-imagine-image-2.0' },
  'or-qwen-image-3-pro': { model: () => 'qwen/qwen-image-3-pro' },
  'or-mai-image-2.6': { model: () => 'microsoft/mai-image-2.6' },
  'or-image-any': { model: (p) => String(p.orModel ?? '').trim() },
}

/** The Image API request for the form's values, before it is fitted to the model. References are data URLs. */
export function imageRequest(model: string, p: ParamValues, references: string[], svg = false): Record<string, unknown> {
  const transparent = p.transparent === true
  const body: Record<string, unknown> = {
    model,
    prompt: String(p.prompt ?? ''),
    aspect_ratio: asString(p.aspectRatio),
    resolution: asString(p.resolution),
    quality: asString(p.quality),
    background: transparent ? 'transparent' : undefined,
    output_format: svg ? 'svg' : transparent ? 'png' : undefined,
    seed: typeof p.seed === 'number' ? p.seed : undefined,
    input_references: references.length ? references.map((url) => ({ type: 'image_url', image_url: { url } })) : undefined,
  }
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))
}

const RESOLUTIONS = ['512', '768', '1K', '1.5K', '2K', '4K']
const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max']

/** The option nearest `wanted` in a ranked list (ties go to the higher one). */
function nearestRanked(wanted: string, options: string[], order: string[]): string | undefined {
  const i = order.indexOf(wanted)
  if (i < 0) return undefined
  let best: string | undefined
  let bestDistance = Infinity
  for (const o of options) {
    const j = order.indexOf(o)
    if (j < 0) continue
    const d = Math.abs(j - i) + (j < i ? 0.1 : 0)
    if (d < bestDistance) [best, bestDistance] = [o, d]
  }
  return best
}

const invalid = (message: string) => new ProviderError(jobError('invalid_params', message))

/**
 * Fits a request to what the model supports: settings it lacks are left out; aspect, resolution and quality snap to
 * the nearest it offers. Throws for what can't be fitted (too many references, a transparency it can't do).
 */
export function fitImageRequest(body: Record<string, unknown>, m: OpenRouterImageModel): Record<string, unknown> {
  const out = { ...body }
  const snap = (key: string, fit: (v: string) => string | undefined) => {
    const v = out[key]
    if (typeof v !== 'string') return
    const fitted = fit(v)
    if (fitted === undefined) delete out[key]
    else out[key] = fitted
  }
  snap('aspect_ratio', (v) => (!m.aspects?.length ? undefined : m.aspects.includes(v) ? v : closestAspect(m.aspects, aspectValue(v) ?? 0)))
  snap('resolution', (v) => (!m.resolutions?.length ? undefined : m.resolutions.includes(v) ? v : nearestRanked(v, m.resolutions, RESOLUTIONS)))
  snap('quality', (v) => (!m.qualities?.length ? undefined : m.qualities.includes(v) ? v : nearestRanked(v, m.qualities, QUALITIES)))
  if (out.background === 'transparent' && !m.transparent) throw invalid(`${m.name} can’t make transparent backgrounds — turn that off or pick GPT Image`)
  if (m.svg) out.output_format = 'svg'
  else if (typeof out.output_format === 'string' && m.formats && !m.formats.includes(out.output_format)) delete out.output_format
  if (!m.seed) delete out.seed
  const refs = Array.isArray(out.input_references) ? out.input_references.length : 0
  if (refs > m.refs.max) {
    throw invalid(m.refs.max ? `${m.name} takes up to ${m.refs.max} reference image${m.refs.max === 1 ? '' : 's'}` : `${m.name} doesn’t take reference images`)
  }
  if (refs < m.refs.min) throw invalid(`${m.name} needs ${m.refs.min === 1 ? 'a reference image' : `at least ${m.refs.min} reference images`}`)
  return out
}

/**
 * References go inline in the JSON request, as JPEGs of at most 1536 px: three 1.5–1.9 MB PNGs made a ~7 MB body, and
 * OpenRouter cut the connection mid-upload (EPIPE) — 7 of 13 keyframes on 2026-10-12. A cut-out for a transparent
 * picture stays a PNG.
 */
const REFERENCE_LIMITS = { maxEdge: 1536, maxBytes: 700_000, format: 'jpeg' } as const
const TRANSPARENT_REFERENCE_LIMITS = { maxEdge: 1536, maxBytes: 2_000_000 }

async function imageDataUrl(input: ResolvedInput, limits: Parameters<typeof fitImageInput>[1], signal: AbortSignal): Promise<string> {
  const file = await fitImageInput(input, limits, signal)
  try {
    return `data:${file.mime};base64,${(await readFile(file.path)).toString('base64')}`
  } finally {
    await file.cleanup()
  }
}

async function referenceDataUrls(ctx: JobContext): Promise<string[]> {
  const value = ctx.inputs.referenceImages
  const inputs = Array.isArray(value) ? value : value ? [value] : []
  const limits = ctx.params.transparent === true ? TRANSPARENT_REFERENCE_LIMITS : REFERENCE_LIMITS
  const urls: string[] = []
  for (const input of inputs) {
    if (input.kind === 'image') urls.push(await imageDataUrl(input, limits, ctx.signal))
  }
  return urls
}

/** File type from the first bytes, for results without a media type. */
function sniffImageExt(data: Buffer): string {
  if (data[0] === 0x89 && data.subarray(1, 4).toString('latin1') === 'PNG') return 'png'
  if (data[0] === 0xff && data[1] === 0xd8) return 'jpg'
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  if (/^\s*(<\?xml|<svg)/i.test(data.subarray(0, 256).toString('utf8'))) return 'svg'
  return 'png'
}

/** `data[].b64_json` → files (SVG markup comes base64-encoded too). */
export function imageOutputs(response: unknown, extra: Pick<ProviderOutput, 'meta' | 'modelLabel'> = {}): ProviderOutput[] {
  const items = isRecord(response) && Array.isArray(response.data) ? response.data : []
  return items.flatMap((item): ProviderOutput[] => {
    const b64 = isRecord(item) ? asString(item.b64_json) : undefined
    const data = b64 ? Buffer.from(b64, 'base64') : undefined
    if (!data?.length) return []
    return [{ kind: 'buffer', data, ext: extFrom(isRecord(item) ? item.media_type : undefined) ?? sniffImageExt(data), ...extra }]
  })
}

function imageError(status: number, body: string): ProviderError {
  if (status === 413) return invalid(`${LABEL}: the reference images are too large — use fewer or smaller ones`)
  if (status === 404) return invalid(`${LABEL}: model not found${body ? ` (${body.slice(0, 200)})` : ''}`)
  // OpenRouter bills only finished images, so a failed request costs nothing.
  return httpError(status, body, LABEL)
}

async function submitImage(ctx: JobContext): Promise<SubmitResult> {
  const route = OPENROUTER_IMAGE_ROUTES[ctx.model.id]
  if (!route) throw new ProviderError(jobError('internal', `${LABEL}: no image model mapping for ${ctx.model.id}`))
  const apiKey = ctx.credentials.apiKey
  if (!apiKey) throw new ProviderError(jobError('auth', `${LABEL}: missing API key — add it in Settings → Providers`))
  const model = route.model(ctx.params)
  if (!OPENROUTER_MODEL_ID_RE.test(model)) throw invalid('Pick an OpenRouter image model')

  // Without the catalogue (offline, OpenRouter hiccup) the request goes as the form has it.
  let info: OpenRouterImageModel | undefined
  let listed = false
  try {
    const models = await listImageModels()
    listed = true
    info = models.find((m) => m.id === model)
  } catch {
    // keep going unfitted
  }
  if (listed && !info) throw invalid(`OpenRouter has no image model “${model}”`)

  const body = imageRequest(model, ctx.params, await referenceDataUrls(ctx), route.svg)
  const request = info ? fitImageRequest(body, info) : body
  ctx.recordRequest(summarizePayload(request))
  const res = await httpFetch(
    `${OPENROUTER_API}/images`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...OPENROUTER_HEADERS },
      body: JSON.stringify(request),
    },
    // The top quality tiers can take minutes; nothing streams back until the image is done.
    { label: LABEL, signal: ctx.signal, timeoutMs: 15 * 60_000 },
  )
  if (!res.ok) throw imageError(res.status, await readText(res))
  let data: unknown
  try {
    data = await res.json()
  } catch {
    throw new ProviderError(jobError('provider', `${LABEL}: unreadable response from ${model}`, { maybeCharged: true, retryable: true }))
  }
  if (isRecord(data) && isRecord(data.error)) {
    throw new ProviderError(jobError('provider', `${LABEL}: ${asString(data.error.message) ?? 'the model failed'}`, { retryable: true }))
  }
  // "Any OpenRouter image model" names the model it ran on the result.
  const outputs = imageOutputs(data, {
    meta: { openrouterModel: model },
    ...(ctx.model.id === 'or-image-any' ? { modelLabel: info?.name ?? model } : {}),
  })
  if (!outputs.length) throw new ProviderError(jobError('provider', `${LABEL}: ${model} returned no image — it may have declined the prompt`))
  const cost = isRecord(data) && isRecord(data.usage) ? asNumber(data.usage.cost) : undefined
  // The images are saved as files: keep only their size in the job's response record.
  const record = isRecord(data) && Array.isArray(data.data)
    ? { ...data, data: data.data.map((item) => (isRecord(item) && typeof item.b64_json === 'string' ? { ...item, b64_json: base64Placeholder(item.b64_json) } : item)) }
    : data
  return { type: 'done', outputs, costUsd: cost, response: summarizePayload(record) }
}

// ------------------------------------------------------------------------------------ video requests

/** Each OpenRouter video model in the catalog → OpenRouter's model id. */
export const OPENROUTER_VIDEO_ROUTES: Record<string, { model: string }> = {
  'or-seedance-2.5': { model: 'bytedance/seedance-2.5' },
}

/**
 * A camera guide is re-encoded for Seedance (no audio, short side 720, 24 fps, cut or held on its last frame to the
 * clip's length) and handed over as an https URL. Checked live on 2026-10-26: OpenRouter refuses data URLs for videos
 * ("Only HTTPS URLs are allowed"), and Seedance refuses reference videos under 407,696 pixels a frame (848×480 failed),
 * so even a 480p clip gets a 720p guide.
 */
export const GUIDE_VIDEO = { shortEdge: 720, crf: 23, fps: 24 } as const

/**
 * The clip's length with a camera guide: the length asked for — what the estimate priced, as the guide's seconds are
 * billed too — within Seedance's 4–30; the guide is cut or held on its last frame to it.
 */
export function guideSeconds(requested: number): number {
  return Math.max(4, Math.min(30, Math.round(requested)))
}

/** Re-encodes the guide into `out`: short side 720 (scaled up if smaller), the clip's length, no audio. */
export async function encodeGuide(guide: ResolvedInput, seconds: number, out: string, signal: AbortSignal): Promise<void> {
  const { fps, crf, shortEdge: S } = GUIDE_VIDEO
  const frames = Math.round(seconds * fps)
  const vf = [
    `fps=${fps}`,
    // Landscape: height = S; portrait: width = S; even sizes for yuv420p.
    `scale='if(gte(iw,ih),-2,${S})':'if(gte(iw,ih),${S},-2)':flags=lanczos`,
    'setsar=1',
    // A guide shorter than the clip holds its last frame.
    `tpad=stop_mode=clone:stop=${frames}`,
    `trim=end_frame=${frames}`,
    'setpts=N/FRAME_RATE/TB',
  ].join(',')
  try {
    await runFfmpeg(['-i', guide.path, '-an', '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { signal })
  } catch (err) {
    if (signal.aborted) throw err
    throw invalid(`Could not read the camera guide (${err instanceof Error ? err.message : String(err)})`)
  }
}

/** Where a camera guide waits, for the length of one job, for the model to fetch it over https. */
export interface GuideHost {
  /** Copies the file up; `key` is what remove() takes. */
  put(file: string, signal: AbortSignal): Promise<{ url: string; key: string }>
  remove(key: string): Promise<void>
}
export type GuideHostFor = (credentials: Credentials) => GuideHost | undefined

export const GUIDE_HOST_MISSING =
  'Seedance takes a camera guide only from a public https address — set “Camera-guide upload” and its https address in Settings → Providers → OpenRouter'

/** `user@host:/dir` — a plain host and an absolute folder (they go into an ssh command line). */
// User and host start with a letter or digit: "-F…" would reach ssh as an option.
const UPLOAD_TARGET_RE = /^((?:[A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*):(\/[A-Za-z0-9._\/-]*)$/
const GUIDE_NAME_RE = /^wildroom-guide-[0-9a-f]{24}\.mp4$/
/** Guides older than this are swept from the folder on the next upload (a job that never finished, a crash). */
const GUIDE_SWEEP_MINUTES = 180

export function parseUploadTarget(target: string, baseUrl: string): { host: string; dir: string; baseUrl: string } | string {
  const m = UPLOAD_TARGET_RE.exec(target.trim())
  if (!m) return 'Camera-guide upload must look like user@host:/var/www/folder'
  const url = baseUrl.trim()
  if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(url)) return 'The camera-guide address must be an https URL, e.g. https://example.com/folder/'
  return { host: m[1]!, dir: m[2]!.replace(/\/+$/, '') || '/', baseUrl: url.endsWith('/') ? url : `${url}/` }
}

/**
 * The guide is copied with the system's scp/ssh (the user's SSH key, never a password prompt) into a folder their web
 * server serves over https, and deleted when the job ends; leftovers older than three hours go on the next upload.
 */
export function sshGuideHost(credentials: Credentials, fetchImpl: typeof fetch = fetch): GuideHost | undefined {
  if (!credentials.uploadTarget || !credentials.uploadUrl) return undefined
  const parsed = parseUploadTarget(credentials.uploadTarget, credentials.uploadUrl)
  if (typeof parsed === 'string') throw invalid(parsed)
  const { host, dir, baseUrl } = parsed
  const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15']
  const run = (cmd: string, args: string[], signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      execFile(cmd, args, { signal, timeout: 120_000 }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(0, 300))) : resolve()))
    })
  return {
    async put(file, signal) {
      const name = `wildroom-guide-${randomBytes(12).toString('hex')}.mp4`
      try {
        await run('ssh', [...ssh, host, `find '${dir}' -maxdepth 1 -name 'wildroom-guide-*.mp4' -mmin +${GUIDE_SWEEP_MINUTES} -delete`], signal).catch(() => {})
        await run('scp', ['-q', ...ssh, file, `${host}:${dir}/${name}`], signal)
      } catch (err) {
        if (signal.aborted) throw err
        throw new ProviderError(jobError('network', `${LABEL}: could not copy the camera guide to ${host} — ${err instanceof Error ? err.message : String(err)}`, { retryable: true }))
      }
      const url = `${baseUrl}${name}`
      const res = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }).catch(() => undefined)
      if (!res?.ok) {
        await this.remove(name)
        throw invalid(`The camera guide was copied to ${host}:${dir}, but ${baseUrl} doesn’t serve it (${res ? `HTTP ${res.status}` : 'no answer'}) — the web server must serve that folder at that address`)
      }
      return { url, key: name }
    },
    async remove(key) {
      if (!GUIDE_NAME_RE.test(key)) return
      await run('ssh', [...ssh, host, `rm -f '${dir}/${key}'`]).catch(() => {})
    },
  }
}

/** What the prompt says about the inputs when a camera guide goes along (Seedance names them @Image1, @Video1). */
export function guidedPrompt(prompt: string, keyframe: boolean): string {
  const note = keyframe
    ? 'Start from @Image1: the opening frame — keep its look, people and place. Follow @Video1 only for the camera move, framing and where everyone is, not its grey look.'
    : 'Follow @Video1 only for the camera move, framing and where everyone is, not its grey look.'
  return prompt.trim() ? `${prompt.trim()}\n\n${note}` : note
}

/**
 * The Video API request. Without a camera guide the start/end frames go as `frame_images` (image-to-video) and
 * references as `input_references`. With one, everything is a reference: OpenRouter treats a request with any
 * `frame_images` as image-to-video and drops the references — the video with them — so the keyframe goes in as the
 * first reference image instead.
 */
export function videoRequest(
  model: string,
  p: ParamValues,
  media: { firstFrame?: string; lastFrame?: string; references: string[]; videos: string[] },
): Record<string, unknown> {
  const image = (url: string) => ({ type: 'image_url', image_url: { url } })
  const guided = media.videos.length > 0
  const frames = guided
    ? []
    : [
        ...(media.firstFrame ? [{ ...image(media.firstFrame), frame_type: 'first_frame' }] : []),
        ...(media.lastFrame ? [{ ...image(media.lastFrame), frame_type: 'last_frame' }] : []),
      ]
  const references = [
    ...(guided && media.firstFrame ? [image(media.firstFrame)] : []),
    ...(frames.length ? [] : media.references.map(image)),
    ...media.videos.map((url) => ({ type: 'video_url', video_url: { url } })),
  ]
  const prompt = String(p.prompt ?? '')
  const body: Record<string, unknown> = {
    model,
    prompt: guided ? guidedPrompt(prompt, Boolean(media.firstFrame)) : prompt,
    duration: Number(p.duration ?? 5),
    resolution: asString(p.resolution),
    aspect_ratio: asString(p.aspectRatio),
    generate_audio: p.audio !== false,
    seed: typeof p.seed === 'number' ? p.seed : undefined,
    frame_images: frames.length ? frames : undefined,
    input_references: references.length ? references : undefined,
  }
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))
}

function videoSubmitError(status: number, body: string): ProviderError {
  if (status === 413) return invalid(`${LABEL}: the request is too large — use a shorter camera guide or fewer reference images`)
  if (status === 404) return invalid(`${LABEL}: model not found${body ? ` (${body.slice(0, 200)})` : ''}`)
  // Failed video jobs are not billed.
  return httpError(status, body, LABEL)
}

const authHeaders = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}`, ...OPENROUTER_HEADERS })

async function submitVideo(ctx: JobContext, hostFor: GuideHostFor): Promise<SubmitResult> {
  const route = OPENROUTER_VIDEO_ROUTES[ctx.model.id]
  if (!route) throw new ProviderError(jobError('internal', `${LABEL}: no video model mapping for ${ctx.model.id}`))
  const apiKey = ctx.credentials.apiKey
  if (!apiKey) throw new ProviderError(jobError('auth', `${LABEL}: missing API key — add it in Settings → Providers`))
  const p = ctx.params
  const one = (key: string) => {
    const v = ctx.inputs[key]
    return Array.isArray(v) ? v[0] : v
  }
  const first = one('firstFrame')
  const last = one('lastFrame')
  const guide = one('guideVideo')
  const refInputs = (() => {
    const v = ctx.inputs.referenceImages
    return (Array.isArray(v) ? v : v ? [v] : []).filter((r) => r.kind === 'image')
  })()
  if (guide && last) throw invalid('A camera guide and an end frame don’t work together — the guide sets the whole shot. Remove the end frame')
  if (last && !first) throw invalid('An end frame needs a start frame')
  if (!guide && refInputs.length && first) throw invalid('Use reference images or start/end frames, not both')
  const images = refInputs.length + (guide && first ? 1 : 0)
  if (images > OR_SEEDANCE_MAX_IMAGES) throw invalid(`${ctx.model.label} takes up to ${OR_SEEDANCE_MAX_IMAGES} images${guide && first ? ', the start frame included' : ''}`)

  const host = guide ? hostFor(ctx.credentials) : undefined
  if (guide && !host) throw invalid(GUIDE_HOST_MISSING)

  const seconds = guide ? guideSeconds(Number(p.duration ?? 5)) : Number(p.duration ?? 5)
  const frames = {
    firstFrame: first?.kind === 'image' ? await imageDataUrl(first, REFERENCE_LIMITS, ctx.signal) : undefined,
    lastFrame: last?.kind === 'image' ? await imageDataUrl(last, REFERENCE_LIMITS, ctx.signal) : undefined,
    references: await referenceDataUrls(ctx),
  }
  let hosted: { url: string; key: string } | undefined
  if (guide && host) {
    const file = join(ctx.tmpDir, `or-guide-${ctx.generationId}.mp4`)
    try {
      await encodeGuide(guide, seconds, file, ctx.signal)
      hosted = await host.put(file, ctx.signal)
    } finally {
      await rm(file, { force: true })
    }
  }
  try {
    const body = videoRequest(route.model, { ...p, duration: seconds }, { ...frames, videos: hosted ? [hosted.url] : [] })
    ctx.recordRequest(summarizePayload(body))
    const res = await httpFetch(
      `${OPENROUTER_API}/videos`,
      { method: 'POST', headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      { label: LABEL, signal: ctx.signal, timeoutMs: 180_000 },
    )
    if (!res.ok) throw videoSubmitError(res.status, await readText(res))
    const data: unknown = await res.json().catch(() => undefined)
    const id = isRecord(data) ? asString(data.id) : undefined
    if (!id) {
      throw new ProviderError(
        jobError('provider', `${LABEL} accepted the video request but returned no job id: ${JSON.stringify(data ?? null).slice(0, 300)}`, { maybeCharged: true }),
      )
    }
    return { type: 'async', taskId: id, meta: { openrouterModel: route.model, seconds, ...(hosted ? { guideKey: hosted.key } : {}) } }
  } catch (err) {
    if (hosted && host) await host.remove(hosted.key)
    throw err
  }
}

/** GET /videos/{id} → the job's state; a finished clip is downloaded by the worker with the key in the header. */
export function parseVideoJob(data: unknown, id: string, apiKey: string): PollResult {
  if (!isRecord(data)) return { type: 'running' }
  const status = asString(data.status)
  if (status === 'pending') return { type: 'running', detail: 'Queued at OpenRouter' }
  if (status === 'in_progress') return { type: 'running', detail: 'Rendering' }
  if (status === 'completed') {
    const unsigned = Array.isArray(data.unsigned_urls) ? data.unsigned_urls.filter((u): u is string => typeof u === 'string' && /^https:\/\//.test(u)) : []
    const urls = unsigned.length ? unsigned : [`${OPENROUTER_API}/videos/${encodeURIComponent(id)}/content?index=0`]
    const cost = isRecord(data.usage) ? asNumber(data.usage.cost) : undefined
    // Signed `urls` work without the key: never kept in the job's record.
    const { urls: _signed, ...record } = data
    return {
      type: 'done',
      outputs: urls.map((url) => ({ kind: 'url' as const, url, ext: 'mp4', headers: { Authorization: `Bearer ${apiKey}` } })),
      costUsd: cost,
      response: summarizePayload(record),
    }
  }
  if (status === 'failed' || status === 'cancelled' || status === 'expired') {
    const err = data.error
    const detail = (isRecord(err) ? asString(err.message) : asString(err)) ?? (status === 'failed' ? 'the render failed' : `the job was ${status}`)
    const code = soundsLikeModeration(detail) ? 'moderation' : 'provider'
    // Failed jobs are not billed.
    return { type: 'failed', error: jobError(code, `${LABEL}: ${detail}`, { retryable: code === 'provider' && status !== 'cancelled' }) }
  }
  return { type: 'running' }
}

async function pollVideo(ctx: JobContext, hostFor: GuideHostFor): Promise<PollResult> {
  const id = ctx.providerTaskId
  if (!id) return { type: 'failed', error: jobError('internal', `${LABEL}: no job id to poll`) }
  const apiKey = ctx.credentials.apiKey
  if (!apiKey) throw new ProviderError(jobError('auth', `${LABEL}: missing API key — add it in Settings → Providers`, { maybeCharged: true }))
  const res = await httpFetch(`${OPENROUTER_API}/videos/${encodeURIComponent(id)}`, { headers: authHeaders(apiKey) }, { label: LABEL, signal: ctx.signal, timeoutMs: 30_000 })
  if (!res.ok) {
    const err = httpError(res.status, await readText(res), LABEL)
    // Not listed yet right after submitting: keep polling (the worker gives up eventually).
    throw res.status === 404 ? new ProviderError({ ...err.jobError, retryable: true }) : err
  }
  const result = parseVideoJob(await res.json().catch(() => undefined), id, apiKey)
  // The model has fetched the guide by the time the job ends: take it off the host.
  const guideKey = asString(ctx.providerMeta.guideKey)
  if (guideKey && (result.type === 'done' || result.type === 'failed')) {
    try {
      await hostFor(ctx.credentials)?.remove(guideKey)
    } catch {
      // A host that is no longer configured or reachable: the next upload's sweep deletes it.
    }
  }
  return result
}

async function releaseGuide(ctx: JobContext, hostFor: GuideHostFor) {
  const guideKey = asString(ctx.providerMeta.guideKey)
  if (guideKey) await hostFor(ctx.credentials)?.remove(guideKey)
}

// ------------------------------------------------------------------------------------ adapter

/**
 * OpenRouter: one key for hundreds of text models (Claude, GPT, Gemini, DeepSeek…) that the AI Director uses, for
 * image models (GPT Image, Nano Banana, Seedream, FLUX.3, Recraft…) through its Image API, and for video models
 * (Seedance 2.5) through its Video API. Image jobs answer in one request; video jobs are submitted, then polled.
 * `fetchImpl` is for the key test; jobs use the global fetch. `guideHost` is where camera guides go (tests fake it).
 */
export function createOpenRouterAdapter(fetchImpl: typeof fetch = fetch, opts: { guideHost?: GuideHostFor } = {}): ProviderAdapter {
  const hostFor: GuideHostFor = opts.guideHost ?? ((credentials) => sshGuideHost(credentials))
  return {
    id: 'openrouter',
    label: LABEL,
    version: '2026-10-26.2',
    credentialFields: ['apiKey', 'uploadTarget', 'uploadUrl'],
    requiredFields: ['apiKey'],
    defaultConcurrency: 4,
    pollIntervalMs: 5000,
    async test(credentials: Credentials): Promise<ProviderTestResult> {
      try {
        const res = await fetchImpl(`${OPENROUTER_API}/key`, {
          headers: { Authorization: `Bearer ${credentials.apiKey}`, ...OPENROUTER_HEADERS },
          signal: AbortSignal.timeout(15_000),
        })
        if (res.status === 401) return { ok: false, message: 'Invalid API key' }
        if (!res.ok) {
          const detail = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message
          return { ok: false, message: `OpenRouter error ${res.status}${detail ? `: ${detail}` : ''}` }
        }
        const info = ((await res.json()) as KeyInfo).data ?? {}
        const remaining = typeof info.limit_remaining === 'number' ? info.limit_remaining : undefined
        const limit = typeof info.limit === 'number' ? info.limit : undefined
        const spent = typeof info.usage === 'number' ? ` $${info.usage.toFixed(2)} spent with this key so far.` : ''
        return {
          ok: true,
          message: `Connected${info.label ? ` (${info.label})` : ''} — the AI Director can use any OpenRouter text model, and Generate its image models and Seedance video.${spent}${info.is_free_tier ? ' Free tier: only free models until you add credits.' : ''}`,
          ...(remaining !== undefined || limit !== undefined ? { credits: { label: 'Key limit', remaining, limit, unit: 'USD' } } : {}),
        }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },
    async submit(ctx: JobContext): Promise<SubmitResult> {
      if (ctx.model.kind === 'video') return submitVideo(ctx, hostFor)
      if (ctx.model.kind !== 'image') throw new ProviderError(jobError('invalid_params', `${LABEL} generates images and video only`))
      return submitImage(ctx)
    },
    async poll(ctx: JobContext): Promise<PollResult> {
      return pollVideo(ctx, hostFor)
    },
    /** A canceled job's camera guide comes off the host now, not at the next upload's sweep (the job itself runs on). */
    async cancel(ctx: JobContext): Promise<void> {
      await releaseGuide(ctx, hostFor)
    },
    /** So does the guide of a job that ended without its result (lost contact, a poll error). */
    async release(ctx: JobContext): Promise<void> {
      await releaseGuide(ctx, hostFor)
    },
  }
}
