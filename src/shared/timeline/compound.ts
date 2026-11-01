import type { Flicks } from '../time/flicks'
import { type MarkerKind, type ProjectDoc, type SpineItem, activeTake } from '../types/project-doc'
import {
  anchorAt,
  anchoredFrame,
  defaultLaneFor,
  findOwnerIndex,
  indexSpine,
  layoutTimeline,
  ownerAt,
  spineGeometry,
} from './layout'
import {
  type PrimitiveOptions,
  auditionClip,
  bladeClip,
  bladeSpineAt,
  cutRangeEnd,
  gapReplacing,
  insertItems,
  lockFpsFor,
  moveItem,
  padSpineTo,
  placeConnected,
  rememberPositions,
  removeItems,
  setRangeOf,
  transitionAt,
} from './primitives'
import type { MarkerPatch, RecipeContext, TimelineRecipe, TrimEdge } from './types'
import {
  type ConnectableClip,
  anchoredTo,
  assetDurationOf,
  clampDelta,
  clampFades,
  clampSpeed,
  deepClone,
  findClip,
  framesAvailable,
  mapClipKeyframes,
  prepareIncoming,
  preserveAnchoredFrames,
  removeWhere,
  sanitizeFrame,
  sourceRoom,
  trimHead,
  trimTail,
  withFreshIds,
} from './util'

// ---------------------------------------------------------------------------------------------------------------
// Edits (E / W / Q / D)

/** E — append to the end of the primary storyline. */
export const appendToSpine =
  (items: readonly SpineItem[]): TimelineRecipe =>
  (d, ctx) =>
    insertItems(d, { frame: Infinity, items }, ctx)

/** W — insert at a frame, pushing everything after it to the right. */
export const insertAt =
  (frame: number, items: readonly SpineItem[]): TimelineRecipe =>
  (d, ctx) =>
    insertItems(d, { frame, items }, ctx)

/** Q — connect clips at a frame (one after another); lane defaults to 1, or −1 for audio-only clips. */
export const connectAt =
  (frame: number, items: readonly ConnectableClip[], lane?: number): TimelineRecipe =>
  (d, ctx) => {
    const clips = prepareIncoming(
      d,
      items.filter((c) => (c.kind as string) !== 'gap'),
      ctx.newId,
    )
    if (!clips.length) return
    let at = lockFpsFor(d, clips, sanitizeFrame(frame), ctx)
    if (!Number.isFinite(at)) at = indexSpine(d.spine).end
    for (const clip of clips) {
      placeConnected(d, clip, at, lane, ctx)
      at += clip.duration
    }
  }

/**
 * Replaces the spine range [frame, frame + length of `items`) with `items`, blading at both edges; a range starting
 * inside a transition starts at the edit point under it (no cut there could hold the transition). Clips connected to
 * replaced items are re-anchored (they keep their frames), never deleted.
 */
export function overwriteRange(
  d: ProjectDoc,
  args: { frame: number; items: readonly SpineItem[] },
  ctx: RecipeContext,
  opts: PrimitiveOptions = {},
): void {
  const clips = prepareIncoming(d, args.items, ctx.newId)
  if (!clips.length) return
  let frame = lockFpsFor(d, clips, sanitizeFrame(args.frame), ctx, opts)
  const end = indexSpine(d.spine).end
  if (!Number.isFinite(frame)) frame = end
  if (frame >= end) {
    padSpineTo(d, frame, ctx)
    d.spine.push(...clips)
    return
  }
  frame = transitionAt(indexSpine(d.spine), frame)?.editPoint ?? frame
  const span = spineGeometry(clips).end
  bladeSpineAt(d, frame, ctx)
  const index = indexSpine(d.spine)
  let first = findOwnerIndex(index.geo, frame)
  if (first < 0 || index.geo[first]!.start < frame) first++
  let last = first
  while (last < d.spine.length && index.geo[last]!.start < frame + span) last++
  rememberPositions(d, ctx, new Set(d.spine.slice(first, last).map((s) => s.id)))
  // The far edge is cut once the range is measured: inside a transition, the piece left before it (the last one
  // replaced; it keeps its id) can't hold the overlap, which moves what follows until that piece is gone.
  cutRangeEnd(d, frame + span, ctx)
  d.spine.splice(first, last - first, ...clips)
}

/** D — overwrite. */
export const overwriteAt =
  (frame: number, items: readonly SpineItem[]): TimelineRecipe =>
  (d, ctx) =>
    overwriteRange(d, { frame, items }, ctx)

// ---------------------------------------------------------------------------------------------------------------
// Blade / delete

/**
 * Blade at a frame. Without `ids` (Blade All) it cuts the spine item owning the frame and every connected clip
 * under it; with `ids` it cuts just those clips, wherever the frame falls strictly inside them. A spine item is never
 * cut inside a transition (see bladeSpineIndex).
 */
export const bladeAt =
  (frame: number, ids?: readonly string[]): TimelineRecipe =>
  (d, ctx) => {
    const f = Math.round(frame)
    const layout = layoutTimeline(d)
    const only = ids ? new Set(ids) : undefined
    const targets: string[] = []
    if (only) {
      for (const s of layout.spine) if (only.has(s.id) && f > s.start + s.overlapIn && f < s.ownEnd) targets.push(s.id)
    } else {
      const owner = ownerAt(layout, f)
      if (owner && f > owner.start) targets.push(owner.id)
    }
    for (const c of layout.connected) if ((!only || only.has(c.id)) && f > c.start && f < c.end) targets.push(c.id)
    for (const id of targets) bladeClip(d, { id, frame: f }, ctx)
  }

export const rippleDelete =
  (ids: readonly string[]): TimelineRecipe =>
  (d, ctx) =>
    removeItems(d, { ids, mode: 'ripple' }, ctx)

export const replaceWithGap =
  (ids: readonly string[]): TimelineRecipe =>
  (d, ctx) =>
    removeItems(d, { ids, mode: 'gap' }, ctx)

// ---------------------------------------------------------------------------------------------------------------
// Trims

/**
 * Spine clips: ripple trim (the start stays put, everything after moves). Connected clips: plain trim; a start
 * trim keeps the end fixed by moving the start. Start trims move a media clip's source in, so clips connected to
 * it move with its picture; titles, gaps and generators have no source offset (their picture is start-relative).
 */
export const trimEdge =
  (id: string, edge: TrimEdge, deltaFrames: number): TimelineRecipe =>
  (d, ctx) => {
    const ref = findClip(d, id)
    const delta = Math.round(deltaFrames)
    if (!ref || !delta) return
    const clip = ref.clip
    const fps = d.settings.fps
    const room = sourceRoom(clip, fps, ctx.media)
    if (edge === 'end') {
      // delta is clamped against the media here; setRange would also re-clamp clips already past their media.
      const dd = clampDelta(delta, 1 - clip.duration, room.tail)
      if (dd) trimTail(clip, dd)
      return
    }
    const index = indexSpine(d.spine)
    const start = ref.where === 'connected' ? (anchoredFrame(d.spine, index, ref.item, fps) ?? 0) : 0
    const lo = ref.where === 'connected' ? Math.max(-room.head, -start) : -room.head
    const dd = clampDelta(delta, lo, clip.duration - 1)
    if (!dd) return
    trimHead(clip, dd, fps)
    if (ref.where === 'connected') {
      const anchor = anchorAt(d.spine, index, start + dd, fps)
      if (anchor) Object.assign(ref.item, anchor)
    }
  }

/**
 * Moves the edit point between spine item `leftId` and the next one. Nothing else moves, except clips attached to
 * a non-media right item, which follow its (start-relative) picture.
 */
export const roll =
  (leftId: string, deltaFrames: number): TimelineRecipe =>
  (d, ctx) => {
    const i = d.spine.findIndex((s) => s.id === leftId)
    const left = d.spine[i]
    const right = d.spine[i + 1]
    if (i < 0 || !left || !right) return
    const fps = d.settings.fps
    const lr = sourceRoom(left, fps, ctx.media)
    const rr = sourceRoom(right, fps, ctx.media)
    const delta = clampDelta(
      Math.round(deltaFrames),
      Math.max(1 - left.duration, -rr.head),
      Math.min(right.duration - 1, lr.tail),
    )
    if (!delta) return
    trimTail(left, delta)
    trimHead(right, delta, fps)
  }

/** Changes which part of the source is shown; the clip and whatever is connected to it stay put. */
export const slip =
  (id: string, deltaFlicks: Flicks): TimelineRecipe =>
  (d, ctx) => {
    const clip = findClip(d, id)?.clip
    if (!clip || clip.kind !== 'media') return
    const take = activeTake(clip)
    const target = (take?.sourceIn ?? 0) + Math.round(deltaFlicks)
    if (!take || !Number.isFinite(target) || target === take.sourceIn) return
    preserveAnchoredFrames(d, clip, () => setRangeOf(d, { id, range: { sourceIn: target } }, ctx))
  }

/** Moves a spine item between its neighbours by trimming the previous item's end and the next item's start. */
export const slide =
  (id: string, deltaFrames: number): TimelineRecipe =>
  (d, ctx) => {
    const i = d.spine.findIndex((s) => s.id === id)
    const prev = d.spine[i - 1]
    const next = d.spine[i + 1]
    if (i < 0 || !prev || !next) return
    const fps = d.settings.fps
    const pr = sourceRoom(prev, fps, ctx.media)
    const nr = sourceRoom(next, fps, ctx.media)
    const delta = clampDelta(
      Math.round(deltaFrames),
      Math.max(1 - prev.duration, -nr.head),
      Math.min(next.duration - 1, pr.tail),
    )
    if (!delta) return
    trimTail(prev, delta)
    trimHead(next, delta, fps)
  }

// ---------------------------------------------------------------------------------------------------------------
// Storyline ⇄ connected

/** Spine item → connected clip (lane 1, or −1 when audio-only) at the same frame, leaving a gap behind. */
export const liftFromStoryline =
  (id: string): TimelineRecipe =>
  (d, ctx) => {
    const i = d.spine.findIndex((s) => s.id === id)
    const item = d.spine[i]
    if (!item || item.kind === 'gap') return
    rememberPositions(d, ctx, new Set([id]))
    const clip = deepClone(item)
    delete clip.transitionIn
    delete clip.transitionOut
    const gap = gapReplacing(item, ctx.newId())
    d.spine[i] = gap
    // Local frame 0 of a gap maps to source time 0.
    d.connected.push({ kind: 'clip', id: clip.id, clip, anchorId: gap.id, anchorSourceTime: 0, lane: defaultLaneFor(clip) })
  }

/** Connected clip → spine at its current frame, overwriting what is there. */
export const overwriteToPrimary =
  (id: string): TimelineRecipe =>
  (d, ctx) => {
    const ci = d.connected.findIndex((c) => c.id === id)
    const item = d.connected[ci]
    if (!item) return
    const start = anchoredFrame(d.spine, indexSpine(d.spine), item, d.settings.fps) ?? ctx.prevAbs.get(id) ?? 0
    const clip = deepClone(item.clip)
    d.connected.splice(ci, 1)
    overwriteRange(d, { frame: start, items: [clip] }, ctx, { autoFps: false })
  }

/**
 * A clip dragged between the primary storyline and the lanes, as in Final Cut. A storyline clip dropped on a lane
 * becomes a connected clip starting at `frame` (measured after it leaves) and the storyline closes up behind it; its
 * own connected clips and markers move with it, by as much as it moved. A connected clip dropped on lane 0 is
 * inserted into the storyline at `frame` (a clip boundary), pushing what follows. Otherwise it is a plain move.
 */
export const moveAcross =
  (id: string, frame: number, lane: number): TimelineRecipe =>
  (d, ctx) => {
    const ref = findClip(d, id)
    if (!ref) return
    const at = sanitizeFrame(frame)
    if (ref.where === 'spine' && lane !== 0) {
      const item = ref.clip
      if (item.kind === 'gap' || !Number.isFinite(at)) return
      const from = indexSpine(d.spine).geo[ref.index]!.start
      for (const t of anchoredTo(d, new Set([id]))) {
        const abs = ctx.prevAbs.get(t.id)
        if (abs !== undefined) ctx.prevAbs.set(t.id, Math.max(0, abs + at - from))
      }
      d.spine.splice(ref.index, 1)
      const clip = deepClone(item)
      delete clip.transitionIn
      delete clip.transitionOut
      placeConnected(d, clip, at, lane, ctx)
      return
    }
    if (ref.where === 'connected' && lane === 0) {
      const clip = deepClone(ref.clip)
      d.connected.splice(ref.index, 1)
      insertItems(d, { frame: at, items: [clip] }, ctx, { autoFps: false })
      return
    }
    moveItem(d, { id, frame: at, lane: ref.where === 'connected' ? lane : undefined }, ctx)
  }

// ---------------------------------------------------------------------------------------------------------------
// Retime / audio

/** FCP retime: duration scales by oldSpeed / newSpeed (clamped to the media); connected clips follow the picture. */
export const setSpeed =
  (id: string, speed: number): TimelineRecipe =>
  (d, ctx) => {
    const clip = findClip(d, id)?.clip
    const s = clampSpeed(speed)
    if (!clip || clip.kind !== 'media' || s === undefined || s === clip.speed) return
    const fps = d.settings.fps
    const ratio = clip.speed / s
    let duration = Math.max(1, Math.round(clip.duration * ratio))
    const assetDur = assetDurationOf(clip, ctx.media)
    if (assetDur !== undefined) {
      const sourceIn = activeTake(clip)?.sourceIn ?? 0
      duration = Math.min(duration, Math.max(1, framesAvailable(assetDur - sourceIn, s, fps)))
    }
    mapClipKeyframes(clip, (f) => Math.round(f * ratio))
    clip.speed = s
    clip.duration = duration
    clampFades(clip)
  }

/** Mutes a clip's own audio and connects an audio-only copy (same takes, new ids) at lane −1 on the same frame. */
export const detachAudio =
  (id: string): TimelineRecipe =>
  (d, ctx) => {
    const ref = findClip(d, id)
    const clip = ref?.clip
    if (!ref || !clip || clip.kind !== 'media' || !clip.video || !clip.audio?.enabled) return
    const index = indexSpine(d.spine)
    const start =
      ref.where === 'spine' ? index.geo[ref.index]!.start : anchoredFrame(d.spine, index, ref.item, d.settings.fps)
    if (start === undefined) return
    const copy = withFreshIds(deepClone(clip), ctx.newId)
    delete copy.video
    delete copy.transitionIn
    delete copy.transitionOut
    if (copy.audio) copy.audio.enabled = true
    clip.audio.enabled = false
    placeConnected(d, copy, start, -1, ctx)
  }

// ---------------------------------------------------------------------------------------------------------------
// Markers

function markerFrame(frame: number): number {
  return Number.isFinite(frame) ? sanitizeFrame(frame) : 0
}

export const addMarker =
  (frame: number, kind: MarkerKind = 'standard', name = ''): TimelineRecipe =>
  (d, ctx) => {
    const id = ctx.newId()
    const f = markerFrame(frame)
    const anchor = anchorAt(d.spine, indexSpine(d.spine), f, d.settings.fps)
    // Without a spine there is no anchor yet: normalize places the marker from this hint.
    ctx.prevAbs.set(id, f)
    d.markers.push({ id, kind, name, anchorId: anchor?.anchorId ?? '', anchorSourceTime: anchor?.anchorSourceTime ?? 0 })
  }

export const moveMarker =
  (id: string, frame: number): TimelineRecipe =>
  (d, ctx) => {
    const m = d.markers.find((x) => x.id === id)
    if (!m) return
    const f = markerFrame(frame)
    const anchor = anchorAt(d.spine, indexSpine(d.spine), f, d.settings.fps)
    ctx.prevAbs.set(id, f)
    if (anchor) Object.assign(m, anchor)
  }

export const removeMarker =
  (id: string): TimelineRecipe =>
  (d) =>
    removeWhere(d.markers, (m) => m.id === id)

export const updateMarker =
  (id: string, patch: MarkerPatch): TimelineRecipe =>
  (d) => {
    const m = d.markers.find((x) => x.id === id)
    if (!m) return
    if (patch.name !== undefined) m.name = patch.name
    if (patch.kind !== undefined) m.kind = patch.kind
    if (patch.done !== undefined) m.done = patch.done
  }

// ---------------------------------------------------------------------------------------------------------------
// Misc

/** Copies connected clips so the earliest copy starts at `frame`, keeping relative offsets and lanes. */
export const duplicate =
  (ids: readonly string[], frame: number): TimelineRecipe =>
  (d, ctx) => {
    const wanted = new Set(ids)
    const index = indexSpine(d.spine)
    const fps = d.settings.fps
    const picked = d.connected
      .filter((c) => wanted.has(c.id))
      .map((c) => ({ c, start: anchoredFrame(d.spine, index, c, fps) ?? 0 }))
    if (!picked.length) return
    const origin = Math.min(...picked.map((p) => p.start))
    const at = Number.isFinite(frame) ? sanitizeFrame(frame) : index.end
    const copies = picked.map(({ c, start }) => ({
      clip: withFreshIds(deepClone(c.clip), ctx.newId),
      frame: at + start - origin,
      lane: c.lane,
    }))
    for (const cp of copies) placeConnected(d, cp.clip, cp.frame, cp.lane, ctx)
  }

/** A generation finished: point its pending takes at the new asset. */
export const resolveGeneration =
  (generationId: string, assetId: string): TimelineRecipe =>
  (d, ctx) =>
    auditionClip(d, { id: '', action: { type: 'resolve', generationId, assetId } }, ctx)
