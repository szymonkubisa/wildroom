import { type Clip, type ProjectDoc, activeTake } from '../types/project-doc'
import type { MediaInfoLookup, RecipeContext } from './types'
import { mapClipKeyframes, mapMotionTime } from './util'

export const PROJECT_FPS_OPTIONS = [24, 25, 30, 48, 50, 60] as const

/** Nearest supported project rate (ties go to the lower rate): 23.976 → 24, 29.97 → 30, 120 → 60. */
export function nearestProjectFps(fps: number): number {
  let best: number = PROJECT_FPS_OPTIONS[0]
  for (const f of PROJECT_FPS_OPTIONS) if (Math.abs(f - fps) < Math.abs(best - fps)) best = f
  return best
}

/** Rescales every frame-valued field of a clip (durations, transitions, fades, keyframes) by `ratio`. */
export function rescaleClipFrames(clip: Clip, ratio: number): void {
  const scale = (v: number) => Math.round(v * ratio)
  clip.duration = Math.max(1, scale(clip.duration))
  if (clip.transitionIn) clip.transitionIn.duration = Math.max(1, scale(clip.transitionIn.duration))
  if (clip.transitionOut) clip.transitionOut.duration = Math.max(1, scale(clip.transitionOut.duration))
  if (clip.kind === 'media' && clip.audio) {
    clip.audio.fadeIn = scale(clip.audio.fadeIn)
    clip.audio.fadeOut = scale(clip.audio.fadeOut)
  }
  mapClipKeyframes(clip, scale)
  mapMotionTime(clip, scale)
}

export function rescaleDocFrames(doc: ProjectDoc, ratio: number): void {
  for (const s of doc.spine) rescaleClipFrames(s, ratio)
  for (const c of doc.connected) rescaleClipFrames(c.clip, ratio)
}

function videoAssetFps(clips: readonly Clip[], media: MediaInfoLookup): number | undefined {
  for (const clip of clips) {
    if (clip.kind !== 'media') continue
    const assetId = activeTake(clip)?.assetId
    const info = assetId ? media(assetId) : undefined
    if (info && info.kind === 'video' && info.hasVideo && info.fps && Number.isFinite(info.fps) && info.fps > 0)
      return info.fps
  }
  return undefined
}

/**
 * fps auto-lock. When `settings.fpsAuto` is on and one of `clips` is media with a video asset of known frame
 * rate, the project locks to the nearest supported rate. Frame values already in the doc (and the recipe's
 * `prevAbs`) are rescaled. Returns newFps / oldFps (1 when nothing changed) so the caller can rescale its own
 * frame arguments and incoming clips, which are expressed in the pre-op fps.
 */
export function applyFpsAutoLock(doc: ProjectDoc, clips: readonly Clip[], ctx: RecipeContext): number {
  if (!doc.settings.fpsAuto || !ctx.media) return 1
  const assetFps = videoAssetFps(clips, ctx.media)
  if (assetFps === undefined) return 1
  const oldFps = doc.settings.fps
  const newFps = nearestProjectFps(assetFps)
  doc.settings.fpsAuto = false
  if (newFps === oldFps) return 1
  const ratio = newFps / oldFps
  doc.settings.fps = newFps
  rescaleDocFrames(doc, ratio)
  for (const [id, abs] of ctx.prevAbs) ctx.prevAbs.set(id, Math.round(abs * ratio))
  return ratio
}
