import { framesToFlicks } from '../time/flicks'
import {
  type Clip,
  type GapClip,
  type MediaClip,
  type ProjectDoc,
  type SpineItem,
  type Transition,
  activeTake,
  defaultAudioProps,
  defaultVideoProps,
} from '../types/project-doc'
import { applyFpsAutoLock, rescaleClipFrames } from './fps'
import {
  type SpineIndex,
  anchorAt,
  anchoredFrame,
  effectiveSpeed,
  findOwnerIndex,
  indexSpine,
  localFrameAt,
  sanitizeLane,
  sourceTimeAt,
} from './layout'
import type {
  AuditionAction,
  ClipPropsPatch,
  RangePatch,
  RecipeContext,
  RemoveMode,
  TimelineRecipe,
  TransitionEdge,
} from './types'
import {
  type ConnectableClip,
  anchoredTo,
  assetDurationOf,
  clampFades,
  clampSpeed,
  collectIds,
  deepClone,
  findClip,
  fitToMedia,
  framesAvailable,
  mapClipKeyframes,
  prepareIncoming,
  preserveAnchoredFrames,
  rememberAnchoredPositions,
  removeWhere,
  sanitizeFrame,
  shiftMotion,
} from './util'

export interface PrimitiveOptions {
  /** Run the fps auto-lock for incoming clips (default true; off when re-inserting clips already in the doc). */
  autoFps?: boolean
}

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers (also used by the compound ops)

/** Runs the fps auto-lock for incoming clips; rescales them and returns `frame` converted to the new fps. */
export function lockFpsFor(
  doc: ProjectDoc,
  clips: Clip[],
  frame: number,
  ctx: RecipeContext,
  opts: PrimitiveOptions = {},
): number {
  if (opts.autoFps === false) return frame
  const ratio = applyFpsAutoLock(doc, clips, ctx)
  if (ratio === 1) return frame
  for (const c of clips) {
    rescaleClipFrames(c, ratio)
    fitToMedia(c, doc.settings.fps, ctx.media)
  }
  return Math.round(frame * ratio)
}

/** A gap standing in for `item`: same duration and transitions, so the layout does not move. */
export function gapReplacing(item: SpineItem, id: string): GapClip {
  const gap: GapClip = { kind: 'gap', id, duration: item.duration, enabled: true }
  if (item.transitionIn) gap.transitionIn = { ...item.transitionIn }
  if (item.transitionOut) gap.transitionOut = { ...item.transitionOut }
  return gap
}

/** Appends a gap so the spine reaches at least `frame` (exactly `frame` when it had to grow). */
export function padSpineTo(doc: ProjectDoc, frame: number, ctx: RecipeContext): void {
  const end = indexSpine(doc.spine).end
  if (!Number.isFinite(frame) || end >= frame) return
  // A fade-out on the previous last item becomes an overlap with the new gap: the gap grows by that overlap, measured
  // with the gap long enough to hold all of it (a 3-frame pad after a 24-frame fade held 2, and grew 2 a pass).
  const fade = Math.round(doc.spine.at(-1)?.transitionOut?.duration ?? 0)
  const gap: GapClip = { kind: 'gap', id: ctx.newId(), duration: frame - end + (fade > 0 ? fade : 0), enabled: true }
  doc.spine.push(gap)
  gap.duration = frame - end + (indexSpine(doc.spine).geo.at(-2)?.overlapOut ?? 0)
}

/** Current absolute frame of every connected item / marker anchored to `spineIds`, stored in `ctx.prevAbs`. */
export function rememberPositions(doc: ProjectDoc, ctx: RecipeContext, spineIds: ReadonlySet<string>): void {
  const index = indexSpine(doc.spine)
  const fps = doc.settings.fps
  rememberAnchoredPositions(doc, ctx, spineIds, (t) => anchoredFrame(doc.spine, index, t, fps))
}

/** Adds a (prepared) connected clip at an absolute frame, growing the spine when the frame lies past its end. */
export function placeConnected(
  doc: ProjectDoc,
  clip: ConnectableClip,
  frame: number,
  lane: number | undefined,
  ctx: RecipeContext,
): void {
  const f = Number.isFinite(frame) ? sanitizeFrame(frame) : indexSpine(doc.spine).end
  if (f >= indexSpine(doc.spine).end) padSpineTo(doc, f + Math.max(1, clip.duration), ctx)
  const anchor = anchorAt(doc.spine, indexSpine(doc.spine), f, doc.settings.fps)!
  doc.connected.push({ kind: 'clip', id: clip.id, clip, ...anchor, lane: sanitizeLane(lane, clip) })
}

// ---------------------------------------------------------------------------------------------------------------
// blade

/** Splits `left` at `offset` frames: `left` keeps the head, the returned copy (fresh ids) is the tail. */
function splitClip(left: Clip, offset: number, ctx: RecipeContext, fps: number): Clip {
  const right = deepClone(left)
  right.id = ctx.newId()
  right.duration = left.duration - offset
  left.duration = offset
  delete right.transitionIn
  if (left.transitionOut) delete left.transitionOut
  if (right.kind === 'media') {
    // Every take is split, so switching takes later keeps both pieces consistent.
    const shift = framesToFlicks(offset * effectiveSpeed(right), fps)
    for (const t of right.takes) {
      t.id = ctx.newId()
      t.sourceIn += shift
    }
    if (right.audio) right.audio.fadeIn = 0
  }
  if (left.kind === 'media' && left.audio) left.audio.fadeOut = 0
  if (right.kind === 'motion') shiftMotion(right, offset)
  mapClipKeyframes(right, (f) => f - offset)
  clampFades(left)
  clampFades(right)
  return right
}

/**
 * Blades spine item `i` at `offset` frames from its start; returns the right piece's id, or undefined when the cut
 * falls inside a transition. Each piece must keep a frame of its own beside the transition it carries on
 * (clampedOverlaps: incoming + outgoing ≤ duration − 1): a shorter one has the overlap clamped on normalize, and
 * everything after it slides — B cut at 90, inside A's 20-frame dissolve into it (80–99), made the film 11 frames
 * longer.
 */
export function bladeSpineIndex(doc: ProjectDoc, i: number, offset: number, ctx: RecipeContext): string | undefined {
  const g = indexSpine(doc.spine).geo[i]
  if (!g || !(offset > g.overlapIn && g.start + offset < g.ownEnd)) return undefined
  return splitSpineIndex(doc, i, offset, ctx)
}

/**
 * The frames a transition keeps from being cut (see bladeSpineIndex) when `frame` is one of them: from the edit point
 * under the transition to the first frame after it that can be cut. Undefined for any other frame.
 */
export function transitionAt(index: SpineIndex, frame: number): { editPoint: number; after: number } | undefined {
  const g = index.geo[findOwnerIndex(index.geo, frame)]
  if (!g || !(frame > g.start && frame <= g.start + g.overlapIn)) return undefined
  return { editPoint: g.start, after: g.start + g.overlapIn + 1 }
}

/**
 * Cuts the spine at `frame`, the far end of a range about to be overwritten or removed — even inside a transition:
 * the piece before the cut, too short to hold it, goes with the range and the overlap with it. Measure the range
 * before calling this (until that piece is gone, the clamped overlap moves what follows).
 */
export function cutRangeEnd(doc: ProjectDoc, frame: number, ctx: RecipeContext): void {
  const index = indexSpine(doc.spine)
  if (!(frame > 0 && frame < index.end)) return
  const i = findOwnerIndex(index.geo, frame)
  const start = index.geo[i]!.start
  if (start < frame) splitSpineIndex(doc, i, frame - start, ctx)
}

/** bladeSpineIndex without the transition check. */
function splitSpineIndex(doc: ProjectDoc, i: number, offset: number, ctx: RecipeContext): string {
  const fps = doc.settings.fps
  const left = doc.spine[i]!
  const right = splitClip(left, offset, ctx, fps) as SpineItem
  // Items anchored at/after the cut move to the right piece now (not only in normalize), so they stay on their
  // picture even if the right piece is displaced later in the same recipe (e.g. by insert).
  for (const t of anchoredTo(doc, new Set([left.id]))) {
    const local = localFrameAt(left, t.anchorSourceTime, fps)
    if (local >= offset) {
      t.anchorId = right.id
      t.anchorSourceTime = sourceTimeAt(right, local - offset, fps)
    }
  }
  doc.spine.splice(i + 1, 0, right)
  return right.id
}

/** Blades the spine item owning `frame` when the frame falls strictly inside it (and not inside a transition). */
export function bladeSpineAt(doc: ProjectDoc, frame: number, ctx: RecipeContext): void {
  const index = indexSpine(doc.spine)
  if (!(frame > 0 && frame < index.end)) return
  const i = findOwnerIndex(index.geo, frame)
  const start = index.geo[i]!.start
  if (start < frame) bladeSpineIndex(doc, i, frame - start, ctx)
}

/**
 * Splits a spine or connected clip at an absolute frame strictly inside it. The left piece keeps the id; returns
 * the right piece's id (undefined when nothing was cut).
 */
export function bladeClip(doc: ProjectDoc, args: { id: string; frame: number }, ctx: RecipeContext): string | undefined {
  const ref = findClip(doc, args.id)
  if (!ref) return undefined
  const frame = Math.round(args.frame)
  const fps = doc.settings.fps
  const index = indexSpine(doc.spine)
  if (ref.where === 'spine') {
    const g = index.geo[ref.index]!
    if (!(frame > g.start && frame < g.ownEnd)) return undefined
    return bladeSpineIndex(doc, ref.index, frame - g.start, ctx)
  }
  const start = anchoredFrame(doc.spine, index, ref.item, fps)
  if (start === undefined || !(frame > start && frame < start + ref.clip.duration)) return undefined
  const right = splitClip(ref.clip, frame - start, ctx, fps) as ConnectableClip
  const anchor = anchorAt(doc.spine, index, frame, fps)!
  doc.connected.splice(ref.index + 1, 0, { kind: 'clip', id: right.id, clip: right, ...anchor, lane: ref.item.lane })
  return right.id
}

// ---------------------------------------------------------------------------------------------------------------
// insert / remove / move / connect

/**
 * Spine index to insert at `frame`, blading the owning item when the frame falls strictly inside it — inside a
 * transition, at the edit point under it (no cut there could hold the transition).
 */
function insertionIndex(doc: ProjectDoc, frame: number, ctx: RecipeContext): number {
  const index = indexSpine(doc.spine)
  if (frame >= index.end) return doc.spine.length
  const at = transitionAt(index, frame)?.editPoint ?? frame
  const i = findOwnerIndex(index.geo, at)
  const start = index.geo[i]!.start
  if (start === at) return i
  bladeSpineIndex(doc, i, at - start, ctx)
  return i + 1
}

export function insertItems(
  doc: ProjectDoc,
  args: { frame: number; items: readonly SpineItem[] },
  ctx: RecipeContext,
  opts: PrimitiveOptions = {},
): void {
  const items = prepareIncoming(doc, args.items, ctx.newId)
  if (!items.length) return
  const frame = lockFpsFor(doc, items, sanitizeFrame(args.frame), ctx, opts)
  doc.spine.splice(insertionIndex(doc, frame, ctx), 0, ...items)
}

export function removeItems(
  doc: ProjectDoc,
  args: { ids: readonly string[]; mode: RemoveMode },
  ctx: RecipeContext,
): void {
  const ids = new Set(args.ids)
  removeWhere(doc.markers, (m) => ids.has(m.id))
  removeWhere(doc.connected, (c) => ids.has(c.id))
  const spineIds = new Set(doc.spine.filter((s) => ids.has(s.id)).map((s) => s.id))
  if (!spineIds.size) return
  if (args.mode === 'ripple') {
    removeWhere(doc.spine, (s) => spineIds.has(s.id))
    removeWhere(doc.connected, (c) => spineIds.has(c.anchorId))
    removeWhere(doc.markers, (m) => spineIds.has(m.anchorId))
    return
  }
  rememberPositions(doc, ctx, spineIds)
  doc.spine.forEach((s, i) => {
    if (spineIds.has(s.id) && s.kind !== 'gap') doc.spine[i] = gapReplacing(s, ctx.newId())
  })
}

export function connectClip(
  doc: ProjectDoc,
  args: { clip: ConnectableClip; frame: number; lane?: number },
  ctx: RecipeContext,
  opts: PrimitiveOptions = {},
): void {
  if ((args.clip.kind as string) === 'gap') return
  const clips = prepareIncoming(doc, [args.clip], ctx.newId)
  const frame = lockFpsFor(doc, clips, sanitizeFrame(args.frame), ctx, opts)
  placeConnected(doc, clips[0]!, frame, args.lane, ctx)
}

/**
 * Connected item: re-anchored at the new absolute frame (lane updated when given). Spine item: lifted out and
 * inserted at `frame`, measured on the storyline after the lift (magnetic); its connected items travel with it.
 */
export function moveItem(doc: ProjectDoc, args: { id: string; frame: number; lane?: number }, ctx: RecipeContext): void {
  const ref = findClip(doc, args.id)
  if (!ref) return
  const frame = sanitizeFrame(args.frame)
  if (ref.where === 'spine') {
    const [item] = doc.spine.splice(ref.index, 1)
    insertItems(doc, { frame, items: [item!] }, ctx, { autoFps: false })
    return
  }
  if (!Number.isFinite(frame)) return
  if (frame >= indexSpine(doc.spine).end) padSpineTo(doc, frame + Math.max(1, ref.clip.duration), ctx)
  const anchor = anchorAt(doc.spine, indexSpine(doc.spine), frame, doc.settings.fps)!
  ref.item.anchorId = anchor.anchorId
  ref.item.anchorSourceTime = anchor.anchorSourceTime
  if (args.lane !== undefined) ref.item.lane = sanitizeLane(args.lane, ref.clip)
}

// ---------------------------------------------------------------------------------------------------------------
// setRange / setProps / setTransition

/**
 * Trim / slip. `sourceIn` applies to the active take of media clips (ignored for gaps, titles, generators).
 * Media with a known asset length keeps its source range inside [0, asset]; a pure slip keeps the duration.
 */
export function setRangeOf(doc: ProjectDoc, args: { id: string; range: RangePatch }, ctx: RecipeContext): void {
  const ref = findClip(doc, args.id)
  if (!ref) return
  const clip = ref.clip
  const fps = doc.settings.fps
  const { sourceIn, duration } = args.range
  const assetDur = assetDurationOf(clip, ctx.media)
  const speed = effectiveSpeed(clip)
  const take = clip.kind === 'media' ? activeTake(clip) : undefined
  const slip = take !== undefined && sourceIn !== undefined && Number.isFinite(sourceIn)
  if (slip) {
    let s = Math.max(0, Math.round(sourceIn))
    if (assetDur !== undefined) s = Math.min(s, Math.max(0, assetDur - framesToFlicks(speed, fps)))
    take.sourceIn = s
  }
  if (duration !== undefined && Number.isFinite(duration)) {
    let d = Math.max(1, Math.round(duration))
    if (take && assetDur !== undefined) d = Math.min(d, Math.max(1, framesAvailable(assetDur - take.sourceIn, speed, fps)))
    clip.duration = d
  } else if (slip && assetDur !== undefined) {
    const extent = framesToFlicks(clip.duration * speed, fps)
    if (take.sourceIn + extent > assetDur) take.sourceIn = Math.max(0, assetDur - extent)
  }
  clampFades(clip)
}

function assignDefined<T extends object>(target: T, patch: Partial<T>): void {
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (target as Record<string, unknown>)[k] = deepClone(v)
}

export function setClipProps(doc: ProjectDoc, args: { id: string; patch: ClipPropsPatch }, _ctx?: RecipeContext): void {
  const clip = findClip(doc, args.id)?.clip
  if (!clip) return
  const p = args.patch
  if (p.name === null) delete clip.name
  else if (p.name !== undefined) clip.name = p.name
  if (p.enabled !== undefined) clip.enabled = p.enabled
  if (clip.kind === 'gap') return
  if (p.video === null) delete clip.video
  else if (p.video) {
    if (!clip.video) clip.video = defaultVideoProps()
    assignDefined(clip.video, p.video)
  }
  if (clip.kind === 'media') {
    const speed = p.speed === undefined ? undefined : clampSpeed(p.speed)
    if (speed !== undefined) clip.speed = speed
    if (p.audio === null) delete clip.audio
    else if (p.audio) {
      if (!clip.audio) clip.audio = defaultAudioProps()
      assignDefined(clip.audio, p.audio)
    }
  } else if (clip.kind === 'title') {
    if (p.template !== undefined) clip.template = p.template
    if (p.text !== undefined) clip.text = p.text
    if (p.subtitle === null) delete clip.subtitle
    else if (p.subtitle !== undefined) clip.subtitle = p.subtitle
    if (p.style) assignDefined(clip.style, p.style)
    if (p.animation !== undefined) clip.animation = p.animation
  } else if (clip.kind === 'generator') {
    if (p.generator !== undefined) clip.generator = p.generator
    if (p.params) assignDefined(clip.params, p.params)
  } else {
    if (p.tracks) clip.tracks = deepClone(p.tracks)
    if (p.camera === null) delete clip.camera
    else if (p.camera) clip.camera = deepClone(p.camera)
    if (p.detached === null) delete clip.detached
    else if (p.detached) clip.detached = deepClone(p.detached)
    if (p.span === null) delete clip.span
    else if (p.span === 'timeline' && doc.connected.some((c) => c.id === clip.id)) clip.span = 'timeline'
  }
}

export function setTransitionOf(
  doc: ProjectDoc,
  args: { id: string; edge: TransitionEdge; transition: Transition | null },
  _ctx?: RecipeContext,
): void {
  const item = doc.spine.find((s) => s.id === args.id)
  if (!item) return
  const key = args.edge === 'in' ? 'transitionIn' : 'transitionOut'
  const t = args.transition
  if (!t || !(Math.round(t.duration) >= 1)) delete item[key]
  else item[key] = { type: t.type, duration: Math.round(t.duration) }
}

// ---------------------------------------------------------------------------------------------------------------
// audition

function selectTake(doc: ProjectDoc, clip: MediaClip, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= clip.takes.length || index === clip.active) return
  // Keeps the duration; connected items / markers stay on their timeline frames.
  preserveAnchoredFrames(doc, clip, () => {
    clip.active = index
  })
}

/** Sets `assetId` on pending takes of a generation, wherever they are (it may sit in several clips). */
function resolveTakes(doc: ProjectDoc, generationId: string, assetId: string, ctx: RecipeContext): void {
  const touched: Clip[] = []
  const visit = (clip: Clip) => {
    if (clip.kind !== 'media') return
    let hit = false
    for (const t of clip.takes)
      if (t.generationId === generationId && !t.assetId) {
        t.assetId = assetId
        hit = true
      }
    if (hit) touched.push(clip)
  }
  doc.spine.forEach(visit)
  for (const c of doc.connected) visit(c.clip)
  // The first real video asset may be what locks the project fps.
  if (touched.length) applyFpsAutoLock(doc, touched, ctx)
}

export function auditionClip(doc: ProjectDoc, args: { id: string; action: AuditionAction }, ctx: RecipeContext): void {
  const { action } = args
  if (action.type === 'resolve') {
    resolveTakes(doc, action.generationId, action.assetId, ctx)
    return
  }
  const clip = findClip(doc, args.id)?.clip
  if (!clip || clip.kind !== 'media') return
  switch (action.type) {
    case 'add': {
      const take = deepClone(action.take)
      const used = collectIds(doc)
      while (!take.id || used.has(take.id)) take.id = ctx.newId()
      clip.takes.push(take)
      if (action.select) selectTake(doc, clip, clip.takes.length - 1)
      return
    }
    case 'select':
      selectTake(doc, clip, action.index)
      return
    case 'finalize': {
      if (!clip.takes.length) return
      const keep = Math.min(clip.takes.length - 1, Math.max(0, clip.active))
      clip.takes.splice(keep + 1)
      clip.takes.splice(0, keep)
      clip.active = 0
      return
    }
    case 'remove': {
      const i = action.index
      if (!Number.isInteger(i) || i < 0 || i >= clip.takes.length) return
      preserveAnchoredFrames(doc, clip, () => {
        clip.takes.splice(i, 1)
        if (i < clip.active) clip.active -= 1
        else if (clip.active >= clip.takes.length) clip.active = Math.max(0, clip.takes.length - 1)
      })
      return
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Raw recipes `(draft, args, ctx)` and op factories

export const primitives = {
  insert: insertItems,
  remove: removeItems,
  setRange: setRangeOf,
  blade: bladeClip,
  connect: connectClip,
  move: moveItem,
  setProps: setClipProps,
  setTransition: setTransitionOf,
  audition: auditionClip,
}

/** Inserts spine items at `frame` (blading the item under it); at/after the spine end it appends. */
export const insert =
  (frame: number, items: readonly SpineItem[]): TimelineRecipe =>
  (d, ctx) =>
    insertItems(d, { frame, items }, ctx)

/** 'ripple' closes the hole and deletes clips connected to removed spine items; 'gap' leaves gaps. */
export const remove =
  (ids: readonly string[], mode: RemoveMode = 'ripple'): TimelineRecipe =>
  (d, ctx) =>
    removeItems(d, { ids, mode }, ctx)

export const setRange =
  (id: string, range: RangePatch): TimelineRecipe =>
  (d, ctx) =>
    setRangeOf(d, { id, range }, ctx)

export const blade =
  (id: string, frame: number): TimelineRecipe =>
  (d, ctx) => {
    bladeClip(d, { id, frame }, ctx)
  }

export const connect =
  (item: ConnectableClip, frame: number, lane?: number): TimelineRecipe =>
  (d, ctx) =>
    connectClip(d, { clip: item, frame, lane }, ctx)

export const move =
  (id: string, frame: number, lane?: number): TimelineRecipe =>
  (d, ctx) =>
    moveItem(d, { id, frame, lane }, ctx)

export const setProps =
  (id: string, patch: ClipPropsPatch): TimelineRecipe =>
  (d) =>
    setClipProps(d, { id, patch })

export const setTransition =
  (spineItemId: string, edge: TransitionEdge, transition: Transition | null): TimelineRecipe =>
  (d) =>
    setTransitionOf(d, { id: spineItemId, edge, transition })

/** For `{ type: 'resolve' }` the id is ignored: every pending take of the generation is resolved. */
export const audition =
  (id: string, action: AuditionAction): TimelineRecipe =>
  (d, ctx) =>
    auditionClip(d, { id, action }, ctx)
