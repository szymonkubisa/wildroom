import { z } from 'zod'
import { KLING_MAX_SHOTS, KLING_MAX_SHOT_CHARS, MULTI_SHOT_PROMPT_HELP, multiShotProblem, parseMultiShot } from '../multishot'
import { P, hasAsset, param } from '../params'
import type { CostEstimate, ModelSpec, ParamDef, ParamUi, ParamValues } from '../types'
import type { WorkflowOverrides } from '../workflow'

const AS_OF = '2026-09-28'

export type KlingResolution = '720p' | '1080p' | '4k'

/**
 * How native audio works for a model:
 * - `toggle`: user choice;  `toggle-1080p`: only offered at 1080p;  `always`: always generated;  `none`: silent.
 */
export type KlingAudioMode = 'toggle' | 'toggle-1080p' | 'always' | 'none'

/**
 * Kling elements (characters/props from the element library) a model accepts, in the new request format
 * (`contents: [{ type: 'element', element_id, id }]`). Docs (2026-09-28):
 * https://kling.ai/document-api/api/video/3-0-omni/image-to-video — Kling 3.0: up to 3 elements, image-to-video only
 * (text-to-video has no `contents`); https://kling.ai/document-api/api/video/3-0-omni/video-omni — Omni: at most 3
 * with a first (+ last) frame, otherwise up to 7 multi-image elements (reference images count towards the 7).
 */
export interface KlingElementLimits {
  /** Maximum without start/end frames. */
  max: number
  /** Maximum when a start frame (and optional end frame) is used. */
  withFrames: number
  /** Elements only work together with a start frame (Kling 3.0 image-to-video). */
  needsFirstFrame?: boolean
}

export interface KlingVariant {
  /** Catalog model id. */
  id: string
  /** Model slug in the API path (`/text-to-video/{slug}`, `/omni-video/{slug}`). */
  slug: string
  /**
   * Endpoint family: `standard` = `/text-to-video/{slug}` or `/image-to-video/{slug}` (picked by the start frame),
   * `omni` = `/omni-video/{slug}` for everything.
   */
  family?: 'standard' | 'omni'
  label: string
  description: string
  badges: string[]
  /** Allowed durations in seconds: a range or an explicit list. */
  durations: { min: number; max: number } | { values: number[] }
  defaultDuration: number
  resolutions: KlingResolution[]
  defaultResolution: KlingResolution
  audio: KlingAudioMode
  firstFrame: boolean
  lastFrame: boolean
  multiShot: boolean
  /** Undefined = the model takes no Kling elements. */
  elements?: KlingElementLimits
  /** USD per second by resolution, silent vs. with native audio (null = combination not offered). */
  pricing: Partial<Record<KlingResolution, { silent: number | null; audio: number | null }>>
  /** How the storyboard works with it, beyond what its params say (see workflowFor). */
  workflow?: WorkflowOverrides
}

/** Kling speaks its lines in English or Chinese (English ones read best in lower case). */
const KLING_SPEECH = { languages: ['English', 'Chinese'], lowercaseEnglish: true }
/** Kling's own shot list: up to 6 shots of up to 512 characters each. */
const KLING_SHOT_LIST = { maxShots: KLING_MAX_SHOTS, maxShotChars: KLING_MAX_SHOT_CHARS }

/** Kling official-API video models. The adapter reads slugs and audio behaviour from here. */
export const KLING_VARIANTS: KlingVariant[] = [
  {
    id: 'kling-3.0',
    slug: 'kling-3.0',
    label: 'Kling 3.0',
    description: 'Kling’s flagship: up to 15 s in 4K with native audio, start/end frames and multi-shot cuts.',
    badges: ['4K', 'Audio', 'First+Last', 'Multi-shot', '15 s'],
    durations: { min: 3, max: 15 },
    defaultDuration: 5,
    resolutions: ['720p', '1080p', '4k'],
    defaultResolution: '720p',
    audio: 'toggle',
    firstFrame: true,
    lastFrame: true,
    multiShot: true,
    elements: { max: 3, withFrames: 3, needsFirstFrame: true },
    pricing: {
      '720p': { silent: 0.084, audio: 0.126 },
      '1080p': { silent: 0.112, audio: 0.168 },
      '4k': { silent: 0.42, audio: 0.42 },
    },
    workflow: { multishot: KLING_SHOT_LIST, speech: KLING_SPEECH },
  },
  {
    // https://kling.ai/document-api/api/video/3-0-omni/video-omni — POST /omni-video/kling-3.0-omni
    // Prices: https://kling.ai/document-api/pricing/base/video ("No Video Input" rows).
    id: 'kling-3.0-omni',
    slug: 'kling-3.0-omni',
    family: 'omni',
    label: 'Kling 3.0 Omni',
    description: 'Kling’s all-in-one model: up to 7 cast characters (elements), start/end frames, multi-shot cuts and native audio, up to 15 s in 4K.',
    badges: ['Characters', '4K', 'Audio', 'Multi-shot', '15 s'],
    durations: { min: 3, max: 15 },
    defaultDuration: 5,
    resolutions: ['720p', '1080p', '4k'],
    defaultResolution: '720p',
    audio: 'toggle',
    firstFrame: true,
    lastFrame: true,
    multiShot: true,
    elements: { max: 7, withFrames: 3 },
    pricing: {
      '720p': { silent: 0.084, audio: 0.112 },
      '1080p': { silent: 0.112, audio: 0.14 },
      '4k': { silent: 0.42, audio: 0.42 },
    },
    workflow: { multishot: KLING_SHOT_LIST, speech: KLING_SPEECH },
  },
  {
    id: 'kling-3.0-turbo',
    slug: 'kling-3.0-turbo',
    label: 'Kling 3.0 Turbo',
    description: 'Faster Kling 3.0 up to 1080p; native audio is always on.',
    badges: ['Fast', 'Audio', '1080p'],
    durations: { min: 3, max: 15 },
    defaultDuration: 5,
    resolutions: ['720p', '1080p'],
    defaultResolution: '720p',
    audio: 'always',
    firstFrame: true,
    lastFrame: false,
    multiShot: false,
    pricing: {
      '720p': { silent: null, audio: 0.112 },
      '1080p': { silent: null, audio: 0.14 },
    },
    // No shot list of its own: a multi-shot clip has its cuts written in prose.
    workflow: { speech: KLING_SPEECH },
  },
  {
    id: 'kling-2.6',
    slug: 'kling-2.6',
    label: 'Kling 2.6',
    description: 'Solid all-rounder, 3–10 s up to 1080p; native audio at 1080p.',
    badges: ['Audio', '1080p'],
    durations: { min: 3, max: 10 },
    defaultDuration: 5,
    resolutions: ['720p', '1080p'],
    // Its sound comes only at 1080p: a 720p default would make every clip silent.
    defaultResolution: '1080p',
    audio: 'toggle-1080p',
    firstFrame: true,
    lastFrame: false,
    multiShot: false,
    pricing: {
      '720p': { silent: 0.042, audio: null },
      '1080p': { silent: 0.07, audio: 0.14 },
    },
  },
  {
    id: 'kling-2.5-turbo',
    slug: 'kling-2.5-turbo',
    label: 'Kling 2.5 Turbo',
    description: 'Budget Kling for silent B-roll and start→end frame transitions (5 or 10 s).',
    badges: ['First+Last', '1080p', 'Budget'],
    durations: { values: [5, 10] },
    defaultDuration: 5,
    resolutions: ['720p', '1080p'],
    defaultResolution: '720p',
    audio: 'none',
    firstFrame: true,
    lastFrame: true,
    multiShot: false,
    pricing: {
      '720p': { silent: 0.042, audio: null },
      '1080p': { silent: 0.07, audio: null },
    },
  },
]

export function klingVariant(modelId: string): KlingVariant | undefined {
  return KLING_VARIANTS.find((v) => v.id === modelId)
}

/** Element ids from the `elements` param (non-empty strings, in order). */
export function klingElementIds(values: ParamValues): string[] {
  return Array.isArray(values.elements) ? values.elements.filter((e): e is string => typeof e === 'string' && e.length > 0) : []
}

/** How the prompt refers to the n-th (0-based) element: `@element_1`, `@element_2`… (the `id` sent with it). */
export const klingElementRef = (index: number) => `element_${index + 1}`

/** How many Kling elements a model takes for this input (0 = none: unsupported, or Kling 3.0 without a start frame). */
export function klingElementLimit(modelId: string, hasFirstFrame: boolean): number {
  const limits = klingVariant(modelId)?.elements
  if (!limits || (limits.needsFirstFrame && !hasFirstFrame)) return 0
  return hasFirstFrame ? limits.withFrames : limits.max
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Points character names in a prompt at their elements: `names[i]` (the character behind `elements[i]`) becomes
 * `@element_{i+1}`, whole words only, longest names first. Handles already in the prompt are left alone.
 */
export function withKlingElementMentions(prompt: string, names: readonly (string | undefined)[]): string {
  const order = names
    .map((name, index) => ({ name: name?.trim() ?? '', index }))
    .filter((n) => n.name.length > 0 && !prompt.includes(`@${klingElementRef(n.index)}`))
    .sort((a, b) => b.name.length - a.name.length)
  let out = prompt
  for (const { name, index } of order) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_@])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'giu')
    out = out.replace(pattern, `@${klingElementRef(index)}`)
  }
  return out
}

/** Whether a request with these (parsed) params gets native audio. */
export function klingAudioOn(variant: KlingVariant, values: ParamValues): boolean {
  switch (variant.audio) {
    case 'always':
      return true
    case 'none':
      return false
    case 'toggle':
      return values.audio !== false
    case 'toggle-1080p':
      return values.resolution === '1080p' && values.audio !== false
  }
}

const RES_LABEL: Record<KlingResolution, string> = { '720p': '720p', '1080p': '1080p', '4k': '4K' }

function intSlider(key: string, label: string, min: number, max: number, def: number, extra: Partial<ParamUi> = {}): ParamDef {
  const d = P.slider(key, label, min, max, 1, def, extra)
  d.schema = z.coerce.number().int().min(min).max(max)
  return d
}

function elementsHelp(limits: KlingElementLimits): string {
  const count = limits.needsFirstFrame
    ? `Up to ${limits.withFrames}, together with a start frame`
    : limits.withFrames < limits.max
      ? `Up to ${limits.max} (${limits.withFrames} with a start frame)`
      : `Up to ${limits.max}`
  return `${count}. Cast characters synced to Kling’s element library; mention them in the prompt as @element_1, @element_2… in this order.`
}

function params(v: KlingVariant): ParamDef[] {
  const out: ParamDef[] = [
    v.multiShot
      ? P.prompt({ help: MULTI_SHOT_PROMPT_HELP, placeholder: 'Describe the shot — or, with Multi-shot on:\nShot 1 (3s): …\nShot 2 (2s): …' })
      : P.prompt(),
  ]
  if (v.firstFrame) out.push(P.image('firstFrame', 'Start frame', { help: 'Animate from this image (image-to-video)' }))
  if (v.lastFrame) out.push(P.image('lastFrame', 'End frame', { help: 'Requires a start frame — the shot ends on this image' }))
  if (v.elements) {
    out.push(
      param('elements', z.array(z.string().min(1)).max(v.elements.max, `Up to ${v.elements.max} characters`).optional(), {
        label: 'Characters (Kling elements)',
        control: 'elements',
        maxItems: v.elements.max,
        advanced: false,
        help: elementsHelp(v.elements),
      }),
    )
  }
  out.push(
    'values' in v.durations
      ? P.segmented('duration', 'Duration', v.durations.values, v.defaultDuration, { unit: 's', labels: (d) => `${d}s` })
      : intSlider('duration', 'Duration', v.durations.min, v.durations.max, v.defaultDuration, { unit: 's' }),
  )
  out.push(
    P.segmented('aspectRatio', 'Aspect', ['16:9', '9:16', '1:1'] as const, '16:9', {
      help: 'Image-to-video follows the start frame',
      visibleIf: (values) => !hasAsset(values.firstFrame),
    }),
    P.segmented('resolution', 'Resolution', v.resolutions, v.defaultResolution, { labels: (r) => RES_LABEL[r] }),
  )
  if (v.audio === 'toggle') out.push(P.toggle('audio', 'Native audio', true, { help: 'Dialogue, SFX and ambience generated with the picture' }))
  if (v.audio === 'toggle-1080p')
    out.push(
      P.toggle('audio', 'Native audio', true, {
        help: 'Available at 1080p',
        visibleIf: (values) => values.resolution === '1080p',
      }),
    )
  if (v.multiShot)
    out.push(
      P.toggle('multiShot', 'Multi-shot', false, {
        advanced: true,
        help: 'Cut between several shots within the clip. Write “Shot 1 (3s): …” lines in the prompt to plan each shot, or let Kling plan the cuts.',
      }),
    )
  return out
}

function validate(v: KlingVariant) {
  return (values: ParamValues): string | null => {
    if (hasAsset(values.lastFrame) && !hasAsset(values.firstFrame)) return 'An end frame needs a start frame'
    const duration = Number(values.duration)
    if ('values' in v.durations && !v.durations.values.includes(duration))
      return `${v.label} supports ${v.durations.values.join(' or ')} second clips`
    if (!('values' in v.durations) && (duration < v.durations.min || duration > v.durations.max))
      return `${v.label} supports ${v.durations.min}–${v.durations.max} s`
    const elements = klingElementIds(values)
    if (v.elements && elements.length) {
      const framed = hasAsset(values.firstFrame)
      if (new Set(elements).size !== elements.length) return 'Each character can only be used once'
      if (v.elements.needsFirstFrame && !framed)
        return `${v.label} uses characters (Kling elements) only together with a start frame — add one, or use Kling 3.0 Omni`
      const max = framed ? v.elements.withFrames : v.elements.max
      if (elements.length > max) return `${v.label} takes up to ${max} characters${framed ? ' with a start frame' : ''}`
    }
    if (v.multiShot && values.multiShot === true && typeof values.prompt === 'string') {
      const plan = parseMultiShot(values.prompt)
      const problem = plan && multiShotProblem(plan.shots, duration)
      if (problem) return problem
    }
    return null
  }
}

export function klingCost(v: KlingVariant, values: ParamValues): CostEstimate {
  const resolution = (values.resolution as KlingResolution | undefined) ?? v.defaultResolution
  const duration = Number(values.duration ?? v.defaultDuration)
  const audio = klingAudioOn(v, values)
  const row = v.pricing[resolution]
  const rate = row ? (audio ? row.audio : row.silent) : null
  if (rate == null) {
    return { usd: null, detail: `No published price for ${RES_LABEL[resolution]}${audio ? ' with audio' : ''}`, asOf: AS_OF }
  }
  const usd = Math.round(rate * duration * 1000) / 1000
  return {
    usd,
    detail: `${duration} s × $${rate.toFixed(3)}/s (${RES_LABEL[resolution]}${audio ? ', audio' : ''})`,
    asOf: AS_OF,
  }
}

export const klingModels: ModelSpec[] = KLING_VARIANTS.map((v) => ({
  id: v.id,
  label: v.label,
  vendor: 'Kling AI',
  provider: 'kling',
  kind: 'video',
  description: v.description,
  badges: v.badges,
  output: 'video',
  params: params(v),
  validate: validate(v),
  estimateCost: (values: ParamValues) => klingCost(v, values),
  maxVariants: 1,
  ...(v.workflow ? { workflow: v.workflow } : {}),
}))
