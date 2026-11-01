import { z } from 'zod'
import { flicksToSeconds } from '../../time/flicks'
import { KLING_MAX_SHOTS, KLING_MAX_SHOT_CHARS } from '../multishot'
import { P, hasValue, param } from '../params'
import type { CostEstimate, ModelSpec, ParamDef, ParamUi, ParamValues } from '../types'
import type { WorkflowOverrides } from '../workflow'

/**
 * fal.ai-hosted models. Param keys follow the shared conventions; the server adapter
 * (src/server/providers/fal.ts, FAL_ROUTES) maps them to each endpoint's field names.
 * Field names verified against fal's OpenAPI schemas on 2026-09-28.
 */

const AS_OF = '2026-09-28'

const round = (usd: number) => Math.round(usd * 10_000) / 10_000
/** $0.20, $0.0675, $1.164 — up to 4 decimals, at least 2. */
const money = (usd: number) => {
  const trimmed = usd.toFixed(4).replace(/0+$/, '')
  return `$${(trimmed.split('.')[1]?.length ?? 0) < 2 ? usd.toFixed(2) : trimmed}`
}
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length

function intSlider(key: string, label: string, min: number, max: number, def: number, extra: Partial<ParamUi> = {}): ParamDef {
  const d = P.slider(key, label, min, max, 1, def, extra)
  d.schema = z.coerce.number().int().min(min).max(max)
  return d
}

const startFrame = () => P.image('firstFrame', 'Start frame', { help: 'Animate from this image (image-to-video)' })
const endFrame = (help = 'Requires a start frame — the shot ends on this image') => P.image('lastFrame', 'End frame', { help })
const noFrames = (values: ParamValues) => !hasValue(values.firstFrame) && !hasValue(values.lastFrame)
const lastNeedsFirst = (values: ParamValues) =>
  hasValue(values.lastFrame) && !hasValue(values.firstFrame) ? 'An end frame needs a start frame' : null

const audioToggle = (def = true, help = 'Generate dialogue, SFX and ambience with the picture') =>
  P.toggle('audio', 'Generate audio', def, { help })

function perSecond(rate: number, seconds: number, label: string, asOf = AS_OF): CostEstimate {
  return { usd: round(rate * seconds), detail: `${seconds} s × ${money(rate)}/s (${label})`, asOf }
}

// ------------------------------------------------------------------------------------ image sizes

export type FalAspect = '16:9' | '9:16' | '1:1' | '4:3' | '3:4'
export interface FalSize {
  width: number
  height: number
}

const sizes = (w169: number, h169: number, square: number, w43: number, h43: number): Record<FalAspect, FalSize> => ({
  '16:9': { width: w169, height: h169 },
  '9:16': { width: h169, height: w169 },
  '1:1': { width: square, height: square },
  '4:3': { width: w43, height: h43 },
  '3:4': { width: h43, height: w43 },
})

/** FLUX.2 [pro] output sizes (multiples of 16), billed per started megapixel (2^20 px). */
export const FLUX2_SIZES = {
  '1MP': sizes(1344, 768, 1024, 1152, 864),
  '2MP': sizes(1920, 1088, 1440, 1664, 1248),
  '4MP': sizes(2560, 1440, 2048, 2304, 1728),
} as const satisfies Record<string, Record<FalAspect, FalSize>>

/** Seedream 5 Pro sizes: fal bills ≤1536² px at the standard rate and up to 2048² px at the high rate. */
export const SEEDREAM5_SIZES = {
  standard: sizes(1920, 1080, 1536, 1664, 1248),
  high: sizes(2560, 1440, 2048, 2304, 1728),
} as const satisfies Record<string, Record<FalAspect, FalSize>>

const IMAGE_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', 'auto'] as const
const aspectLabel = (v: string) => (v === 'auto' ? 'Auto' : v)

const referenceImages = (max: number) =>
  P.images('referenceImages', 'Reference images', max, {
    help: `Up to ${max} images to edit or compose from (switches to the edit endpoint)`,
  })

// ------------------------------------------------------------------------------------ image models

const nanoBananaPro: ModelSpec = {
  id: 'fal-nano-banana-pro',
  label: 'Nano Banana Pro',
  vendor: 'Google',
  provider: 'fal',
  kind: 'image',
  description: 'Gemini 3 Pro Image: best prompt adherence, legible text and multi-image edits up to 4K.',
  badges: ['4K', 'Refs', 'Edit', 'Text'],
  output: 'image',
  params: [
    P.prompt({ max: 20_000 }),
    referenceImages(14),
    P.select('aspectRatio', 'Aspect', ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '3:2', '2:3', '5:4', '4:5', 'auto'] as const, '16:9', {
      labels: aspectLabel,
    }),
    P.segmented('resolution', 'Resolution', ['1K', '2K', '4K'] as const, '2K'),
    P.seed(),
  ],
  estimateCost: (values) => {
    const rate = values.resolution === '4K' ? 0.3 : 0.15
    return { usd: rate, detail: `${money(rate)} per image (${String(values.resolution ?? '2K')})`, asOf: AS_OF }
  },
  maxVariants: 4,
}

const NB2_RATES: Record<string, number> = { '0.5K': 0.06, '1K': 0.08, '2K': 0.12, '4K': 0.16 }

const nanoBanana2: ModelSpec = {
  id: 'fal-nano-banana-2',
  label: 'Nano Banana 2',
  vendor: 'Google',
  provider: 'fal',
  kind: 'image',
  description: 'Fast, cheaper Gemini image model for iterations and storyboards, with reference-image edits.',
  badges: ['Fast', '4K', 'Refs', 'Edit'],
  output: 'image',
  params: [
    P.prompt({ max: 20_000 }),
    referenceImages(14),
    P.select('aspectRatio', 'Aspect', ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '3:2', '2:3', '5:4', '4:5', 'auto'] as const, '16:9', {
      labels: aspectLabel,
    }),
    P.segmented('resolution', 'Resolution', ['0.5K', '1K', '2K', '4K'] as const, '1K'),
    P.seed(),
  ],
  estimateCost: (values) => {
    const res = String(values.resolution ?? '1K')
    const rate = NB2_RATES[res] ?? 0.08
    return { usd: rate, detail: `${money(rate)} per image (${res})`, asOf: AS_OF }
  },
  maxVariants: 4,
}

const seedream5Pro: ModelSpec = {
  id: 'fal-seedream-5-pro',
  label: 'Seedream 5 Pro',
  vendor: 'ByteDance',
  provider: 'fal',
  kind: 'image',
  description: 'ByteDance’s photoreal image model with strong multi-reference editing (up to 10 images).',
  badges: ['Refs', 'Edit', '4 MP'],
  output: 'image',
  params: [
    P.prompt({ max: 5000 }),
    referenceImages(10),
    P.select('aspectRatio', 'Aspect', IMAGE_ASPECTS, '16:9', { labels: aspectLabel }),
    P.segmented('resolution', 'Resolution', ['standard', 'high'] as const, 'high', {
      labels: (v) => (v === 'standard' ? 'Standard (~2 MP)' : 'High (~4 MP)'),
    }),
  ],
  estimateCost: (values) => {
    const rate = values.resolution === 'standard' ? 0.0675 : 0.135
    return { usd: rate, detail: `${money(rate)} per image (${values.resolution === 'standard' ? '≤1536² px' : '≤2048² px'})`, asOf: AS_OF }
  },
  maxVariants: 6,
}

const flux2Pro: ModelSpec = {
  id: 'fal-flux-2-pro',
  label: 'FLUX.2 [pro]',
  vendor: 'Black Forest Labs',
  provider: 'fal',
  kind: 'image',
  description: 'Crisp photoreal stills with precise composition; multi-reference editing.',
  badges: ['Refs', 'Edit', '4 MP'],
  output: 'image',
  params: [
    P.prompt({ max: 5000 }),
    referenceImages(8),
    P.select('aspectRatio', 'Aspect', IMAGE_ASPECTS, '16:9', { labels: aspectLabel, help: 'Auto (keep the input’s shape) needs reference images' }),
    P.segmented('resolution', 'Resolution', ['1MP', '2MP', '4MP'] as const, '2MP'),
    P.seed(),
  ],
  validate: (values) =>
    values.aspectRatio === 'auto' && !hasValue(values.referenceImages) ? 'Auto aspect ratio needs reference images' : null,
  estimateCost: (values) => {
    const tier = (values.resolution as keyof typeof FLUX2_SIZES | undefined) ?? '2MP'
    const aspect = values.aspectRatio === 'auto' || !values.aspectRatio ? undefined : (values.aspectRatio as FalAspect)
    const size = aspect ? FLUX2_SIZES[tier][aspect] : undefined
    const mp = size ? Math.ceil((size.width * size.height) / 2 ** 20) : Number.parseInt(tier, 10)
    const usd = round(0.03 + 0.015 * Math.max(0, mp - 1))
    const refs = hasValue(values.referenceImages) ? ' + $0.015 per input megapixel' : ''
    return { usd, detail: `${mp} MP output: $0.03 + $0.015 × ${mp - 1} extra MP${refs}`, asOf: AS_OF }
  },
  maxVariants: 1,
}

// ------------------------------------------------------------------------------------ image models (schemas + prices checked 2026-10-02)

const OCT_AS_OF = '2026-10-02'
const MP = 2 ** 20

/** A size of about `area` px in the aspect ratio ('16:9', '2.35:1'…), edges multiples of 16 and at most `maxEdge`. */
export function sizeForArea(aspect: unknown, area: number, maxEdge = 3840): FalSize | undefined {
  if (typeof aspect !== 'string') return undefined
  const [a, b] = aspect.split(':').map(Number)
  if (!a || !b) return undefined
  const ratio = a / b
  const scale = Math.min(1, maxEdge / Math.max(Math.sqrt(area * ratio), Math.sqrt(area / ratio)))
  return { width: Math.floor((Math.sqrt(area * ratio) * scale) / 16) * 16, height: Math.floor((Math.sqrt(area / ratio) * scale) / 16) * 16 }
}

const megapixels = (size: FalSize | undefined) => (size ? (size.width * size.height) / MP : 1)

/** GPT Image 2.5 takes 655,360–8,294,400 px; 4K is the 8.3 MP ceiling (3840×2160 at 16:9). */
export const GPT_IMAGE_AREA = { '1K': MP, '2K': 4 * MP, '4K': 8_294_400 } as const
export const gptImageSize = (aspect: unknown, resolution: unknown) =>
  sizeForArea(aspect, GPT_IMAGE_AREA[String(resolution ?? '1K') as keyof typeof GPT_IMAGE_AREA] ?? MP)
/** fal's quoted cost of one 1024² image by quality (token-billed: $30 per 1M output image tokens). */
export const GPT_IMAGE_RATES: Record<string, number> = { low: 0.0059, medium: 0.0132, high: 0.0527, xhigh: 0.0937, max: 0.2107 }

const gptImage25: ModelSpec = {
  id: 'fal-gpt-image-2.5',
  label: 'GPT Image 2.5',
  vendor: 'OpenAI',
  provider: 'fal',
  kind: 'image',
  description: 'OpenAI’s image model: pixel-accurate text, layouts and UI, transparent backgrounds, and edits from up to 16 images.',
  badges: ['Text', 'Edit', 'Refs', 'Transparent', '4K'],
  output: 'image',
  params: [
    P.prompt({ max: 32_000 }),
    referenceImages(16),
    P.select('aspectRatio', 'Aspect', ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9', 'auto'] as const, '16:9', {
      labels: aspectLabel,
      help: 'Auto lets the model pick (edits keep the input’s shape)',
    }),
    P.segmented('resolution', 'Resolution', ['1K', '2K', '4K'] as const, '1K', { visibleIf: (values) => values.aspectRatio !== 'auto' }),
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
    const mp = values.aspectRatio === 'auto' ? 1 : megapixels(gptImageSize(values.aspectRatio ?? '16:9', values.resolution))
    const refs = hasValue(values.referenceImages) ? ' + input images' : ''
    return { usd: round(rate * mp), detail: `≈ ${money(rate)} per MP at ${quality} quality × ${mp.toFixed(1)} MP (token-billed)${refs}`, asOf: OCT_AS_OF }
  },
  maxVariants: 4,
}

const RECRAFT_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const
/** Recraft takes fal's named sizes. */
export const RECRAFT_SIZES: Record<string, string> = {
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
  '1:1': 'square_hd',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
}
const RECRAFT_STYLES = [
  'any',
  'realistic_image',
  'digital_illustration',
  'vector_illustration',
  ...(['b_and_w', 'hard_flash', 'hdr', 'natural_light', 'studio_portrait', 'enterprise', 'motion_blur', 'evening_light', 'faded_nostalgia', 'forest_life', 'mystic_naturalism', 'natural_tones', 'organic_calm', 'real_life_glow', 'retro_realism', 'retro_snapshot', 'urban_drama', 'village_realism', 'warm_folk'] as const).map(
    (s) => `realistic_image/${s}` as const,
  ),
  ...(['pixel_art', 'hand_drawn', 'grain', 'infantile_sketch', '2d_art_poster', 'handmade_3d', 'hand_drawn_outline', 'engraving_color', '2d_art_poster_2', 'antiquarian', 'bold_fantasy', 'child_book', 'child_books', 'cover', 'crosshatch', 'digital_engraving', 'expressionism', 'freehand_details', 'grain_20', 'graphic_intensity', 'hard_comics', 'long_shadow', 'modern_folk', 'multicolor', 'neon_calm', 'noir', 'nostalgic_pastel', 'outline_details', 'pastel_gradient', 'pastel_sketch', 'pop_art', 'pop_renaissance', 'street_art', 'tablet_sketch', 'urban_glow', 'urban_sketching', 'vanilla_dreams', 'young_adult_book', 'young_adult_book_2'] as const).map(
    (s) => `digital_illustration/${s}` as const,
  ),
  ...(['bold_stroke', 'chemistry', 'colored_stencil', 'contour_pop_art', 'cosmics', 'cutout', 'depressive', 'editorial', 'emotional_flat', 'infographical', 'marker_outline', 'mosaic', 'naivector', 'roundish_flat', 'segmented_colors', 'sharp_contrast', 'thin', 'vector_photo', 'vivid_shapes', 'engraving', 'line_art', 'line_circuit', 'linocut'] as const).map(
    (s) => `vector_illustration/${s}` as const,
  ),
]
const RECRAFT_FAMILY: Record<string, string> = {
  any: 'Any',
  realistic_image: 'Realistic',
  digital_illustration: 'Illustration',
  vector_illustration: 'Vector',
}
const recraftStyleLabel = (v: string) => {
  const [family = '', sub] = v.split('/')
  const name = RECRAFT_FAMILY[family] ?? family
  return sub ? `${name} · ${sub.replaceAll('_', ' ')}` : name
}

const recraftV3: ModelSpec = {
  id: 'fal-recraft-v3',
  label: 'Recraft V3',
  vendor: 'Recraft',
  provider: 'fal',
  kind: 'image',
  description: 'Design-focused model with 80+ styles — realistic, illustration and vector — for brand-consistent art and graphics.',
  badges: ['Styles', 'Design'],
  output: 'image',
  params: [
    P.prompt({ max: 1000 }),
    P.select('style', 'Style', RECRAFT_STYLES, 'realistic_image', { labels: recraftStyleLabel }),
    P.select('aspectRatio', 'Aspect', RECRAFT_ASPECTS, '16:9'),
  ],
  estimateCost: (values) => {
    const vector = String(values.style ?? '').startsWith('vector_illustration')
    const rate = vector ? 0.08 : 0.04
    return { usd: rate, detail: `${money(rate)} per image${vector ? ' (vector style)' : ''}`, asOf: OCT_AS_OF }
  },
  maxVariants: 4,
}

const recraftVector: ModelSpec = {
  id: 'fal-recraft-v4.1-vector',
  label: 'Recraft V4.1 Vector',
  vendor: 'Recraft',
  provider: 'fal',
  kind: 'image',
  description: 'Real SVG vectors for logos, icons and illustrations — scale to any size; the timeline uses a PNG preview.',
  badges: ['SVG', 'Vector'],
  output: 'image',
  params: [
    P.prompt({ max: 10_000 }),
    P.select('aspectRatio', 'Aspect', RECRAFT_ASPECTS, '1:1'),
    P.toggle('pro', 'Pro', false, { help: 'More detailed vectors — $0.30 instead of $0.08' }),
  ],
  estimateCost: (values) => {
    const rate = values.pro === true ? 0.3 : 0.08
    return { usd: rate, detail: `${money(rate)} per SVG${values.pro === true ? ' (Pro)' : ''}`, asOf: OCT_AS_OF }
  },
  maxVariants: 4,
}

const IDEOGRAM_RATES: Record<string, number> = { turbo: 0.0075, balanced: 0.015, quality: 0.025 }
export const ideogramSize = (aspect: unknown, resolution: unknown) => sizeForArea(aspect, (Number.parseInt(String(resolution ?? '1MP'), 10) || 1) * MP)

const ideogramV4: ModelSpec = {
  id: 'fal-ideogram-v4',
  label: 'Ideogram V4',
  vendor: 'Ideogram',
  provider: 'fal',
  kind: 'image',
  description: 'Typography specialist: posters, logos and ads with crisp, correctly spelled text; remix an image you add.',
  badges: ['Text', 'Design', 'Remix'],
  output: 'image',
  params: [
    P.prompt({ max: 10_000 }),
    P.images('referenceImages', 'Image to remix', 1, { help: 'Optional — restyle this image (image-to-image)', source: true }),
    P.select('aspectRatio', 'Aspect', ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '4:5', 'auto'] as const, '16:9', {
      labels: aspectLabel,
      help: 'Auto (keep the input’s shape) needs an image to remix',
    }),
    P.segmented('resolution', 'Resolution', ['1MP', '2MP', '4MP'] as const, '1MP', { visibleIf: (values) => values.aspectRatio !== 'auto' }),
    P.segmented('speed', 'Mode', ['turbo', 'balanced', 'quality'] as const, 'balanced', {
      labels: (v) => ({ turbo: 'Turbo', balanced: 'Balanced', quality: 'Quality' })[v],
    }),
    P.slider('strength', 'Remix strength', 0, 1, 0.05, 0.8, {
      advanced: true,
      help: 'How far the result may move from the image',
      visibleIf: (values) => hasValue(values.referenceImages),
    }),
    P.toggle('promptExpansion', 'Expand prompt', false, { advanced: true, help: 'Let Ideogram rewrite the prompt — off keeps your exact wording' }),
    P.seed(),
  ],
  validate: (values) => (values.aspectRatio === 'auto' && !hasValue(values.referenceImages) ? 'Auto aspect ratio needs an image to remix' : null),
  estimateCost: (values) => {
    const speed = String(values.speed ?? 'balanced')
    const rate = IDEOGRAM_RATES[speed] ?? IDEOGRAM_RATES.balanced!
    const mp = values.aspectRatio === 'auto' ? 1 : megapixels(ideogramSize(values.aspectRatio ?? '16:9', values.resolution))
    return { usd: round(rate * mp), detail: `${money(rate)} per MP (${speed}) × ${mp.toFixed(1)} MP`, asOf: OCT_AS_OF }
  },
  maxVariants: 4,
}

const KREA_RATES: Record<string, number> = { medium: 0.03, large: 0.06 }

const krea2: ModelSpec = {
  id: 'fal-krea-2',
  label: 'Krea 2',
  vendor: 'Krea',
  provider: 'fal',
  kind: 'image',
  description: 'Aesthetic image model steered by style references (up to 10); Turbo for very cheap drafts.',
  badges: ['Style refs', 'Fast'],
  output: 'image',
  params: [
    P.prompt({ max: 5000 }),
    P.images('referenceImages', 'Style references', 10, { help: 'Images whose look the result should follow (Medium and Large)' }),
    P.select('aspectRatio', 'Aspect', ['16:9', '9:16', '1:1', '4:3', '3:2', '2:3', '4:5', '2.35:1'] as const, '16:9'),
    P.segmented('tier', 'Model', ['turbo', 'medium', 'large'] as const, 'medium', {
      labels: (v) => ({ turbo: 'Turbo', medium: 'Medium', large: 'Large' })[v],
    }),
    P.segmented('creativity', 'Creativity', ['raw', 'low', 'medium', 'high'] as const, 'medium', {
      labels: (v) => v[0]!.toUpperCase() + v.slice(1),
      visibleIf: (values) => values.tier !== 'turbo',
    }),
    P.seed(),
  ],
  validate: (values) =>
    values.tier === 'turbo' && hasValue(values.referenceImages) ? 'Turbo doesn’t take style references — use Medium or Large' : null,
  estimateCost: (values) => {
    const tier = String(values.tier ?? 'medium')
    if (tier === 'turbo') {
      const mp = megapixels(sizeForArea(values.aspectRatio ?? '16:9', MP))
      return { usd: round(0.008 * mp), detail: `$0.008 per MP × ${mp.toFixed(1)} MP (Turbo)`, asOf: OCT_AS_OF }
    }
    const refs = hasValue(values.referenceImages)
    const rate = (KREA_RATES[tier] ?? 0.03) + (refs ? 0.005 : 0)
    return { usd: round(rate), detail: `${money(rate)} per image (${tier}${refs ? ', with style references' : ''})`, asOf: OCT_AS_OF }
  },
  maxVariants: 4,
}

const maiImage25: ModelSpec = {
  id: 'fal-mai-image-2.5',
  label: 'MAI-Image-2.5',
  vendor: 'Microsoft',
  provider: 'fal',
  kind: 'image',
  description: 'Microsoft’s photoreal image model with precise single-image edits.',
  badges: ['Edit'],
  output: 'image',
  params: [
    P.prompt({ max: 5000 }),
    P.images('referenceImages', 'Image to edit', 1, { help: 'Optional — edit this image instead of generating from scratch', source: true }),
    P.select('aspectRatio', 'Aspect', ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', 'auto'] as const, '16:9', { labels: aspectLabel }),
  ],
  estimateCost: (values) => ({
    usd: 0.05,
    detail: `≈ $0.05 per image (token-billed)${hasValue(values.referenceImages) ? ' + input image' : ''}`,
    asOf: OCT_AS_OF,
  }),
  maxVariants: 4,
}

// ------------------------------------------------------------------------------------ video models

const RES_LABEL = (v: string) => (v === '4k' ? '4K' : v)

/** Veo 3.1 reference-to-video ("ingredients"): up to 3 images, no start or end frame, a fixed 8 s, no negative prompt. */
export const VEO_MAX_REFERENCES = 3
export const VEO_REFERENCE_SECONDS = 8

function veoReferencesProblem(values: ParamValues): string | null {
  if (!hasValue(values.referenceImages)) return null
  if (!noFrames(values)) return 'Veo takes reference images or start/end frames, not both'
  if (Number(values.duration ?? VEO_REFERENCE_SECONDS) !== VEO_REFERENCE_SECONDS) return `With reference images Veo renders exactly ${VEO_REFERENCE_SECONDS} s`
  return null
}

function veo(fast: boolean): ModelSpec {
  const rates = fast
    ? { hd: { silent: 0.1, audio: 0.15 }, uhd: { silent: 0.3, audio: 0.35 } }
    : { hd: { silent: 0.2, audio: 0.4 }, uhd: { silent: 0.4, audio: 0.6 } }
  return {
    id: fast ? 'fal-veo3.1-fast' : 'fal-veo3.1',
    label: fast ? 'Veo 3.1 Fast' : 'Veo 3.1',
    vendor: 'Google',
    provider: 'fal',
    kind: 'video',
    description: fast
      ? 'Cheaper, quicker Veo 3.1 for drafts — same controls, native audio, reference images and 4K.'
      : 'Google’s cinematic model: realistic motion, native dialogue/SFX audio, start/end frames or up to 3 reference images, up to 4K.',
    badges: fast ? ['Fast', '4K', 'Audio', 'First+Last'] : ['4K', 'Audio', 'First+Last'],
    output: 'video',
    params: [
      P.prompt({ max: 20_000 }),
      P.negativePrompt(),
      startFrame(),
      endFrame(),
      P.images('referenceImages', 'Ingredients', VEO_MAX_REFERENCES, {
        help: `Up to ${VEO_MAX_REFERENCES} images of characters or objects to keep (reference-to-video): always 8 s, no start or end frame`,
      }),
      P.segmented('duration', 'Duration', [4, 6, 8] as const, 8, { unit: 's', labels: (v) => `${v}s` }),
      P.segmented('aspectRatio', 'Aspect', ['16:9', '9:16'] as const, '16:9', {
        help: 'Image-to-video follows the start frame',
        visibleIf: (values) => !hasValue(values.firstFrame),
      }),
      P.segmented('resolution', 'Resolution', ['720p', '1080p', '4k'] as const, '720p', { labels: RES_LABEL }),
      audioToggle(),
      P.seed(),
    ],
    validate: (values) => lastNeedsFirst(values) ?? veoReferencesProblem(values),
    estimateCost: (values) => {
      const tier = values.resolution === '4k' ? rates.uhd : rates.hd
      const audio = values.audio !== false
      return perSecond(audio ? tier.audio : tier.silent, Number(values.duration ?? 8), `${RES_LABEL(String(values.resolution ?? '720p'))}${audio ? ', audio' : ''}`)
    },
    maxVariants: 1,
    // Veo speaks English; a clip is at most 8 s. Its ingredients (reference images) aren't numbered — the prompt names
    // who they are — and come without frames, always 8 s.
    workflow: {
      speech: { languages: ['English'] },
      multishot: { maxSeconds: 8 },
      cast: { param: 'referenceImages', max: VEO_MAX_REFERENCES, maxWithKeyframe: 0, token: '{name}', fixedSeconds: VEO_REFERENCE_SECONDS, label: 'Ingredients' },
    },
  }
}

const SEEDANCE_RATES: Record<string, number> = { '480p': 0.2205, '720p': 0.473, '1080p': 1.164 }
/** Seedance 2.5 reference-to-video: up to 30 images, named @Image1… in the prompt; no start or end frame with them. */
export const SEEDANCE_MAX_REFERENCES = 30

const seedance25: ModelSpec = {
  id: 'fal-seedance-2.5',
  label: 'Seedance 2.5',
  vendor: 'ByteDance',
  provider: 'fal',
  kind: 'video',
  description: 'Long, coherent shots up to 30 s with synced audio and lip-synced speech; start/end frames or up to 30 reference images.',
  badges: ['Audio', 'First+Last', 'Refs', '30 s'],
  output: 'video',
  params: [
    P.prompt({ max: 5000 }),
    startFrame(),
    endFrame(),
    P.images('referenceImages', 'Reference images', SEEDANCE_MAX_REFERENCES, {
      help: 'Characters, products or places to keep (reference-to-video), named @Image1, @Image2… in the prompt; no start or end frame',
    }),
    intSlider('duration', 'Duration', 4, 30, 5, { unit: 's' }),
    P.select('aspectRatio', 'Aspect', ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'auto'] as const, '16:9', {
      labels: aspectLabel,
      help: 'Image-to-video follows the start frame',
      visibleIf: (values) => !hasValue(values.firstFrame),
    }),
    P.segmented('resolution', 'Resolution', ['480p', '720p', '1080p'] as const, '720p'),
    audioToggle(true, 'Same price with or without audio'),
  ],
  validate: (values) =>
    lastNeedsFirst(values) ?? (hasValue(values.referenceImages) && !noFrames(values) ? 'Use reference images or start/end frames, not both' : null),
  estimateCost: (values) => {
    const res = String(values.resolution ?? '720p')
    const est = perSecond(SEEDANCE_RATES[res] ?? 0.473, Number(values.duration ?? 5), res)
    return { ...est, detail: `${est.detail} + a small per-token fee` }
  },
  maxVariants: 1,
  // The cast and the place's photo share one numbered slot: @Image1… the characters, then the place.
  workflow: {
    cast: { token: '@Image{n}', maxWithKeyframe: 0, label: 'Reference images' },
    scene: { param: 'referenceImages', token: '@Image{n}' },
  },
}

const WAN_RATES: Record<string, number> = { '480p': 0.05, '720p': 0.1, '1080p': 0.2 }

const wan30: ModelSpec = {
  id: 'fal-wan-3.0',
  label: 'Wan 3.0',
  vendor: 'Alibaba',
  provider: 'fal',
  kind: 'video',
  description: 'Affordable 2–30 s shots up to 1080p with generated audio and start/end frames.',
  badges: ['Audio', 'First+Last', '30 s', 'Budget'],
  output: 'video',
  params: [
    P.prompt({ max: 20_000 }),
    startFrame(),
    endFrame(),
    intSlider('duration', 'Duration', 2, 30, 5, { unit: 's' }),
    P.select('aspectRatio', 'Aspect', ['16:9', '9:16', '1:1', '4:3', '3:4'] as const, '16:9', {
      help: 'Image-to-video follows the start frame',
      visibleIf: (values) => !hasValue(values.firstFrame),
    }),
    P.segmented('resolution', 'Resolution', ['480p', '720p', '1080p'] as const, '720p'),
    audioToggle(),
    P.seed(),
  ],
  validate: lastNeedsFirst,
  estimateCost: (values) => {
    const res = String(values.resolution ?? '720p')
    return perSecond(WAN_RATES[res] ?? 0.2, Number(values.duration ?? 5), res)
  },
  maxVariants: 1,
}

const MINIMAX_RATES: Record<string, number> = { '480p': 0.05, '768p': 0.08, '1080p': 0.16 }

const minimaxH3Max: ModelSpec = {
  id: 'fal-minimax-h3-max',
  label: 'MiniMax H3 Max',
  vendor: 'MiniMax',
  provider: 'fal',
  kind: 'video',
  description: 'Hailuo H3 Max: dynamic, physical motion 5–15 s; start and/or end keyframes.',
  badges: ['Audio', 'First+Last', '15 s'],
  output: 'video',
  params: [
    P.prompt({ max: 20_000 }),
    startFrame(),
    endFrame('Optional — may be used alone; the shot ends on this image'),
    intSlider('duration', 'Duration', 5, 15, 5, { unit: 's' }),
    P.select('aspectRatio', 'Aspect', ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const, '16:9', {
      help: 'Keyframe shots follow the image',
      visibleIf: noFrames,
    }),
    P.segmented('resolution', 'Resolution', ['480p', '768p', '1080p'] as const, '768p', {
      help: '1080p refines a native 768p render',
    }),
    P.select('promptExpansion', 'Prompt expansion', ['disabled', 'balanced', 'quality'] as const, 'balanced', {
      advanced: true,
      labels: (v) => (v === 'disabled' ? 'Off' : v === 'balanced' ? 'Balanced (~1 s)' : 'Quality (up to ~30 s)'),
    }),
    P.seed(),
  ],
  estimateCost: (values) => {
    const res = String(values.resolution ?? '768p')
    return perSecond(MINIMAX_RATES[res] ?? 0.08, Number(values.duration ?? 5), res)
  },
  maxVariants: 1,
}

const PIXVERSE_RATES: Record<string, { silent: number; audio: number }> = {
  '360p': { silent: 0.025, audio: 0.035 },
  '540p': { silent: 0.035, audio: 0.045 },
  '720p': { silent: 0.045, audio: 0.06 },
  '1080p': { silent: 0.09, audio: 0.115 },
}

const pixverseV6: ModelSpec = {
  id: 'fal-pixverse-v6',
  label: 'PixVerse V6',
  vendor: 'PixVerse',
  provider: 'fal',
  kind: 'video',
  description: 'Fast, stylised 1–15 s clips with optional audio and multi-clip camera changes.',
  badges: ['Audio', 'Multi-clip', '15 s', 'Budget'],
  output: 'video',
  params: [
    P.prompt({ max: 2048, help: 'Limited to 2048 bytes (accents and emoji count double)' }),
    P.negativePrompt(2048),
    startFrame(),
    intSlider('duration', 'Duration', 1, 15, 5, { unit: 's' }),
    P.select('aspectRatio', 'Aspect', ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '3:2', '2:3'] as const, '16:9', {
      help: 'Image-to-video follows the start frame',
      visibleIf: (values) => !hasValue(values.firstFrame),
    }),
    P.segmented('resolution', 'Resolution', ['360p', '540p', '720p', '1080p'] as const, '720p'),
    audioToggle(),
    P.toggle('multiClip', 'Multi-clip', false, { advanced: true, help: 'Dynamic camera changes between several clips' }),
    P.seed(),
  ],
  validate: (values) => {
    for (const key of ['prompt', 'negativePrompt'] as const) {
      const text = values[key]
      if (typeof text === 'string' && utf8Bytes(text) > 2048)
        return `${key === 'prompt' ? 'Prompt' : 'Negative prompt'} is over PixVerse’s 2048-byte limit`
    }
    return null
  },
  estimateCost: (values) => {
    const res = String(values.resolution ?? '720p')
    const audio = values.audio !== false
    const row = PIXVERSE_RATES[res] ?? PIXVERSE_RATES['1080p']!
    return perSecond(audio ? row.audio : row.silent, Number(values.duration ?? 5), `${res}${audio ? ', audio' : ''}`)
  },
  maxVariants: 1,
}

const ltx25Pro: ModelSpec = {
  id: 'fal-ltx-2.5-pro',
  label: 'LTX-2.5 Pro',
  vendor: 'Lightricks',
  provider: 'fal',
  kind: 'video',
  description: 'Lightricks LTX-2.5 Pro: 6–10 s at up to 50 fps with audio, camera moves and start/end frames.',
  badges: ['Audio', 'First+Last', '50 fps'],
  output: 'video',
  params: [
    P.prompt({ max: 5000 }),
    startFrame(),
    endFrame(),
    P.segmented('duration', 'Duration', [6, 8, 10] as const, 6, { unit: 's', labels: (v) => `${v}s` }),
    P.segmented('aspectRatio', 'Aspect', ['16:9', '9:16'] as const, '16:9', {
      help: 'Image-to-video follows the start frame',
      visibleIf: (values) => !hasValue(values.firstFrame),
    }),
    P.segmented('resolution', 'Resolution', ['720p', '1080p'] as const, '720p'),
    P.segmented('fps', 'FPS', [24, 25, 50] as const, 24),
    audioToggle(),
    P.select(
      'cameraMotion',
      'Camera move',
      ['none', 'static', 'dolly_in', 'dolly_out', 'dolly_left', 'dolly_right', 'jib_up', 'jib_down', 'focus_shift'] as const,
      'none',
      { advanced: true, labels: (v) => (v === 'none' ? 'From prompt' : v.replace('_', ' ').replace(/^\w/, (c) => c.toUpperCase())) },
    ),
  ],
  validate: lastNeedsFirst,
  estimateCost: (values) => {
    const res = String(values.resolution ?? '720p')
    return perSecond(res === '720p' ? 0.12 : 0.17, Number(values.duration ?? 6), res)
  },
  maxVariants: 1,
  // Lightricks: 2–4 cuts per multi-shot clip.
  workflow: { multishot: { maxShots: 4 } },
}

// ------------------------------------------------------------------------------------ video models (schemas + prices checked 2026-10-02)

const happyHorse11: ModelSpec = {
  id: 'fal-happy-horse-1.1',
  label: 'Happy Horse 1.1',
  vendor: 'Alibaba',
  provider: 'fal',
  kind: 'video',
  description: 'Talking characters with lip-synced speech in 7 languages, written in the prompt; up to 9 reference images.',
  badges: ['Audio', 'Lip-sync', 'Refs'],
  output: 'video',
  params: [
    P.prompt({ max: 5000 }),
    startFrame(),
    P.images('referenceImages', 'Reference images', 9, { help: 'Characters, products or places to keep (reference-to-video)' }),
    intSlider('duration', 'Duration', 3, 15, 5, { unit: 's' }),
    P.select('aspectRatio', 'Aspect', ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', '5:4', '4:5'] as const, '16:9', {
      help: 'Image-to-video follows the start frame',
      visibleIf: (values) => !hasValue(values.firstFrame),
    }),
    P.segmented('resolution', 'Resolution', ['720p', '1080p'] as const, '720p'),
    P.seed(),
  ],
  validate: (values) => (hasValue(values.firstFrame) && hasValue(values.referenceImages) ? 'Use a start frame or reference images, not both' : null),
  estimateCost: (values) => {
    const res = String(values.resolution ?? '720p')
    return perSecond(res === '720p' ? 0.14 : 0.18, Number(values.duration ?? 5), `${res}, audio`, OCT_AS_OF)
  },
  maxVariants: 1,
  // The prompt names the references character1…character9; references or a start frame, never both.
  workflow: { cast: { max: 9, maxWithKeyframe: 0, token: 'character{n}' } },
}

const GEMINI_OMNI_RATES: Record<string, number> = { '360p': 0.03, '720p': 0.1, '1080p': 0.15, '4k': 0.3 }

const geminiOmniFlash: ModelSpec = {
  id: 'fal-gemini-omni-flash',
  label: 'Gemini Omni Flash',
  vendor: 'Google',
  provider: 'fal',
  kind: 'video',
  description: 'Google’s fast omni video model: physically plausible motion with built-in audio, start/end frames, from cheap 360p drafts to 4K.',
  badges: ['Audio', 'First+Last', '4K', 'Budget'],
  output: 'video',
  params: [
    P.prompt({ max: 20_000 }),
    startFrame(),
    endFrame(),
    intSlider('duration', 'Duration', 3, 10, 8, { unit: 's' }),
    P.segmented('aspectRatio', 'Aspect', ['16:9', '9:16'] as const, '16:9'),
    P.segmented('resolution', 'Resolution', ['360p', '720p', '1080p', '4k'] as const, '720p', { labels: RES_LABEL }),
  ],
  validate: lastNeedsFirst,
  estimateCost: (values) => {
    const res = String(values.resolution ?? '720p')
    return perSecond(GEMINI_OMNI_RATES[res] ?? 0.1, Number(values.duration ?? 8), `${RES_LABEL(res)}, audio`, OCT_AS_OF)
  },
  maxVariants: 1,
}

/** Luma Ray 3.2 prices per 5 s clip; text-to-video doubles for 10 s, image-to-video is 5 s only. */
const LUMA_RATES = {
  t2v: { '540p': 0.5, '720p': 1, '1080p': 2 },
  i2v: { '540p': 0.15, '720p': 0.3, '1080p': 1.2 },
} as const satisfies Record<string, Record<string, number>>

const lumaRay32: ModelSpec = {
  id: 'fal-luma-ray-3.2',
  label: 'Luma Ray 3.2',
  vendor: 'Luma',
  provider: 'fal',
  kind: 'video',
  description: 'Luma’s cinematic model: seamless loops, start and/or end frames, 5–10 s shots (5 s with frames).',
  badges: ['Loop', 'First+Last'],
  output: 'video',
  params: [
    P.prompt({ max: 6000 }),
    startFrame(),
    endFrame('Optional — may be used alone; the shot ends on this image'),
    P.segmented('duration', 'Duration', [5, 10] as const, 5, { unit: 's', labels: (v) => `${v}s`, help: 'Shots from a start or end frame are 5 s' }),
    P.select('aspectRatio', 'Aspect', ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const, '16:9'),
    P.segmented('resolution', 'Resolution', ['540p', '720p', '1080p'] as const, '720p'),
    P.toggle('loop', 'Seamless loop', false, { help: 'The last frame flows back into the first' }),
  ],
  validate: (values) =>
    (hasValue(values.firstFrame) || hasValue(values.lastFrame)) && Number(values.duration) === 10 ? 'Shots from a start or end frame are 5 s' : null,
  estimateCost: (values) => {
    const res = String(values.resolution ?? '720p') as keyof typeof LUMA_RATES.t2v
    const fromFrames = hasValue(values.firstFrame) || hasValue(values.lastFrame)
    const clips = !fromFrames && Number(values.duration) === 10 ? 2 : 1
    const rate = (fromFrames ? LUMA_RATES.i2v : LUMA_RATES.t2v)[res] ?? 1
    return {
      usd: round(rate * clips),
      detail: `${money(rate)} per 5 s (${res}, ${fromFrames ? 'image' : 'text'}-to-video)${clips > 1 ? ' × 2' : ''}`,
      asOf: OCT_AS_OF,
    }
  },
  maxVariants: 1,
  // The storyboard renders from keyframes, and from a frame its validate takes 5 s only.
  workflow: { maxSecondsFromFrame: 5 },
}

/** fal's Kling Standard endpoints render 720p, Pro 1080p — the app shows the tier as a resolution. */
export type KlingFalTier = 'standard' | 'pro'
export const klingFalTier = (resolution: unknown): KlingFalTier => (resolution === '720p' ? 'standard' : 'pro')
const klingFalResolution = () =>
  P.segmented('resolution', 'Resolution', ['720p', '1080p'] as const, '720p', {
    labels: (v) => (v === '720p' ? 'Standard 720p' : 'Pro 1080p'),
    help: 'fal’s Standard and Pro tiers',
  })
/** USD per second by tier (fal pages, 2026-10-02 — same as Kling’s own API). */
const KLING_FAL_RATES = {
  v3: { standard: { silent: 0.084, audio: 0.126 }, pro: { silent: 0.112, audio: 0.168 } },
  o3: { standard: { silent: 0.084, audio: 0.112 }, pro: { silent: 0.112, audio: 0.14 } },
} as const
function klingFalCost(family: keyof typeof KLING_FAL_RATES, values: ParamValues, audioDefault: boolean): CostEstimate {
  const tier = klingFalTier(values.resolution)
  const audio = typeof values.audio === 'boolean' ? values.audio : audioDefault
  const rate = KLING_FAL_RATES[family][tier]
  return perSecond(audio ? rate.audio : rate.silent, Number(values.duration ?? 5), `${tier === 'pro' ? '1080p' : '720p'}${audio ? ', audio' : ''}`, OCT_AS_OF)
}

// Kling elements and shot lists on fal (schemas checked 2026-10-09: fal-ai/kling-video/v3/{tier}/image-to-video,
// …/o3/{tier}/reference-to-video).

/** A Kling element on fal: a front view plus 1–3 more angles (`frontal_image_url` + `reference_image_urls`). */
export const KLING_FAL_ELEMENT_VIEWS = { min: 2, max: 4 } as const
/** Elements a request takes together with a start frame. */
export const KLING_FAL_ELEMENTS_WITH_FRAME = 3
/** O3 reference-to-video: elements and reference images together. */
export const KLING_O3_MAX_INPUTS = 7
/** Three elements of four views each. */
const KLING_FAL_ELEMENT_IMAGES = KLING_FAL_ELEMENTS_WITH_FRAME * KLING_FAL_ELEMENT_VIEWS.max

/**
 * The storyboard's characters as Kling elements, flat: `elementImages` lists every element's views (front first), one
 * element after another, and `elementCounts` how many each has ([3, 2]: element 1 is images 1–3, element 2 images
 * 4–5). The job worker resolves flat asset lists only; the fal adapter rebuilds fal's `elements` from the two. The
 * prompt names them @Element1, @Element2… Set by the storyboard, never drawn.
 */
const klingElementParams = (): ParamDef[] => [
  P.images('elementImages', 'Element images', KLING_FAL_ELEMENT_IMAGES, {
    hidden: true,
    help: 'Each element’s front view, then its other angles — @Element1, @Element2… in the prompt',
  }),
  param('elementCounts', z.array(z.coerce.number().int().min(1).max(KLING_FAL_ELEMENT_VIEWS.max)).max(KLING_O3_MAX_INPUTS).optional(), {
    label: 'Images per element',
    control: 'text',
    hidden: true,
  }),
]

const countOf = (v: unknown) => (Array.isArray(v) ? v.length : hasValue(v) ? 1 : 0)

/** The element lists agree with each other and with fal's rules: 2–4 views each, at most `max` elements. */
function klingElementsProblem(values: ParamValues, opts: { needsFrame: boolean; refs?: number }): string | null {
  const images = countOf(values.elementImages)
  const counts = Array.isArray(values.elementCounts) ? values.elementCounts.map(Number) : []
  if (!images && !counts.length) return null
  if (counts.reduce((a, b) => a + b, 0) !== images) return 'The element images don’t match their counts'
  if (counts.some((n) => n < KLING_FAL_ELEMENT_VIEWS.min || n > KLING_FAL_ELEMENT_VIEWS.max)) return 'Each Kling element takes a front view and 1–3 more angles'
  const framed = hasValue(values.firstFrame)
  if (opts.needsFrame && !framed) return 'Kling elements need a start frame'
  if (framed && counts.length > KLING_FAL_ELEMENTS_WITH_FRAME) return `Up to ${KLING_FAL_ELEMENTS_WITH_FRAME} Kling elements with a start frame`
  if (counts.length + (opts.refs ?? 0) > KLING_O3_MAX_INPUTS) return `Up to ${KLING_O3_MAX_INPUTS} elements and reference images together`
  return null
}

/**
 * Kling's own shot list on fal (`multi_prompt`, sent instead of the prompt): up to 6 shots, each ≤ 512 characters and
 * at least 1 s, adding up to the clip. Set by the storyboard's multi-shot groups, never drawn.
 */
const multiPromptParam = () =>
  param(
    'multiPrompt',
    z
      .array(z.object({ prompt: z.string().trim().min(1).max(KLING_MAX_SHOT_CHARS), duration: z.coerce.number().int().min(1).max(15) }))
      .min(1)
      .max(KLING_MAX_SHOTS)
      .optional(),
    { label: 'Shots', control: 'text', hidden: true },
  )

function multiPromptProblem(values: ParamValues): string | null {
  const shots = Array.isArray(values.multiPrompt) ? (values.multiPrompt as { duration: number }[]) : []
  if (!shots.length) return null
  const sum = shots.reduce((a, s) => a + Number(s.duration), 0)
  const duration = Number(values.duration ?? 5)
  return sum === duration ? null : `The shots add up to ${sum} s, the clip is ${duration} s`
}

const klingV3: ModelSpec = {
  id: 'fal-kling-3.0',
  label: 'Kling 3.0 (fal)',
  vendor: 'Kling AI',
  provider: 'fal',
  kind: 'video',
  description: 'Kling 3.0 through fal — no Kling key needed: up to 15 s with native audio and start/end frames, Standard 720p or Pro 1080p.',
  badges: ['Audio', 'First+Last', '15 s'],
  output: 'video',
  params: [
    P.prompt({ max: 2500 }),
    P.negativePrompt(2500),
    startFrame(),
    endFrame(),
    ...klingElementParams(),
    multiPromptParam(),
    intSlider('duration', 'Duration', 3, 15, 5, { unit: 's' }),
    P.segmented('aspectRatio', 'Aspect', ['16:9', '9:16', '1:1'] as const, '16:9', {
      help: 'Image-to-video follows the start frame',
      visibleIf: (values) => !hasValue(values.firstFrame),
    }),
    klingFalResolution(),
    audioToggle(),
  ],
  validate: (values) => lastNeedsFirst(values) ?? klingElementsProblem(values, { needsFrame: true }) ?? multiPromptProblem(values),
  estimateCost: (values) => klingFalCost('v3', values, true),
  maxVariants: 1,
  // Elements (a front view + angles each) only with a start frame, up to 3; the multiPrompt param makes the shot list native.
  workflow: {
    cast: { param: 'elementImages', max: 0, maxWithKeyframe: KLING_FAL_ELEMENTS_WITH_FRAME, token: '@Element{n}', needsAngles: true, label: 'Kling elements' },
    speech: { languages: ['English', 'Chinese'], lowercaseEnglish: true },
  },
}

/**
 * O3 takes the characters as elements (@Element1…, up to 3 kept to be safe — 3 is its limit with a start frame) and
 * the place's photo, or a character with only a front view, as reference images (@Image1…); 7 inputs in all. It speaks
 * English or Chinese like every Kling.
 */
const KLING_O3_WORKFLOW: WorkflowOverrides = {
  cast: {
    param: 'elementImages',
    max: KLING_FAL_ELEMENTS_WITH_FRAME,
    maxWithKeyframe: KLING_FAL_ELEMENTS_WITH_FRAME,
    token: '@Element{n}',
    needsAngles: true,
    label: 'Kling elements',
  },
  scene: { param: 'referenceImages', token: '@Image{n}' },
  speech: { languages: ['English', 'Chinese'], lowercaseEnglish: true },
}

/** Kling O3 (Kling 3.0 Omni) on fal: text-, image- or reference-to-video (elements and reference images go to the last). */

const klingO3Params = (): ParamDef[] => [
  P.prompt({ max: 2500 }),
  startFrame(),
  endFrame(),
  P.images('referenceImages', 'Reference images', KLING_O3_MAX_INPUTS, { help: 'Characters, products or places to keep (reference-to-video)' }),
  ...klingElementParams(),
  intSlider('duration', 'Duration', 3, 15, 5, { unit: 's' }),
  P.segmented('aspectRatio', 'Aspect', ['16:9', '9:16', '1:1'] as const, '16:9', {
    help: 'Image-to-video follows the start frame',
    visibleIf: (values) => !hasValue(values.firstFrame) || hasValue(values.referenceImages) || hasValue(values.elementImages),
  }),
]

const klingO3Validate = (values: ParamValues) =>
  lastNeedsFirst(values) ?? klingElementsProblem(values, { needsFrame: false, refs: countOf(values.referenceImages) })

const klingO3: ModelSpec = {
  id: 'fal-kling-o3',
  label: 'Kling O3',
  vendor: 'Kling AI',
  provider: 'fal',
  kind: 'video',
  description: 'Kling O3 (Kling 3.0 Omni) through fal: start/end frames, up to 7 reference images, optional native audio, Standard 720p or Pro 1080p.',
  badges: ['Refs', 'First+Last', 'Audio', '15 s'],
  output: 'video',
  params: [...klingO3Params(), klingFalResolution(), audioToggle(false)],
  validate: klingO3Validate,
  estimateCost: (values) => klingFalCost('o3', values, false),
  maxVariants: 1,
  workflow: KLING_O3_WORKFLOW,
}

const klingO34k: ModelSpec = {
  id: 'fal-kling-o3-4k',
  label: 'Kling O3 4K',
  vendor: 'Kling AI',
  provider: 'fal',
  kind: 'video',
  description: 'Kling O3 rendering natively in 4K through fal: start/end frames, up to 7 reference images, optional native audio.',
  badges: ['4K', 'First+Last', 'Refs', 'Audio'],
  output: 'video',
  params: [...klingO3Params(), audioToggle(false, 'Same price with or without audio')],
  validate: klingO3Validate,
  estimateCost: (values) => perSecond(0.42, Number(values.duration ?? 5), `4K${values.audio === true ? ', audio' : ''}`, OCT_AS_OF),
  maxVariants: 1,
  workflow: KLING_O3_WORKFLOW,
}

/** Veo 3.1 extend adds a fixed 7 s at 720p, to 720p/1080p clips Veo made (up to 30 s in all). */
export const VEO_EXTEND_SECONDS = 7
export const VEO_EXTEND_MAX_SECONDS = 30
export const VEO_EXTEND_SOURCES = ['fal-veo3.1', 'fal-veo3.1-fast', 'fal-veo3.1-extend']
export const canExtendWithVeo = (asset: {
  kind: string
  durationFlicks?: number
  width?: number
  height?: number
  generation?: { modelId: string }
}) =>
  asset.kind === 'video' &&
  VEO_EXTEND_SOURCES.includes(asset.generation?.modelId ?? '') &&
  Math.min(asset.width ?? 0, asset.height ?? 0) <= 1080 &&
  flicksToSeconds(asset.durationFlicks ?? 0) + VEO_EXTEND_SECONDS <= VEO_EXTEND_MAX_SECONDS + 0.5
const VEO_EXTEND_RATES = { standard: { silent: 0.2, audio: 0.4 }, fast: { silent: 0.1, audio: 0.15 } } as const

const veoExtend: ModelSpec = {
  id: 'fal-veo3.1-extend',
  label: 'Veo 3.1 Extend',
  vendor: 'Google',
  provider: 'fal',
  kind: 'video',
  description: 'Continues a Veo-made clip by 7 s at 720p, keeping motion and sound continuous; the result is the whole, longer clip (up to 30 s).',
  badges: ['Extend', 'Audio'],
  output: 'video',
  params: [
    P.video('video', 'Clip to extend'),
    P.prompt({ max: 20_000, help: 'What happens next' }),
    P.segmented('tier', 'Speed', ['fast', 'standard'] as const, 'fast', { labels: (v) => (v === 'fast' ? 'Fast' : 'Standard') }),
    audioToggle(),
  ],
  estimateCost: (values) => {
    const tier = values.tier === 'standard' ? VEO_EXTEND_RATES.standard : VEO_EXTEND_RATES.fast
    const audio = values.audio !== false
    return perSecond(audio ? tier.audio : tier.silent, VEO_EXTEND_SECONDS, `${values.tier === 'standard' ? 'standard' : 'fast'}${audio ? ', audio' : ''}`, OCT_AS_OF)
  },
  maxVariants: 1,
}

// ------------------------------------------------------------------------------------ audio / post

const SYNC_MODES = ['cut_off', 'loop', 'bounce', 'silence', 'remap'] as const
const SYNC_MODE_LABELS: Record<(typeof SYNC_MODES)[number], string> = {
  cut_off: 'Cut to shorter',
  loop: 'Loop video',
  bounce: 'Ping-pong video',
  silence: 'Pad with silence',
  remap: 'Time-remap video',
}

const syncLipsyncV3: ModelSpec = {
  id: 'fal-sync-lipsync-v3',
  label: 'Sync Lipsync 3',
  vendor: 'Sync Labs',
  provider: 'fal',
  kind: 'lipsync',
  description: 'Re-times a face’s lip movements in a video to new speech audio.',
  badges: ['Lip-sync'],
  output: 'video',
  params: [
    P.video('video', 'Video'),
    P.audio('audioClip', 'Speech audio'),
    P.select('syncMode', 'When lengths differ', SYNC_MODES, 'cut_off', { labels: (v) => SYNC_MODE_LABELS[v] }),
  ],
  estimateCost: () => ({ usd: null, detail: '$8 per minute of output (≈ $0.133/s)', asOf: AS_OF }),
  maxVariants: 1,
}

const mmaudioV2: ModelSpec = {
  id: 'fal-mmaudio-v2',
  label: 'MMAudio V2',
  vendor: 'MMAudio',
  provider: 'fal',
  kind: 'foley',
  description: 'Foley for a video clip: synchronised sound effects and ambience from the picture plus a prompt.',
  badges: ['Video→Audio', 'Budget'],
  output: 'audio',
  defaultRole: 'effects',
  params: [
    P.video('video', 'Video'),
    P.prompt({ label: 'Sound', max: 2000, placeholder: 'Footsteps on gravel, distant thunder, wind' }),
    P.negativePrompt(2000),
    P.slider('durationSeconds', 'Length', 1, 30, 1, 8, { unit: 's', help: 'Usually the clip length' }),
    P.seed(),
  ],
  estimateCost: (values) => perSecond(0.001, Number(values.durationSeconds ?? 8), 'audio'),
  maxVariants: 1,
}

const stableAudio25: ModelSpec = {
  id: 'fal-stable-audio-2.5',
  label: 'Stable Audio 2.5',
  vendor: 'Stability AI',
  provider: 'fal',
  kind: 'music',
  description: 'Instrumental music and soundscapes up to 190 s at a flat price per track.',
  badges: ['Instrumental', '190 s', 'Budget'],
  output: 'audio',
  defaultRole: 'music',
  params: [
    P.prompt({ max: 2000, label: 'Music', placeholder: 'Warm lo-fi piano, vinyl crackle, 80 BPM' }),
    intSlider('durationSeconds', 'Length', 1, 190, 30, { unit: 's' }),
    P.seed(),
  ],
  estimateCost: () => ({ usd: 0.2, detail: '$0.20 per track', asOf: AS_OF }),
  maxVariants: 1,
}

// ------------------------------------------------------------------------------------ upscale

/**
 * Upscalers: schemas and prices checked on fal on 2026-09-29. fal bills them by output size × duration, which the
 * params alone don't tell (the input's resolution and length aren't known here), so estimates are rate cards.
 */
const UPSCALE_AS_OF = '2026-09-29'

const upscaleFactor = () =>
  P.segmented('scale', 'Upscale', [2, 4] as const, 2, {
    labels: (v) => `${v}×`,
    help: 'Multiplies width and height — 2× turns 1080p into 4K',
  })

/** Topaz frame-interpolation targets; 0 keeps the source frame rate (no interpolation). */
export const TOPAZ_TARGET_FPS = [0, 24, 25, 30, 48, 50, 60] as const

const topazUpscaleVideo: ModelSpec = {
  id: 'fal-topaz-upscale-video',
  label: 'Topaz Video Upscale',
  vendor: 'Topaz Labs',
  provider: 'fal',
  kind: 'upscale',
  description: 'Topaz Proteus upscaling up to 4× with optional Apollo frame interpolation to 60 fps (smooth motion, slow-mo).',
  badges: ['4×', 'Interpolation'],
  output: 'video',
  params: [
    P.video('video', 'Video'),
    upscaleFactor(),
    P.select('targetFps', 'Frame rate', TOPAZ_TARGET_FPS, 0, {
      labels: (v) => (v === 0 ? 'Keep source' : `${v} fps (interpolate)`),
      help: 'Interpolation generates in-between frames; 60 fps output costs double',
    }),
  ],
  estimateCost: (values) => ({
    usd: null,
    detail: `Per second of output: $0.08 above 1080p, $0.02 up to 1080p, $0.01 up to 720p${
      Number(values.targetFps) === 60 ? ' — doubled at 60 fps' : ' (doubled for 60 fps output)'
    }`,
    asOf: UPSCALE_AS_OF,
  }),
  maxVariants: 1,
}

const seedvr2UpscaleVideo: ModelSpec = {
  id: 'fal-seedvr2-upscale-video',
  label: 'SeedVR2 Video Upscale',
  vendor: 'ByteDance',
  provider: 'fal',
  kind: 'upscale',
  description: 'ByteDance SeedVR2 one-step diffusion restoration: upscales up to 4× and rebuilds fine texture and detail.',
  badges: ['4×', 'Restoration'],
  output: 'video',
  params: [P.video('video', 'Video'), upscaleFactor(), P.seed()],
  estimateCost: () => ({
    usd: null,
    detail: '$0.001 per megapixel of upscaled video (width × height × frames) — about $0.20/s for 4K at 24 fps',
    asOf: UPSCALE_AS_OF,
  }),
  maxVariants: 1,
}

const topazUpscaleImage: ModelSpec = {
  id: 'fal-topaz-upscale-image',
  label: 'Topaz Image Upscale',
  vendor: 'Topaz Labs',
  provider: 'fal',
  kind: 'upscale',
  description: 'Topaz Standard V2 upscaling for stills and frames, up to 4× with face recovery.',
  badges: ['4×', 'Faces'],
  output: 'image',
  params: [
    P.image('image', 'Image', { required: true }),
    upscaleFactor(),
    P.toggle('faceEnhancement', 'Face recovery', true, { advanced: true, help: 'Restores faces — turn off for stylised art' }),
  ],
  estimateCost: (values) => {
    const inputMp = Number(values.scale) === 4 ? '1.5' : '6'
    return {
      usd: null,
      detail: `$0.08 per image up to 24 MP output (a ≤${inputMp} MP input), $0.16 up to 48 MP, $0.32 up to 96 MP`,
      asOf: UPSCALE_AS_OF,
    }
  },
  maxVariants: 1,
}

// ------------------------------------------------------------------------------------ image tools (canvas)

const IMAGE_TOOLS_AS_OF = '2026-10-05'

const briaRmbg: ModelSpec = {
  id: 'fal-bria-rmbg',
  label: 'Bria RMBG 2.0',
  vendor: 'Bria',
  provider: 'fal',
  kind: 'cutout',
  description: 'Removes the background: the subject on transparency. Trained only on licensed data — safe for commercial work.',
  badges: ['Transparent PNG', 'Commercial-safe'],
  output: 'image',
  params: [P.image('image', 'Image', { required: true })],
  estimateCost: () => ({ usd: 0.018, detail: '$0.018 per image', asOf: IMAGE_TOOLS_AS_OF }),
  maxVariants: 1,
}

export const BIREFNET_MODELS = ['General Use (Light)', 'General Use (Light 2K)', 'General Use (Heavy)', 'Matting', 'Portrait'] as const

const birefnet: ModelSpec = {
  id: 'fal-birefnet-v2',
  label: 'BiRefNet v2',
  vendor: 'BiRefNet (open source)',
  provider: 'fal',
  kind: 'cutout',
  description: 'Open-source background removal with modes for hair and fur (Matting) and portraits; pennies or less per image.',
  badges: ['Transparent PNG', 'Hair & fur'],
  output: 'image',
  params: [
    P.image('image', 'Image', { required: true }),
    P.select('mode', 'Model', BIREFNET_MODELS, 'General Use (Light 2K)', {
      help: 'Matting keeps hair and fur; Portrait is tuned for people',
    }),
    P.segmented('resolution', 'Working resolution', ['1024x1024', '2048x2048'] as const, '2048x2048', {
      advanced: true,
      help: 'Higher is sharper on large images',
    }),
  ],
  estimateCost: () => ({ usd: null, detail: 'Billed by GPU time on fal — a few seconds per image', asOf: IMAGE_TOOLS_AS_OF }),
  maxVariants: 1,
}

const recraftVectorize: ModelSpec = {
  id: 'fal-recraft-vectorize',
  label: 'Recraft Vectorize',
  vendor: 'Recraft',
  provider: 'fal',
  kind: 'vectorize',
  description: 'Traces an image into a clean SVG — for logos, icons and flat illustrations. Inputs are scaled to fit its 4096 px / 5 MB limit.',
  badges: ['SVG'],
  output: 'image',
  params: [P.image('image', 'Image', { required: true })],
  estimateCost: () => ({ usd: 0.01, detail: '$0.01 per image', asOf: IMAGE_TOOLS_AS_OF }),
  maxVariants: 1,
}

// ------------------------------------------------------------------------------------ custom endpoint

export const FAL_CUSTOM_PLACEHOLDERS = ['prompt', 'image', 'video', 'audio'] as const

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function custom(kind: 'video' | 'image' | 'audio'): ModelSpec {
  const outputPath = kind === 'video' ? 'video.url' : kind === 'image' ? 'images[*].url' : 'audio.url'
  return {
    id: kind === 'video' ? 'fal-custom' : `fal-custom-${kind}`,
    label: `Custom fal ${kind === 'video' ? 'video' : kind} endpoint`,
    vendor: 'fal',
    provider: 'fal',
    kind: kind === 'audio' ? 'sfx' : kind,
    description: 'Call any fal endpoint by id with a raw JSON input — for trying new models on day one.',
    badges: ['Advanced'],
    output: kind,
    ...(kind === 'audio' ? { defaultRole: 'effects' } : {}),
    params: [
      P.prompt({ max: 20_000, help: 'Inserted wherever the input JSON contains "{{prompt}}"' }),
      param(
        'endpointId',
        z
          .string()
          .trim()
          .regex(/^[\w.-]+(\/[\w.@-]+)+$/, 'Use an endpoint id like fal-ai/some-model/text-to-video'),
        { label: 'Endpoint id', control: 'text', placeholder: 'fal-ai/some-model/text-to-video' },
      ),
      param(
        'inputJson',
        z
          .string()
          .trim()
          .refine((s) => parseJsonObject(s) !== null, 'Input must be a JSON object'),
        {
          label: 'Input JSON',
          control: 'textarea',
          help: 'Sent as the request input. "{{prompt}}", "{{image}}", "{{video}}" and "{{audio}}" are replaced with the prompt and the uploaded input files.',
        },
        '{\n  "prompt": "{{prompt}}"\n}',
      ),
      param(
        'outputPath',
        z
          .string()
          .trim()
          .regex(/^[A-Za-z_]\w*(?:\[(?:\d+|\*)\]|\.[A-Za-z_]\w*)*$/, 'Use a path like video.url or images[0].url'),
        { label: 'Output path', control: 'text', help: 'Where the file URL sits in the response; [*] takes every item' },
        outputPath,
      ),
      P.image('image', 'Image input', { advanced: true }),
      P.video('video', 'Video input', false),
      P.audio('audioClip', 'Audio input', false),
    ],
    validate: (values) => {
      const json = typeof values.inputJson === 'string' ? values.inputJson : ''
      const inputs: Record<string, unknown> = { image: values.image, video: values.video, audio: values.audioClip }
      for (const [name, value] of Object.entries(inputs)) {
        if (json.includes(`{{${name}}}`) && !hasValue(value)) return `Input JSON uses {{${name}}} but no ${name} input is set`
      }
      return null
    },
    estimateCost: () => ({ usd: null, detail: 'Custom endpoint — see the model’s pricing on fal.ai', asOf: AS_OF }),
    maxVariants: 1,
  }
}

export const falModels: ModelSpec[] = [
  nanoBananaPro,
  nanoBanana2,
  seedream5Pro,
  flux2Pro,
  gptImage25,
  recraftV3,
  recraftVector,
  ideogramV4,
  krea2,
  maiImage25,
  veo(false),
  veo(true),
  seedance25,
  wan30,
  minimaxH3Max,
  pixverseV6,
  ltx25Pro,
  happyHorse11,
  geminiOmniFlash,
  lumaRay32,
  klingV3,
  klingO3,
  klingO34k,
  veoExtend,
  syncLipsyncV3,
  mmaudioV2,
  stableAudio25,
  topazUpscaleVideo,
  seedvr2UpscaleVideo,
  topazUpscaleImage,
  briaRmbg,
  birefnet,
  recraftVectorize,
  custom('video'),
  custom('image'),
  custom('audio'),
]
