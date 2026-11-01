import type { AssetDTO } from '@shared/types/assets'
import type { Scene } from '@/engine/scene'

/** A spoken word placed on the timeline (frames, [start, end)). */
export interface TimelineWord {
  text: string
  start: number
  end: number
  clipId: string
  speaker?: string
}

const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'hmm', 'mm', 'mhm', 'eh', 'yyy', 'eee', 'yyyy'])

export function isFiller(text: string): boolean {
  return FILLERS.has(text.toLowerCase().replace(/[^a-z]/g, ''))
}

/** Words heard on the timeline, from every enabled audio segment whose media has word timings. */
export function timelineWords(scene: Scene, getAsset: (id: string) => AssetDTO | undefined): TimelineWord[] {
  const out: TimelineWord[] = []
  for (const seg of scene.audio) {
    if (!seg.audio.enabled) continue
    const words = getAsset(seg.assetId)?.alignment?.words
    if (!words?.length) continue
    for (const w of words) {
      const start = seg.start + ((w.start - seg.sourceStart) / seg.speed) * scene.fps
      const end = seg.start + ((w.end - seg.sourceStart) / seg.speed) * scene.fps
      if (end <= seg.start || start >= seg.end || !w.text.trim()) continue
      const s = Math.max(seg.start, Math.round(start))
      out.push({
        text: w.text.trim(),
        start: s,
        end: Math.min(seg.end, Math.max(s + 1, Math.round(end))),
        clipId: seg.clipId,
        speaker: w.voiceId,
      })
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end)
}

export interface Paragraph {
  speaker?: string
  words: { word: TimelineWord; index: number }[]
}

/** Groups words into paragraphs at long pauses or speaker changes. */
export function paragraphs(words: TimelineWord[], fps: number, pauseSeconds = 1.2): Paragraph[] {
  const out: Paragraph[] = []
  words.forEach((word, index) => {
    const last = out.at(-1)
    const prev = words[index - 1]
    if (!last || !prev || word.start - prev.end > pauseSeconds * fps || word.speaker !== prev.speaker) out.push({ speaker: word.speaker, words: [{ word, index }] })
    else last.words.push({ word, index })
  })
  return out
}

export interface CutRange {
  start: number
  end: number
  clipIds: string[]
}

/**
 * Timeline ranges to remove for the selected words: from each word's start to the next kept word's start, so the
 * pause after a removed word goes too — but never more than `maxTrail` frames past the word, so a long silence or
 * a silent shot after it is kept. Merged, latest first — ready to ripple-delete one by one.
 */
export function cutRanges(words: TimelineWord[], remove: ReadonlySet<number>, maxTrail = 8): CutRange[] {
  const ranges: { start: number; end: number; clipIds: Set<string> }[] = []
  words.forEach((w, i) => {
    if (!remove.has(i)) return
    let next: TimelineWord | undefined
    for (let k = i + 1; k < words.length; k++) {
      if (!remove.has(k)) {
        next = words[k]
        break
      }
    }
    const end = next ? Math.max(w.end, Math.min(next.start, w.end + maxTrail)) : w.end
    const last = ranges.at(-1)
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, end)
      last.clipIds.add(w.clipId)
    } else ranges.push({ start: w.start, end, clipIds: new Set([w.clipId]) })
  })
  return ranges.map((r) => ({ start: r.start, end: r.end, clipIds: [...r.clipIds] })).reverse()
}

/** Pauses between consecutive words longer than `maxSeconds`, shortened to `keepSeconds` (latest first). */
export function pauseRanges(words: TimelineWord[], fps: number, maxSeconds = 1, keepSeconds = 0.35): CutRange[] {
  const out: CutRange[] = []
  const keep = Math.round(keepSeconds * fps)
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1]!
    const b = words[i]!
    if (b.start - a.end <= maxSeconds * fps) continue
    out.push({ start: a.end + Math.floor(keep / 2), end: b.start - Math.ceil(keep / 2), clipIds: [a.clipId, b.clipId] })
  }
  return out.reverse()
}
