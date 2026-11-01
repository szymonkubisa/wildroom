import type { TimelineLayout } from '@shared/timeline'
import type { AssetDTO } from '@shared/types/assets'
import type { Scene } from '@/engine/scene'

/** A caption line on the timeline, in project frames [start, end). */
export interface CaptionCue {
  start: number
  end: number
  text: string
}

export interface CaptionOptions {
  maxChars: number
  maxSeconds: number
  /** A pause longer than this starts a new caption. */
  gapSeconds: number
  minSeconds: number
}

export const DEFAULT_CAPTION_OPTIONS: CaptionOptions = { maxChars: 42, maxSeconds: 4, gapSeconds: 0.45, minSeconds: 0.8 }

interface TimedWord {
  text: string
  start: number // seconds on the timeline
  end: number
}

/**
 * Builds caption cues from the word timings of dialogue clips (ElevenLabs TTS/dialogue alignment), following
 * each clip's trim, slip and speed, so the captions match what is actually heard.
 */
export function captionCuesFromDialogue(
  scene: Scene,
  getAsset: (id: string) => AssetDTO | undefined,
  options: Partial<CaptionOptions> = {},
): CaptionCue[] {
  const opts = { ...DEFAULT_CAPTION_OPTIONS, ...options }
  const fps = scene.fps
  const words: TimedWord[] = []
  for (const seg of scene.audio) {
    if (!seg.audio.enabled) continue
    const alignment = getAsset(seg.assetId)?.alignment
    if (!alignment?.words.length) continue
    // Dialogue clips, plus any clip whose speech was transcribed (e.g. a video's own sound).
    const transcribed = /transcri/.test(alignment.source ?? '')
    if (!transcribed && (seg.role.split('.')[0] ?? seg.role) !== 'dialogue') continue
    const segStart = seg.start / fps
    const segEnd = seg.end / fps
    for (const w of alignment.words) {
      const start = segStart + (w.start - seg.sourceStart) / seg.speed
      const end = segStart + (w.end - seg.sourceStart) / seg.speed
      if (end <= segStart || start >= segEnd || !w.text.trim()) continue
      words.push({ text: w.text.trim(), start: Math.max(start, segStart), end: Math.min(end, segEnd) })
    }
  }
  words.sort((a, b) => a.start - b.start)

  const cues: { start: number; end: number; words: string[] }[] = []
  for (const w of words) {
    const cue = cues.at(-1)
    const text = cue ? [...cue.words, w.text].join(' ') : w.text
    const lastWord = cue?.words.at(-1) ?? ''
    const sentenceEnd = /[.?!…]["”']?$/.test(lastWord) && (cue?.words.join(' ').length ?? 0) > 12
    const split =
      !cue ||
      w.start - cue.end > opts.gapSeconds ||
      text.length > opts.maxChars ||
      w.end - cue.start > opts.maxSeconds ||
      sentenceEnd
    if (split) cues.push({ start: w.start, end: w.end, words: [w.text] })
    else {
      cue.words.push(w.text)
      cue.end = w.end
    }
  }

  return cues.map((c, i) => {
    const next = cues[i + 1]
    let end = Math.max(c.end + 0.15, c.start + opts.minSeconds)
    if (next) end = Math.min(end, next.start)
    return { start: Math.round(c.start * fps), end: Math.max(Math.round(c.start * fps) + 1, Math.round(end * fps)), text: c.words.join(' ') }
  })
}

/** Caption title clips currently on the timeline (so manual edits are respected when exporting SRT). */
export function captionCuesFromTimeline(layout: TimelineLayout): CaptionCue[] {
  return layout.connected
    .filter((c) => !c.hanging && c.item.clip.kind === 'title' && c.item.clip.template === 'caption' && c.item.clip.enabled)
    .map((c) => ({ start: c.start, end: c.end, text: c.item.clip.kind === 'title' ? c.item.clip.text : '' }))
    .filter((c) => c.text.trim())
    .sort((a, b) => a.start - b.start)
}

/** Cues cut to an exported range [start, end): one running into it starts with it, one that's left empty goes. */
export function cuesInRange(cues: CaptionCue[], start: number, end: number): CaptionCue[] {
  return cues
    .map((c) => ({ ...c, start: Math.max(c.start, start), end: Math.min(c.end, end) }))
    .filter((c) => c.end > c.start)
}

function stamp(frame: number, fps: number, separator: ',' | '.'): string {
  const ms = Math.round((frame / fps) * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor(ms / 60_000) % 60
  const s = Math.floor(ms / 1000) % 60
  const rest = ms % 1000
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(rest, 3)}`
}

export function cuesToSrt(cues: CaptionCue[], fps: number, offsetFrames = 0): string {
  return cues
    .map((c, i) => `${i + 1}\n${stamp(c.start - offsetFrames, fps, ',')} --> ${stamp(c.end - offsetFrames, fps, ',')}\n${c.text}\n`)
    .join('\n')
}

export function cuesToVtt(cues: CaptionCue[], fps: number, offsetFrames = 0): string {
  return `WEBVTT\n\n${cues.map((c) => `${stamp(c.start - offsetFrames, fps, '.')} --> ${stamp(c.end - offsetFrames, fps, '.')}\n${c.text}\n`).join('\n')}`
}

export function downloadText(filename: string, text: string, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
