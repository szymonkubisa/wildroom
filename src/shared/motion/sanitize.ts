import { sortKeys } from '../timeline/keyframes'
import { firstKeyFrame } from './anchors'
import { clipsInAllTimelines } from '../timeline/timelines'
import { sanitizeCanvas } from '../types/canvas'
import type {
  KeyEase,
  Keyframe,
  MotionBehavior,
  MotionBehaviorKind,
  MotionCamera,
  MotionClip,
  MotionItemTransform,
  MotionTrack,
  MotionWordAnchor,
  ProjectDoc,
  RevealMode,
} from '../types/project-doc'

const EASES = new Set(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold', 'back', 'elastic', 'bounce'])
const REVEALS = new Set<RevealMode>([
  'typewriter',
  'words',
  'wipe-left',
  'wipe-up',
  'draw',
  'words-rise',
  'words-pop',
  'words-blur',
  'letters-rise',
  'letters-fade',
  'highlight-sweep',
  'roll',
])
const BEHAVIORS = new Set<MotionBehaviorKind>(['shake', 'wiggle', 'float', 'spin', 'orbit', 'pulse'])
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function sanitizeEase(raw: unknown): KeyEase | undefined {
  if (typeof raw === 'string') return EASES.has(raw) ? (raw as KeyEase) : undefined
  const p = (raw as { type?: unknown; p?: unknown } | null)?.p
  if ((raw as { type?: unknown } | null)?.type !== 'bezier' || !Array.isArray(p) || p.length !== 4 || !p.every(finite)) return undefined
  const [x1, y1, x2, y2] = p as [number, number, number, number]
  return { type: 'bezier', p: [clamp(x1, 0, 1), y1, clamp(x2, 0, 1), y2] }
}

/** Keys with a whole frame and a usable value (`value` returns undefined to drop one), sorted, one per frame. */
function sanitizeKeys<T>(raw: unknown, value: (v: unknown) => T | undefined): Keyframe<T>[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const byFrame = new Map<number, Keyframe<T>>()
  for (const k of raw) {
    if (!k || typeof k !== 'object' || !finite(k.frame)) continue
    const v = value(k.value)
    if (v === undefined) continue
    const key: Keyframe<T> = { frame: Math.round(k.frame), value: v }
    const ease = sanitizeEase(k.ease)
    if (ease) key.ease = ease
    byFrame.set(key.frame, key)
  }
  return byFrame.size ? sortKeys([...byFrame.values()]) : undefined
}

const unit = (v: unknown) => (finite(v) ? clamp(v, 0, 1) : undefined)

function itemTransform(v: unknown): MotionItemTransform | undefined {
  const o = v as Partial<MotionItemTransform> | null
  if (!o || typeof o !== 'object') return undefined
  return { x: finite(o.x) ? o.x : 0, y: finite(o.y) ? o.y : 0, scale: finite(o.scale) ? Math.max(0, o.scale) : 1, rotation: finite(o.rotation) ? o.rotation : 0 }
}

function camera(v: unknown): MotionCamera | undefined {
  const o = v as Partial<MotionCamera> | null
  if (!o || typeof o !== 'object') return undefined
  return { x: finite(o.x) ? o.x : 0, y: finite(o.y) ? o.y : 0, zoom: finite(o.zoom) ? clamp(o.zoom, 0.05, 20) : 1 }
}

function sanitizeTrack(raw: unknown): MotionTrack | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: MotionTrack = {}
  const opacity = sanitizeKeys(r.opacity, unit)
  const transform = sanitizeKeys(r.transform, itemTransform)
  const reveal = sanitizeKeys(r.reveal, unit)
  const trim = sanitizeKeys(r.trim, (v) => {
    const o = v as { start?: unknown; end?: unknown } | null
    return o && typeof o === 'object' ? { start: unit(o.start) ?? 0, end: unit(o.end) ?? 1 } : undefined
  })
  if (trim) out.trim = trim
  const stretch = sanitizeKeys(r.stretch, (v) => {
    const o = v as { x?: unknown; y?: unknown } | null
    return o && typeof o === 'object' ? { x: finite(o.x) ? clamp(o.x, -20, 20) : 1, y: finite(o.y) ? clamp(o.y, -20, 20) : 1 } : undefined
  })
  if (stretch) out.stretch = stretch
  const color = sanitizeKeys(r.color, (v) => (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) ? v : undefined))
  if (color) out.color = color
  const blur = sanitizeKeys(r.blur, (v) => (finite(v) ? clamp(v, 0, 500) : undefined))
  if (blur) out.blur = blur
  const behaviors = Array.isArray(r.behaviors)
    ? (r.behaviors as Record<string, unknown>[]).flatMap((b): MotionBehavior[] => {
        if (!b || !BEHAVIORS.has(b.kind as MotionBehaviorKind) || !finite(b.amount) || !finite(b.period)) return []
        const out: MotionBehavior = { kind: b.kind as MotionBehaviorKind, amount: clamp(b.amount, -10000, 10000), period: clamp(Math.round(b.period), 1, 100000) }
        if (finite(b.seed)) out.seed = Math.round(b.seed)
        if (finite(b.from)) out.from = Math.round(b.from)
        if (finite(b.to)) out.to = Math.round(b.to)
        return [out]
      })
    : []
  if (behaviors.length) out.behaviors = behaviors.slice(0, 16)
  const loop = r.loop as { from?: unknown; to?: unknown } | undefined
  if (loop && finite(loop.from) && finite(loop.to) && loop.to > loop.from) out.loop = { from: Math.round(loop.from), to: Math.round(loop.to) }
  if (r.progress === 'reveal' || r.progress === 'trim') out.progress = r.progress
  const an = r.anchor as Partial<MotionWordAnchor> | undefined
  if (an && typeof an.text === 'string' && an.text.trim()) {
    const anchor: MotionWordAnchor = { text: an.text.trim().slice(0, 200) }
    if (finite(an.nth) && Math.round(an.nth) > 1) anchor.nth = Math.round(an.nth)
    if (typeof an.clipId === 'string' && an.clipId) anchor.clipId = an.clipId
    if (finite(an.offset) && Math.round(an.offset)) anchor.offset = Math.round(an.offset)
    if (finite(an.at)) anchor.at = Math.round(an.at)
    out.anchor = anchor
  }
  if (finite(r.motionBlur) && r.motionBlur > 0) out.motionBlur = clamp(r.motionBlur, 0, 2)
  const f = r.follow as { pathId?: unknown; progress?: unknown; orient?: unknown } | undefined
  const progress = f && typeof f === 'object' && typeof f.pathId === 'string' ? sanitizeKeys(f.progress, unit) : undefined
  if (progress) out.follow = { pathId: f!.pathId as string, progress, ...(f!.orient === true ? { orient: true } : {}) }
  if (opacity) out.opacity = opacity
  if (transform) out.transform = transform
  if (reveal) out.reveal = reveal
  if (REVEALS.has(r.revealMode as RevealMode)) out.revealMode = r.revealMode as RevealMode
  if (finite(r.rollFrom) && r.rollFrom) out.rollFrom = r.rollFrom
  // An anchor saved before `at` existed is pinned to its first key now, so keys added before it later stay before it.
  if (out.anchor && out.anchor.at === undefined) {
    const first = firstKeyFrame(out)
    if (first !== undefined) out.anchor.at = first
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Repairs a motion clip read from disk (hand-edited or written by another version): bad keys are dropped, values
 * clamped, the detached snapshot cleaned like a board. The rest of the clip (duration, video…) is left as it is.
 */
export function sanitizeMotionClip(clip: MotionClip): MotionClip {
  const out: MotionClip = { ...clip, boardId: typeof clip.boardId === 'string' ? clip.boardId : '', frameId: typeof clip.frameId === 'string' ? clip.frameId : '', tracks: {} }
  if (clip.tracks && typeof clip.tracks === 'object') {
    for (const [id, raw] of Object.entries(clip.tracks)) {
      const track = sanitizeTrack(raw)
      if (track) out.tracks[id] = track
    }
  }
  const cam = sanitizeKeys(clip.camera, camera)
  if (cam) out.camera = cam
  else delete out.camera
  if (finite(clip.offset) && Math.round(clip.offset)) out.offset = Math.round(clip.offset)
  else delete out.offset
  if (clip.span !== 'timeline') delete out.span
  if (clip.detached !== undefined) {
    const items = Array.isArray(clip.detached) ? sanitizeCanvas({ boards: [{ id: 'detached', name: '', items: clip.detached }] })?.boards[0]?.items : undefined
    if (items?.[0]?.kind === 'frame') out.detached = items
    else delete out.detached
  }
  return out
}

/** Repairs every motion clip of every timeline in place (a document just read from disk, not yet in the store). */
export function sanitizeMotionClips(doc: ProjectDoc): void {
  for (const clip of clipsInAllTimelines(doc)) {
    if (clip.kind !== 'motion') continue
    const fixed = sanitizeMotionClip(clip)
    for (const k of Object.keys(clip)) delete (clip as unknown as Record<string, unknown>)[k]
    Object.assign(clip, fixed)
  }
}
