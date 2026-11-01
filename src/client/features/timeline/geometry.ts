import type { TimelineLayout } from '@shared/timeline'

export const RULER_HEIGHT = 26
export const PAD_X = 16
export const EDGE_HIT = 6

export type RowKind = 'video' | 'spine' | 'audio'

export interface Row {
  lane: number
  kind: RowKind
  top: number
  height: number
}

const HEIGHTS: Record<RowKind, number> = { video: 52, spine: 68, audio: 40 }

/** The lanes the layout uses, with one empty lane kept on each side as a drop target. */
export function laneSpan(layout: TimelineLayout): { min: number; max: number } {
  let maxLane = 0
  let minLane = 0
  for (const c of layout.connected) {
    maxLane = Math.max(maxLane, c.lane)
    minLane = Math.min(minLane, c.lane)
  }
  return { min: minLane - 1, max: maxLane + 1 }
}

/**
 * Rows top → bottom: connected video/title lanes (highest first), the primary storyline, then connected
 * audio lanes. One empty lane is kept on each side as a drop target. `frozen`: the lanes to show while a clip is
 * dragged (laneSpan of the timeline before the drag) — no new empty lane appears under the pointer, so the rows
 * don't shift as the clip changes lane.
 */
export function buildRows(layout: TimelineLayout, frozen?: { min: number; max: number }): { rows: Row[]; height: number } {
  const span = laneSpan(layout)
  const maxLane = frozen ? Math.max(frozen.max, span.max - 1) : span.max
  const minLane = frozen ? Math.min(frozen.min, span.min + 1) : span.min
  const lanes: number[] = []
  for (let l = maxLane; l >= 1; l--) lanes.push(l)
  lanes.push(0)
  for (let l = -1; l >= minLane; l--) lanes.push(l)
  let top = 6
  const rows = lanes.map((lane) => {
    const kind: RowKind = lane > 0 ? 'video' : lane === 0 ? 'spine' : 'audio'
    const row = { lane, kind, top, height: HEIGHTS[kind] }
    top += row.height + 2
    return row
  })
  return { rows, height: top + 24 }
}

export function frameToX(frame: number, pxPerFrame: number): number {
  return PAD_X + frame * pxPerFrame
}

export function xToFrame(x: number, pxPerFrame: number): number {
  return Math.max(0, Math.round((x - PAD_X) / pxPerFrame))
}

export function rowAtY(rows: Row[], y: number): Row | undefined {
  return rows.find((r) => y >= r.top - 1 && y < r.top + r.height + 1)
}

/** Ruler tick spacing: major step (frames) so that majors are ≥ ~90 px apart. */
export function tickSteps(pxPerFrame: number, fps: number): { major: number; minor: number } {
  const candidates = [1, 2, 5, 10, fps / 2, fps, fps * 2, fps * 5, fps * 10, fps * 30, fps * 60, fps * 120, fps * 300, fps * 600]
    .map((v) => Math.max(1, Math.round(v)))
    .sort((a, b) => a - b)
  const major = candidates.find((c) => c * pxPerFrame >= 90) ?? candidates[candidates.length - 1]!
  // Minor ticks must divide the major step exactly and stay at least 8 px apart.
  let minor = major
  for (const div of [5, 4, 2]) {
    if (major % div === 0 && (major / div) * pxPerFrame >= 8) {
      minor = major / div
      break
    }
  }
  return { major, minor }
}

export const MIN_ZOOM = 0.03
export const MAX_ZOOM = 48

// ---- audio band (volume line, fades, waveform) --------------------------------------------------------

export const CLIP_LABEL_HEIGHT = 16

/**
 * Vertical band of a clip that shows its audio (waveform + volume line), relative to the clip's top.
 * Audio-only clips use everything under the label; video clips with sound get a strip at the bottom.
 */
export function audioBand(clipHeight: number, audioOnly: boolean): { top: number; height: number } {
  if (audioOnly) return { top: CLIP_LABEL_HEIGHT, height: Math.max(8, clipHeight - CLIP_LABEL_HEIGHT - 2) }
  const height = Math.max(16, Math.round((clipHeight - CLIP_LABEL_HEIGHT) * 0.42))
  return { top: clipHeight - height, height }
}

export const MIN_DB = -60
export const MAX_DB = 12

/** 0..1 position of a gain value inside the band (bottom = −∞, 0 dB sits about a fifth from the top). */
export function dbToPos(db: number): number {
  const d = Math.max(MIN_DB, Math.min(MAX_DB, db))
  return d >= -30 ? 0.25 + (0.75 * (d + 30)) / (MAX_DB + 30) : (0.25 * (d - MIN_DB)) / 30
}

export function posToDb(pos: number): number {
  const p = Math.max(0, Math.min(1, pos))
  const db = p >= 0.25 ? -30 + ((p - 0.25) / 0.75) * (MAX_DB + 30) : MIN_DB + (p / 0.25) * 30
  return Math.round(db * 2) / 2
}
