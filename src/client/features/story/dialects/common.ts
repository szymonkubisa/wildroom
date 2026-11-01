/**
 * What every prompt dialect shares: the compiler interface, what a clip or a shot is compiled from, and the small
 * pieces of wording (framing, whole-second shot lengths, who speaks how) the dialects build their prompts with.
 */
import type { VideoWorkflow } from '@shared/models/workflow'
import type { StoryCharacter, StoryShot } from '@shared/types/story'
import { PARTIAL_PHRASE, isUnseen, lookOf, partialKind, shotCast, titleCase, withoutPictureNotes } from '../cast'
import type { ClipKnobs, Cut } from '../multishot'
import { linePhrases } from '../soundtrack'

export type { ClipKnobs }

/** Everything about a clip or a shot that isn't the shots themselves: the place, the cast's names, the voices. */
export interface ClipContext {
  /** Who stands where in the place, kept across the cuts. */
  blocking?: string
  /** The place's one light logic. */
  light?: string
  /** The story's spoken language (storyLanguage), when the lines show it. */
  language?: string
  /** Characters given to the model as references or elements, by id → how the prompt names them ("Image 1", "@element_1", "character1"). */
  subjects?: ReadonlyMap<string, string>
  /** Their voice samples, by id → "Audio 1" (LTX on RunPod). */
  voices?: ReadonlyMap<string, string>
  /** The place sent as the scene reference (LTX's referenceBackground): its name, description and token. */
  scene?: { token: string; name: string; description: string }
  /** The place the shots are set in. */
  place?: { name: string; description?: string }
  /** The languages the model speaks and how it wants English lines written. */
  speech?: VideoWorkflow['speech']
  /** The style is already written for the model (styleFor): use it as it is (LTX otherwise drops its "no …" phrases). */
  styleAsIs?: boolean
  /** Write the clip as the model's own shot list (Kling's API: "Shot n (Xs): …" lines, the scene setup inside shot 1). */
  shotList?: boolean
  /** Longest text per shot in that list (Kling: 512 characters). */
  shotLimit?: number
  /** The clip starts from the first shot's keyframe: the picture shows who stands where (see multishotPrompt). */
  fromFrame?: boolean
}

/** A multi-shot clip to compile: the cuts (planCutsFor), its length, the Cast, the style (already styleFor'd). */
export interface ClipInput {
  cuts: Cut[]
  total: number
  characters: StoryCharacter[]
  style: string
  context: ClipContext
}

export interface CompiledShot {
  prompt: string
  /** Whole seconds; a clip's shots add up to its length. */
  duration: number
}

/** A compiled clip: the prompt, and — for dialects that time their shots — each shot with its whole-second length. */
export interface CompiledClip {
  prompt: string
  shots?: CompiledShot[]
}

/** One shot to compile (videoPrompt's pieces). */
export interface ShotInput {
  shot: StoryShot
  characters: StoryCharacter[]
  /** Already styleFor'd. */
  style: string
  /** The shot's camera move in the model's wording (cameraFor), if it has one. */
  camera?: string
  context: ClipContext
  /** The model voices the lines itself: the dialogue and sounds go into the prompt. */
  speaks: boolean
  /** Rendered from a keyframe: the clothes are in the picture, who they are is enough. */
  fromFrame?: boolean
  /** How the shot ends (endingOf), when it has an end frame: said in the prompt whether or not the end picture goes too. */
  ending?: string
  /** Made to its recorded voice track (lip sync): a still camera, and the lines' words without delivery or cues. */
  lipSync?: boolean
  /** The prompt fits the model's prompt param. */
  fits: (prompt: string) => boolean
}

export interface DialectSoundtrackOptions {
  dialogue?: boolean
  sound?: boolean
  subjects?: ReadonlyMap<string, string>
  voices?: ReadonlyMap<string, string>
  language?: string
  speech?: VideoWorkflow['speech']
}

/** One prompt dialect: how a multi-shot clip, a single shot and a shot's dialogue + sounds are written for a family. */
export interface DialectCompiler {
  clip(input: ClipInput, knobs?: ClipKnobs): CompiledClip
  shot(input: ShotInput): string
  soundtrack(shot: StoryShot, characters: StoryCharacter[], opts?: DialectSoundtrackOptions): string
  /** Last resort when a shot list still breaks its per-shot limit after the whole ladder: cut each shot down to `limit`. */
  clamp?(clip: CompiledClip, limit: number): CompiledClip
}

// ------------------------------------------------------------------------------------ wording

export const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a')

/** "WIDE" → "wide shot", "medium close-up shot" stays: the framing, lower case, ending in "shot". */
export function framingOf(shotType?: string): string | undefined {
  const t = shotType?.trim()
  if (!t) return undefined
  return (/\bshot$/i.test(t) ? t : `${t} shot`).toLowerCase()
}

/** Whitespace (newlines included) collapsed to single spaces. */
export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** One line, and no ';' — Kling's shot list uses it as a separator. */
export const flat = (text: string) => oneLine(text.replace(/;/g, ','))

/** The text as a sentence: ending in a full stop unless it already ends a sentence (empty stays empty). */
export function stop(text: string): string {
  const t = text.trim()
  return !t || /[.!?…]["”’']?$/.test(t) ? t : `${t}.`
}

/** The first candidate that fits, else the last (the leanest). */
export const firstFitting = (candidates: string[], fits: (prompt: string) => boolean) => candidates.find(fits) ?? candidates.at(-1)!

/**
 * The knobs a single shot tries, richest first — videoPrompt's order: with the dialogue and sounds (a model that
 * speaks), without the sounds, without either; the looks in full then short (only short from a keyframe: the
 * clothes are in the picture), and at last no looks.
 */
export function shotLadder(speaks: boolean, fromFrame?: boolean): ClipKnobs[] {
  const out: ClipKnobs[] = []
  for (const looks of fromFrame ? (['short'] as const) : (['full', 'short'] as const)) {
    if (speaks) out.push({ looks }, { looks, sound: false })
    out.push({ looks, sound: false, dialogue: false })
  }
  out.push({ looks: 'none', sound: false, dialogue: false })
  return out
}

/** The end frame's opening that only says the camera stays: "Same framing as the start;", "From exactly the same camera, …". */
const SAME_CAMERA = /^\s*(?:from\s+)?(?:exactly\s+)?(?:the\s+)?same\s+(?:camera|framing|composition|shot|angle|view|lens|setup)\b[^.;:,—–]*[.;:,—–]\s*/i

/** Longest ending the prompt says. */
const ENDING_WORDS = 30

/**
 * How the shot ends, for its video prompt: the first sentence of its end frame — the Director writes there what
 * changed and what is no longer where it was ("The phone is no longer on the floor; it is in her raised hand.") —
 * without an opening that only says the camera stays, at most 30 words (its first clause, else its first 30 words).
 * The user's idea: an end picture that barely differs froze the clip, so the end goes into the prompt too.
 */
export function endingOf(shot: Pick<StoryShot, 'endFrame'>): string | undefined {
  const text = oneLine(shot.endFrame ?? '').replace(SAME_CAMERA, '')
  const first = text.split(/(?<=[.!?])\s+/)[0]?.trim()
  if (!first) return undefined
  const words = (t: string) => t.split(/\s+/).filter(Boolean)
  const clause = first.split(/;\s*/)[0]!
  const short = words(first).length <= ENDING_WORDS ? first : words(clause).length <= ENDING_WORDS ? clause : words(first).slice(0, ENDING_WORDS).join(' ')
  return stop(capitalise(short.replace(/[,;:\s]+$/, '')))
}

/** Openers lowered after "At the end of the shot, " — never a name ("Claire", "Porsche"), which keeps its capital. */
const OPENER = /^(?:The|A|An|It|Its|His|Her|Their|This|That|These|Those|There|Now|Everything|Nothing|All|Both|Each|Every|Some|No|One|Only|He|She|They|We)\b/

/** The ending as the dialects say it: "At the end of the shot, the phone is in her raised hand." */
export function endingSentence(ending: string): string {
  return `At the end of the shot, ${OPENER.test(ending) ? ending.charAt(0).toLowerCase() + ending.slice(1) : ending}`
}

/** At most `max` characters, cut at a word and marked with "…". */
export function truncate(text: string, max?: number): string {
  if (!max || text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - 1)).replace(/\s+\S*$/, '')}…`
}

/**
 * Whole-second shot lengths adding up to `total` exactly, each at least 1 s: the cut points rounded to the second
 * (Kling's shot list and Veo's timestamps take whole seconds).
 */
export function wholeSeconds(cuts: readonly Cut[], total: number): number[] {
  const end = Math.round(total)
  const out: number[] = []
  let t = 0
  cuts.forEach((c, i) => {
    const last = i === cuts.length - 1
    const at = last ? end : Math.min(end - (cuts.length - 1 - i), Math.max(t + 1, Math.round(c.end)))
    out.push(at - t)
    t = at
  })
  return out
}

/** The cut points (interior boundaries) of shots this long. */
export function cutPoints(durations: readonly number[]): number[] {
  const out: number[] = []
  let t = 0
  for (const d of durations.slice(0, -1)) out.push((t += d))
  return out
}

/** Everyone the shots show, in order of appearance, without the unseen (narrators, voices). */
export function clipCast(shots: readonly StoryShot[], characters: readonly StoryCharacter[]): StoryCharacter[] {
  const ids = [...new Set(shots.flatMap(shotCast))]
  return ids.map((id) => characters.find((c) => c.id === id)).filter((c): c is StoryCharacter => Boolean(c) && !isUnseen(c!))
}

/** How the prompt calls a character: their reference token, else their name. */
export const nameOf = (c: StoryCharacter, subjects?: ReadonlyMap<string, string>) => subjects?.get(c.id) ?? titleCase(c.name)

/**
 * Who a character is, for the scene setup: their look from the Cast ("Maja: a woman in her thirties…"), or — when
 * the model knows them by a token — "@element_1 is Maja, a woman in her thirties…". `short` keeps the first clause.
 * A token that is just the name (Veo's ingredients) is no token. Picture notes stay out (withoutPictureNotes).
 */
export function introOf(c: StoryCharacter, short: boolean, token?: string): string {
  const name = titleCase(c.name)
  if (!token || token === name) return lookOf(c, short) || name
  const look = withoutPictureNotes(c.description)
  const text = (short ? look.split(';')[0]! : look).trim().replace(/[.;,\s]+$/, '')
  const who = !text ? name : text.toLowerCase().startsWith(name.toLowerCase().split(/\s+/)[0]!) ? text : `${name}, ${text}`
  return `${token} is ${who}`
}

/** Who is in one shot (introOf each), those seen only in part marked so (partialKind); none with `looks: 'none'`. */
export function shotIntros(
  shot: StoryShot,
  characters: readonly StoryCharacter[],
  looks: ClipKnobs['looks'],
  subjects?: ReadonlyMap<string, string>,
): string[] {
  if (looks === 'none') return []
  const part = PARTIAL_PHRASE[partialKind(shot)]
  return clipCast([shot], characters).map((c) => {
    const intro = introOf(c, looks === 'short', subjects?.get(c.id))
    return shot.characterIds.includes(c.id) ? intro : `${intro}, ${part}`
  })
}

/**
 * The place in the scene setup: its description (or name), or just its name when the prompt is short of room. Sent
 * as a reference image (Kling O3's @Image1), it says so: "…, as in @Image1".
 */
export function placeText(place: ClipContext['place'], full: boolean, scene?: ClipContext['scene']): string | undefined {
  if (!place) return scene ? `Setting: ${scene.token}` : undefined
  const description = place.description?.trim().replace(/[.\s]+$/, '')
  const text = full && description ? description : place.name.trim() ? `Setting: ${place.name.trim()}` : undefined
  return scene ? `${text ?? 'Setting'}, as in ${scene.token}` : text
}

/** "00:04", "01:12" (to the nearest second: 59.6 s is "01:00"). */
export function timestamp(seconds: number): string {
  const whole = Math.round(seconds)
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * A delivery note as a voice: "whispering" → "in a whispering voice"; an adverb or a longer note ("quietly, with a
 * smirk") is said as it is; none → "in a natural voice".
 */
export function voicePhrase(delivery: string): string {
  const d = delivery.trim()
  if (!d) return 'in a natural voice'
  return /^[a-z-]+$/i.test(d) && !/ly$/i.test(d) ? `in ${article(d)} ${d} voice` : d
}

// ------------------------------------------------------------------------------------ dialogue

/** One spoken line and where its speaker is: in the frame, there but seen from behind, off-screen, or an unseen narrator. */
export interface SpokenLine {
  speaker?: StoryCharacter
  where: 'on' | 'behind' | 'off' | 'narrator'
  delivery: string
  parts: { cue?: string; words: string }[]
}

/** The shot's spoken lines (none when `dialogue` is off), with who says them from where — soundtrackPrompt's rules. */
export function spokenLines(shot: StoryShot, characters: readonly StoryCharacter[], dialogue = true): SpokenLine[] {
  if (!dialogue) return []
  // An insert shows hands or objects: whoever talks is heard, not seen.
  const insert = /\binsert\b/i.test(shot.shotType ?? '')
  return shot.dialogue
    .filter((l) => l.text.trim())
    .map((l) => {
      const c = characters.find((x) => x.id === l.characterId)
      const { delivery, parts } = linePhrases(l.text)
      if (!c || isUnseen(c)) return { where: 'narrator' as const, delivery, parts }
      const where = !insert && shot.characterIds.includes(c.id) ? 'on' : !insert && shot.partialIds?.includes(c.id) ? 'behind' : 'off'
      return { speaker: c, where, delivery, parts }
    })
}

const CJK = /[㐀-鿿]/

/** The language a line is spoken in: the story's when the lines show it, Chinese for Chinese characters, else English. */
export const lineLanguage = (line: SpokenLine, language?: string) =>
  language ?? (line.parts.some((p) => CJK.test(p.words)) ? 'Chinese' : 'English')

/**
 * An English line in lower case (Kling reads it best so) — except "I", acronyms ("NASA", "TV"), the Cast's names
 * and any capitalised word inside a sentence, which is taken for a proper noun.
 */
export function lowercaseEnglish(text: string, names: readonly string[]): string {
  const keep = new Set(names.flatMap((n) => n.toLowerCase().split(/[\s-]+/)).filter(Boolean))
  return text.replace(/\p{L}[\p{L}\p{N}'’]*/gu, (word, offset: number) => {
    if (word.length > 1 && word === word.toUpperCase()) return word
    if (/^I(?:['’]\p{L}+)?$/u.test(word)) return word
    if (keep.has(word.toLowerCase())) return word
    const before = text.slice(0, offset)
    const sentenceStart = !before.trim() || /[.!?…]["”’']?\s+$/.test(before) || /(?:^|\s)["“‘]$/.test(before)
    return sentenceStart && /^\p{Lu}[\p{Ll}'’]*$/u.test(word) ? word.toLowerCase() : word
  })
}
