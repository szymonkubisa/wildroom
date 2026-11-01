/**
 * Multi-shot prompts: a friendly syntax users type in the prompt box, and Kling's native storyboard syntax.
 *
 * Friendly (any mix, one shot per line):
 *   Shot 1 (3s): wide shot of the harbour at dawn
 *   Shot 2: close-up of the keeper's hands            ← no duration: shares the time that is left
 *   [2s] the lamp flickers on
 *   shot 4, 3, native Kling syntax works too;
 *
 * Kling native (docs, 2026-09-28 — https://kling.ai/document-api/api/video/3-0-omni/text-to-video and
 * …/3-0-omni/video-omni): `"shot n, m, words; shot n, m, words;"` where n = shot number (1–6), m = the shot's
 * duration in seconds (each ≥ 1 s, all shots must add up to the clip duration) and words = the shot prompt
 * (≤ 512 characters). Kling's task result does NOT report shot boundaries, so the durations we send are the
 * expected cut points (refined later by scene detection on the rendered clip).
 */

export interface MultiShotShot {
  text: string
  /** Seconds as typed; undefined = share the remaining time evenly. */
  seconds?: number
}

export interface ResolvedShot {
  text: string
  /** Whole seconds, ≥ 1. */
  seconds: number
}

/** What the Kling adapter stores on the output asset (`meta.multiShot`). */
export interface MultiShotMeta {
  shots: ResolvedShot[]
  /** Cut points in seconds from the clip's t=0 (interior boundaries only). */
  expectedCuts: number[]
  /** Multi-shot was on but the prompt had no shot list: Kling planned the cuts itself. */
  auto?: boolean
}

export const KLING_MAX_SHOTS = 6
export const KLING_MAX_SHOT_CHARS = 512

/** Help text for prompts of multi-shot capable models. */
export const MULTI_SHOT_PROMPT_HELP =
  'Multi-shot: one shot per line, e.g. “Shot 1 (3s): wide shot of the harbour” or “[2s] close-up…”. ' +
  'Durations must add up to the clip length; shots without one share the rest. Up to 6 shots; ' +
  'text before the first shot is kept as context for shot 1.'

export class MultiShotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MultiShotError'
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing

interface Header {
  /** Boundary the header starts at (before any bullet): where the previous shot's text ends. */
  from: number
  end: number
  /** Shot number as typed ("Shot 3"), undefined for duration-only headers ("[3s]"). */
  label?: number
  seconds?: number
}

const UNIT = String.raw`(?:seconds?|secs?|s)\b`
const NUM = String.raw`(\d+(?:\.\d+)?)`
const BULLET_RE = /[ \t]*(?:[-*•][ \t]+)?/y
const LABEL_RE = /([[(])?[ \t]*shot[ \t]*#?[ \t]*(\d{1,2})[ \t]*([\])])?/iy
const PAREN_SECONDS_RE = new RegExp(String.raw`[ \t]*[[(][ \t]*${NUM}[ \t]*(?:${UNIT})?[ \t]*[\])]`, 'iy')
const SEPARATOR_RE = /[ \t]*[:.,\-–—][ \t]*/y
/** "3s," / "3 sec:" / "3s " (with a unit) or native "3," (without one). */
const INLINE_SECONDS_RE = new RegExp(String.raw`[ \t]*${NUM}[ \t]*(?:${UNIT}[ \t]*(?:[:.,\-–—][ \t]*)?|(?:[:,]|[\-–—](?=[ \t]))[ \t]*)`, 'iy')
const DURATION_HEADER_RE = new RegExp(String.raw`[[(][ \t]*${NUM}[ \t]*${UNIT}[ \t]*[\])][ \t]*(?:[:.,\-–—][ \t]*)?`, 'iy')
const END_OF_LINE_RE = /[ \t]*(?:\n|$)/y

function stickyMatch(re: RegExp, text: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos
  return re.exec(text)
}

/** `inline`: the boundary is a sentence end inside a line, where only "Shot N" labels may start a shot. */
function matchHeader(text: string, boundary: number, inline: boolean): Header | undefined {
  const bullet = stickyMatch(BULLET_RE, text, boundary)
  const start = bullet ? boundary + bullet[0].length : boundary
  const label = stickyMatch(LABEL_RE, text, start)
  if (label) {
    let pos = start + label[0].length
    let seconds: number | undefined
    const paren = stickyMatch(PAREN_SECONDS_RE, text, pos)
    if (paren) {
      seconds = Number(paren[1])
      pos += paren[0].length
      // "[Shot 1 (3s)]": the bracket opened before "Shot" closes after the duration.
      const close = label[1] && !label[3] ? stickyMatch(/[ \t]*[\])]/y, text, pos) : null
      if (close) pos += close[0].length
    }
    const separator = stickyMatch(SEPARATOR_RE, text, pos)
    if (separator) pos += separator[0].length
    const closedBracket = Boolean(label[1] && label[3])
    // "Shot 2 people walk in" is prose, not a header: require a separator, a duration, "[Shot 2]" or a line end.
    if (!separator && !paren && !closedBracket && !stickyMatch(END_OF_LINE_RE, text, pos)) return undefined
    if (seconds === undefined && (separator || closedBracket)) {
      const inlineSeconds = stickyMatch(INLINE_SECONDS_RE, text, pos)
      if (inlineSeconds) {
        seconds = Number(inlineSeconds[1])
        pos += inlineSeconds[0].length
      }
    }
    return { from: boundary, end: pos, label: Number(label[2]), seconds }
  }
  if (inline) return undefined
  const duration = stickyMatch(DURATION_HEADER_RE, text, start)
  if (duration) return { from: boundary, end: start + duration[0].length, seconds: Number(duration[1]) }
  return undefined
}

/** Positions where a shot header may start: text start, line starts, after `;`, and after a sentence end. */
function boundaries(text: string): { pos: number; inline: boolean }[] {
  const out = [{ pos: 0, inline: false }]
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\n' || ch === ';') out.push({ pos: i + 1, inline: false })
    else if ((ch === '.' || ch === '!' || ch === '?') && (text[i + 1] === ' ' || text[i + 1] === '\t')) out.push({ pos: i + 1, inline: true })
  }
  return out
}

const clean = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .replace(/^[\s;]+|[\s;]+$/g, '')
    .trim()

/**
 * Splits a prompt written as a shot list. Returns null for ordinary prompts (no shot headers). Numbered headers
 * must start at "Shot 1"; text before the first header is prepended to shot 1 as shared context.
 */
export function parseMultiShot(prompt: string): { shots: MultiShotShot[] } | null {
  const text = prompt.replace(/\r\n?/g, '\n')
  if (!text.trim()) return null
  const headers: Header[] = []
  let consumedTo = 0
  for (const b of boundaries(text)) {
    if (b.pos < consumedTo) continue
    const header = matchHeader(text, b.pos, b.inline)
    if (!header) continue
    headers.push(header)
    consumedTo = header.end
  }
  // "Shot 2, then…" opening a prompt is prose; a real shot list starts at shot 1 (or with a "[3s]" header).
  if (!headers.length || (headers[0]!.label !== undefined && headers[0]!.label !== 1)) return null

  const preamble = clean(text.slice(0, headers[0]!.from))
  const shots = headers.map((h, i): MultiShotShot => {
    const body = clean(text.slice(h.end, headers[i + 1]?.from ?? text.length))
    const shotText = i === 0 && preamble ? clean(`${preamble} ${body}`) : body
    return h.seconds === undefined || !Number.isFinite(h.seconds) ? { text: shotText } : { text: shotText, seconds: h.seconds }
  })
  return { shots }
}

// ---------------------------------------------------------------------------------------------------------------
// Durations and cuts

/**
 * Whole-second duration per shot so the shots add up to `totalSeconds` (Kling's rule): shots without a duration
 * share the remaining time evenly (earlier shots get the spare seconds). Throws MultiShotError when impossible.
 */
export function resolveShotDurations(shots: readonly MultiShotShot[], totalSeconds: number): ResolvedShot[] {
  const total = Math.round(totalSeconds)
  if (!(total >= 1)) throw new MultiShotError('The clip needs a duration of at least 1 s')
  const known = shots.map((s) => (s.seconds === undefined ? undefined : Math.round(s.seconds)))
  for (const [i, k] of known.entries()) if (k !== undefined && k < 1) throw new MultiShotError(`Shot ${i + 1} must last at least 1 s`)
  const sumKnown = known.reduce<number>((sum, k) => sum + (k ?? 0), 0)
  const unknown = known.filter((k) => k === undefined).length
  if (!unknown) {
    if (sumKnown !== total) throw new MultiShotError(`Shot durations add up to ${sumKnown} s but the clip is ${total} s`)
    return shots.map((s, i) => ({ text: s.text, seconds: known[i]! }))
  }
  const rest = total - sumKnown
  if (rest < unknown) {
    throw new MultiShotError(
      rest <= 0
        ? `The shot durations already fill the ${total} s clip — ${unknown === 1 ? 'one shot has' : `${unknown} shots have`} no time left`
        : `Only ${rest} s left for ${unknown} shots without a duration (each needs at least 1 s)`,
    )
  }
  const base = Math.floor(rest / unknown)
  let spare = rest - base * unknown
  return shots.map((s, i) => {
    const k = known[i]
    if (k !== undefined) return { text: s.text, seconds: k }
    const seconds = base + (spare > 0 ? 1 : 0)
    if (spare > 0) spare--
    return { text: s.text, seconds }
  })
}

/** Best-effort durations when the strict rules fail (never throws; used for splitting existing clips). */
function looseDurations(shots: readonly MultiShotShot[], total: number): number[] {
  const known = shots.map((s) => (s.seconds !== undefined && s.seconds > 0 ? s.seconds : undefined))
  const sumKnown = known.reduce<number>((sum, k) => sum + (k ?? 0), 0)
  const unknown = known.filter((k) => k === undefined).length
  if (!unknown) return known.map((k) => (k! * total) / sumKnown)
  const rest = total - sumKnown
  if (rest > 0) return known.map((k) => k ?? rest / unknown)
  return shots.map(() => total / shots.length)
}

/**
 * Expected cut points (seconds from t=0, interior boundaries only) for a shot list rendered as a
 * `totalSeconds` clip. Uses the same whole-second distribution the Kling adapter sends; falls back to
 * proportional/even spacing when the list does not fit the duration.
 */
export function expectedCuts(shots: readonly MultiShotShot[], totalSeconds: number): number[] {
  if (shots.length < 2 || !(totalSeconds > 0)) return []
  let durations: number[]
  try {
    durations = resolveShotDurations(shots, totalSeconds).map((s) => s.seconds)
  } catch {
    durations = looseDurations(shots, totalSeconds)
  }
  const cuts: number[] = []
  let t = 0
  for (const d of durations.slice(0, -1)) {
    t += d
    if (t > 0 && t < totalSeconds) cuts.push(Math.round(t * 1000) / 1000)
  }
  return cuts
}

const nativeText = (text: string) => text.replace(/;/g, ',').replace(/\s+/g, ' ').trim()

/**
 * Kling's native storyboard prompt: `shot 1, 3, words; shot 2, 2, words;`. With `totalSeconds` the durations
 * are resolved first (see resolveShotDurations); without it every shot needs its own duration.
 */
export function toKlingMultiShotPrompt(shots: readonly MultiShotShot[], totalSeconds?: number): string {
  const resolved =
    totalSeconds === undefined
      ? shots.map((s, i): ResolvedShot => {
          if (s.seconds === undefined) throw new MultiShotError(`Shot ${i + 1} has no duration`)
          return { text: s.text, seconds: Math.max(1, Math.round(s.seconds)) }
        })
      : resolveShotDurations(shots, totalSeconds)
  return resolved.map((s, i) => `shot ${i + 1}, ${s.seconds}, ${nativeText(s.text)};`).join(' ')
}

/** First problem that would make Kling reject this shot list for a `totalSeconds` clip, or null. */
export function multiShotProblem(shots: readonly MultiShotShot[], totalSeconds: number): string | null {
  if (!shots.length) return null
  if (shots.length > KLING_MAX_SHOTS) return `Kling multi-shot supports up to ${KLING_MAX_SHOTS} shots (this prompt has ${shots.length})`
  for (const [i, s] of shots.entries()) {
    if (!s.text.trim()) return `Shot ${i + 1} needs a description`
    if (s.seconds !== undefined && s.seconds < 1) return `Shot ${i + 1} must last at least 1 s`
    if (s.seconds !== undefined && !Number.isInteger(s.seconds)) return `Shot ${i + 1}: Kling needs whole seconds (got ${s.seconds} s)`
    const length = nativeText(s.text).length
    if (length > KLING_MAX_SHOT_CHARS) return `Shot ${i + 1} is too long (${length}/${KLING_MAX_SHOT_CHARS} characters)`
  }
  try {
    resolveShotDurations(shots, totalSeconds)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  return null
}
