import { sortKeys } from '../timeline/keyframes'
import type { BezierEase, Keyframe, MotionItemTransform, MotionTrack } from '../types/project-doc'

/** One-click animations: each returns the keys of one element's track, starting at animation frame `at`. */

export const EASE_OUT: BezierEase = { type: 'bezier', p: [0.22, 1, 0.36, 1] }
export const EASE_IN: BezierEase = { type: 'bezier', p: [0.55, 0, 1, 0.45] }
/** Overshoots a little before settling (pop). */
export const EASE_BACK: BezierEase = { type: 'bezier', p: [0.34, 1.56, 0.64, 1] }

export interface PresetTiming {
  /** Animation frame the move starts on. */
  at: number
  /** Length of the move in frames. */
  frames: number
}

const tf = (x: number, y: number, scale = 1, rotation = 0): MotionItemTransform => ({ x, y, scale, rotation })
const end = (p: PresetTiming) => p.at + Math.max(1, Math.round(p.frames))

export function fadeIn(p: PresetTiming): MotionTrack {
  return { opacity: [{ frame: p.at, value: 0, ease: EASE_OUT }, { frame: end(p), value: 1 }] }
}

export function fadeOut(p: PresetTiming): MotionTrack {
  return { opacity: [{ frame: p.at, value: 1, ease: EASE_IN }, { frame: end(p), value: 0 }] }
}

/** Fades in while rising `distance` frame units into place. */
export function slideUpIn(p: PresetTiming & { distance: number }): MotionTrack {
  return {
    ...fadeIn(p),
    transform: [{ frame: p.at, value: tf(0, p.distance), ease: EASE_OUT }, { frame: end(p), value: tf(0, 0) }],
  }
}

export function pop(p: PresetTiming): MotionTrack {
  return {
    opacity: [{ frame: p.at, value: 0, ease: EASE_OUT }, { frame: p.at + Math.max(1, Math.round(p.frames / 2)), value: 1 }],
    transform: [{ frame: p.at, value: tf(0, 0, 0.6), ease: EASE_BACK }, { frame: end(p), value: tf(0, 0, 1) }],
  }
}

/** Text appears letter by letter. */
export function typewriter(p: PresetTiming): MotionTrack {
  return { reveal: [{ frame: p.at, value: 0, ease: 'linear' }, { frame: end(p), value: 1 }], revealMode: 'typewriter' }
}

/** A shape's outline draws itself, then it fills. */
export function draw(p: PresetTiming): MotionTrack {
  return { reveal: [{ frame: p.at, value: 0, ease: 'ease-in-out' }, { frame: end(p), value: 1 }], revealMode: 'draw' }
}

function mergeKeys<T>(a: Keyframe<T>[] | undefined, b: Keyframe<T>[] | undefined): Keyframe<T>[] | undefined {
  if (!a?.length) return b
  if (!b?.length) return a
  const frames = new Set(b.map((k) => k.frame))
  return sortKeys([...a.filter((k) => !frames.has(k.frame)), ...b])
}

/** Two animations of one element on one track (an entrance and an exit); `b`'s keys win on shared frames. */
export function mergeTracks(a: MotionTrack | undefined, b: MotionTrack): MotionTrack {
  const out: MotionTrack = {}
  for (const k of ['opacity', 'transform', 'reveal', 'trim', 'stretch', 'color', 'blur'] as const) {
    const keys = mergeKeys<unknown>(a?.[k], b[k])
    if (keys) (out as Record<string, unknown>)[k] = keys
  }
  const revealMode = b.revealMode ?? a?.revealMode
  if (revealMode) out.revealMode = revealMode
  return out
}

/** The same animation on each element in turn, `stepFrames` apart from `startFrame` (back to front order). */
export function stagger(
  itemIds: readonly string[],
  startFrame: number,
  stepFrames: number,
  preset: (at: number) => MotionTrack,
): Record<string, MotionTrack> {
  const out: Record<string, MotionTrack> = {}
  itemIds.forEach((id, i) => {
    out[id] = preset(Math.round(startFrame + i * stepFrames))
  })
  return out
}
