/**
 * Spoken-text helpers shared by the storyboard's dialogue-length check (client), temp voices (macOS `say`) and the
 * Director's dialogue trimmer (server): one word count and one pace, so "this line is too long" means the same on both.
 */

/** Natural speaking pace (Polish and English) used for "does this line fit the shot" budgets. */
export const WORDS_PER_SECOND = 2.5

const LEADING_TAGS = /^\s*(?:\[[^\][\n]{1,60}\]\s*)+/
const ANY_TAG = /\[[^\][\n]{1,60}\]/g
/** `say` reads `[[slnc 500]]`-style embedded commands: never let user text drive the synthesizer. */
const SAY_COMMAND = /\[\[[^\]\n]*\]\]/g

/** The ElevenLabs audio tags a line starts with, e.g. "[whispering]" or "[sighs] [softly]" ('' when none). */
export function leadingTags(text: string): string {
  return LEADING_TAGS.exec(text)?.[0].trim().replace(/\]\s+\[/g, '] [') ?? ''
}

/** The line without its leading audio tags. */
export function withoutLeadingTags(text: string): string {
  return text.replace(LEADING_TAGS, '').trim()
}

/** Text for a plain TTS voice: audio tags and acting cues ([whispering], [laughs]) and embedded commands removed, single-spaced. */
export function speakableText(text: string): string {
  return text.replace(SAY_COMMAND, ' ').replace(ANY_TAG, ' ').replace(/\s+/g, ' ').trim()
}

/** Spoken words in a line (audio tags and lone punctuation like "—" don't count). */
export function countWords(text: string): number {
  const plain = speakableText(text)
  return plain ? plain.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0
}

/**
 * How a shot's lines sit in it — the way the voice track and Assemble lay them under the picture: the first word a
 * moment after the shot starts, a short gap between two lines, room after the last before the cut.
 */
export const LINE_LEAD = 0.3
export const LINE_GAP = 0.25
export const LINE_TAIL = 0.6

/** Seconds a shot's lines take, laid out so: the lead, the words at WORDS_PER_SECOND, the gaps, the tail (0 without any). */
export function linesSeconds(texts: readonly string[]): number {
  const words = texts.map(countWords).filter((n) => n > 0)
  if (!words.length) return 0
  return LINE_LEAD + words.reduce((a, b) => a + b, 0) / WORDS_PER_SECOND + LINE_GAP * (words.length - 1) + LINE_TAIL
}

/**
 * The whole seconds a shot needs for its lines: what the Director makes a speaking shot, and below which the
 * storyboard calls its lines tight. One rule for both — the Director's "half a second, then 2.5 words a second" made
 * two lines of 9 words 8 s, which the storyboard's own estimate called tight (it wanted 10) and the voice track
 * outgrew (9).
 */
export function secondsForLines(texts: readonly string[]): number {
  const seconds = linesSeconds(texts)
  return seconds ? Math.ceil(seconds - 1e-9) : 0
}
