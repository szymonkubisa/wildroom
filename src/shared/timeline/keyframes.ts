import type { KeyEase, Keyframe } from '../types/project-doc'

/**
 * CSS `cubic-bezier(x1, y1, x2, y2)` at progress `t`: solves x(s) = t for the curve parameter (Newton, then
 * bisection when the slope is too flat), returns y(s).
 */
export function cubicBezier(p: readonly [number, number, number, number], t: number): number {
  const [x1, y1, x2, y2] = p
  if (t <= 0) return 0
  if (t >= 1) return 1
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const x = (s: number) => ((ax * s + bx) * s + cx) * s
  const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx
  let s = t
  for (let i = 0; i < 8; i++) {
    const err = x(s) - t
    if (Math.abs(err) < 1e-6) return ((ay * s + by) * s + cy) * s
    const d = dx(s)
    if (Math.abs(d) < 1e-6) break
    s -= err / d
    if (s < 0 || s > 1) break
  }
  let lo = 0
  let hi = 1
  s = t
  for (let i = 0; i < 40; i++) {
    const v = x(s)
    if (Math.abs(v - t) < 1e-6) break
    if (v < t) lo = s
    else hi = s
    s = (lo + hi) / 2
  }
  return ((ay * s + by) * s + cy) * s
}

function bounce(t: number): number {
  const n = 7.5625
  const d = 2.75
  if (t < 1 / d) return n * t * t
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375
  return n * (t -= 2.625 / d) * t + 0.984375
}

/** Maps segment progress 0..1 through the easing of the segment's first key. */
export function ease(kind: KeyEase | undefined, t: number): number {
  if (typeof kind === 'object') return cubicBezier(kind.p, t)
  switch (kind) {
    case 'hold':
      return 0
    case 'ease-in':
      return t * t * t
    case 'ease-out':
      return 1 - (1 - t) ** 3
    case 'ease-in-out':
      return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
    case 'back':
      // Overshoots by about a tenth, then settles.
      return 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2
    case 'elastic':
      return t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1
    case 'bounce':
      return bounce(t)
    default:
      return t
  }
}

/** Keyframe interpolation; `frame` is relative to the clip start. Keys must be sorted by frame. */
export function keyframeValue(keys: readonly Keyframe<number>[] | undefined, frame: number, fallback: number): number {
  if (!keys?.length) return fallback
  if (frame <= keys[0]!.frame) return keys[0]!.value
  const last = keys[keys.length - 1]!
  if (frame >= last.frame) return last.value
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i]!
    if (frame <= b.frame) {
      // On the key itself: its own value (a "hold" before it would otherwise still give the previous one).
      if (frame === b.frame) return b.value
      const a = keys[i - 1]!
      const t = (frame - a.frame) / Math.max(1, b.frame - a.frame)
      return a.value + (b.value - a.value) * ease(a.ease, t)
    }
  }
  return fallback
}

/** Keys of any value, mixed by `mix` (colours, say) through the segment's easing. */
export function keyframeMix<T>(keys: readonly Keyframe<T>[] | undefined, frame: number, mix: (a: T, b: T, t: number) => T): T | undefined {
  if (!keys?.length) return undefined
  if (frame <= keys[0]!.frame) return keys[0]!.value
  const last = keys[keys.length - 1]!
  if (frame >= last.frame) return last.value
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i]!
    if (frame > b.frame) continue
    if (frame === b.frame) return b.value
    const a = keys[i - 1]!
    return mix(a.value, b.value, ease(a.ease, (frame - a.frame) / Math.max(1, b.frame - a.frame)))
  }
  return last.value
}

/** Numeric object keyframes (e.g. transforms) interpolated field by field. */
export function keyframeObject<T extends object>(keys: readonly Keyframe<T>[] | undefined, frame: number, fallback: T): T {
  if (!keys?.length) return fallback
  const out = { ...fallback }
  for (const field of Object.keys(fallback) as (keyof T)[]) {
    const track = keys.map((k) => ({ frame: k.frame, ease: k.ease, value: Number(k.value[field]) }))
    ;(out as Record<keyof T, unknown>)[field] = keyframeValue(track, frame, Number(fallback[field]))
  }
  return out
}

export function sortKeys<T>(keys: readonly Keyframe<T>[] | undefined): Keyframe<T>[] {
  return [...(keys ?? [])].sort((a, b) => a.frame - b.frame)
}

/** Adds or replaces the key at `frame` (keeping that key's easing). */
export function upsertKey<T>(keys: readonly Keyframe<T>[] | undefined, frame: number, value: T): Keyframe<T>[] {
  const f = Math.max(0, Math.round(frame))
  const existing = keys?.find((k) => k.frame === f)
  const next: Keyframe<T> = existing?.ease ? { frame: f, value, ease: existing.ease } : { frame: f, value }
  return sortKeys([...(keys ?? []).filter((k) => k.frame !== f), next])
}

export function removeKey<T>(keys: readonly Keyframe<T>[] | undefined, frame: number): Keyframe<T>[] {
  return sortKeys((keys ?? []).filter((k) => k.frame !== Math.round(frame)))
}

/** Key sitting exactly on `frame`, if any. */
export function keyAt<T>(keys: readonly Keyframe<T>[] | undefined, frame: number): Keyframe<T> | undefined {
  return keys?.find((k) => k.frame === Math.round(frame))
}

/** Nearest key frame strictly before/after `frame`. */
export function adjacentKey<T>(keys: readonly Keyframe<T>[] | undefined, frame: number, dir: -1 | 1): number | undefined {
  const frames = sortKeys(keys).map((k) => k.frame)
  return dir < 0 ? frames.filter((f) => f < frame).at(-1) : frames.find((f) => f > frame)
}
