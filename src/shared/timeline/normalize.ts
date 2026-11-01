import type { Flicks } from '../time/flicks'
import type { GapClip, ProjectDoc, SpineItem } from '../types/project-doc'
import {
  anchoredFrame,
  clampedOverlaps,
  findOwnerIndex,
  indexSpine,
  localFrameAt,
  sanitizeLane,
  sourceTimeAt,
} from './layout'
import { MAX_SPEED, MIN_SPEED, collectIds, removeWhere } from './util'

interface AnchoredRef {
  id: string
  anchorId: string
  anchorSourceTime: Flicks
}

/**
 * Restores the document invariants after an op (runs inside the op's immer recipe):
 *  1. drops spine items shorter than a frame, merges adjacent gaps, keeps `transitionIn` only on the first item;
 *  2. clamps transitions (and fades) — a transition clamped below one frame is removed;
 *  3. re-anchors every connected item and marker to the spine item owning its absolute frame (computed through
 *     its current anchor, or taken from `prevAbs` when the anchor is gone), keeping that frame unchanged;
 *  4. gives a non-empty spine to docs that have connected items or markers;
 *  5. keeps media clips valid (active take in range; no takes → gap on the spine, removed when connected).
 * `newId` is used for the gap of step 4; without it a deterministic unused id is derived.
 */
export function normalize(draft: ProjectDoc, prevAbs: ReadonlyMap<string, number>, newId?: () => string): void {
  const fps = draft.settings.fps
  sanitizeNumbers(draft)

  // Target frames are measured before the spine cleanup, which is layout-preserving (clamped overlaps are what
  // the layout already uses, merged gaps keep their overlap, removed items span no frames).
  const index0 = indexSpine(draft.spine)
  const desired = new Map<string, number>()
  const measure = (t: AnchoredRef) => {
    const abs = anchoredFrame(draft.spine, index0, t, fps) ?? prevAbs.get(t.id) ?? 0
    desired.set(t.id, Math.max(0, Math.round(abs)))
  }
  draft.connected.forEach(measure)
  draft.markers.forEach(measure)
  // Overlays over the whole timeline start at its first frame.
  for (const c of draft.connected) if (c.clip.kind === 'motion' && c.clip.span === 'timeline') desired.set(c.id, 0)

  fixMediaClips(draft)
  cleanupSpine(draft.spine)

  if (!draft.spine.length && (draft.connected.length || draft.markers.length)) {
    let reach = 1
    for (const c of draft.connected) reach = Math.max(reach, desired.get(c.id)! + c.clip.duration)
    for (const m of draft.markers) reach = Math.max(reach, desired.get(m.id)! + 1)
    const gap: GapClip = { kind: 'gap', id: unusedId(draft, newId), duration: reach, enabled: true }
    draft.spine.push(gap)
  }

  const spine = draft.spine
  const index = indexSpine(spine)
  const reanchor = (t: AnchoredRef) => {
    const frame = desired.get(t.id)!
    const i = frame >= index.end ? spine.length - 1 : findOwnerIndex(index.geo, frame)
    const owner = spine[i]!
    const local = frame - index.geo[i]!.start
    if (t.anchorId === owner.id && localFrameAt(owner, t.anchorSourceTime, fps) === local) return
    t.anchorId = owner.id
    t.anchorSourceTime = sourceTimeAt(owner, local, fps)
  }
  draft.connected.forEach(reanchor)
  draft.markers.forEach(reanchor)

  for (const c of draft.connected) {
    const lane = sanitizeLane(c.lane, c.clip)
    if (lane !== c.lane) c.lane = lane
  }

  // …last as long as the storyline and sit above everything else connected.
  const top = Math.max(0, ...draft.connected.filter((c) => !(c.clip.kind === 'motion' && c.clip.span === 'timeline')).map((c) => c.lane))
  for (const c of draft.connected) {
    if (c.clip.kind !== 'motion' || c.clip.span !== 'timeline') continue
    const duration = Math.max(1, index.end)
    if (c.clip.duration !== duration) c.clip.duration = duration
    if (c.lane !== top + 1) c.lane = top + 1
  }
}

/** Integer durations and sane speeds (only ever changes corrupt input). */
function sanitizeNumbers(doc: ProjectDoc): void {
  const fix = (clip: SpineItem) => {
    const d = Number.isFinite(clip.duration) ? Math.round(clip.duration) : 0
    if (d !== clip.duration) clip.duration = d
    if (clip.kind === 'media' && !(clip.speed >= MIN_SPEED && clip.speed <= MAX_SPEED)) {
      clip.speed = Number.isFinite(clip.speed) && clip.speed > 0 ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, clip.speed)) : 1
    }
  }
  doc.spine.forEach(fix)
  for (const c of doc.connected) fix(c.clip)
}

function fixMediaClips(doc: ProjectDoc): void {
  const fixActive = (clip: SpineItem) => {
    if (clip.kind !== 'media' || !clip.takes.length) return
    const a = Number.isFinite(clip.active) ? Math.min(clip.takes.length - 1, Math.max(0, Math.round(clip.active))) : 0
    if (a !== clip.active) clip.active = a
  }
  doc.spine.forEach((clip, i) => {
    if (clip.kind === 'media' && !clip.takes.length) {
      const gap: GapClip = { kind: 'gap', id: clip.id, duration: clip.duration, enabled: clip.enabled }
      if (clip.name !== undefined) gap.name = clip.name
      if (clip.transitionIn) gap.transitionIn = { ...clip.transitionIn }
      if (clip.transitionOut) gap.transitionOut = { ...clip.transitionOut }
      doc.spine[i] = gap
    } else fixActive(clip)
  })
  removeWhere(
    doc.connected,
    (c) =>
      (c.clip.kind as string) === 'gap' || (c.clip.kind === 'media' && !c.clip.takes.length) || c.clip.duration < 1,
  )
  for (const c of doc.connected) {
    if (c.clip.id !== c.id) c.clip.id = c.id
    fixActive(c.clip)
  }
}

function cleanupSpine(spine: SpineItem[]): void {
  for (let i = 1; i < spine.length; i++) if (spine[i]!.transitionIn) delete spine[i]!.transitionIn
  writeTransitions(spine)
  // Items shorter than a frame span nothing and (after the clamp above) carry no overlaps.
  removeWhere(spine, (s) => !(s.duration >= 1))
  for (let i = 0; i < spine.length - 1; ) {
    const a = spine[i]!
    const b = spine[i + 1]!
    if (a.kind !== 'gap' || b.kind !== 'gap') {
      i++
      continue
    }
    // Layout-preserving merge: the overlap between the two gaps is folded into the merged duration.
    a.duration += b.duration - (a.transitionOut?.duration ?? 0)
    if (b.transitionOut) a.transitionOut = { ...b.transitionOut }
    else delete a.transitionOut
    spine.splice(i + 1, 1)
  }
  writeTransitions(spine)
}

function writeTransitions(spine: SpineItem[]): void {
  const overlaps = clampedOverlaps(spine)
  spine.forEach((item, i) => {
    if (i === 0 && item.transitionIn) clampFade(item, 'transitionIn')
    if (!item.transitionOut) return
    if (i === spine.length - 1) {
      clampFade(item, 'transitionOut')
      return
    }
    const ov = overlaps[i]!
    if (ov < 1) delete item.transitionOut
    else if (item.transitionOut.duration !== ov) item.transitionOut.duration = ov
  })
}

/** Fades (fade-in on the first item, fade-out on the last) must fit in the item. */
function clampFade(item: SpineItem, key: 'transitionIn' | 'transitionOut'): void {
  const t = item[key]!
  const d = Math.min(Math.round(t.duration), item.duration)
  if (!(d >= 1)) delete item[key]
  else if (t.duration !== d) t.duration = d
}

function unusedId(doc: ProjectDoc, newId: (() => string) | undefined): string {
  const used = collectIds(doc)
  if (newId) {
    for (let tries = 0; tries < 100; tries++) {
      const id = newId()
      if (!used.has(id)) return id
    }
  }
  let n = 1
  while (used.has(`gap-${n}`)) n++
  return `gap-${n}`
}
