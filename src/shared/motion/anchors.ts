import { flicksToSeconds } from '../time/flicks'
import type { TimelineLayout } from '../timeline/types'
import type { AlignedWord } from '../types/assets'
import { type Keyframe, type MotionClip, type MotionTrack, type MotionWordAnchor, activeTake } from '../types/project-doc'

/**
 * Keys timed to the voice-over. A track's `anchor` names words; when the clip plays (and in the inspector and on the
 * board) the track's keys are moved together so its first one lands where they are said — read from the voice clips'
 * word timings as they are now, so recording the voice-over again re-times the animation by itself.
 */

/** A dialogue clip with word timings, where it plays on the timeline. */
export interface VoiceTiming {
  clipId: string
  /** Timeline frames it plays over. */
  start: number
  end: number
  /** Source seconds at its first frame, and its speed. */
  sourceIn: number
  speed: number
  words: readonly AlignedWord[]
}

/** Every clip on the timeline whose sound has word timings (voice-overs, dialogue), in order. */
export function voiceTimings(layout: TimelineLayout, words: (assetId: string) => readonly AlignedWord[] | undefined): VoiceTiming[] {
  const out: VoiceTiming[] = []
  const add = (clip: TimelineLayout['spine'][number]['item'], start: number, end: number) => {
    if (clip.kind !== 'media' || !clip.enabled) return
    const take = activeTake(clip)
    const w = take?.assetId ? words(take.assetId) : undefined
    if (w?.length) out.push({ clipId: clip.id, start, end, sourceIn: flicksToSeconds(take!.sourceIn), speed: clip.speed || 1, words: w })
  }
  for (const s of layout.spine) add(s.item, s.start, s.end)
  for (const c of layout.connected) add(c.item.clip, c.start, c.end)
  return out.sort((a, b) => a.start - b.start)
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** Where the anchor's words are said: a timeline frame, or undefined when they aren't (in those voices). */
export function anchorFrame(anchor: MotionWordAnchor, voices: readonly VoiceTiming[], fps: number): number | undefined {
  const want = anchor.text.split(/\s+/).map(norm).filter(Boolean)
  if (!want.length) return undefined
  let left = Math.max(1, Math.round(anchor.nth ?? 1))
  for (const v of voices) {
    const spoken = v.words.map((w) => norm(w.text))
    for (let i = 0; i + want.length <= spoken.length; i++) {
      if (!want.every((t, k) => spoken[i + k] === t)) continue
      const at = v.start + Math.round(((v.words[i]!.start - v.sourceIn) / v.speed) * fps)
      // Words cut off by the clip's trims aren't heard.
      if (at < v.start || at >= v.end) continue
      if (--left === 0) return at
    }
  }
  return undefined
}

/** The first animation frame a track does something on (its keys, its route, its behaviours' start). */
export function firstKeyFrame(track: MotionTrack): number | undefined {
  const frames: number[] = []
  for (const k of ['opacity', 'transform', 'reveal', 'trim', 'stretch', 'color', 'blur'] as const) for (const key of track[k] ?? []) frames.push(key.frame)
  for (const key of track.follow?.progress ?? []) frames.push(key.frame)
  for (const b of track.behaviors ?? []) if (b.from !== undefined) frames.push(b.from)
  return frames.length ? Math.min(...frames) : undefined
}

const shiftKeys = <T>(keys: Keyframe<T>[] | undefined, by: number) => keys?.map((k) => ({ ...k, frame: k.frame + by }))

/** The track with every key (route, behaviour range and loop too) `by` frames later. */
export function shiftTrack(track: MotionTrack, by: number): MotionTrack {
  if (!by) return track
  const out: MotionTrack = { ...track }
  for (const k of ['opacity', 'transform', 'reveal', 'trim', 'stretch', 'color', 'blur'] as const) {
    const keys = shiftKeys<unknown>(track[k], by)
    if (keys) (out as Record<string, unknown>)[k] = keys
  }
  if (track.follow) out.follow = { ...track.follow, progress: shiftKeys(track.follow.progress, by)! }
  if (track.behaviors) out.behaviors = track.behaviors.map((b) => ({ ...b, ...(b.from !== undefined ? { from: b.from + by } : {}), ...(b.to !== undefined ? { to: b.to + by } : {}) }))
  if (track.loop) out.loop = { from: track.loop.from + by, to: track.loop.to + by }
  if (track.anchor?.at !== undefined) out.anchor = { ...track.anchor, at: track.anchor.at + by }
  return out
}

/**
 * How far each anchored track's keys move (frames): from its anchor frame (`at`, else its first key) as stored to
 * where its words are said, plus the anchor's offset. Tracks whose words aren't said stay as stored.
 */
export function anchorShifts(clip: MotionClip, start: number, voices: readonly VoiceTiming[], fps: number): Record<string, number> {
  const out: Record<string, number> = {}
  const playing = voices.filter((v) => v.end > start && v.start < start + clip.duration)
  for (const [id, track] of Object.entries(clip.tracks)) {
    const a = track.anchor
    if (!a) continue
    const first = a.at ?? firstKeyFrame(track)
    if (first === undefined) continue
    const pool = a.clipId ? voices.filter((v) => v.clipId === a.clipId) : playing
    const said = anchorFrame(a, pool, fps)
    if (said === undefined) continue
    // Timeline frame → animation frame of this clip.
    const shift = said - start + (clip.offset ?? 0) + Math.round(a.offset ?? 0) - first
    if (shift) out[id] = shift
  }
  return out
}

/** The clip as it plays: its anchored tracks moved onto their words (the same clip when nothing moves). */
export function anchoredClip(clip: MotionClip, shifts: Record<string, number>): MotionClip {
  const ids = Object.keys(shifts)
  if (!ids.length) return clip
  const tracks = { ...clip.tracks }
  for (const id of ids) if (tracks[id]) tracks[id] = shiftTrack(tracks[id]!, shifts[id]!)
  return { ...clip, tracks }
}

/** Tracks edited as they play, back to how they're stored (an anchored one moved back by its shift). */
export function unanchorTracks(tracks: MotionClip['tracks'], shifts: Record<string, number>): MotionClip['tracks'] {
  const out = { ...tracks }
  for (const [id, by] of Object.entries(shifts)) if (out[id]) out[id] = shiftTrack(out[id]!, -by)
  return out
}
