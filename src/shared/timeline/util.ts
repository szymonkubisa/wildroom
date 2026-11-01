import { type Draft, current, isDraft } from 'immer'
import { type Flicks, flicksToFrames, framesToFlicks } from '../time/flicks'
import {
  type Clip,
  type ConnectedItem,
  type GapClip,
  type Keyframe,
  type Marker,
  type MotionClip,
  type ProjectDoc,
  type SpineItem,
  type Transform,
  activeTake,
} from '../types/project-doc'
import { effectiveSpeed, localFrameAt, sourceTimeAt } from './layout'
import type { MediaInfoLookup, RecipeContext } from './types'

export const MIN_SPEED = 0.01
export const MAX_SPEED = 100

export type ConnectableClip = Exclude<Clip, GapClip>

/** Deep copy of plain data; works on immer drafts too (the copy is never a draft and never frozen). */
export function deepClone<T>(value: T): T {
  return clonePlain(isDraft(value) ? (current(value as Draft<T>) as T) : value)
}

function clonePlain<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clonePlain) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = clonePlain(v)
    return out as T
  }
  return value
}

/** Integer frame ≥ 0 (Infinity passes through, NaN becomes 0). */
export function sanitizeFrame(frame: number): number {
  return Number.isNaN(frame) ? 0 : Math.max(0, Math.round(frame))
}

/** Clamps a signed delta into [lo, hi] without ever flipping its direction. */
export function clampDelta(delta: number, lo: number, hi: number): number {
  return delta > 0 ? Math.max(0, Math.min(delta, hi)) : Math.min(0, Math.max(delta, lo))
}

export function clampSpeed(speed: number): number | undefined {
  if (!Number.isFinite(speed) || speed <= 0) return undefined
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed))
}

/** Removes matching elements in place (keeps immer patches index-based instead of replacing the array). */
export function removeWhere<T>(arr: T[], pred: (value: T) => boolean): void {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) arr.splice(i, 1)
}

// ---------------------------------------------------------------------------------------------------------------
// Lookups

export type ClipRef =
  | { where: 'spine'; index: number; clip: SpineItem }
  | { where: 'connected'; index: number; item: ConnectedItem; clip: ConnectableClip }

export function findClip(doc: ProjectDoc, id: string): ClipRef | undefined {
  const si = doc.spine.findIndex((s) => s.id === id)
  if (si >= 0) return { where: 'spine', index: si, clip: doc.spine[si]! }
  const ci = doc.connected.findIndex((c) => c.id === id)
  if (ci >= 0) {
    const item = doc.connected[ci]!
    return { where: 'connected', index: ci, item, clip: item.clip }
  }
  return undefined
}

export function collectIds(doc: ProjectDoc): Set<string> {
  const ids = new Set<string>()
  const addClip = (clip: Clip) => {
    ids.add(clip.id)
    if (clip.kind === 'media') for (const t of clip.takes) ids.add(t.id)
  }
  doc.spine.forEach(addClip)
  for (const c of doc.connected) {
    ids.add(c.id)
    addClip(c.clip)
  }
  for (const m of doc.markers) ids.add(m.id)
  return ids
}

/** Re-ids incoming clips (and their takes) whose ids collide with ids already in use. Mutates the clips. */
export function ensureUniqueIds(used: Set<string>, clips: Clip[], newId: () => string): void {
  const fresh = () => {
    let id = newId()
    while (used.has(id)) id = newId()
    return id
  }
  for (const clip of clips) {
    if (used.has(clip.id)) clip.id = fresh()
    used.add(clip.id)
    if (clip.kind === 'media')
      for (const t of clip.takes) {
        if (used.has(t.id)) t.id = fresh()
        used.add(t.id)
      }
  }
}

/** Gives a copied clip (and its takes) brand-new ids. */
export function withFreshIds<T extends Clip>(clip: T, newId: () => string): T {
  clip.id = newId()
  if (clip.kind === 'media') for (const t of clip.takes) t.id = newId()
  return clip
}

/** Clones clips coming from outside the doc, rounds frame values and makes their ids unique. */
export function prepareIncoming<T extends Clip>(doc: ProjectDoc, clips: readonly T[], newId: () => string): T[] {
  const out = clips.map((c) => {
    const clip = deepClone(c)
    clip.duration = Math.round(clip.duration)
    if (clip.transitionIn) clip.transitionIn.duration = Math.round(clip.transitionIn.duration)
    if (clip.transitionOut) clip.transitionOut.duration = Math.round(clip.transitionOut.duration)
    return clip
  })
  ensureUniqueIds(collectIds(doc), out, newId)
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Anchored items

type AnchoredThing = ConnectedItem | Marker

export function anchoredTo(doc: ProjectDoc, anchorIds: ReadonlySet<string>): AnchoredThing[] {
  return [...doc.connected, ...doc.markers].filter((t) => anchorIds.has(t.anchorId))
}

/**
 * Runs `mutate` (which changes how `clip` maps source time, e.g. a slip or a take switch) while keeping every
 * connected item and marker anchored to it on the same timeline frame.
 */
export function preserveAnchoredFrames(doc: ProjectDoc, clip: Clip, mutate: () => void): void {
  const fps = doc.settings.fps
  const targets = anchoredTo(doc, new Set([clip.id]))
  const locals = targets.map((t) => localFrameAt(clip, t.anchorSourceTime, fps))
  mutate()
  targets.forEach((t, i) => {
    t.anchorSourceTime = sourceTimeAt(clip, locals[i]!, fps)
  })
}

/** Records where items anchored to `spineIds` are now, so normalize can re-place them once the anchors vanish. */
export function rememberAnchoredPositions(
  doc: ProjectDoc,
  ctx: RecipeContext,
  spineIds: ReadonlySet<string>,
  absOf: (t: AnchoredThing) => number | undefined,
): void {
  for (const t of anchoredTo(doc, spineIds)) {
    const abs = absOf(t)
    if (abs !== undefined) ctx.prevAbs.set(t.id, abs)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Media limits

/** Asset duration limiting the clip's source range, or undefined when unlimited (stills, pending, unknown). */
export function assetDurationOf(clip: Clip, media: MediaInfoLookup | undefined): Flicks | undefined {
  if (clip.kind !== 'media' || !media) return undefined
  const assetId = activeTake(clip)?.assetId
  if (!assetId) return undefined
  const info = media(assetId)
  if (!info || info.kind === 'image' || info.durationFlicks === undefined) return undefined
  return Number.isFinite(info.durationFlicks) ? info.durationFlicks : undefined
}

/** Whole timeline frames that `flicks` of source fill at `speed`. */
export function framesAvailable(flicks: Flicks, speed: number, fps: number): number {
  if (!(flicks > 0)) return 0
  let n = Math.floor(flicksToFrames(flicks, fps) / speed + 1e-9)
  while (n > 0 && framesToFlicks(n * speed, fps) > flicks) n--
  return n
}

export interface SourceRoom {
  /** Frames the head can be extended by. */
  head: number
  /** Frames the tail can be extended by (negative when the clip already runs past its media). */
  tail: number
}

export function sourceRoom(clip: Clip, fps: number, media: MediaInfoLookup | undefined): SourceRoom {
  const assetDur = assetDurationOf(clip, media)
  if (clip.kind !== 'media' || assetDur === undefined) return { head: Infinity, tail: Infinity }
  const sourceIn = activeTake(clip)?.sourceIn ?? 0
  const speed = effectiveSpeed(clip)
  return {
    head: framesAvailable(sourceIn, speed, fps),
    tail: framesAvailable(assetDur - sourceIn, speed, fps) - clip.duration,
  }
}

/** Shrinks a media clip so its source range fits its asset (when the asset length is known). */
export function fitToMedia(clip: Clip, fps: number, media: MediaInfoLookup | undefined): void {
  const assetDur = assetDurationOf(clip, media)
  if (clip.kind !== 'media' || assetDur === undefined) return
  const take = activeTake(clip)
  if (!take) return
  const speed = effectiveSpeed(clip)
  take.sourceIn = Math.max(0, Math.min(take.sourceIn, assetDur - framesToFlicks(speed, fps)))
  clip.duration = Math.max(1, Math.min(clip.duration, framesAvailable(assetDur - take.sourceIn, speed, fps)))
}

/**
 * Head trim by `delta` frames (positive trims, negative extends): the active take's source in moves by
 * delta × speed, keyframes stay on their picture. Callers clamp `delta`.
 */
export function trimHead(clip: Clip, delta: number, fps: number): void {
  if (clip.kind === 'media') {
    const take = activeTake(clip)
    if (take) take.sourceIn = Math.max(0, take.sourceIn + framesToFlicks(delta * effectiveSpeed(clip), fps))
  }
  if (clip.kind === 'motion') shiftMotion(clip, delta)
  clip.duration -= delta
  mapClipKeyframes(clip, (f) => f - delta)
  clampFades(clip)
}

/** Tail trim by `delta` frames (positive extends). Callers clamp `delta`. */
export function trimTail(clip: Clip, delta: number): void {
  clip.duration += delta
  clampFades(clip)
}

export function clampFades(clip: Clip): void {
  if (clip.kind !== 'media' || !clip.audio) return
  if (clip.audio.fadeIn > clip.duration) clip.audio.fadeIn = clip.duration
  if (clip.audio.fadeOut > clip.duration) clip.audio.fadeOut = clip.duration
}

// ---------------------------------------------------------------------------------------------------------------
// Keyframes (frames are relative to the clip start)

function mapKeys<T>(keys: Keyframe<T>[] | undefined, f: (frame: number) => number): void {
  if (keys) for (const k of keys) k.frame = f(k.frame)
}

export function mapClipKeyframes(clip: Clip, f: (frame: number) => number): void {
  if (clip.kind !== 'gap' && clip.video) {
    mapKeys<number>(clip.video.opacityKeys, f)
    mapKeys<Transform>(clip.video.transformKeys, f)
  }
  if (clip.kind === 'media' && clip.audio) mapKeys<number>(clip.audio.gainKeys, f)
}

/** Moves where a motion clip starts in its animation by `delta` frames (head trims and blades keep the picture). */
export function shiftMotion(clip: MotionClip, delta: number): void {
  const offset = (clip.offset ?? 0) + delta
  if (offset) clip.offset = offset
  else delete clip.offset
}

/** Maps a motion clip's animation time: its offset and every element and camera key (frame-rate changes). */
export function mapMotionTime(clip: Clip, f: (frame: number) => number): void {
  if (clip.kind !== 'motion') return
  if (clip.offset) clip.offset = f(clip.offset)
  for (const track of Object.values(clip.tracks)) {
    mapKeys(track.opacity, f)
    mapKeys(track.transform, f)
    mapKeys(track.reveal, f)
    mapKeys(track.trim, f)
    mapKeys(track.stretch, f)
    mapKeys(track.color, f)
    mapKeys(track.blur, f)
    mapKeys(track.follow?.progress, f)
    for (const b of track.behaviors ?? []) {
      // A period is a length: it scales with the time but doesn't shift with it.
      b.period = Math.max(1, f(b.period) - f(0))
      if (b.from !== undefined) b.from = f(b.from)
      if (b.to !== undefined) b.to = f(b.to)
    }
    if (track.loop) track.loop = { from: f(track.loop.from), to: f(track.loop.to) }
    if (track.anchor?.offset) track.anchor.offset = f(track.anchor.offset) - f(0)
    if (track.anchor?.at !== undefined) track.anchor.at = f(track.anchor.at)
  }
  mapKeys(clip.camera, f)
}
