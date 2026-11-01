import type { ModelSpec, ParamValues } from '@shared/models/types'
import type { StoryCharacter, StoryShot } from '@shared/types/story'
import type { StoryDoc } from '@shared/types/story'
import { isUnseen, shotCast, titleCase as nameCase, voiceOf, withSubjects, withoutPictureNotes } from './cast'

/**
 * Does this render come with the model's own soundtrack (LTX, Veo, Kling…)? With an `audio` switch, as set in the
 * render `settings` (its default otherwise, and off where the switch isn't offered, e.g. Kling's audio outside 1080p);
 * models that always make sound (Kling 3.0 Turbo, MiniMax, Happy Horse, Gemini Omni) have no switch, only the
 * catalog's Audio badge.
 */
export function speaksAudio(model: ModelSpec, settings: ParamValues = {}): boolean {
  if (model.output !== 'video') return false
  const audio = model.params.find((p) => p.key === 'audio')
  if (!audio) return model.badges.includes('Audio')
  const values: ParamValues = { ...Object.fromEntries(model.params.map((p) => [p.key, p.default])), ...settings }
  if (audio.ui.visibleIf && !audio.ui.visibleIf(values)) return false
  return values.audio !== false
}

/** For models whose negative prompt works (CFG > 1): spoken lines must not turn into burned-in text. */
export const NO_SUBTITLES = 'subtitles, captions, on-screen text, written words, letters, watermark'

const titleCase = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()

/**
 * Who speaks, as prose: the first part of the character's description ("Jan Różalski, 44 lata, szczupły…"), repeated
 * verbatim every time — LTX keeps a subject consistent when it is restated, not referred to by name or pronoun. A label
 * like `JAN (…):` reads as a screenplay or subtitle and gets drawn as text.
 */
function speakerFor(c: StoryCharacter | undefined): string {
  if (!c) return 'A narrator'
  const name = titleCase(c.name)
  const clause = withoutPictureNotes(c.description).split(';')[0]!.trim().replace(/[.,]+$/, '')
  if (!clause) return name
  const short = clause.length > 90 ? clause.slice(0, 90).replace(/[\s,]+\S*$/, '') : clause
  return short.toLowerCase().includes(name.toLowerCase().split(/\s+/)[0]!) ? short : `${name}, ${short.charAt(0).toLowerCase()}${short.slice(1)}`
}

/** Who speaks when the picture already shows them: the name (their voice says the rest — "in a female voice"). */
const briefSpeaker = (c: StoryCharacter) => nameCase(c.name)

/** Leading ElevenLabs-style audio tags ("[pod nosem, z przekąsem] Tekst") become a delivery note. */
function splitDelivery(text: string): { delivery: string; words: string } {
  const tags = /^\s*((?:\[[^\]]*\]\s*)+)/.exec(text)
  if (!tags) return { delivery: '', words: text.trim() }
  const delivery = [...tags[1]!.matchAll(/\[([^\]]*)\]/g)]
    .map((m) => m[1]!.trim())
    .filter(Boolean)
    .join(', ')
  return { delivery, words: text.slice(tags[0].length).trim() }
}

/**
 * A line as phrases with the acting cues between them — "[pod nosem] No weź. [patrzy na ekran] No weź, weź." gives the
 * delivery "pod nosem" and the phrases "No weź." and, after the cue "patrzy na ekran", "No weź, weź." Lightricks:
 * LTX follows acting direction phrase by phrase, so a cue between phrases plays, a long unbroken quote gets rushed.
 */
export function linePhrases(text: string): { delivery: string; parts: { cue?: string; words: string }[] } {
  const { delivery, words: rest } = splitDelivery(text)
  const parts: { cue?: string; words: string }[] = []
  let cue: string | undefined
  for (const piece of rest.split(/(\[[^\]]*\])/)) {
    const tag = /^\[([^\]]*)\]$/.exec(piece)
    if (tag) {
      if (cue) parts.push({ cue, words: '' })
      cue = tag[1]!.trim() || undefined
      continue
    }
    const words = piece.trim()
    if (words) parts.push({ ...(cue ? { cue } : {}), words })
    else if (cue) continue
    cue = undefined
  }
  if (cue) parts.push({ cue, words: '' })
  return { delivery, parts }
}

/** The phrases in quotes with the cues between them: "No weź.", then looks at the screen, "No weź, weź." */
export function quoted(parts: { cue?: string; words: string }[]): string {
  return parts.map((p) => [p.cue && `then ${p.cue}`, p.words && `"${p.words}"`].filter(Boolean).join(', ')).join(', ')
}

const POLISH = /[ąćęłńóśźż]/i
const CJK = /[㐀-鿿]/
/** Without a delivery note video models act the line out — a plain question comes out shouted. */
const NATURAL = 'in a natural, conversational voice'

export interface SoundtrackOptions {
  sound?: boolean
  dialogue?: boolean
  /** Characters given to the model as reference images, by id → how the prompt names them ("Image 1"). */
  subjects?: ReadonlyMap<string, string>
  /** Their voice samples, by id → how the prompt names them ("Audio 1"). */
  voices?: ReadonlyMap<string, string>
  /** The story's spoken language (see storyLanguage), for lines too short to tell. */
  language?: string
  /**
   * The picture is a start frame that shows everyone: speakers are named and said to be the woman or the man, not
   * described again (re-describing what the frame shows makes it drift).
   */
  brief?: boolean
  /**
   * The clip is made to the recorded lines (a voice track, lip sync): their words only, without the delivery or the
   * cues between phrases — Lightricks: no motion or pacing cues for a lip-synced shot; the recording has them.
   */
  wordsOnly?: boolean
}

/**
 * Everyday English words: lines that use them are English ("I'm getting married tomorrow."). None that Polish also
 * writes ("i", "a", "to", "no", "on", "we", "go" are Polish words too).
 */
const ENGLISH = new Set(
  "i'm i'll i've you you're your me my he she it it's is are was be been not don't can't won't the an and but or of in at for with that this what where why how here there now know came come love left get getting tomorrow tell word without years".split(' '),
)

/** Do these lines read as English? At least one everyday English word, and they are a fair share of all the words. */
export function looksEnglish(texts: readonly string[]): boolean {
  const words = texts.flatMap((t) => t.toLowerCase().replace(/\[[^\]]*\]/g, ' ').match(/[a-z’']+/g) ?? []).map((w) => w.replace(/’/g, "'"))
  const english = words.filter((w) => ENGLISH.has(w)).length
  return english > 0 && english / words.length >= 0.2
}

/**
 * The story's spoken language when the lines show it: Polish letters anywhere make every line Polish ("Jak konia."
 * too); lines that read as English make it English (named on every line: Lightricks wants the language said).
 */
export function storyLanguage(story: Pick<StoryDoc, 'shots'>): string | undefined {
  const lines = story.shots.flatMap((s) => s.dialogue.map((l) => l.text))
  if (lines.some((t) => POLISH.test(t))) return 'Polish'
  return looksEnglish(lines) ? 'English' : undefined
}

const listed = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : (xs[0] ?? ''))

/**
 * The shot's dialogue and sound effects as prose for a video model that generates audio: who speaks (by look, or as
 * an off-screen voice when they are not in the shot), how, in which language, and the exact words, in order — then
 * the sounds. Written as narration, not as a script, so the model voices the lines instead of printing them.
 */
export function soundtrackPrompt(shot: StoryShot, characters: StoryCharacter[], opts: SoundtrackOptions = {}): string {
  // Words only: a line that is all cue ("[sighs]") says nothing.
  const spoken = opts.dialogue === false ? [] : shot.dialogue.filter((l) => (opts.wordsOnly ? linePhrases(l.text).parts.some((p) => p.words) : l.text.trim()))
  // One language for the shot, named whenever it is known (the guide: lines "with language and accent named"): the
  // story's; else a short line without diacritics ("Janek… co to znaczy?") is still Polish, Chinese characters are
  // Chinese, everyday English words English — never assumed, a Polish "Dobrze." isn't English.
  const lang =
    opts.language ??
    (spoken.some((l) => POLISH.test(l.text)) ? 'Polish' : spoken.some((l) => CJK.test(l.text)) ? 'Chinese' : looksEnglish(spoken.map((l) => l.text)) ? 'English' : undefined)
  const language = lang ? ` in ${lang}` : ''
  const nameOf = (c: StoryCharacter) => opts.subjects?.get(c.id) ?? c.name.charAt(0).toUpperCase() + c.name.slice(1).toLowerCase()
  // An insert shows hands or objects: whoever talks is heard, not seen ("lips moving" would pull a face into frame).
  const insert = /\binsert\b/i.test(shot.shotType ?? '')
  const sentences = spoken.map((l) => {
    const c = characters.find((x) => x.id === l.characterId)
    const phrases = linePhrases(l.text)
    const delivery = opts.wordsOnly ? '' : phrases.delivery
    const parts = opts.wordsOnly ? [{ words: phrases.parts.map((p) => p.words).filter(Boolean).join(' ') }] : phrases.parts
    const said = quoted(parts)
    const last = parts.at(-1)?.words ?? ''
    const speaker = (c && opts.subjects?.get(c.id)) ?? (opts.brief && c ? briefSpeaker(c) : speakerFor(c))
    const onScreen = Boolean(c && !insert && shot.characterIds.includes(c.id) && !isUnseen(c))
    // Seen from behind (the shoulder of an over-the-shoulder shot): in the shot, but no lips to sync.
    const fromBehind = Boolean(c && !onScreen && !insert && shot.partialIds?.includes(c.id))
    // Whose voice: "Image 1" says nothing about it (the description does), so a referenced speaker is always given
    // one — the Cast's Voice, else the gender — and a described one when the Cast has a Voice.
    const voice = c && !opts.voices?.has(c.id) && (opts.subjects?.has(c.id) || opts.brief || c.voice?.trim()) ? voiceOf(c) : undefined
    const inVoice = voice ? ` in ${voice}` : ''
    const how = opts.wordsOnly ? ',' : `, ${delivery || (voice ? 'natural and conversational' : NATURAL)},`
    if (onScreen) {
      // Everyone else in the frame keeps quiet: the model otherwise hands a line to the wrong face.
      const others = shotCast(shot)
        .filter((id) => id !== c!.id)
        .map((id) => characters.find((x) => x.id === id))
        .filter((x): x is StoryCharacter => Boolean(x) && !isUnseen(x!))
        .map(nameOf)
      const quiet = others.length ? `, while ${listed(others)} ${others.length > 1 ? 'listen' : 'listens'} silently with closed lips` : ''
      const audio = opts.voices?.get(c!.id)
      // Licon's subject-reference wording: the lips follow the voice sample, which is named before the words.
      if (audio) return `${speaker} speaks${language} with visible lip movement synchronized with ${audio}${how.replace(/,$/, '')}${quiet}. ${audio} (${speaker}): ${said}`
      if (opts.subjects?.has(c!.id)) return `${speaker} speaks${language}${inVoice} with visible lip movement${how.replace(/,$/, '')}${quiet}: ${said}`
      return `${speaker} says${language}${inVoice}${how} ${said}, lips moving with the words${quiet}.`
    }
    const verb = fromBehind ? 'is heard saying' : 'is heard off-screen saying'
    const end = /[.!?…]$/.test(last) && !parts.at(-1)?.cue ? '' : '.'
    return `${speaker} ${verb}${language}${inVoice}${how} ${said}${end}`
  })
  const parts = [...sentences]
  // Sounds are shot text: a referenced character is called by their image there too ("Image 2's shoes").
  const sfx = shot.sfx?.trim() && (opts.subjects ? withSubjects(shot.sfx.trim(), characters, opts.subjects) : shot.sfx.trim())
  // "We hear the platform ambience continues" read as a broken sentence: the sounds as a label of their own.
  if (opts.sound !== false && sfx) parts.push(`Ambient sound: ${sfx.replace(/\.$/, '').replace(/^./, (ch) => ch.toLowerCase())}.`)
  return parts.join(' ')
}
