import { mixColor } from '../canvas/color'
import { keyframeMix, keyframeObject, keyframeValue, sortKeys, upsertKey } from '../timeline/keyframes'
import type { CanvasFrameItem, CanvasGroupItem, CanvasItem } from '../types/canvas'
import type { KeyEase, Keyframe, MotionCamera, MotionClip, MotionItemTransform, MotionStretch, MotionTrack, MotionTrim, RevealMode } from '../types/project-doc'
import { firstKeyFrame } from './anchors'
import { DEFAULT_CAMERA, IDENTITY_ITEM_TRANSFORM, type MotionItem, type MotionSource } from './evaluate'
import { EASE_BACK, EASE_IN, EASE_OUT, draw, fadeIn, fadeOut, pop, slideUpIn, typewriter } from './presets'

/**
 * Editing a motion clip's animation: one-click presets, scene presets, keys at the playhead, detaching. Pure, so the
 * inspector and the board's animation mode share it. Frames here are animation frames (clip frame + offset).
 */

export type PresetId =
  | 'fade-in'
  | 'slide-up-in'
  | 'pop'
  | 'spin-in'
  | 'rack-focus'
  | 'typewriter'
  | 'words'
  | 'words-rise'
  | 'words-pop'
  | 'words-blur'
  | 'letters-rise'
  | 'highlight'
  | 'count-up'
  | 'draw'
  | 'wipe-in'
  | 'follow-path'
  | 'shake'
  | 'float'
  | 'fade-out'
  | 'fly-out'

/** What can be animated: a drawn element, or a group (its animation adds to its members'). */
export type AnimItem = MotionItem | CanvasGroupItem

export interface PresetDef {
  id: PresetId
  label: string
  /** Entrances work on the first half of the clip, exits on the second (see applyPreset). */
  side: 'in' | 'out'
  fits: (item: AnimItem) => boolean
  /** Rides along another shape: only offered (and staggered) when the frame has one. */
  route?: boolean
}

const any = () => true
const drawn = (i: AnimItem) => i.kind !== 'group'
const text = (i: AnimItem) => i.kind === 'text'
const numbers = (i: AnimItem) => i.kind === 'text' && /\d/.test(i.text)
export const PRESETS: PresetDef[] = [
  { id: 'fade-in', label: 'Fade in', side: 'in', fits: any },
  { id: 'slide-up-in', label: 'Slide up in', side: 'in', fits: any },
  { id: 'pop', label: 'Pop', side: 'in', fits: any },
  { id: 'spin-in', label: 'Spin in', side: 'in', fits: any },
  { id: 'rack-focus', label: 'Rack focus', side: 'in', fits: any },
  { id: 'typewriter', label: 'Typewriter', side: 'in', fits: text },
  { id: 'words', label: 'Word by word', side: 'in', fits: text },
  { id: 'words-rise', label: 'Words rise', side: 'in', fits: text },
  { id: 'words-pop', label: 'Words pop', side: 'in', fits: text },
  { id: 'words-blur', label: 'Words unblur', side: 'in', fits: text },
  { id: 'letters-rise', label: 'Letters rise', side: 'in', fits: text },
  { id: 'highlight', label: 'Highlight', side: 'in', fits: text },
  { id: 'count-up', label: 'Count up', side: 'in', fits: numbers },
  { id: 'draw', label: 'Draw', side: 'in', fits: (i) => i.kind === 'shape' },
  { id: 'wipe-in', label: 'Wipe in', side: 'in', fits: drawn },
  { id: 'follow-path', label: 'Follow path', side: 'in', fits: any, route: true },
  { id: 'shake', label: 'Shake', side: 'in', fits: any },
  { id: 'float', label: 'Float', side: 'in', fits: any },
  { id: 'fade-out', label: 'Fade out', side: 'out', fits: any },
  { id: 'fly-out', label: 'Fly out', side: 'out', fits: any },
]

export const presetDef = (id: PresetId) => PRESETS.find((p) => p.id === id)!

/** The animation frames a clip shows: [offset, offset + duration). */
export function motionRange(clip: Pick<MotionClip, 'offset' | 'duration'>): { start: number; end: number } {
  const start = clip.offset ?? 0
  return { start, end: start + clip.duration }
}

export interface PresetTiming {
  /** Length of the move, frames. */
  frames: number
  /** Entrances: frames after the clip starts. Exits: frames before it ends. */
  delay: number
}

/** Words or letters in a text element (word and letter presets take longer for longer text). */
function unitCount(item: AnimItem | undefined, letters: boolean): number {
  if (item?.kind !== 'text') return 1
  return letters ? item.text.replace(/\s/g, '').length : item.text.split(/\s+/).filter(Boolean).length
}

export interface PresetContext {
  /** The element it goes on (word presets stretch with its words). */
  item?: AnimItem
  /** The shape `follow-path` rides along. */
  routeId?: string
}

/**
 * The keys a preset writes for an element in a clip; slides travel 4% of the frame's height. Word and letter
 * presets give each word about a third of the length (each letter a tenth), so longer text takes longer.
 */
export function presetTrack(id: PresetId, clip: Pick<MotionClip, 'offset' | 'duration'>, timing: PresetTiming, frameH: number, ctx: PresetContext = {}): MotionTrack {
  const { start, end } = motionRange(clip)
  const base = Math.max(1, Math.round(timing.frames))
  const perUnit = id === 'letters-rise' ? 0.1 : id.startsWith('words') ? 0.35 : 0
  const frames = perUnit ? Math.max(base, Math.round(base * perUnit * unitCount(ctx.item, id === 'letters-rise'))) : base
  const at = presetDef(id).side === 'in' ? start + Math.round(timing.delay) : end - Math.round(timing.delay) - frames
  const p = { at, frames }
  const reveal = (mode: RevealMode, ease: KeyEase = 'linear'): MotionTrack => ({ reveal: [{ frame: at, value: 0, ease }, { frame: at + frames, value: 1 }], revealMode: mode })
  switch (id) {
    case 'fade-in':
      return fadeIn(p)
    case 'slide-up-in':
      return slideUpIn({ ...p, distance: Math.round(frameH * 0.04) })
    case 'pop':
      return pop(p)
    case 'typewriter':
      return typewriter(p)
    case 'words':
      return { ...typewriter(p), revealMode: 'words' }
    case 'draw':
      return draw(p)
    case 'wipe-in':
      return { reveal: [{ frame: at, value: 0, ease: EASE_OUT }, { frame: at + frames, value: 1 }], revealMode: 'wipe-left' }
    case 'fade-out':
      return fadeOut(p)
    case 'spin-in':
      return {
        ...fadeIn(p),
        transform: [{ frame: at, value: { x: 0, y: 0, scale: 0.3, rotation: -180 }, ease: EASE_BACK }, { frame: at + frames, value: { x: 0, y: 0, scale: 1, rotation: 0 } }],
      }
    case 'rack-focus':
      return { blur: [{ frame: at, value: Math.round(frameH * 0.02), ease: EASE_OUT }, { frame: at + frames, value: 0 }] }
    case 'words-rise':
    case 'words-pop':
    case 'words-blur':
    case 'letters-rise':
      return reveal(id)
    case 'highlight':
      return reveal('highlight-sweep', 'ease-in-out')
    case 'count-up':
      return reveal('roll', EASE_OUT)
    case 'follow-path':
      return ctx.routeId ? { follow: { pathId: ctx.routeId, progress: [{ frame: at, value: 0, ease: 'ease-in-out' }, { frame: end - 1, value: 1 }] } } : {}
    case 'shake':
      return { behaviors: [{ kind: 'shake', amount: Math.max(2, Math.round(frameH * 0.012)), period: 2, seed: 1, from: at, to: at + frames }] }
    case 'float':
      return { behaviors: [{ kind: 'float', amount: Math.max(2, Math.round(frameH * 0.012)), period: Math.max(24, frames * 4), seed: 1 }] }
    case 'fly-out':
      // Off to the right and up, turning and shrinking, blurred by its speed.
      return {
        opacity: [{ frame: at, value: 1, ease: EASE_IN }, { frame: at + frames, value: 0 }],
        transform: [{ frame: at, value: { x: 0, y: 0, scale: 1, rotation: 0 }, ease: EASE_IN }, { frame: at + frames, value: { x: Math.round(frameH * 0.9), y: -Math.round(frameH * 0.25), scale: 0.7, rotation: 25 } }],
        motionBlur: 0.5,
      }
  }
}

type TrackKey = 'opacity' | 'transform' | 'reveal' | 'trim' | 'stretch' | 'color' | 'blur'
const TRACK_KEYS: TrackKey[] = ['opacity', 'transform', 'reveal', 'trim', 'stretch', 'color', 'blur']

/** A track without empty key lists; undefined when nothing is left. */
export function cleanTrack(track: MotionTrack): MotionTrack | undefined {
  const out: MotionTrack = {}
  for (const k of TRACK_KEYS) if (track[k]?.length) (out as Record<TrackKey, unknown>)[k] = track[k]
  if (out.reveal && track.revealMode) out.revealMode = track.revealMode
  if (out.reveal && track.rollFrom) out.rollFrom = track.rollFrom
  if (track.follow?.progress.length) out.follow = track.follow
  if (track.loop && Object.keys(out).length) out.loop = track.loop
  if (track.behaviors?.length) out.behaviors = track.behaviors
  if (track.anchor && Object.keys(out).length) out.anchor = track.anchor
  if (track.progress) {
    out.progress = track.progress
    if (track.revealMode) out.revealMode = track.revealMode
  }
  if (track.motionBlur && Object.keys(out).length) out.motionBlur = track.motionBlur
  return Object.keys(out).length ? out : undefined
}

/**
 * Puts a preset on an element's track. An entrance replaces the keys of the properties it animates in the first half
 * of the clip, an exit those in the second half — so clicking presets swaps the entrance (or the exit) and an
 * entrance and an exit live side by side.
 */
export function applyPreset(track: MotionTrack | undefined, preset: MotionTrack, side: 'in' | 'out', clip: Pick<MotionClip, 'offset' | 'duration'>): MotionTrack {
  const { start, end } = motionRange(clip)
  const split = (start + end) / 2
  const keep = (f: number) => (side === 'in' ? f >= split : f <= split)
  const out: MotionTrack = { ...track }
  for (const k of TRACK_KEYS) {
    const added = preset[k] as Keyframe<unknown>[] | undefined
    if (!added) continue
    const kept = ((track?.[k] ?? []) as Keyframe<unknown>[]).filter((key) => keep(key.frame) && !added.some((a) => a.frame === key.frame))
    ;(out as Record<TrackKey, unknown>)[k] = sortKeys([...kept, ...added])
  }
  if (preset.revealMode) {
    out.revealMode = preset.revealMode
    if (preset.revealMode !== 'roll') delete out.rollFrom
  }
  if (preset.follow) out.follow = preset.follow
  if (preset.motionBlur) out.motionBlur = preset.motionBlur
  // A behaviour preset replaces one of the same kind.
  if (preset.behaviors) out.behaviors = [...(track?.behaviors ?? []).filter((b) => !preset.behaviors!.some((p) => p.kind === b.kind)), ...preset.behaviors]
  // A new entrance on a track timed to words: the entrance is what lands on them.
  const entrance = side === 'in' ? firstKeyFrame(preset) : undefined
  if (out.anchor && entrance !== undefined) out.anchor = { ...out.anchor, at: entrance }
  return cleanTrack(out) ?? {}
}

/** The preset on each element in turn (back to front), `step` frames apart. */
export function staggerTracks(
  tracks: MotionClip['tracks'],
  items: readonly AnimItem[],
  id: PresetId,
  clip: Pick<MotionClip, 'offset' | 'duration'>,
  timing: PresetTiming & { step: number },
  frameH: number,
): MotionClip['tracks'] {
  const def = presetDef(id)
  const out = { ...tracks }
  const route = def.route ? items.find((r) => r.kind === 'shape') : undefined
  items.filter((item) => def.fits(item) && (!def.route || (route && route.id !== item.id))).forEach((item, i) => {
    const preset = presetTrack(id, clip, { frames: timing.frames, delay: timing.delay + i * timing.step }, frameH, { item, routeId: route?.id })
    out[item.id] = applyPreset(out[item.id], preset, def.side, clip)
  })
  return out
}

/** Camera centred on an element, close enough that it fills about 70% of the frame (at most 4×). */
export function cameraOn(frame: CanvasFrameItem, item: CanvasItem): MotionCamera {
  const zoom = Math.max(1, Math.min(4, 0.7 * Math.min(frame.w / item.w, frame.h / item.h)))
  return { x: item.x + item.w / 2 - (frame.x + frame.w / 2), y: item.y + item.h / 2 - (frame.y + frame.h / 2), zoom }
}

/** Keys that push the camera in on an element from `at`, over `frames`, from wherever it is then. */
export function zoomToItem(camera: MotionClip['camera'], frame: CanvasFrameItem, item: CanvasItem, at: number, frames: number): Keyframe<MotionCamera>[] {
  const from = keyframeObject(camera, at, { ...DEFAULT_CAMERA })
  const startKey = { frame: at, value: from, ease: EASE_OUT }
  const keys = upsertKey(camera, at, from).map((k) => (k.frame === at ? startKey : k))
  return upsertKey(keys, at + Math.max(1, Math.round(frames)), cameraOn(frame, item))
}

/** What an element's track says at animation frame `t` (its board place when it has no keys). */
export function trackValues(
  track: MotionTrack | undefined,
  t: number,
): { opacity: number; transform: MotionItemTransform; reveal: number; trim: MotionTrim; stretch: MotionStretch; color?: string; blur: number } {
  return {
    opacity: keyframeValue(track?.opacity, t, 1),
    transform: keyframeObject(track?.transform, t, { ...IDENTITY_ITEM_TRANSFORM }),
    reveal: keyframeValue(track?.reveal, t, 1),
    trim: keyframeObject(track?.trim, t, { start: 0, end: 1 }),
    stretch: keyframeObject(track?.stretch, t, { x: 1, y: 1 }),
    color: keyframeMix(track?.color, t, mixColor),
    blur: keyframeValue(track?.blur, t, 0),
  }
}

/** The frame and its contents as they are now: a detached clip keeps playing them whatever happens on the board. */
export function snapshotFrame(src: MotionSource): CanvasItem[] | undefined {
  return src.frame ? structuredClone([src.frame, ...src.items]) : undefined
}
