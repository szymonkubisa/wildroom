import type { MotionBehavior, MotionTrack } from '../types/project-doc'

/**
 * Procedural motion on top of an element's keys: shake, wiggle, float, spin, orbit and pulse, worked out from the
 * animation frame and a seed alone, so every frame is the same in the preview and the export (and thousands of keys
 * become one line).
 */

export const BEHAVIOR_KINDS = ['shake', 'wiggle', 'float', 'spin', 'orbit', 'pulse'] as const

/** What a behaviour adds: a move (frame units), a turn (degrees) and a scale factor. */
export interface BehaviorOffset {
  x: number
  y: number
  rotation: number
  scale: number
}

/** A repeatable pseudo-random value in -1..1 for integer `i`. */
function hash(i: number, seed: number): number {
  let x = Math.imul(i | 0, 374761393) ^ Math.imul(seed | 0, 668265263)
  x = Math.imul(x ^ (x >>> 13), 1274126177)
  return (((x ^ (x >>> 16)) >>> 0) / 4294967295) * 2 - 1
}

/** Smooth value noise: random values on whole numbers, eased in between. */
export function noise(u: number, seed: number): number {
  const i = Math.floor(u)
  const f = u - i
  const s = f * f * (3 - 2 * f)
  return hash(i, seed) + (hash(i + 1, seed) - hash(i, seed)) * s
}

/** Frames a behaviour eases in and out over at the ends of its range. */
const RAMP = 6

/** How much a behaviour is on at `t` (0..1): fully inside its range, easing in and out over its ends. */
function weight(b: MotionBehavior, t: number): number {
  const a = b.from === undefined ? 1 : Math.min(1, Math.max(0, (t - b.from) / RAMP))
  const z = b.to === undefined ? 1 : Math.min(1, Math.max(0, (b.to - t) / RAMP))
  return a * z
}

/**
 * Frames a behaviour has been on by `t`, its ramps counted at their weight (the integral of `weight`): a spin turns by
 * this, so it speeds up and slows down over its ramps — and holds its angle after `to` — instead of jumping.
 */
function onFrames(b: MotionBehavior, t: number): number {
  const on =
    b.from === undefined ? t : t < b.from ? 0 : t < b.from + RAMP ? (t - b.from) ** 2 / (2 * RAMP) : RAMP / 2 + (t - b.from - RAMP)
  const off = b.to === undefined || t < b.to - RAMP ? 0 : t < b.to ? (t - b.to + RAMP) ** 2 / (2 * RAMP) : RAMP / 2 + (t - b.to)
  return Math.max(0, on - off)
}

/** The sum of an element's behaviours at animation frame `t`. */
export function behaviorOffset(behaviors: readonly MotionBehavior[] | undefined, t: number): BehaviorOffset {
  const out: BehaviorOffset = { x: 0, y: 0, rotation: 0, scale: 1 }
  for (const b of behaviors ?? []) {
    if (b.kind === 'spin') {
      // `amount` degrees per period.
      out.rotation += (b.amount * onFrames(b, t)) / Math.max(1, b.period)
      continue
    }
    const w = weight(b, t)
    if (w <= 0) continue
    const u = t / Math.max(1, b.period)
    const seed = b.seed ?? 1
    const a = b.amount * w
    const wave = 2 * Math.PI * u
    switch (b.kind) {
      case 'shake':
        out.x += a * noise(u * 1.7, seed)
        out.y += a * noise(u * 1.7, seed + 101)
        out.rotation += a * 0.05 * noise(u * 1.7, seed + 202)
        break
      case 'wiggle':
        out.x += a * noise(u, seed)
        out.y += a * noise(u, seed + 101)
        out.rotation += a * 0.1 * noise(u, seed + 202)
        break
      case 'float':
        out.y += a * Math.sin(wave)
        out.x += a * 0.3 * Math.sin(wave / 2 + seed)
        break
      case 'orbit':
        out.x += a * Math.cos(wave)
        out.y += a * Math.sin(wave)
        break
      case 'pulse':
        // `amount` is how much bigger at the peak (0.1 = 10%).
        out.scale *= 1 + a * 0.5 * (1 - Math.cos(wave))
        break
    }
  }
  return out
}

/** Animation time for the track's keys: past the loop's end they play its range again and again. */
export function loopTime(loop: MotionTrack['loop'], t: number): number {
  if (!loop || loop.to <= loop.from || t <= loop.to) return t
  return loop.from + ((t - loop.from) % (loop.to - loop.from))
}
