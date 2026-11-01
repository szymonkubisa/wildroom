import type { Clip, SpineItem } from '../types/project-doc'
import { indexSpine, layoutTimeline } from './layout'
import { bladeClip, bladeSpineAt, cutRangeEnd, insertItems, placeConnected, removeItems, transitionAt } from './primitives'
import type { TimelineLayout, TimelineRecipe } from './types'
import { type ConnectableClip, deepClone, sanitizeFrame, withFreshIds } from './util'

/** A copied clip: `offset` frames after the earliest copied clip, `lane` 0 = primary storyline. */
export interface ClipboardEntry {
  clip: Clip
  offset: number
  lane: number
}

/** Snapshot of the selected clips for copy/paste (deep copies, safe to keep after the doc changes). */
export function copyEntries(layout: TimelineLayout, ids: readonly string[]): ClipboardEntry[] {
  const wanted = new Set(ids)
  const picked = [
    ...layout.spine.filter((s) => wanted.has(s.id)).map((s) => ({ clip: s.item as Clip, start: s.start, lane: 0 })),
    ...layout.connected.filter((c) => wanted.has(c.id) && !c.hanging).map((c) => ({ clip: c.item.clip as Clip, start: c.start, lane: c.lane })),
  ]
  if (!picked.length) return []
  const origin = Math.min(...picked.map((p) => p.start))
  return picked
    .sort((a, b) => a.start - b.start)
    .map((p) => {
      const clip = deepClone(p.clip)
      delete clip.transitionIn
      return { clip, offset: p.start - origin, lane: p.lane }
    })
}

/**
 * Pastes at `frame`: storyline clips are inserted there as one block (rippling what follows), connected clips
 * keep their offset and lane. Every pasted clip gets fresh ids.
 */
export const pasteClips =
  (frame: number, entries: readonly ClipboardEntry[]): TimelineRecipe =>
  (d, ctx) => {
    if (!entries.length) return
    const at = Number.isFinite(frame) ? sanitizeFrame(frame) : indexSpine(d.spine).end
    const spine = entries.filter((e) => e.lane === 0).map((e) => withFreshIds(deepClone(e.clip), ctx.newId) as SpineItem)
    if (spine.length) insertItems(d, { frame: at, items: spine }, ctx, { autoFps: false })
    for (const e of entries) {
      if (e.lane === 0 || e.clip.kind === 'gap') continue
      const clip = withFreshIds(deepClone(e.clip), ctx.newId) as ConnectableClip
      placeConnected(d, clip, at + e.offset, e.lane, ctx)
    }
  }

/**
 * Removes the timeline range [start, end) and closes the hole (text-based editing, filler removal).
 * The storyline is cut at both edges; a range starting inside a transition starts after it (no cut there could hold
 * the transition, and the range deletes nothing outside it). Connected clips that start inside the range lose the part
 * inside it; connected clips in `cutIds` that span the range are cut too; any other connected clip is left alone.
 */
export const rippleDeleteRange =
  (start: number, end: number, cutIds: readonly string[] = []): TimelineRecipe =>
  (d, ctx) => {
    const from = Math.max(0, Math.round(start))
    const s = transitionAt(indexSpine(d.spine), from)?.after ?? from
    const e = Math.round(end)
    if (e <= s) return
    const cut = new Set(cutIds)
    bladeSpineAt(d, s, ctx)
    for (const c of layoutTimeline(d).connected) {
      if (c.hanging || c.end <= s || c.start >= e) continue
      if (c.start >= s) {
        bladeClip(d, { id: c.id, frame: e }, ctx)
      } else if (cut.has(c.id)) {
        const right = bladeClip(d, { id: c.id, frame: s }, ctx)
        if (right) bladeClip(d, { id: right, frame: e }, ctx)
      }
    }
    const layout = layoutTimeline(d)
    const ids = [
      ...layout.spine.filter((x) => x.start >= s && x.start < e).map((x) => x.id),
      ...layout.connected.filter((x) => !x.hanging && x.start >= s && x.start < e).map((x) => x.id),
    ]
    // The far edge is cut once the range is measured: the piece before it keeps its id and goes with the range.
    cutRangeEnd(d, e, ctx)
    if (ids.length) removeItems(d, { ids, mode: 'ripple' }, ctx)
  }

/** Swaps a gap on the storyline for `clip`, which takes the gap's exact length and its transitions. */
export const replaceGap =
  (gapId: string, clip: SpineItem): TimelineRecipe =>
  (d, ctx) => {
    const i = d.spine.findIndex((x) => x.id === gapId)
    const gap = d.spine[i]
    if (!gap || gap.kind !== 'gap') return
    const next = withFreshIds(deepClone(clip), ctx.newId)
    next.duration = gap.duration
    // Replace with gap kept the clip's transitions on the gap so nothing moved; Fill gap dropping them slid
    // everything after a dissolve by its length.
    delete next.transitionIn
    delete next.transitionOut
    if (gap.transitionIn) next.transitionIn = { ...gap.transitionIn }
    if (gap.transitionOut) next.transitionOut = { ...gap.transitionOut }
    d.spine[i] = next
  }
