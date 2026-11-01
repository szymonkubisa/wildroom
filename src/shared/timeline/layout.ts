import { type Flicks, flicksToFrames, framesToFlicks } from '../time/flicks'
import { type Clip, type ProjectDoc, type SpineItem, clipSourceIn, clipSpeed } from '../types/project-doc'
import type {
  ClipLayoutItem,
  ConnectedLayoutItem,
  LayoutEntry,
  MarkerLayoutItem,
  SpineLayoutItem,
  TimelineLayout,
} from './types'

// ---------------------------------------------------------------------------------------------------------------
// Source mapping

/** Speed used for time mapping (guards against corrupt values in un-normalized docs). */
export function effectiveSpeed(clip: Clip): number {
  const s = clipSpeed(clip)
  return Number.isFinite(s) && s > 0 ? s : 1
}

/** Source time (flicks) shown at `localFrame` frames after the clip's start. */
export function sourceTimeAt(clip: Clip, localFrame: number, fps: number): Flicks {
  return clipSourceIn(clip) + framesToFlicks(localFrame * effectiveSpeed(clip), fps)
}

/** Inverse of `sourceTimeAt`, rounded to the nearest frame. */
export function localFrameAt(clip: Clip, sourceTime: Flicks, fps: number): number {
  return Math.round(flicksToFrames(sourceTime - clipSourceIn(clip), fps) / effectiveSpeed(clip))
}

// ---------------------------------------------------------------------------------------------------------------
// Spine geometry

export interface SpineGeometry {
  start: number
  end: number
  ownEnd: number
  overlapIn: number
  overlapOut: number
}

function spanOf(item: { duration: number }): number {
  return Number.isFinite(item.duration) ? Math.max(0, item.duration) : 0
}

/**
 * Overlap (frames) that each item's `transitionOut` creates with the next item, clamped so that
 * overlap ≤ min(left, right) − 1 and incoming + outgoing ≤ duration − 1 for every item (greedy, left to right).
 */
export function clampedOverlaps(spine: readonly SpineItem[]): number[] {
  const overlaps: number[] = []
  let incoming = 0
  for (let i = 0; i < spine.length; i++) {
    const item = spine[i]!
    const next = spine[i + 1]
    let ov = 0
    if (next && item.transitionOut) {
      ov = Math.min(Math.round(item.transitionOut.duration), spanOf(item) - 1 - incoming, spanOf(next) - 1)
      if (!(ov >= 1)) ov = 0
    }
    overlaps.push(ov)
    incoming = ov
  }
  return overlaps
}

export function spineGeometry(spine: readonly SpineItem[]): { geo: SpineGeometry[]; end: number } {
  const overlaps = clampedOverlaps(spine)
  const geo: SpineGeometry[] = []
  let start = 0
  let incoming = 0
  for (let i = 0; i < spine.length; i++) {
    const end = start + spanOf(spine[i]!)
    const overlapOut = overlaps[i]!
    const nextStart = end - overlapOut
    geo.push({ start, end, ownEnd: nextStart, overlapIn: incoming, overlapOut })
    incoming = overlapOut
    start = nextStart
  }
  return { geo, end: geo.length ? geo[geo.length - 1]!.end : 0 }
}

/** Index of the spine item owning `frame` ([start, next start)); frames past the end map to the last item. */
export function findOwnerIndex(geo: readonly SpineGeometry[], frame: number): number {
  let lo = 0
  let hi = geo.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (geo[mid]!.start <= frame) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

export interface SpineIndex {
  geo: SpineGeometry[]
  end: number
  indexById: Map<string, number>
}

export function indexSpine(spine: readonly SpineItem[]): SpineIndex {
  const { geo, end } = spineGeometry(spine)
  const indexById = new Map<string, number>()
  spine.forEach((item, i) => indexById.set(item.id, i))
  return { geo, end, indexById }
}

export interface Anchor {
  anchorId: string
  anchorSourceTime: Flicks
}

/** Absolute frame of an anchor point, or undefined when the anchor is not on the spine. */
export function anchoredFrame(
  spine: readonly SpineItem[],
  index: SpineIndex,
  anchor: Anchor,
  fps: number,
): number | undefined {
  const i = index.indexById.get(anchor.anchorId)
  if (i === undefined) return undefined
  return index.geo[i]!.start + localFrameAt(spine[i]!, anchor.anchorSourceTime, fps)
}

/** Anchor for an absolute frame: the owning spine item (the last one when past the end). */
export function anchorAt(
  spine: readonly SpineItem[],
  index: SpineIndex,
  frame: number,
  fps: number,
): Anchor | undefined {
  if (!spine.length) return undefined
  const f = Math.max(0, frame)
  const i = f >= index.end ? spine.length - 1 : Math.max(0, findOwnerIndex(index.geo, f))
  const owner = spine[i]!
  return { anchorId: owner.id, anchorSourceTime: sourceTimeAt(owner, f - index.geo[i]!.start, fps) }
}

// ---------------------------------------------------------------------------------------------------------------
// Full layout

/** Lane a connected clip prefers when none is given: audio-only media below the spine, everything else above. */
export function defaultLaneFor(clip: Clip): number {
  return clip.kind === 'media' && !clip.video && clip.audio ? -1 : 1
}

export function sanitizeLane(lane: number | undefined, clip: Clip): number {
  const l = lane === undefined || !Number.isFinite(lane) ? 0 : Math.round(lane)
  return l === 0 ? defaultLaneFor(clip) : l
}

export function layoutTimeline(doc: ProjectDoc): TimelineLayout {
  const fps = doc.settings.fps
  const index = indexSpine(doc.spine)
  const spineEnd = index.end
  const byId = new Map<string, LayoutEntry>()

  const spine: SpineLayoutItem[] = doc.spine.map((item, i) => {
    const entry: SpineLayoutItem = { type: 'spine', id: item.id, index: i, lane: 0, ...index.geo[i]!, item }
    byId.set(item.id, entry)
    return entry
  })

  const connected: ConnectedLayoutItem[] = doc.connected.map((c) => {
    const abs = anchoredFrame(doc.spine, index, c, fps)
    const start = abs ?? 0
    return {
      type: 'connected' as const,
      id: c.id,
      start,
      end: start + spanOf(c.clip),
      lane: 0,
      preferredLane: sanitizeLane(c.lane, c.clip),
      anchorId: c.anchorId,
      hanging: abs === undefined || start >= spineEnd,
      item: c,
    }
  })
  connected.sort((a, b) => a.start - b.start || compareIds(a.id, b.id))

  // Lane resolution: items arrive sorted by start, so a lane is free iff its last end ≤ this start.
  const laneEnds = new Map<number, number>()
  let minLane = 0
  let maxLane = 0
  for (const c of connected) {
    const step = c.preferredLane > 0 ? 1 : -1
    let lane = c.preferredLane
    while ((laneEnds.get(lane) ?? -Infinity) > c.start) lane += step
    laneEnds.set(lane, c.end)
    c.lane = lane
    minLane = Math.min(minLane, lane)
    maxLane = Math.max(maxLane, lane)
    byId.set(c.id, c)
  }

  const markers: MarkerLayoutItem[] = doc.markers.map((m) => {
    const abs = anchoredFrame(doc.spine, index, m, fps)
    const frame = abs ?? 0
    return {
      type: 'marker' as const,
      id: m.id,
      frame,
      kind: m.kind,
      name: m.name,
      done: m.done ?? false,
      anchorId: m.anchorId,
      hanging: abs === undefined || frame >= spineEnd,
      marker: m,
    }
  })
  markers.sort((a, b) => a.frame - b.frame || compareIds(a.id, b.id))
  for (const m of markers) byId.set(m.id, m)

  let extent = spineEnd
  for (const c of connected) extent = Math.max(extent, c.end)
  for (const m of markers) extent = Math.max(extent, m.frame + 1)

  return { fps, duration: spineEnd, extent, spine, connected, markers, lanes: { min: minLane, max: maxLane }, byId }
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Spine item owning `frame`, or undefined outside [0, duration). */
export function ownerAt(layout: TimelineLayout, frame: number): SpineLayoutItem | undefined {
  if (!(frame >= 0) || frame >= layout.duration) return undefined
  const i = findOwnerIndex(layout.spine, frame)
  return i < 0 ? undefined : layout.spine[i]
}

/**
 * Compositing order, bottom to top: negative lanes (lowest first), the spine (both sides of a transition,
 * outgoing first), then positive lanes ascending.
 */
export function compareComposite(a: ClipLayoutItem, b: ClipLayoutItem): number {
  if (a.lane !== b.lane) return a.lane - b.lane
  if (a.type === 'spine' && b.type === 'spine') return a.index - b.index
  return a.start - b.start || compareIds(a.id, b.id)
}

/** Every clip (spine and connected, gaps and disabled clips included) covering `frame`, in compositing order. */
export function clipsAt(layout: TimelineLayout, frame: number): ClipLayoutItem[] {
  const hits: ClipLayoutItem[] = []
  for (const s of layout.spine) {
    if (s.start > frame) break
    if (frame < s.end) hits.push(s)
  }
  for (const c of layout.connected) {
    if (c.start > frame) break
    if (frame < c.end) hits.push(c)
  }
  return hits.sort(compareComposite)
}
