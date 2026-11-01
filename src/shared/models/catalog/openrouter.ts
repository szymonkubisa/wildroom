import { z } from 'zod'
import { P, hasValue, param } from '../params'
import type { CostEstimate, ModelSpec, ParamValues } from '../types'
import { GPT_IMAGE_RATES } from './fal'

/**
 * Image models through OpenRouter's Image API (POST /api/v1/images): one key for GPT Image, Nano Banana, Seedream,
 * FLUX.3, Recraft, Grok Imagine… Param keys follow the shared conventions; the server
 * (src/server/providers/openrouter.ts, OPENROUTER_IMAGE_ROUTES) maps each model to OpenRouter's model id and
 * request fields. Capabilities and prices checked against /api/v1/images/models and each model's /endpoints on
 * 2026-10-05. OpenRouter bills only finished images and reports the exact cost with each one.
 */

export const OPENROUTER_IMAGE_AS_OF = '2026-10-05'
const AS_OF = OPENROUTER_IMAGE_AS_OF

const round = (usd: number) => Math.round(usd * 10_000) / 10_000
/** $0.20, $0.0675, $0.134 — up to 4 decimals, at least 2. */
const money = (usd: number) => {
  const trimmed = usd.toFixed(4).replace(/0+$/, '')
  return `$${(trimmed.split('.')[1]?.length ?? 0) < 2 ? usd.toFixed(2) : trimmed}`
}
const refCount = (values: ParamValues) => (Array.isArray(values.referenceImages) ? values.referenceImages.length : 0)
const aspectLabel = (v: string) => (v === 'auto' ? 'Auto' : v)
const aspect = (values: readonly string[], def = '16:9', help?: string) =>
  P.select('aspectRatio', 'Aspect', values, def, { labels: aspectLabel, ...(help ? { help } : {}) })
const references = (max: number, help = `Up to ${max} images to edit or compose from`) =>
  P.images('referenceImages', 'Reference images', max, { help })
/** A flat price per image, looked up by one param's value (resolution, tier…). */
const perImage =
  (rates: Record<string, number>, key: string, fallback: string, extra?: (v: ParamValues) => { usd: number; note: string }) =>
  (values: ParamValues): CostEstimate => {
    const tier = String(values[key] ?? fallback)
    const rate = rates[tier] ?? rates[fallback]!
    const add = extra?.(values)
    return { usd: round(rate + (add?.usd ?? 0)), detail: `${money(rate)} per image (${tier})${add?.note ?? ''}`, asOf: AS_OF }
  }
/** Inputs some vendors bill per reference image. */
const perInput = (rate: number) => (values: ParamValues) => {
  const n = refCount(values)
  return { usd: rate * n, note: n ? ` + ${n} × ${money(rate)} per input image` : '' }
}

const WIDE_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9', '5:4', '4:5', 'auto'] as const

// ------------------------------------------------------------------------------------ curated models

const gptImage25: ModelSpec = {
  id: 'or-gpt-image-2.5',
  label: 'GPT Image 2.5',
  vendor: 'OpenAI',
  provider: 'openrouter',
  kind: 'image',
  description: 'OpenAI’s image model: pixel-accurate text, layouts and UI, transparent backgrounds, and edits from up to 16 images.',
  badges: ['Text', 'Edit', 'Refs', 'Transparent'],
  output: 'image',
  params: [
    P.prompt({ max: 32_000 }),
    references(16),
    aspect(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9', 'auto'], '16:9', 'Auto lets the model pick (edits keep the input’s shape)'),
    P.select('quality', 'Quality', ['low', 'medium', 'high', 'xhigh', 'max'] as const, 'high', {
      labels: (v) => ({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' })[v],
      help: 'Higher quality costs more and takes longer',
    }),
    P.segmented('tier', 'Tier', ['flare', 'sunburst'] as const, 'flare', {
      labels: (v) => (v === 'flare' ? 'Flare (fast)' : 'Sunburst (detail)'),
    }),
    P.toggle('transparent', 'Transparent background', false, { help: 'PNG with alpha — logos, product cut-outs, stickers' }),
  ],
  estimateCost: (values) => {
    const quality = String(values.quality ?? 'high')
    const rate = GPT_IMAGE_RATES[quality] ?? GPT_IMAGE_RATES.high!
    return {
      usd: round(rate),
      detail: `≈ ${money(rate)} per image at ${quality} quality (token-billed: $30 per 1M image tokens)${refCount(values) ? ' + input images' : ''}`,
      asOf: AS_OF,
    }
  },
  maxVariants: 4,
  twinOf: 'fal-gpt-image-2.5',
}

const nanoBananaPro: ModelSpec = {
  id: 'or-nano-banana-pro',
  label: 'Nano Banana Pro',
  vendor: 'Google',
  provider: 'openrouter',
  kind: 'image',
  description: 'Gemini 3 Pro Image: best prompt adherence, legible text and multi-image edits up to 4K.',
  badges: ['4K', 'Refs', 'Edit', 'Text'],
  output: 'image',
  params: [
    P.prompt({ max: 20_000 }),
    references(14),
    aspect(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '3:2', '2:3', '5:4', '4:5']),
    P.segmented('resolution', 'Resolution', ['1K', '2K', '4K'] as const, '2K'),
  ],
  // $120 per 1M image tokens: 1,120 tokens up to 2K, 2,000 at 4K.
  estimateCost: (values) => {
    const k4 = values.resolution === '4K'
    const rate = k4 ? 0.24 : 0.1344
    return { usd: rate, detail: `≈ ${money(rate)} per image (${k4 ? '4K' : '1K–2K'}, token-billed)`, asOf: AS_OF }
  },
  maxVariants: 4,
  twinOf: 'fal-nano-banana-pro',
}

const nanoBanana2: ModelSpec = {
  id: 'or-nano-banana-2',
  label: 'Nano Banana 2',
  vendor: 'Google',
  provider: 'openrouter',
  kind: 'image',
  description: 'Fast, cheaper Gemini image model for iterations and storyboards, with reference-image edits and extreme banners (8:1).',
  badges: ['Fast', '4K', 'Refs', 'Edit'],
  output: 'image',
  params: [
    P.prompt({ max: 20_000 }),
    references(14),
    aspect(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '3:2', '2:3', '5:4', '4:5', '4:1', '1:4', '8:1', '1:8']),
    P.segmented('resolution', 'Resolution', ['512', '1K', '2K', '4K'] as const, '1K', { labels: (v) => (v === '512' ? '0.5K' : v) }),
  ],
  // $60 per 1M image tokens.
  estimateCost: perImage({ '512': 0.045, '1K': 0.067, '2K': 0.101, '4K': 0.151 }, 'resolution', '1K'),
  maxVariants: 4,
  twinOf: 'fal-nano-banana-2',
}

const seedream5Pro: ModelSpec = {
  id: 'or-seedream-5-pro',
  label: 'Seedream 5 Pro',
  vendor: 'ByteDance',
  provider: 'openrouter',
  kind: 'image',
  description: 'ByteDance’s photoreal image model with strong multi-reference editing (up to 14 images).',
  badges: ['Refs', 'Edit'],
  output: 'image',
  params: [P.prompt({ max: 5000 }), references(14), aspect(WIDE_ASPECTS), P.segmented('resolution', 'Resolution', ['1K', '2K'] as const, '2K'), P.seed()],
  estimateCost: perImage({ '1K': 0.045, '2K': 0.09 }, 'resolution', '2K', perInput(0.003)),
  maxVariants: 4,
  twinOf: 'fal-seedream-5-pro',
}

const seedream5Lite: ModelSpec = {
  id: 'or-seedream-5-lite',
  label: 'Seedream 5 Lite',
  vendor: 'ByteDance',
  provider: 'openrouter',
  kind: 'image',
  description: 'Lighter Seedream 5: 2K or 4K stills and reference edits at a flat low price.',
  badges: ['4K', 'Refs', 'Cheap'],
  output: 'image',
  params: [P.prompt({ max: 5000 }), references(14), aspect(WIDE_ASPECTS), P.segmented('resolution', 'Resolution', ['2K', '4K'] as const, '2K'), P.seed()],
  estimateCost: () => ({ usd: 0.035, detail: '$0.035 per image (2K or 4K)', asOf: AS_OF }),
  maxVariants: 4,
}

const flux3: ModelSpec = {
  id: 'or-flux-3',
  label: 'FLUX.3',
  vendor: 'Black Forest Labs',
  provider: 'openrouter',
  kind: 'image',
  description: 'Black Forest Labs’ flagship: photoreal stills and multi-reference edits (up to 10 images), 768 px to 4K.',
  badges: ['4K', 'Refs', 'Edit'],
  output: 'image',
  params: [
    P.prompt({ max: 5000 }),
    references(10),
    aspect(WIDE_ASPECTS, '16:9', 'Auto keeps the reference image’s shape'),
    P.select('resolution', 'Resolution', ['768', '1K', '1.5K', '2K', '4K'] as const, '1K', { labels: (v) => (v === '768' ? '768 px' : v) }),
  ],
  estimateCost: perImage({ '768': 0.041, '1K': 0.048, '1.5K': 0.07, '2K': 0.1, '4K': 0.607 }, 'resolution', '1K'),
  maxVariants: 4,
}

const RECRAFT_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const

const recraftV41: ModelSpec = {
  id: 'or-recraft-v4.1',
  label: 'Recraft V4.1',
  vendor: 'Recraft',
  provider: 'openrouter',
  kind: 'image',
  description: 'Design-focused raster images — brand graphics, illustration and photography with clean composition.',
  badges: ['Design'],
  output: 'image',
  params: [
    P.prompt({ max: 10_000 }),
    P.images('referenceImages', 'Image to restyle', 1, { help: 'Optional — generate from this image', source: true }),
    aspect(RECRAFT_ASPECTS),
    P.toggle('pro', 'Pro', false, { help: 'More detailed — $0.21 instead of $0.035' }),
  ],
  estimateCost: (values) => {
    const rate = values.pro === true ? 0.21 : 0.035
    return { usd: rate, detail: `${money(rate)} per image${values.pro === true ? ' (Pro)' : ''}`, asOf: AS_OF }
  },
  maxVariants: 4,
}

const recraftV41Vector: ModelSpec = {
  id: 'or-recraft-v4.1-vector',
  label: 'Recraft V4.1 Vector',
  vendor: 'Recraft',
  provider: 'openrouter',
  kind: 'image',
  description: 'Real SVG vectors for logos, icons and illustrations — scale to any size; the timeline uses a PNG preview.',
  badges: ['SVG', 'Vector'],
  output: 'image',
  params: [
    P.prompt({ max: 10_000 }),
    P.images('referenceImages', 'Image to restyle', 1, { help: 'Optional — vectorise in the spirit of this image', source: true }),
    aspect(RECRAFT_ASPECTS, '1:1'),
    P.toggle('pro', 'Pro', false, { help: 'More detailed vectors — $0.30 instead of $0.08' }),
  ],
  estimateCost: (values) => {
    const rate = values.pro === true ? 0.3 : 0.08
    return { usd: rate, detail: `${money(rate)} per SVG${values.pro === true ? ' (Pro)' : ''}`, asOf: AS_OF }
  },
  maxVariants: 4,
  twinOf: 'fal-recraft-v4.1-vector',
}

const GROK_RATES: Record<string, number> = { low_1K: 0.04, low_2K: 0.06, medium_1K: 0.06, medium_2K: 0.08 }

const grokImagine2: ModelSpec = {
  id: 'or-grok-imagine-2',
  label: 'Grok Imagine Image 2',
  vendor: 'xAI',
  provider: 'openrouter',
  kind: 'image',
  description: 'xAI’s image model: vivid, fast stills and edits from up to 3 images, at 1K or 2K.',
  badges: ['Fast', 'Refs', 'Edit'],
  output: 'image',
  params: [
    P.prompt({ max: 5000 }),
    references(3),
    aspect(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', 'auto']),
    P.segmented('resolution', 'Resolution', ['1K', '2K'] as const, '1K'),
    P.segmented('quality', 'Quality', ['low', 'medium'] as const, 'medium', { labels: (v) => (v === 'low' ? 'Low' : 'Medium') }),
  ],
  estimateCost: (values) => {
    const quality = String(values.quality ?? 'medium')
    const resolution = String(values.resolution ?? '1K')
    const rate = GROK_RATES[`${quality}_${resolution}`] ?? GROK_RATES.medium_1K!
    const extra = perInput(0.01)(values)
    return { usd: round(rate + extra.usd), detail: `${money(rate)} per image (${quality}, ${resolution})${extra.note}`, asOf: AS_OF }
  },
  maxVariants: 4,
}

const qwenImage3Pro: ModelSpec = {
  id: 'or-qwen-image-3-pro',
  label: 'Qwen Image 3 Pro',
  vendor: 'Qwen',
  provider: 'openrouter',
  kind: 'image',
  description: 'Alibaba’s image model: strong text rendering (including Chinese) and edits from up to 4 images.',
  badges: ['Text', 'Refs', 'Edit'],
  output: 'image',
  params: [
    P.prompt({ max: 5000 }),
    references(4),
    aspect(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '2:1', '1:2']),
    P.segmented('resolution', 'Resolution', ['1K', '2K'] as const, '1K'),
    P.seed(),
  ],
  estimateCost: perImage({ '1K': 0.04, '2K': 0.075 }, 'resolution', '1K', perInput(0.003)),
  maxVariants: 4,
}

const maiImage26: ModelSpec = {
  id: 'or-mai-image-2.6',
  label: 'MAI-Image-2.6',
  vendor: 'Microsoft',
  provider: 'openrouter',
  kind: 'image',
  description: 'Microsoft’s photoreal image model with edits from up to 5 images.',
  badges: ['Refs', 'Edit'],
  output: 'image',
  params: [P.prompt({ max: 5000 }), references(5), aspect(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', 'auto'])],
  estimateCost: (values) => ({
    usd: 0.05,
    detail: `≈ $0.05 per image (token-billed: $38 per 1M image tokens)${refCount(values) ? ' + input images' : ''}`,
    asOf: AS_OF,
  }),
  maxVariants: 4,
}

// ------------------------------------------------------------------------------------ any model

/** OpenRouter's model ids: "vendor/model", optionally with a ":variant". */
export const OPENROUTER_MODEL_ID_RE = /^[a-z0-9][\w.-]*\/[\w.-]+(:[\w.-]+)?$/i

/** One of OpenRouter's image models with what it supports, as the "Any OpenRouter image model" picker lists it. */
export interface OpenRouterImageModel {
  id: string
  name: string
  description?: string
  /** Reference images it takes; `max: 0` means text-to-image only. */
  refs: { min: number; max: number }
  aspects?: string[]
  resolutions?: string[]
  qualities?: string[]
  transparent: boolean
  seed: boolean
  /** Output formats it can encode (unset: the provider's default). */
  formats?: string[]
  /** Returns SVG vectors. */
  svg: boolean
}

const anyImageModel: ModelSpec = {
  id: 'or-image-any',
  label: 'Any OpenRouter image model',
  vendor: 'OpenRouter',
  provider: 'openrouter',
  kind: 'image',
  description:
    'Pick any image model OpenRouter lists — new ones included. Settings a model doesn’t have are left out; aspect and resolution snap to the nearest it offers.',
  badges: ['50+ models'],
  output: 'image',
  params: [
    param(
      'orModel',
      z.string().trim().regex(OPENROUTER_MODEL_ID_RE, 'Pick a model'),
      { label: 'Model', control: 'openrouterImageModel' },
      'bytedance-seed/seedream-5-0-flash',
    ),
    P.prompt({ max: 32_000 }),
    references(16, 'Sent to models that take reference images (the list shows how many)'),
    aspect(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9', '5:4', '4:5', '2:1', '1:2', 'auto'], '16:9', 'Snapped to the nearest one the model offers'),
    P.segmented('resolution', 'Resolution', ['1K', '2K', '4K'] as const, '1K', { help: 'For models with size tiers: the nearest one they offer' }),
    P.select('quality', 'Quality', ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const, 'auto', {
      labels: (v) => ({ auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' })[v],
      advanced: true,
      help: 'For models with a quality setting (GPT Image, Grok)',
    }),
    P.toggle('transparent', 'Transparent background', false, { advanced: true, help: 'Only for models that support it (GPT Image, Riverflow…)' }),
    P.seed(),
  ],
  estimateCost: () => ({ usd: null, detail: 'Priced per model on OpenRouter (shown under the picker); the exact cost is recorded after', asOf: AS_OF }),
  maxVariants: 4,
}

// ------------------------------------------------------------------------------------ video models

/**
 * Video models through OpenRouter's Video API (POST /api/v1/videos, then polled): the server maps each one in
 * OPENROUTER_VIDEO_ROUTES (src/server/providers/openrouter.ts). Checked against OpenRouter's docs on 2026-10-26.
 */
export const OPENROUTER_VIDEO_AS_OF = '2026-10-26'
/** Seedance 2.5 on OpenRouter: images in `input_references` (references, or the keyframe when a camera guide is sent). */
export const OR_SEEDANCE_MAX_IMAGES = 9
/**
 * OpenRouter's display price for Seedance 2.5, per 1M tokens (tokens = width × height × seconds × 24 / 1024): cheaper
 * when the request carries a reference video, but the reference video's seconds are billed too — a 4 s 480p clip with
 * a 4 s guide cost $0.494 (2026-10-26), ≈ 8 s at $0.0615. The exact charge comes back with the finished clip (usage.cost).
 */
export const OR_SEEDANCE_PRICE_PER_M = { plain: 10.7, withVideo: 6.4 } as const
const OR_SEEDANCE_PIXELS: Record<string, number> = { '480p': 854 * 480, '720p': 1280 * 720 }

const imageCount = (v: unknown) => (Array.isArray(v) ? v.length : hasValue(v) ? 1 : 0)

const orSeedance25: ModelSpec = {
  id: 'or-seedance-2.5',
  label: 'Seedance 2.5',
  vendor: 'ByteDance',
  provider: 'openrouter',
  kind: 'video',
  description: 'Long, coherent shots up to 30 s with synced audio; start/end frames, reference images, or a Blender previs as a camera guide.',
  badges: ['Audio', 'First+Last', 'Refs', 'Camera guide', '30 s'],
  output: 'video',
  params: [
    P.prompt({ max: 5000 }),
    P.image('firstFrame', 'Start frame', { help: 'Animate from this image (image-to-video). With a camera guide it goes in as the look to keep instead' }),
    P.image('lastFrame', 'End frame', { help: 'Requires a start frame — the shot ends on this image. Not with a camera guide' }),
    P.images('referenceImages', 'Reference images', OR_SEEDANCE_MAX_IMAGES, {
      help: 'Characters, products or places to keep (reference-to-video), named @Image1, @Image2… in the prompt; no start or end frame',
    }),
    {
      ...P.video('guideVideo', 'Camera guide (previs)', false),
      ui: {
        label: 'Camera guide (previs)',
        control: 'video',
        help: 'A Blender previs the clip follows: its camera moves, framing and where things are. The look comes from the start frame and the prompt — use a styled first frame, never the grey one. Sets the clip’s length (4–30 s). Needs a camera-guide upload folder in Settings → Providers → OpenRouter',
      },
    },
    {
      ...P.slider('duration', 'Duration', 4, 30, 1, 5, { unit: 's', help: 'A camera guide is cut, or held on its last frame, to this length (its seconds are billed too)' }),
      schema: z.coerce.number().int().min(4).max(30),
    },
    P.select('aspectRatio', 'Aspect', ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const, '16:9', {
      help: 'Image-to-video follows the start frame',
      visibleIf: (values) => !hasValue(values.firstFrame) || hasValue(values.guideVideo),
    }),
    P.segmented('resolution', 'Resolution', ['480p', '720p'] as const, '720p'),
    P.toggle('audio', 'Generate audio', true, { help: 'Dialogue, SFX and ambience with the picture' }),
    P.seed(),
  ],
  validate: (values) => {
    const guide = hasValue(values.guideVideo)
    const first = hasValue(values.firstFrame)
    const refs = imageCount(values.referenceImages)
    if (guide && hasValue(values.lastFrame)) return 'A camera guide and an end frame don’t work together — the guide sets the whole shot. Remove the end frame'
    if (hasValue(values.lastFrame) && !first) return 'An end frame needs a start frame'
    if (!guide && refs && first) return 'Use reference images or start/end frames, not both'
    if (guide && first && refs + 1 > OR_SEEDANCE_MAX_IMAGES) return `With a camera guide the start frame counts as a reference image: up to ${OR_SEEDANCE_MAX_IMAGES - 1} more`
    return null
  },
  estimateCost: (values) => {
    const res = String(values.resolution ?? '720p')
    const seconds = Number(values.duration ?? 5)
    const withVideo = hasValue(values.guideVideo)
    const perM = withVideo ? OR_SEEDANCE_PRICE_PER_M.withVideo : OR_SEEDANCE_PRICE_PER_M.plain
    const perSecond = ((OR_SEEDANCE_PIXELS[res] ?? OR_SEEDANCE_PIXELS['720p']!) * 24) / 1024 / 1e6 * perM
    // With a guide, the guide (cut or held to the clip's length) is billed as well.
    const billed = withVideo ? seconds * 2 : seconds
    return {
      usd: round(perSecond * billed),
      detail: withVideo
        ? `≈ ${money(perSecond)}/s × (${seconds} s + the guide’s ${seconds} s) (${res}, with a reference video; $${perM.toFixed(2)} per 1M video tokens) — the exact cost is recorded after`
        : `≈ ${money(perSecond)}/s × ${seconds} s (${res}; $${perM.toFixed(2)} per 1M video tokens) — the exact cost is recorded after`,
      asOf: OPENROUTER_VIDEO_AS_OF,
    }
  },
  maxVariants: 1,
  twinOf: 'fal-seedance-2.5',
  // As on fal: the cast and the place's photo share one numbered slot, @Image1… the characters, then the place.
  workflow: {
    cast: { token: '@Image{n}', maxWithKeyframe: 0, label: 'Reference images' },
    scene: { param: 'referenceImages', token: '@Image{n}' },
  },
}

export const openRouterModels: ModelSpec[] = [
  gptImage25,
  nanoBananaPro,
  nanoBanana2,
  seedream5Pro,
  seedream5Lite,
  flux3,
  recraftV41,
  recraftV41Vector,
  grokImagine2,
  qwenImage3Pro,
  maiImage26,
  anyImageModel,
  orSeedance25,
]
