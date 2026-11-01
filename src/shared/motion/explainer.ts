import { z } from 'zod'
import type { AlignedWord } from '../types/assets'
import type { Keyframe, MotionCamera, MotionClip, MotionTrack } from '../types/project-doc'
import { firstKeyFrame } from './anchors'
import { type PresetId, presetTrack } from './edit'
import type { SceneLayout } from './explainerLayout'
import { EXPLAINER_STYLES, type ExplainerStyleId, type ExplainerTheme } from './explainerStyles'

/**
 * Explainers: a topic or a script → scenes, each a voice-over line and a few elements on a Canvas frame that come in
 * as the narrator says their cue. The Director writes the scenes (validated here), the app lays them out, renders the
 * pictures and the voice, then times the animations to the voice's words. Everything here is pure.
 */

export const EXPLAINER_ANIMATIONS = [
  'fade-in',
  'slide-up-in',
  'pop',
  'spin-in',
  'rack-focus',
  'typewriter',
  'words',
  'words-rise',
  'words-pop',
  'words-blur',
  'letters-rise',
  'highlight',
  'count-up',
  'draw',
  'wipe-in',
] as const satisfies readonly PresetId[]
export type ExplainerAnimation = (typeof EXPLAINER_ANIMATIONS)[number] | 'auto'
/** `number` is a figure that counts up; `line` a wave drawn across. */
export const EXPLAINER_KINDS = ['title', 'text', 'number', 'shape', 'line', 'image'] as const
export const EXPLAINER_LAYOUTS = ['column', 'split', 'center', 'full-bleed', 'cards', 'diagram'] as const
export type ExplainerLayout = (typeof EXPLAINER_LAYOUTS)[number]
export const EXPLAINER_SCENES_MAX = 40
export const EXPLAINER_ELEMENTS_MAX = 6
export const EXPLAINER_IMAGES_MAX = 3

export const explainerElementSchema = z.object({
  kind: z.enum(EXPLAINER_KINDS),
  /** Titles and text: what it says. */
  text: z.string().max(240),
  /** Images: what to draw (no text in the picture). */
  prompt: z.string().max(800),
  shape: z.enum(['rect', 'ellipse']),
  /** Words of the voice-over the element comes in on ("" = in turn after the one before). */
  cue: z.string().max(80),
  /** `auto`: the style's move for its kind. */
  animation: z.enum([...EXPLAINER_ANIMATIONS, 'auto']),
  /** The same key in a later scene keeps the element: same place, same picture, there from the cut ("" = none). */
  key: z.string().max(40).default(''),
})
export const explainerSceneSchema = z.object({
  title: z.string().min(1).max(120),
  voiceover: z.string().min(1).max(600),
  elements: z.array(explainerElementSchema).min(1).max(EXPLAINER_ELEMENTS_MAX),
  /** The camera pushes in on the picture while the narrator talks about it. */
  zoom: z.boolean(),
  layout: z.enum(EXPLAINER_LAYOUTS).default('column'),
})
export const explainerSchema = z.object({
  title: z.string().min(1).max(120),
  /** The pictures' shared look, appended to every image prompt. */
  style: z.string().max(400),
  scenes: z.array(explainerSceneSchema).min(1).max(EXPLAINER_SCENES_MAX),
})
export type ExplainerElement = z.infer<typeof explainerElementSchema>
export type ExplainerScene = z.infer<typeof explainerSceneSchema>
export type Explainer = z.infer<typeof explainerSchema>

/** What the text model writes: plain fields only (structured outputs allow no enums or unions); cleaned by sanitizeExplainer. */
export const rawExplainerSchema = z.object({
  title: z.string(),
  style: z.string(),
  scenes: z.array(
    z.object({
      title: z.string(),
      voiceover: z.string(),
      zoom: z.boolean(),
      layout: z.string(),
      elements: z.array(z.object({ kind: z.string(), text: z.string(), prompt: z.string(), shape: z.string(), cue: z.string(), animation: z.string(), key: z.string() })),
    }),
  ),
})
export type RawExplainer = z.infer<typeof rawExplainerSchema>

export interface ExplainerRequest {
  /** The topic, or a script to follow. */
  topic: string
  /** Target length, seconds. */
  seconds: number
  /** Brand style and colours, when the brand kit is on. */
  brand?: { name?: string; style?: string; colors?: string[] }
  /** The look (see explainerStyles). */
  style?: ExplainerStyleId
}
export interface ExplainerResponse {
  explainer: Explainer
  via: string
  model: string
}

/** How many scenes, pictures and voice characters an explainer of `seconds` takes (before it is written: the quote). */
export function explainerEstimate(seconds: number): { scenes: number; images: number; chars: number } {
  const scenes = Math.min(EXPLAINER_SCENES_MAX, Math.max(2, Math.round(seconds / 8)))
  // About a picture a scene: a few scenes have two or three, a few none.
  return { scenes, images: Math.round(scenes * 1.2), chars: Math.round(seconds * 15) }
}

/**
 * The explainer with at most `max` pictures to draw: every scene's first picture goes before any scene's second, and
 * a keyed picture shown again in a later scene costs nothing (it's drawn once). The pictures over go.
 */
export function capPictures(ex: Explainer, max: number): Explainer {
  const kept = new Set<ExplainerElement>()
  const keys = new Set<string>()
  let drawn = 0
  const rounds = Math.max(0, ...ex.scenes.map((sc) => sc.elements.filter((e) => e.kind === 'image').length))
  for (let round = 0; round < rounds; round++)
    for (const sc of ex.scenes) {
      const e = sc.elements.filter((x) => x.kind === 'image')[round]
      if (!e) continue
      if (e.key && keys.has(e.key)) kept.add(e)
      else if (drawn < max) {
        kept.add(e)
        drawn++
        if (e.key) keys.add(e.key)
      }
    }
  return { ...ex, scenes: ex.scenes.map((sc) => ({ ...sc, elements: sc.elements.filter((e) => e.kind !== 'image' || kept.has(e)) })) }
}

const clip = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback)

/** Moves for words only. */
const WORD_MOVES = new Set<string>(['typewriter', 'words', 'words-rise', 'words-pop', 'words-blur', 'letters-rise', 'highlight'])

/**
 * The text model's explainer made valid: unknown kinds, layouts and animations fall back, empty elements go, three
 * pictures per scene at most (one in a diagram), animations that don't fit an element become the style's own (`auto`).
 */
export function sanitizeExplainer(raw: RawExplainer): Explainer | undefined {
  const scenes: ExplainerScene[] = []
  for (const s of raw.scenes ?? []) {
    let images = 0
    const layout = oneOf(s.layout, EXPLAINER_LAYOUTS, 'column')
    // A diagram has one picture slot (in the middle of its ring): more would be drawn, paid for and hidden under it.
    const imagesMax = layout === 'diagram' ? 1 : EXPLAINER_IMAGES_MAX
    const elements: ExplainerElement[] = []
    for (const e of s.elements ?? []) {
      const kind = oneOf(e.kind, EXPLAINER_KINDS, 'text')
      const text = clip(e.text, 240)
      const prompt = clip(e.prompt, 800)
      if ((kind === 'title' || kind === 'text' || kind === 'number') && !text) continue
      if (kind === 'image' && (!prompt || images === imagesMax)) continue
      if (kind === 'image') images++
      let animation: ExplainerAnimation = oneOf(e.animation, [...EXPLAINER_ANIMATIONS, 'auto'] as const, 'auto')
      if (WORD_MOVES.has(animation) && kind !== 'title' && kind !== 'text') animation = 'auto'
      if (animation === 'count-up' && kind !== 'number') animation = 'auto'
      if (animation === 'draw' && kind !== 'shape' && kind !== 'line') animation = 'auto'
      const key = typeof e.key === 'string' ? e.key.trim().toLowerCase().replace(/[^\w-]+/g, '-').slice(0, 40) : ''
      elements.push({ kind, text, prompt, shape: e.shape === 'ellipse' ? 'ellipse' : 'rect', cue: clip(e.cue, 80), animation, key })
      if (elements.length === EXPLAINER_ELEMENTS_MAX) break
    }
    const scene = explainerSceneSchema.safeParse({
      title: clip(s.title, 120) || clip(s.voiceover, 60),
      voiceover: clip(s.voiceover, 600),
      elements,
      zoom: Boolean(s.zoom) && images > 0,
      layout,
    })
    if (scene.success) scenes.push(scene.data)
    if (scenes.length === EXPLAINER_SCENES_MAX) break
  }
  const parsed = explainerSchema.safeParse({ title: clip(raw.title, 120) || scenes[0]?.title || 'Explainer', style: clip(raw.style, 400), scenes })
  return parsed.success ? parsed.data : undefined
}

// ------------------------------------------------------------------------------------------------ layout

export { layoutScene, type SceneLayout, type SharedElements } from './explainerLayout'
export { EXPLAINER_STYLES, type ExplainerStyleId, type ExplainerTheme, explainerStyle } from './explainerStyles'
/** The plain look. */
export const DEFAULT_THEME: ExplainerTheme = EXPLAINER_STYLES.default

// ------------------------------------------------------------------------------------------------ timing

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * Where each cue is said: the start (seconds) of the first run of words matching the cue, searching on from the
 * previous cue so cues keep their order; undefined when a cue isn't said (or is empty).
 */
export function cueSeconds(cues: readonly string[], words: readonly AlignedWord[]): (number | undefined)[] {
  const spoken = words.map((w) => norm(w.text))
  let from = 0
  return cues.map((cue) => {
    const want = cue.split(/\s+/).map(norm).filter(Boolean)
    if (!want.length) return undefined
    const find = (start: number) => {
      for (let i = start; i + want.length <= spoken.length; i++) if (want.every((t, k) => spoken[i + k] === t)) return i
      return -1
    }
    let i = find(from)
    if (i < 0) i = find(0)
    if (i < 0) return undefined
    from = i + want.length
    return words[i]!.start
  })
}

/** Word timings spread over `seconds` by length (a voice with no timings of its own: a macOS temp voice). */
export function estimateWords(text: string, seconds: number): AlignedWord[] {
  const tokens = text.split(/\s+/).filter(Boolean)
  const total = tokens.reduce((n, t) => n + t.length + 1, 0) || 1
  let at = 0
  return tokens.map((t) => {
    const len = ((t.length + 1) / total) * seconds
    const word = { text: t, start: Math.round(at * 1000) / 1000, end: Math.round((at + len) * 1000) / 1000 }
    at += len
    return word
  })
}

/** Seconds the voice starts after its scene does, and the scene's hold after the voice ends. */
export const VOICE_LEAD = 0.4
export const SCENE_TAIL = 0.8
/** How far a scene with `zoom` pushes in: little enough that the page margin keeps the words in the picture. */
export const PUSH_IN = 1.08
/** Elements come in a little before their word, so they're in place as it's said. */
const ANTICIPATE = 0.15
/** The anchor frame of a new track: its first key. */
const anchorAt = (track: MotionTrack) => {
  const at = firstKeyFrame(track)
  return at === undefined ? {} : { at }
}

/** Frames a scene lasts for a voice-over of `voiceSeconds`. */
export function sceneFrames(voiceSeconds: number, fps: number): number {
  return Math.max(Math.round(3 * fps), Math.round((VOICE_LEAD + voiceSeconds + SCENE_TAIL) * fps))
}

/** The move an element makes: the Director's, or (`auto`) the style's for its kind. */
export function elementMove(e: ExplainerElement, theme: ExplainerTheme): PresetId {
  if (e.animation !== 'auto') return e.animation
  // A style's highlighter sweeps under marked words (==…==); text with none just rises in.
  const marked = /==[^=]+==/.test(e.text)
  if (e.kind === 'title') return theme.motion.title === 'highlight' && !marked ? 'words-rise' : theme.motion.title
  if (e.kind === 'text') return theme.motion.text === 'highlight' && !marked ? 'words-rise' : theme.motion.text
  if (e.kind === 'number') return 'count-up'
  if (e.kind === 'line') return 'draw'
  if (e.kind === 'image') return theme.motion.picture
  return 'pop'
}

const TYPING = new Set<PresetId>(['typewriter', 'words', 'words-rise', 'words-pop', 'words-blur', 'letters-rise', 'highlight', 'count-up'])

/**
 * The scene's animation, timed to its voice: each element enters on its cue (in turn after the one before when it has
 * none, the first right away), typing as long as the text takes, and stays timed to those words when the voice-over is
 * recorded again (an anchor). Elements kept from the scene before are there from the cut; decoration comes in with the
 * element it belongs to (or as the scene starts). With `zoom`, the camera pushes in once the voice is under way; the
 * style may float its pictures.
 */
export function sceneMotion(
  scene: ExplainerScene,
  layout: SceneLayout,
  words: readonly AlignedWord[],
  durationFrames: number,
  fps: number,
  theme: ExplainerTheme = DEFAULT_THEME,
): { tracks: MotionClip['tracks']; camera?: Keyframe<MotionCamera>[] } {
  const starts = cueSeconds(
    scene.elements.map((e) => e.cue),
    words,
  )
  const clip = { offset: 0, duration: durationFrames }
  const tracks: MotionClip['tracks'] = {}
  const kept = new Set(layout.kept)
  const at: number[] = []
  let prev = -Infinity
  const timing = (seconds: number, length: number) => ({
    frames: Math.round(length * fps),
    delay: Math.min(Math.round(seconds * fps), Math.max(0, durationFrames - Math.round(length * fps) - 1)),
  })
  scene.elements.forEach((e, i) => {
    const said = starts[i]
    const seconds = said !== undefined ? VOICE_LEAD + said - ANTICIPATE : prev === -Infinity ? 0.1 : prev + 0.45
    prev = Math.max(0, seconds)
    at[i] = prev
    const id = layout.itemIds[i]!
    if (kept.has(id)) return
    const move = elementMove(e, theme)
    const length = TYPING.has(move) ? Math.min(2.5, Math.max(0.6, e.text.length / 22)) : move === 'draw' ? 0.9 : 0.55
    const track = presetTrack(move, clip, timing(prev, length), layout.frame.h)
    // Timed to its words for good: a new recording of the voice-over re-times it (see `anchors.ts`).
    if (e.cue.trim()) track.anchor = { text: e.cue.trim(), offset: -Math.round(ANTICIPATE * fps), ...anchorAt(track) }
    if (e.kind === 'image' && theme.floatPictures) track.behaviors = [{ kind: 'float', amount: Math.round(layout.frame.h * 0.008), period: Math.round(3 * fps), seed: i + 1 }]
    tracks[id] = track
  })
  for (const x of layout.extras) {
    const seconds = x.after >= 0 ? (at[x.after] ?? 0.1) : 0.1
    const track = presetTrack(x.preset, clip, timing(seconds, x.preset === 'draw' ? 0.9 : 0.5), layout.frame.h)
    const cue = x.after >= 0 ? scene.elements[x.after]?.cue.trim() : ''
    if (cue) track.anchor = { text: cue, offset: -Math.round(ANTICIPATE * fps), ...anchorAt(track) }
    tracks[x.id] = track
  }
  const imageAt = scene.elements.findIndex((e) => e.kind === 'image')
  const picture = imageAt >= 0 ? layout.items.find((it) => it.id === layout.itemIds[imageAt]) : undefined
  if (!scene.zoom || !picture) return { tracks }
  // A gentle push-in on the middle: panning towards the picture would crop the words beside it.
  const from = Math.round(durationFrames * 0.35)
  const camera: Keyframe<MotionCamera>[] = [
    { frame: from, value: { x: 0, y: 0, zoom: 1 }, ease: 'ease-in-out' },
    { frame: Math.max(from + 1, durationFrames - 1), value: { x: 0, y: 0, zoom: PUSH_IN } },
  ]
  return { tracks, camera }
}
