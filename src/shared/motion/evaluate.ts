import { mixColor } from '../canvas/color'
import { behaviorOffset, loopTime } from './behaviors'
import { pointAt, shapeOutline } from '../canvas/path'
import { keyframeMix, keyframeObject, keyframeValue } from '../timeline/keyframes'
import { ancestorGroups } from '../canvas/groups'
import type { CanvasAssetItem, CanvasDoc, CanvasFrameItem, CanvasGroupItem, CanvasItem, CanvasShapeItem, CanvasTextItem, GradientFill, Rect } from '../types/canvas'
import type { MotionCamera, MotionClip, MotionItemTransform, MotionTrack, MotionTrim, RevealMode } from '../types/project-doc'

/**
 * Motion clips: a Canvas frame (artboard) played as an animated scene. Evaluation is pure: the same clip, items and
 * frame always resolve to the same picture, so the viewer and the export worker draw identical frames.
 */

/** Board elements that draw in a motion scene (notes and frames never do). */
export type MotionItem = CanvasAssetItem | CanvasTextItem | CanvasShapeItem

export interface ResolvedItem {
  item: MotionItem
  /** Place in frame units, from the frame's top-left corner, after the track's offset. */
  rect: Rect
  scale: number
  /** Width and height factors on top of `scale` (1 when unset). */
  stretch?: { x: number; y: number }
  rotation: number // degrees, around the element's centre
  /** Gaussian blur, frame units. */
  blur?: number
  /** Motion blur: the element's states across the open shutter, drawn and averaged instead of this one. */
  trail?: ResolvedItem[]
  /** The groups it is in, innermost first (masks made of a group clip with all of it). */
  groupIds?: string[]
  /** Used as another element's mask (itself, or a group it is in): drawn only into that mask, never on its own. */
  matte?: boolean
  /** Shown only inside (or with `invert`, outside) this mask: its own `clipBy`, else its nearest group's. */
  clip?: { by: string; invert: boolean }
  opacity: number
  /** 0..1 shown, the way `revealMode` says (1 = whole element). */
  reveal: number
  revealMode?: RevealMode
  /** `roll`: what the numbers count from. */
  rollFrom?: number
  /** Shapes: only this part of the outline is stroked (no fill), when the track trims it. */
  trim?: MotionTrim
}

export interface MotionView {
  /** Frame size in board units. */
  size: { w: number; h: number }
  fill?: string | GradientFill
  camera: MotionCamera
  /** Back to front. */
  items: ResolvedItem[]
  /** The frame is gone (board or frame deleted): draw a placeholder. */
  missing: boolean
}

export const IDENTITY_ITEM_TRANSFORM: Readonly<MotionItemTransform> = Object.freeze({ x: 0, y: 0, scale: 1, rotation: 0 })
export const DEFAULT_CAMERA: Readonly<MotionCamera> = Object.freeze({ x: 0, y: 0, zoom: 1 })

export interface MotionSource {
  frame?: CanvasFrameItem
  /** The frame's contents, back to front. */
  items: CanvasItem[]
}

/** The frame a motion clip plays and its contents: the detached snapshot, else the live board. */
export function motionSource(clip: MotionClip, canvas: CanvasDoc | undefined): MotionSource {
  if (clip.detached) {
    const [first, ...rest] = clip.detached
    return first?.kind === 'frame' ? { frame: first, items: rest } : { items: [] }
  }
  const board = canvas?.boards.find((b) => b.id === clip.boardId)
  const frame = board?.items.find((i): i is CanvasFrameItem => i.kind === 'frame' && i.id === clip.frameId)
  if (!board || !frame) return { items: [] }
  return { frame, items: board.items.filter((i) => i.frameId === frame.id) }
}

export function isMotionItem(item: CanvasItem): item is MotionItem {
  return item.kind === 'asset' || item.kind === 'text' || item.kind === 'shape'
}

/** Time in the clip's animation at `localFrame` frames from the clip's start. */
export function motionTime(clip: MotionClip, localFrame: number): number {
  return localFrame + (clip.offset ?? 0)
}

/** Every element of the frame at `localFrame`; elements without a track stay where the board has them. */
export function evaluateMotion(clip: MotionClip, frame: CanvasFrameItem | undefined, items: readonly CanvasItem[], localFrame: number): MotionView {
  const t = motionTime(clip, localFrame)
  const camera = keyframeObject(clip.camera, t, { ...DEFAULT_CAMERA })
  if (!frame) return { size: { w: 1, h: 1 }, camera, items: [], missing: true }
  const resolved: ResolvedItem[] = []
  const byId = new Map(items.map((i) => [i.id, i]))
  const masks = new Set(items.flatMap((i) => (i.clipBy && byId.has(i.clipBy) ? [i.clipBy] : [])))
  for (const item of items) {
    if (!isMotionItem(item)) continue
    const groups = ancestorGroups(byId, item)
    // Hidden elements (or in a hidden group) aren't drawn — unless something uses them as its mask.
    const isMatte = masks.has(item.id) || groups.some((g) => masks.has(g.id))
    if (!isMatte && (item.hidden || groups.some((g) => g.hidden))) continue
    // An element in a group moves with it: the group's animation on top of the element's own.
    const at = (time: number) => {
      const ri = resolveItem(item, clip.tracks[item.id], frame, items, time, progressAt(clip, time))
      for (const g of groups) composeGroup(ri, resolveItem(g, clip.tracks[g.id], frame, items, time, progressAt(clip, time)), g, frame)
      if (groups.length) ri.groupIds = groups.map((g) => g.id)
      return ri
    }
    const ri = at(t)
    if (isMatte) ri.matte = true
    const clipper = [item, ...groups].find((i) => i.clipBy && byId.has(i.clipBy))
    if (clipper) ri.clip = { by: clipper.clipBy!, invert: Boolean(clipper.clipInvert) }
    const shutter = Math.max(clip.tracks[item.id]?.motionBlur ?? 0, ...groups.map((g) => clip.tracks[g.id]?.motionBlur ?? 0))
    if (shutter > 0) {
      // The shutter is open around the frame: samples spread over `shutter` of a frame, centred on it.
      const samples = Array.from({ length: MOTION_SAMPLES }, (_, j) => at(t + (j / (MOTION_SAMPLES - 1) - 0.5) * shutter))
      if (samples.some((s) => moved(s, ri))) ri.trail = samples
    }
    resolved.push(ri)
  }
  return { size: { w: frame.w, h: frame.h }, fill: frame.fill, camera, items: resolved, missing: false }
}

/** Sub-frame samples drawn and averaged for motion blur. */
export const MOTION_SAMPLES = 8

/**
 * A group's state applied to one of its members: moved by the group's offset, scaled and turned with it around the
 * group's centre, its opacity multiplied and its blur added.
 */
function composeGroup(ri: ResolvedItem, gs: ResolvedItem, group: CanvasGroupItem, frame: CanvasFrameItem) {
  const gx = group.x - frame.x
  const gy = group.y - frame.y
  const cx = gx + group.w / 2
  const cy = gy + group.h / 2
  const sx = gs.scale * (gs.stretch?.x ?? 1)
  const sy = gs.scale * (gs.stretch?.y ?? 1)
  const a = (gs.rotation * Math.PI) / 180
  const vx = (ri.rect.x + ri.rect.w / 2 - cx) * sx
  const vy = (ri.rect.y + ri.rect.h / 2 - cy) * sy
  const nx = cx + (gs.rect.x - gx) + vx * Math.cos(a) - vy * Math.sin(a)
  const ny = cy + (gs.rect.y - gy) + vx * Math.sin(a) + vy * Math.cos(a)
  ri.rect = { ...ri.rect, x: nx - ri.rect.w / 2, y: ny - ri.rect.h / 2 }
  ri.rotation += gs.rotation
  ri.scale *= gs.scale
  if (gs.stretch) ri.stretch = { x: (ri.stretch?.x ?? 1) * gs.stretch.x, y: (ri.stretch?.y ?? 1) * gs.stretch.y }
  ri.opacity *= gs.opacity
  const blur = (ri.blur ?? 0) + (gs.blur ?? 0)
  if (blur > 0) ri.blur = blur
}

/**
 * One element at animation time `t` (fractional for motion blur samples). A group resolves the same way (its state
 * is only composed onto its members; it is never drawn).
 */
/** How far through the clip animation time `t` is (0 on its first frame, 1 on its last). */
function progressAt(clip: MotionClip, t: number): number {
  return clamp01((t - (clip.offset ?? 0)) / Math.max(1, clip.duration - 1))
}

function resolveItem(item: MotionItem | CanvasGroupItem, track: MotionTrack | undefined, frame: CanvasFrameItem, items: readonly CanvasItem[], time: number, progress = 0): ResolvedItem {
  // Keys may loop; behaviours run on the clip's own time.
  const t = loopTime(track?.loop, time)
  const tf = keyframeObject(track?.transform, t, { ...IDENTITY_ITEM_TRANSFORM })
  if (track?.behaviors?.length) {
    const b = behaviorOffset(track.behaviors, time)
    tf.x += b.x
    tf.y += b.y
    tf.rotation += b.rotation
    tf.scale *= b.scale
  }
  const route = track?.follow && followAt(track.follow, items, item, t)
  const color = keyframeMix(track?.color, t, mixColor)
  const stretch = track?.stretch?.length ? keyframeObject(track.stretch, t, { x: 1, y: 1 }) : undefined
  const blur = track?.blur?.length ? Math.max(0, keyframeValue(track.blur, t, 0)) : 0
  return {
    item: item.kind === 'group' ? (item as unknown as MotionItem) : color ? withColor(item, color) : item,
    rect: route
      ? { x: route.x - item.w / 2 - frame.x + tf.x, y: route.y - item.h / 2 - frame.y + tf.y, w: item.w, h: item.h }
      : { x: item.x - frame.x + tf.x, y: item.y - frame.y + tf.y, w: item.w, h: item.h },
    scale: Math.max(0, tf.scale),
    rotation: (item.rotation ?? 0) + tf.rotation + (route?.turn ?? 0),
    opacity: clamp01(keyframeValue(track?.opacity, t, 1)),
    // A progress bar: the reveal (a left-to-right wipe unless the track says otherwise) or the outline follows the clip.
    reveal: track?.progress === 'reveal' ? progress : clamp01(keyframeValue(track?.reveal, t, 1)),
    revealMode: track?.progress === 'reveal' ? (track.revealMode ?? 'wipe-left') : track?.revealMode,
    ...(track?.rollFrom ? { rollFrom: track.rollFrom } : {}),
    ...(track?.progress === 'trim' ? { trim: { start: 0, end: progress } } : track?.trim?.length ? { trim: trimAt(track.trim, t) } : {}),
    ...(stretch && (stretch.x !== 1 || stretch.y !== 1) ? { stretch } : {}),
    ...(blur > 0 ? { blur } : {}),
  }
}

/** Whether a sample sits visibly elsewhere than the frame's own state (else motion blur is skipped). */
function moved(a: ResolvedItem, b: ResolvedItem): boolean {
  const d = (x: number, y: number) => Math.abs(x - y)
  return (
    d(a.rect.x, b.rect.x) > 0.25 ||
    d(a.rect.y, b.rect.y) > 0.25 ||
    d(a.scale, b.scale) > 0.002 ||
    d(a.rotation, b.rotation) > 0.05 ||
    d(a.stretch?.x ?? 1, b.stretch?.x ?? 1) > 0.002 ||
    d(a.stretch?.y ?? 1, b.stretch?.y ?? 1) > 0.002
  )
}

/** The board layout as it stands, no animation (thumbnails, PNG export). */
export function staticView(frame: CanvasFrameItem, items: readonly CanvasItem[]): MotionView {
  return evaluateMotion({ kind: 'motion', id: '', duration: 1, enabled: true, boardId: '', frameId: frame.id, tracks: {} }, frame, items, 0)
}

/** Asset ids the frame's elements show (to load before drawing). */
export function motionAssetIds(items: readonly CanvasItem[]): string[] {
  const ids = new Set<string>()
  for (const i of items) if (i.kind === 'asset' && i.assetId) ids.add(i.assetId)
  return [...ids]
}

/**
 * Where a following element's centre is (board units) and how much it turns: the route's outline in its box, turned
 * with the route around its centre. No route (deleted, or itself) leaves the element where it is.
 */
function followAt(follow: NonNullable<MotionTrack['follow']>, items: readonly CanvasItem[], self: CanvasItem, t: number): { x: number; y: number; turn: number } | undefined {
  const path = items.find((i): i is CanvasShapeItem => i.id === follow.pathId && i.kind === 'shape')
  if (!path || path.id === self.id) return undefined
  const p = pointAt(shapeOutline(path, path.w, path.h), keyframeValue(follow.progress, t, 0))
  const deg = path.rotation ?? 0
  const rad = (deg * Math.PI) / 180
  const dx = p.x - path.w / 2
  const dy = p.y - path.h / 2
  return {
    x: path.x + path.w / 2 + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: path.y + path.h / 2 + dx * Math.sin(rad) + dy * Math.cos(rad),
    turn: follow.orient ? p.angle + deg : 0,
  }
}

/** The element in the track's colour: text, a solid fill, else the outline. */
function withColor(item: MotionItem, color: string): MotionItem {
  if (item.kind === 'text') return { ...item, color }
  if (item.kind !== 'shape') return item
  const open = item.shape === 'line' || item.shape === 'polyline' || item.shape === 'arc'
  if (!open && typeof item.fill === 'string' && item.fill !== 'none') return { ...item, fill: color }
  return item.stroke ? { ...item, stroke: { ...item.stroke, color } } : item
}

function trimAt(keys: MotionTrack['trim'], t: number): MotionTrim {
  const v = keyframeObject(keys, t, { start: 0, end: 1 })
  return { start: clamp01(v.start), end: clamp01(v.end) }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}
