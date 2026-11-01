import type { TimelineLayout } from './types'

export interface SnapPointOptions {
  playhead?: number
  /** Ids (clips or markers) whose own edges must not attract, e.g. the items being dragged. */
  exclude?: ReadonlySet<string>
  /** Additional frames that attract (e.g. detected music beats). */
  extra?: readonly number[]
}

/** Sorted, unique frames worth snapping to: clip starts/ends, marker frames and the playhead. */
export function collectSnapPoints(layout: TimelineLayout, opts: SnapPointOptions = {}): number[] {
  const exclude = opts.exclude
  const points = new Set<number>()
  for (const s of layout.spine) {
    if (exclude?.has(s.id)) continue
    points.add(s.start)
    points.add(s.end)
  }
  for (const c of layout.connected) {
    if (exclude?.has(c.id)) continue
    points.add(c.start)
    points.add(c.end)
  }
  for (const m of layout.markers) if (!exclude?.has(m.id)) points.add(m.frame)
  for (const f of opts.extra ?? []) points.add(Math.round(f))
  if (opts.playhead !== undefined && Number.isFinite(opts.playhead)) points.add(Math.round(opts.playhead))
  return [...points].sort((a, b) => a - b)
}

export interface SnapResult {
  frame: number
  snapped: boolean
  target?: number
}

/** Snaps to the nearest point within `thresholdFrames` (ties go to the earlier point). */
export function snapFrame(frame: number, points: readonly number[], thresholdFrames: number): SnapResult {
  let lo = 0
  let hi = points.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (points[mid]! < frame) lo = mid + 1
    else hi = mid
  }
  // points[lo] is the first point ≥ frame; the nearest is it or its predecessor.
  let best: number | undefined
  for (const p of [points[lo - 1], points[lo]]) {
    if (p === undefined || Math.abs(p - frame) > thresholdFrames) continue
    if (best === undefined || Math.abs(p - frame) < Math.abs(best - frame)) best = p
  }
  return best === undefined ? { frame, snapped: false } : { frame: best, snapped: true, target: best }
}
