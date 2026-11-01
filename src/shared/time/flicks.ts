/**
 * Flicks: 1/705_600_000 s. Every common video frame rate (23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60)
 * and audio sample rate (8k–192k) divides evenly, so source-side times stored as integer flicks never drift.
 * Timeline placement uses integer project frames; everything that points into source media uses flicks.
 */
export const FLICKS_PER_SECOND = 705_600_000

export type Flicks = number

export function secondsToFlicks(seconds: number): Flicks {
  return Math.round(seconds * FLICKS_PER_SECOND)
}

export function flicksToSeconds(flicks: Flicks): number {
  return flicks / FLICKS_PER_SECOND
}

/** Exact for any integer fps that divides FLICKS_PER_SECOND (24, 25, 30, 48, 50, 60, …). */
export function framesToFlicks(frames: number, fps: number): Flicks {
  return Math.round((frames * FLICKS_PER_SECOND) / fps)
}

/** Fractional frame count; callers decide how to round. */
export function flicksToFrames(flicks: Flicks, fps: number): number {
  return (flicks * fps) / FLICKS_PER_SECOND
}

export function framesToSeconds(frames: number, fps: number): number {
  return frames / fps
}

export function secondsToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps)
}

/**
 * The one sampling rule used everywhere (preview seeks, export decode, thumbnails):
 * frame n is represented by the instant at its centre.
 */
export function frameCenterSeconds(frame: number, fps: number): number {
  return (frame + 0.5) / fps
}
