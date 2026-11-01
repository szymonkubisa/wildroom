import type { VideoWorkflow } from '../models/workflow'
import type { StoryCharacter, StoryShot } from '../types/story'

/** Characters the Director describes as never seen ("Niewidoczny rozmówca…", "Voice of the newsreader…"). */
const UNSEEN = /^\s*(niewidoczn|invisible|unseen|off-screen|offscreen|głos\b|voice\b)/i
export const isUnseen = (c: StoryCharacter) => UNSEEN.test(c.description)

/** "TYMON" → "Tymon": how an all-caps (screenplay) Cast name reads in prose. */
export const titleCase = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()

/** "PANI EWA" → "Pani Ewa", "JEAN-LUC" → "Jean-Luc". */
const wordCase = (name: string) => name.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase())

/** How a character's name may be written in shot text: as in the Cast, or capitalized from an all-caps one (longest first). */
const nameForms = (name: string) =>
  [...new Set([name.trim(), titleCase(name.trim()), wordCase(name.trim())])].filter(Boolean).sort((a, b) => b.length - a.length)

/**
 * What a look says about the reference picture rather than the person: a background (as typed, too — "backdround"),
 * a studio, "only one shot", a collage, a second panel or an inset, how the figure is framed ("head to toe", "seen
 * from behind", "full body") or that the scenery stays out. Each pattern is a whole phrase of the note, so a real look
 * keeps "leather panels", "inset pockets", "a full-length coat" and "dressed head to toe in black".
 */
const PICTURE_NOTE = [
  /\bback\s?[dg]?r[aou]{1,2}n?d\b|\bbackdrops?\b|\bbg\b/i,
  /\bstudio\b/i,
  /\b(only )?one (single )?(shot|shoot|photo|photograph|picture|image|pose|view|figure)\b/i,
  /\bcollage\b|\b(single|one|no|second|multi|multiple|split)[- ]?panels?\b|\binsets?(\s+(picture|image|photo|view)s?)?\s*$/i,
  /\b(character|reference|model) sheet\b|\bturnaround\b|\bmultiple views\b|\bsplit[- ]screen\b/i,
  /\b(seen|shown|viewed|photographed|pictured|drawn|shot) from (behind|the back|the front|the side|above|below)\b|^\s*from (behind|the back)\s*$/i,
  /\b(back|rear|front|side|profile|three-quarter)[- ]views?\b|\b(facing|looking (at|into)) the (camera|lens|viewer)\b/i,
  /\bfull[- ](body|figure)\b|\bfull[- ]length (shot|view|portrait|picture|photo)\b|^\s*head[- ]to[- ](toe|feet)\s*$|\b(visible|shown|seen|framed|figure|in (the )?frame|shot|photo)\b[^,;.]*\bhead[- ]to[- ](toe|feet)\b|\bhead[- ]to[- ](toe|feet)\b[^,;.]*\b(visible|shown|in (the )?frame|shot|view)\b/i,
  /\b(in|no|not|without)\b[^,;.]*\b(environment|surroundings|scenery|props)\b/i,
]

/**
 * A look without its picture notes (PICTURE_NOTE), phrase by phrase — the notes for drawing the reference picture
 * belong in StoryCharacter.pictureNotes. Left in the look they rode along into every shot: "On gray backdround — seen
 * from behind." and "Only one shoot on gray background" went into every LTX shot of Impossible Worlds.
 */
export function withoutPictureNotes(text: string): string {
  let changed = false
  const kept = text
    .trim()
    .split(/(?<=[.;!?])\s+/)
    .flatMap((sentence) => {
      const end = /[.;!?]+$/.exec(sentence)?.[0] ?? ''
      // The phrases with what joins them: "On gray backdround", " — ", "seen from behind".
      const pieces = sentence.slice(0, sentence.length - end.length).split(/(\s*,\s*|\s+[—–-]\s+)/)
      let out = ''
      for (let i = 0; i < pieces.length; i += 2) {
        const phrase = pieces[i]!
        if (!phrase.trim()) continue
        if (PICTURE_NOTE.some((re) => re.test(phrase))) {
          changed = true
          continue
        }
        out += out ? `${pieces[i - 1]}${phrase}` : phrase
      }
      if (!out) return []
      // A sentence that lost its first phrase still starts as one.
      return [`${/^\p{Lu}/u.test(sentence) ? out.charAt(0).toUpperCase() + out.slice(1) : out}${end}`]
    })
  return changed ? kept.join(' ') : text
}

/**
 * A character's look for a generator prompt, taken from the Cast — the one place it is written. Shot prompts name the
 * characters and never describe them, so a change in the Cast (glasses off, a new jacket) reaches every shot instead
 * of being contradicted by 40 old copies. It starts with the name, which ties the name in the shot to the look;
 * `short` keeps the first clause (who they are, face and hair) for prompts near the model's limit. Picture notes stay
 * out (withoutPictureNotes).
 */
export function lookOf(c: StoryCharacter, short = false): string {
  const look = withoutPictureNotes(c.description)
  const text = (short ? look.split(';')[0]! : look).trim().replace(/[.;,\s]+$/, '')
  if (!text) return ''
  const name = titleCase(c.name)
  return text.toLowerCase().startsWith(name.toLowerCase().split(/\s+/)[0]!) ? text : `${name}: ${text}`
}

/**
 * What a look says of the clothes: past its first clause (who they are, face and hair) — what is left of someone seen
 * only as an outline in the dark.
 */
export function clothesOf(c: StoryCharacter): string {
  return withoutPictureNotes(c.description).split(';').slice(1).join(';').trim().replace(/[.;,\s]+$/, '')
}

/**
 * Everyone the shot shows: the faces first, then those seen only in part (from behind, hands) — never those who are
 * only an outline in the dark (hiddenIds): no face reference, no lip sync, no video reference.
 */
export const shotCast = (shot: StoryShot): string[] =>
  [...shot.characterIds, ...(shot.partialIds ?? []).filter((id) => !shot.characterIds.includes(id))].filter((id) => !shot.hiddenIds?.includes(id))

/** How someone the shot shows only in part is seen (partialKind). */
export type PartialKind = 'back' | 'hands' | 'feet'

/**
 * How the shot shows those it shows only in part: their hands (an insert, a framing or first frame about hands and
 * fingers), their feet (boots, shoes), else from behind — always from behind over a shoulder. Told "seen from behind"
 * for all of them, the hands-only inserts of The Chase came out as over-the-shoulder shots.
 */
export function partialKind(shot: Pick<StoryShot, 'shotType' | 'frame'>): PartialKind {
  const type = shot.shotType ?? ''
  if (/over[- ]the[- ]shoulder|\bots\b/i.test(type)) return 'back'
  const text = `${type} ${shot.frame ?? ''}`
  const hands = /\b(hands?|fingers?|fingertips?|palms?|wrists?)\b/i.test(text)
  if (!hands && /\b(feet|foot|boots?|shoes?|sneakers?|trainers?)\b/i.test(text)) return 'feet'
  return hands || /\binsert\b/i.test(type) ? 'hands' : 'back'
}

/** …as a video prompt says it after the look ("Maja: … — only the hands and sleeves in the frame"). */
export const PARTIAL_PHRASE: Record<PartialKind, string> = {
  back: 'seen from behind',
  hands: 'only the hands and sleeves in the frame',
  feet: 'only the feet and shoes in the frame',
}

/**
 * The looks of the characters in a shot, one sentence each (empty when there are none). Those seen only in part are
 * marked so (partialKind); characters given to the model as reference images (`subjects`) are left out — the
 * references and the prompt's "Image 1: …" lines describe them.
 */
export function castLooks(shot: StoryShot, characters: readonly StoryCharacter[], short = false, subjects?: ReadonlyMap<string, string>): string {
  const part = PARTIAL_PHRASE[partialKind(shot)]
  return shotCast(shot)
    .map((id) => characters.find((c) => c.id === id))
    .filter((c): c is StoryCharacter => Boolean(c) && !isUnseen(c!) && !subjects?.has(c!.id))
    .map((c) => {
      const look = lookOf(c, short)
      return look && !shot.characterIds.includes(c.id) ? `${look} — ${part}` : look
    })
    .filter(Boolean)
    .join('. ')
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The prompt with each referenced character's name replaced by how the model knows them ("Maja turns to Tymon" →
 * "Image 1 turns to Image 2"): reference-to-video models (LTX with Licon's subject references) tie a subject to its
 * image through that name. Use on shot text only — never on dialogue, where a name is a spoken word.
 */
export function withSubjects(text: string, characters: readonly StoryCharacter[], subjects: ReadonlyMap<string, string>): string {
  let out = text
  for (const [id, token] of subjects) {
    const c = characters.find((x) => x.id === id)
    const re = c && nameRe(c)
    if (re) out = out.replace(re, token)
  }
  return out
}

/** A name as a whole word, in any of the forms nameForms gives. */
const nameRe = (c: StoryCharacter, flags = 'gu') => {
  const forms = nameForms(c.name).map(escapeRe).join('|')
  return forms ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${forms})(?![\\p{L}\\p{N}_])`, flags) : undefined
}

export type ScreenSide = 'left' | 'right'

export const oppositeSide = (side: ScreenSide): ScreenSide => (side === 'left' ? 'right' : 'left')

/** "on the left", "po prawej": a place in the frame, said outright. */
const PLACED = /(?<![\p{L}])(?:on|to|at|in) the (?:far |frame )?(left|right)(?![\p{L}])|(?<![\p{L}])po (lewej|prawej)(?![\p{L}])/iu
/** A bare side ("facing right", "lewa strona"): Polish only in lewy/prawy's own forms, not "prawie" or "prawda". */
const BARE = /(?<![\p{L}])(left|right|(?:lew|praw)(?:a|ą|e|ej|o|y|ym|ych|emu))(?![\p{L}])/iu

const sideOf = (word: string): ScreenSide => (/^(left|lew)/i.test(word) ? 'left' : 'right')

/**
 * Which side of the frame each character holds, read from the place's blocking ("Maja on the left at the ticket
 * machine, facing right toward Tymon; Tymon on the right"): after each mention of a name, up to the next name, a side
 * said outright ("on the left") wins over a bare one ("facing right"). Characters the blocking doesn't place are left out.
 */
export function screenSides(blocking: string | undefined, characters: readonly StoryCharacter[]): Map<string, ScreenSide> {
  const out = new Map<string, ScreenSide>()
  const text = blocking?.trim()
  if (!text) return out
  const mentions = characters
    .flatMap((c) => {
      const re = nameRe(c)
      return re ? [...text.matchAll(re)].map((m) => ({ id: c.id, start: m.index, end: m.index + m[0].length })) : []
    })
    .sort((a, b) => a.start - b.start)
  for (const strong of [true, false]) {
    mentions.forEach((m, i) => {
      if (out.has(m.id)) return
      const span = text.slice(m.end, mentions[i + 1]?.start ?? text.length)
      const found = (strong ? PLACED : BARE).exec(span)
      const word = found?.[1] ?? found?.[2]
      if (word) out.set(m.id, sideOf(word))
    })
  }
  return out
}

const FEMALE = /(?<![\p{L}])(woman|girl|lady|female|actress|mother|wife|kobieta|dziewczyna|dziewczynka|pani|matka|żona|babcia)(?![\p{L}])/iu
const MALE = /(?<![\p{L}])(man|boy|gentleman|male|actor|father|husband|mężczyzna|chłopak|chłopiec|pan|ojciec|mąż|dziadek)(?![\p{L}])/iu

/** "female" or "male" from who the Cast says the character is (the first clause), whichever is said first. */
export function genderOf(c: StoryCharacter): 'female' | 'male' | undefined {
  const who = c.description.split(';')[0]!
  const f = FEMALE.exec(who)
  const m = MALE.exec(who)
  if (f && (!m || f.index < m.index)) return 'female'
  return m ? 'male' : undefined
}

/** The Cast's Voice as written ("Warm, low female voice"), without a leading article or stop. */
const ownVoice = (c: StoryCharacter) => c.voice?.trim().replace(/[.\s]+$/, '').replace(/^(a|an|the)\s+/i, '') || undefined

/**
 * How a character sounds, for a video model that voices the lines: the Cast's Voice ("a warm, low female voice that
 * trembles"), else "a female voice" / "a male voice" from their description. Without it the model gives a line to a
 * voice by what stands near the quote — her lines came out in his voice.
 */
export function voiceOf(c: StoryCharacter): string | undefined {
  const own = ownVoice(c)
  if (own) {
    const text = /^\p{Lu}\p{Ll}/u.test(own) ? own.charAt(0).toLowerCase() + own.slice(1) : own
    const voice = /(?<![\p{L}])voice(?![\p{L}])/iu.test(text) ? text : `${text} voice`
    return `${/^[aeiou]/i.test(voice) ? 'an' : 'a'} ${voice}`
  }
  const gender = genderOf(c)
  return gender && `a ${gender} voice`
}

/**
 * Licon's voice-sample block: "Audio 1: Female voice, belongs only to Image 1." — the Cast's Voice or the gender,
 * else just whose voice it is.
 */
export function audioBlock(audio: string, c: StoryCharacter | undefined, token: string): string {
  const own = c && ownVoice(c)
  const gender = c && genderOf(c)
  const label = own ? own.charAt(0).toUpperCase() + own.slice(1) : gender ? `${gender === 'female' ? 'Female' : 'Male'} voice` : `the voice of ${token}`
  return `${audio}: ${label}, belongs only to ${token}`
}

/** "Image 1: Maja, a petite… Image 2: Tymon, …" — what each reference image is, from the Cast. */
export function subjectsPreamble(characters: readonly StoryCharacter[], subjects: ReadonlyMap<string, string>): string {
  return [...subjects]
    .map(([id, token]) => {
      const c = characters.find((x) => x.id === id)
      const look = c && lookOf(c)
      return look ? `${token}: ${look}` : ''
    })
    .filter(Boolean)
    .join('. ')
}

/**
 * How a video model's prompt names the n-th character it gets as a picture (1-based), by its workflow's cast token:
 * "Image 1" (LTX), "@element_1" / "@Element1" (Kling), the character's name (Veo's ingredients), "character1".
 */
export function castToken(workflow: Pick<VideoWorkflow, 'cast'>, n: number, c?: Pick<StoryCharacter, 'name'>): string {
  const token = workflow.cast?.token ?? 'Image {n}'
  return token.replace('{n}', String(n)).replace('{name}', c ? titleCase(c.name) : `Character ${n}`)
}
