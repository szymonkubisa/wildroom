import { klingElementLimit, klingVariant } from './catalog/kling'
import { KLING_MAX_SHOTS, KLING_MAX_SHOT_CHARS } from './multishot'
import { defaultValues } from './params'
import type { ModelSpec, ParamValues } from './types'

/**
 * How the storyboard works with a video model: who the cast goes in as, how a multi-shot clip is written, which
 * languages it speaks, whether its negative prompt does anything. Read from the model's params first, then its
 * family's habits, then what its catalog entry declares (`ModelSpec.workflow`).
 */

// ------------------------------------------------------------------------------------ families

/** Model families by id and vendor; camera wording (cameraFamily) and the storyboard's dialects both come from it. */
export type ModelFamily = 'ltx' | 'veo' | 'kling' | 'seedance' | 'happyhorse'

export type ModelLike = Pick<ModelSpec, 'id' | 'provider'> & { vendor?: string; kind?: string }

export function modelFamily(model?: ModelLike): ModelFamily | undefined {
  if (!model) return undefined
  const id = model.id.toLowerCase()
  if (id.includes('ltx')) return 'ltx' // local-ltx-*, runpod-ltx-*, fal-ltx-*
  if (id.includes('veo') || (model.vendor === 'Google' && model.kind === 'video')) return 'veo' // Veo, Gemini Omni
  if (model.provider === 'kling' || id.includes('kling')) return 'kling'
  if (id.includes('seedance')) return 'seedance'
  if (id.includes('happy-horse')) return 'happyhorse'
  return undefined
}

/** The prompt dialect the storyboard writes for a model; 'generic' is written like LTX. */
export type Dialect = 'ltx' | 'kling' | 'veo' | 'happyhorse' | 'generic'

export function dialectOf(model?: ModelLike): Dialect {
  const family = modelFamily(model)
  return !family || family === 'seedance' ? 'generic' : family
}

// ------------------------------------------------------------------------------------ the profile

export type CastParam = 'referenceImages' | 'elements' | 'elementImages'
export type IdentitySource = 'keyframe' | 'references' | 'both'

/** How the cast goes in: which param carries them, how many fit, and how the prompt names each one. */
export interface VideoCast {
  param: CastParam
  /** Most characters without a start frame (0: only together with one, e.g. Kling 3.0 elements). */
  max: number
  /** Most characters together with a start frame (0: references or a start frame, never both). */
  maxWithKeyframe: number
  /** How the prompt names the n-th one (1-based): 'Image {n}', '@element_{n}', '@Image{n}', 'character{n}'. */
  token: string
  /** Voice samples taken for the first references ("Audio 1", "Audio 2"). */
  voices?: number
  /** Each character needs a front view plus at least one more angle (Kling elements take 2–4 views). */
  needsAngles?: boolean
  /** From the cast (no start frame), the clip is always this long (Veo's references: 8 s). */
  fixedSeconds?: number
  /** What the UI calls them. */
  label: string
}

/** The place's photo as a reference: LTX's referenceBackground, or a reference image (Kling O3's @Image1). */
export interface VideoScene {
  param: 'referenceBackground' | 'referenceImages'
  /** How the prompt names images in that slot, 1-based ('@Image{n}'). */
  token?: string
}

export interface VideoMultishot {
  /** prose: cuts described in words (LTX); native: the model's own shot list; timestamps: [00:00-00:03]; beats: "Begin with… Cut to…". */
  method: 'prose' | 'native' | 'timestamps' | 'beats'
  maxShots: number
  maxSeconds: number
  /** Longest description per shot (Kling's shot list: 512 characters). */
  maxShotChars?: number
  /** Shortest a shot may be in a clip written in prose: Lightricks — "each shot needs roughly three seconds". */
  minShotSeconds?: number
}

export interface VideoWorkflow {
  dialect: Dialect
  cast?: VideoCast
  /** Where the place's photo goes, and how the prompt names it there ('@Image{n}'; else it is numbered after the cast). */
  scene?: VideoScene
  multishot: VideoMultishot
  /** Languages it speaks lines in (names as storyLanguage gives them: 'English', 'Polish'…), or any. */
  speech: { languages: string[] | 'any'; lowercaseEnglish?: boolean }
  /** effective: the negative prompt works; ineffective: there is one but it does nothing (LTX at CFG 1); none. */
  negative: 'effective' | 'ineffective' | 'none'
  /** The identity sources a group can be rendered from, the automatic choice first. */
  sources: IdentitySource[]
  /** Longest prompt in words the model follows (LTX: one paragraph of at most 200 — Lightricks' prompting guide). */
  maxWords?: number
}

/** What a catalog entry declares (`ModelSpec.workflow`): any part of the profile, laid over what is derived. */
export interface WorkflowOverrides {
  dialect?: Dialect
  cast?: Partial<VideoCast>
  scene?: VideoWorkflow['scene']
  multishot?: Partial<VideoMultishot>
  speech?: Partial<VideoWorkflow['speech']>
  negative?: VideoWorkflow['negative']
  sources?: IdentitySource[]
  maxWords?: number
  /**
   * The longest clip from a start or end frame, where that is shorter than its duration takes (a rule of its validate,
   * which the duration's schema can't show): the clip lengths keep to it, as the storyboard renders from keyframes.
   */
  maxSecondsFromFrame?: number
}

/**
 * Params the storyboard sets itself for every shot or group: stored render settings never carry them (a `multiShot`
 * or `cameraMotion` left over from the Generate panel would otherwise ride along with every render).
 */
export const STORYBOARD_MANAGED: ReadonlySet<string> = new Set([
  'prompt',
  'duration',
  'aspectRatio',
  'negativePrompt',
  'seed',
  'firstFrame',
  'lastFrame',
  'midFrames',
  'midFrameTimes',
  'referenceImages',
  'referenceBackground',
  'voice1',
  'voice2',
  'audioClip',
  'continueFrom',
  'guideVideo',
  'guideKind',
  'elements',
  'elementImages',
  'elementCounts',
  'multiShot',
  'multiPrompt',
  'multiClip',
  'cameraMotion',
])

// ------------------------------------------------------------------------------------ clip lengths

/** The longest clip any model is asked about (Seedance and Wan take 30 s). */
const LONGEST_CLIP = 60

/**
 * Whether the model renders a clip of `seconds` from a keyframe: its duration takes it, within its declared limit from
 * a frame (Luma Ray 3.2 takes 10 s from text but 5 s from a frame: an 8 s shot asked for 10 s and was rejected).
 * Undefined when the model has no duration.
 */
function rendersSeconds(model: ModelSpec): ((seconds: number) => boolean) | undefined {
  const p = model.params.find((x) => x.key === 'duration')
  if (!p) return undefined
  const cap = model.workflow?.maxSecondsFromFrame ?? Number.POSITIVE_INFINITY
  return (s) => s <= cap && p.schema.safeParse(s).success
}

/**
 * The longest clip a model renders from a keyframe: the largest whole-second duration it takes (10 s when it has no
 * duration). RunPod LTX takes 10 s, local LTX 8 s, Veo 8 s, Seedance 30 s, Luma Ray 3.2 5 s.
 */
export function maxClipSeconds(model: ModelSpec): number {
  const takes = rendersSeconds(model)
  if (!takes) return 10
  for (let s = LONGEST_CLIP; s >= 1; s--) if (takes(s)) return s
  return 10
}

/** `seconds` when the model takes it, else the nearest whole second it does (fitParams doesn't clamp sliders). */
export function clipSeconds(model: ModelSpec, seconds: number): number {
  const takes = rendersSeconds(model)
  if (!takes || takes(seconds)) return seconds
  let best: number | undefined
  for (let s = 1; s <= LONGEST_CLIP; s++) if (takes(s) && (best === undefined || Math.abs(s - seconds) < Math.abs(best - seconds))) best = s
  return best ?? seconds
}

/** The shortest clip of at least `seconds` the model renders (its longest when none is that long). */
export function clipAtLeast(model: ModelSpec, seconds: number): number {
  const takes = rendersSeconds(model)
  const max = maxClipSeconds(model)
  if (!takes) return Math.min(max, Math.ceil(seconds))
  for (let s = Math.max(1, Math.ceil(seconds)); s <= max; s++) if (takes(s)) return s
  return max
}

// ------------------------------------------------------------------------------------ workflowFor

/** Lightricks' guidance: 2–4 cuts per clip, written in prose. Every model without a shot list of its own keeps to it. */
const PROSE_MAX_SHOTS = 4
/**
 * …and one paragraph of at most 200 words. The group prompts of The Last Road and Impossible Worlds ran 2.3–2.9k
 * characters (456 words at the median), every shot repeating every look: a cut at 0.54 s, a third shot, swapped clothes.
 */
const LTX_MAX_WORDS = 200
/** …and about three seconds per shot ("a cut every 2 seconds becomes a slideshow"): a 10 s clip takes three. */
export const PROSE_MIN_SHOT_SECONDS = 3

/** Shots a prose clip of `maxSeconds` takes at three seconds each, within 2–4. */
const proseShots = (maxSeconds: number) => Math.max(2, Math.min(PROSE_MAX_SHOTS, Math.floor(maxSeconds / PROSE_MIN_SHOT_SECONDS)))

/** The profile's multi-shot limits; a clip written in prose keeps three seconds a shot (and so fewer shots). */
function multishotOf(m: Partial<VideoMultishot> | undefined, longest: number): VideoMultishot {
  const method = m?.method ?? 'prose'
  const maxSeconds = m?.maxSeconds ?? longest
  const prose = method === 'prose'
  return {
    method,
    maxShots: prose ? Math.min(m?.maxShots ?? PROSE_MAX_SHOTS, proseShots(maxSeconds)) : (m?.maxShots ?? PROSE_MAX_SHOTS),
    maxSeconds,
    ...(m?.maxShotChars ? { maxShotChars: m.maxShotChars } : {}),
    ...(prose ? { minShotSeconds: PROSE_MIN_SHOT_SECONDS } : {}),
  }
}

/** No model (or none chosen yet): the storyboard's LTX defaults. */
const LTX_DEFAULT: VideoWorkflow = {
  dialect: 'ltx',
  multishot: { method: 'prose', maxShots: proseShots(10), maxSeconds: 10, minShotSeconds: PROSE_MIN_SHOT_SECONDS },
  speech: { languages: 'any' },
  negative: 'ineffective',
  sources: ['keyframe'],
  maxWords: LTX_MAX_WORDS,
}

/** What the params say: the cast and scene slots, the longest clip, a native shot list, a negative prompt. */
function derived(model: ModelSpec): WorkflowOverrides {
  const param = (key: string) => model.params.find((p) => p.key === key)
  const out: WorkflowOverrides = {
    multishot: { maxSeconds: maxClipSeconds(model), ...(param('multiShot') || param('multiPrompt') ? { method: 'native' as const } : {}) },
    negative: param('negativePrompt') ? 'effective' : 'none',
  }
  if (model.output !== 'video') return out
  const elements = param('elements')
  const elementImages = param('elementImages')
  const refs = param('referenceImages')
  if (elements) {
    // Kling's element library: limits per model, and Kling 3.0 takes them only with a start frame.
    const known = Boolean(klingVariant(model.id))
    const max = known ? klingElementLimit(model.id, false) : (elements.ui.maxItems ?? 0)
    const maxWithKeyframe = known ? klingElementLimit(model.id, true) : max
    out.cast = { param: 'elements', max, maxWithKeyframe, needsAngles: true }
  } else if (elementImages) {
    // A flat list of every element's views: how many characters that makes is for the catalog to declare.
    out.cast = { param: 'elementImages', max: 0, maxWithKeyframe: 0, needsAngles: true }
  } else if (refs && !refs.ui.source) {
    const max = refs.ui.maxItems ?? 0
    let voices = 0
    while (param(`voice${voices + 1}`)) voices++
    out.cast = { param: 'referenceImages', max, maxWithKeyframe: param('firstFrame') && takesBoth(model) ? max : 0, ...(voices ? { voices } : {}) }
  }
  if (param('referenceBackground')) out.scene = { param: 'referenceBackground' }
  return out
}

/** Whether the model's own rules let references and a start frame go together (Happy Horse: one or the other). */
function takesBoth(model: ModelSpec): boolean {
  if (!model.validate) return true
  const base: ParamValues = { ...defaultValues(model), prompt: 'probe', firstFrame: 'probe' }
  return Boolean(model.validate(base)) || !model.validate({ ...base, referenceImages: ['probe'] })
}

/** How each family is written for, given where its cast goes and whether it has a shot list of its own. */
function familyDefaults(dialect: Dialect, castParam: CastParam | undefined, native: boolean): WorkflowOverrides {
  const out = familyHabits(dialect, castParam, native)
  // A shot list of its own (a multiShot / multiPrompt param) beats the family's way of writing the cuts.
  return native ? { ...out, multishot: { ...out.multishot, method: 'native' } } : out
}

function familyHabits(dialect: Dialect, castParam: CastParam | undefined, native: boolean): WorkflowOverrides {
  switch (dialect) {
    case 'ltx':
      // Licon MSR is reference-to-video: from a start frame the references stay out. LTX runs at CFG 1, so the
      // negative prompt has no effect (and naming what to avoid can draw it in).
      return {
        cast: { token: 'Image {n}', maxWithKeyframe: 0, label: 'References (Licon MSR)' },
        multishot: { method: 'prose', maxShots: PROSE_MAX_SHOTS },
        speech: { languages: 'any' },
        negative: 'ineffective',
        maxWords: LTX_MAX_WORDS,
      }
    case 'kling':
      return {
        cast: {
          token: castParam === 'elements' ? '@element_{n}' : castParam === 'elementImages' ? '@Element{n}' : '@Image{n}',
          label: castParam === 'referenceImages' ? 'Reference images' : 'Kling elements',
        },
        multishot: native
          ? { method: 'native', maxShots: KLING_MAX_SHOTS, maxShotChars: KLING_MAX_SHOT_CHARS }
          : { method: 'prose', maxShots: PROSE_MAX_SHOTS },
        // Kling voices English and Chinese; English lines read best in lower case.
        speech: { languages: ['English', 'Chinese'], lowercaseEnglish: true },
      }
    case 'veo':
      // Veo's ingredients aren't numbered: the prompt names who they are.
      return {
        cast: { token: '{name}', label: 'Ingredients' },
        multishot: { method: 'timestamps', maxShots: 4 },
        speech: { languages: ['English'] },
      }
    case 'happyhorse':
      return {
        cast: { token: 'character{n}', maxWithKeyframe: 0, label: 'Characters' },
        multishot: { method: 'beats', maxShots: 6 },
        speech: { languages: 'any' },
      }
    case 'generic':
      return {
        cast: { token: 'Image {n}', label: 'References' },
        multishot: { method: 'prose', maxShots: PROSE_MAX_SHOTS },
        speech: { languages: 'any' },
      }
  }
}

/** Later layers win, part by part. */
function layered(...layers: WorkflowOverrides[]): WorkflowOverrides {
  const out: WorkflowOverrides = {}
  for (const l of layers) {
    if (l.dialect) out.dialect = l.dialect
    if (l.cast) out.cast = { ...out.cast, ...l.cast }
    if (l.scene) out.scene = l.scene
    if (l.multishot) out.multishot = { ...out.multishot, ...l.multishot }
    if (l.speech) out.speech = { ...out.speech, ...l.speech }
    if (l.negative) out.negative = l.negative
    if (l.sources) out.sources = l.sources
    if (l.maxWords) out.maxWords = l.maxWords
  }
  return out
}

/**
 * The model's storyboard workflow: what its params say (cast slots and limits, longest clip, a native shot list, a
 * negative prompt), then its family's habits (tokens, shot counts, languages), then what its catalog entry declares.
 * No model → the storyboard's LTX defaults; a model of no known family is written for like LTX ('generic').
 */
export function workflowFor(model?: ModelSpec): VideoWorkflow {
  if (!model) return structuredClone(LTX_DEFAULT)
  // Catalog models don't change: their profile is worked out once (the storyboard asks for it on every render, and
  // working it out probes the model's validate), then handed out as a copy anyone may change.
  let profile = profiles.get(model)
  if (!profile) profiles.set(model, (profile = buildWorkflow(model)))
  return structuredClone(profile)
}

const profiles = new WeakMap<ModelSpec, VideoWorkflow>()

function buildWorkflow(model: ModelSpec): VideoWorkflow {
  const declared = model.workflow ?? {}
  const base = derived(model)
  const dialect = declared.dialect ?? dialectOf(model)
  const castParam = declared.cast?.param ?? base.cast?.param
  const native = (declared.multishot?.method ?? base.multishot?.method) === 'native'
  const all = layered(base, familyDefaults(dialect, castParam, native), declared)

  // A cast needs its param on the model (a declaration can come before the param does).
  const castDef = all.cast?.param && model.params.find((p) => p.key === all.cast!.param)
  let cast: VideoCast | undefined
  if (all.cast?.param && castDef) {
    const max = all.cast.max ?? castDef.ui.maxItems ?? 0
    const { param, maxWithKeyframe = max, token = 'Image {n}', label = 'References', ...rest } = all.cast
    cast = { param, max, maxWithKeyframe, token, label, ...rest }
    if (!cast.max && !cast.maxWithKeyframe) cast = undefined
  }
  const hasFrame = model.params.some((p) => p.key === 'firstFrame')
  // References first (the storyboard's automatic choice since references held faces across cuts), then a start
  // frame with the cast, then the start frame alone.
  const sources: IdentitySource[] = all.sources ? [...all.sources] : [
    ...(cast && cast.max > 0 ? (['references'] as const) : []),
    ...(cast && hasFrame && cast.maxWithKeyframe > 0 ? (['both'] as const) : []),
    ...(hasFrame ? (['keyframe'] as const) : []),
  ]
  const scene = all.scene && model.params.some((p) => p.key === all.scene!.param) ? { ...all.scene } : undefined
  return {
    dialect,
    ...(cast ? { cast } : {}),
    ...(scene ? { scene } : {}),
    multishot: multishotOf(all.multishot, maxClipSeconds(model)),
    speech: {
      languages: Array.isArray(all.speech?.languages) ? [...all.speech.languages] : 'any',
      ...(all.speech?.lowercaseEnglish ? { lowercaseEnglish: true } : {}),
    },
    negative: all.negative ?? 'none',
    sources,
    ...(all.maxWords ? { maxWords: all.maxWords } : {}),
  }
}

/**
 * LTX that takes an audio track to follow: a shot made to its lines as the voice actor recorded them (exact words, lip
 * sync, the right voice). Without a model the callers differ — the Director writes for LTX-2.5 on the GPU, which
 * does; a render needs a model — so `noModel` is theirs to say.
 */
export function followsRecordedAudio(model: ModelSpec | undefined, noModel: boolean): boolean {
  if (!model) return noModel
  return workflowFor(model).dialect === 'ltx' && model.params.some((p) => p.key === 'audioClip')
}

/**
 * LTX that takes a start frame renders each shot as its own clip from its keyframe; a group is one clip only when the
 * user picks it. Every native multi-shot take failed (a cut at 0.54 s, three shots for two, Daniel in Claire's jumper —
 * The Last Road, Impossible Worlds) while single shots from their own keyframe were the best ones. `noModel` as above.
 */
export function rendersSeparately(model: ModelSpec | undefined, noModel: boolean): boolean {
  if (!model) return noModel
  return workflowFor(model).dialect === 'ltx' && model.params.some((p) => p.key === 'firstFrame')
}
