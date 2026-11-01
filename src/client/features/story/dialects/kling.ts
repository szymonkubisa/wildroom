/**
 * Kling 3.0 / Omni, after Kling's prompting guide: the scene set up first (style, place, light, who is who and where),
 * then one line per shot — "Shot n (framing, Xs): action. camera." — with the characters named the same way every
 * time (their element or reference token when the model has them), the place by its reference image when it is sent
 * as one (O3's @Image1). Dialogue is bound to its speaker as
 * `Name (tone, language): "line"`, English lines in lower case; an unseen narrator is a `Voiceover (tone)`.
 *
 * On Kling's own API the clip goes in as its native shot list: "Shot n (Xs): text" lines only (parseMultiShot turns
 * them into `shot n, X, text;`), each ≤ 512 characters, the scene setup inside shot 1.
 */
import { cameraSentence } from '@/features/generate/camera'
import { withSubjects } from '../cast'
import { type ClipKnobs, type Cut, sentences } from '../multishot'
import {
  type ClipContext,
  type ClipInput,
  type CompiledClip,
  type CompiledShot,
  type DialectCompiler,
  type DialectSoundtrackOptions,
  type ShotInput,
  capitalise,
  clipCast,
  endingSentence,
  firstFitting,
  flat,
  framingOf,
  introOf,
  lineLanguage,
  lowercaseEnglish,
  nameOf,
  placeText,
  shotIntros,
  shotLadder,
  spokenLines,
  stop,
  truncate,
  wholeSeconds,
} from './common'
import type { StoryCharacter, StoryShot } from '@shared/types/story'

/** Kling's native shot list as the storyboard writes it: one "Shot n (Xs): text" line per shot. */
export const klingShotList = (shots: readonly CompiledShot[]) => shots.map((s, i) => `Shot ${i + 1} (${s.duration}s): ${s.prompt}`).join('\n')

function klingSoundtrack(shot: StoryShot, characters: StoryCharacter[], opts: DialectSoundtrackOptions = {}): string {
  const names = characters.map((c) => c.name)
  const parts = spokenLines(shot, characters, opts.dialogue !== false).map((l) => {
    const language = lineLanguage(l, opts.language)
    const lower = Boolean(opts.speech?.lowercaseEnglish) && language === 'English'
    const said = l.parts
      .map((p) => [p.cue && `(${p.cue})`, p.words && `"${lower ? lowercaseEnglish(p.words, names) : p.words}"`].filter(Boolean).join(' '))
      .join(' ')
    const tone = l.delivery || 'natural'
    if (l.where === 'narrator') return `Voiceover (${tone}): ${said}`
    const where = l.where === 'off' ? 'off-screen, ' : l.where === 'behind' ? 'seen from behind, ' : ''
    return `${nameOf(l.speaker!, opts.subjects)} (${where}${tone}, ${language}): ${said}`
  })
  const sfx = opts.sound !== false && shot.sfx?.trim()
  if (sfx) parts.push(`Sound: ${sfx.replace(/[.\s]+$/, '')}.`)
  return parts.join(' ')
}

/**
 * The scene setup, richest first: 0 everything; 1 the looks shortened, the place by name; 2 without the looks;
 * 3 the style and who stands where; 4 none. Shot 1 of a shot list takes the richest that leaves room for the shot —
 * a long style must never push shot 1's own action and lines past the per-shot limit, where they would be cut off.
 */
const SETUP_LEVELS = [0, 1, 2, 3, 4] as const

interface Setup {
  style: string
  context: ClipContext
  cast: StoryCharacter[]
  subjects?: ReadonlyMap<string, string>
  named: (text: string) => string
  looks?: ClipKnobs['looks']
}

function sceneSetup(o: Setup, level: number): string {
  if (level >= 4) return ''
  const { place, light, blocking } = o.context
  const looks = o.looks === 'none' || level >= 2 ? [] : o.cast.map((c) => introOf(c, o.looks === 'short' || level >= 1, o.subjects?.get(c.id)))
  return sentences([
    o.style,
    level < 3 && placeText(place, level === 0, o.context.scene),
    level < 3 && light && `Light: ${light}`,
    ...looks,
    blocking && o.named(blocking),
  ])
}

function klingClip({ cuts, total, characters, style, context }: ClipInput, knobs: ClipKnobs = {}): CompiledClip {
  const subjects = context.subjects?.size ? context.subjects : undefined
  const named = (text: string) => (subjects ? withSubjects(text, characters, subjects) : text)
  const durations = wholeSeconds(cuts, total)
  const setup = (level: number) =>
    sceneSetup({ style, context, cast: clipCast(cuts.map((c) => c.shot), characters), subjects, named, looks: knobs.looks }, level)
  // The shot itself: what happens, the camera, then who says what and the sounds.
  const own = (c: Cut) => {
    const action = truncate(sentences([named(c.shot.prompt), c.shot.camera && cameraSentence(c.shot.camera)]), knobs.maxShotChars)
    const track = klingSoundtrack(c.shot, characters, { dialogue: knobs.dialogue, sound: knobs.sound, subjects, language: context.language, speech: context.speech })
    return flat(`${stop(action)} ${track}`)
  }
  const framed = (c: Cut) => {
    const framing = framingOf(c.shot.shotType)
    return flat(`${framing ? `${capitalise(framing)}. ` : ''}${own(c)}`)
  }

  if (context.shotList) {
    const limit = context.shotLimit
    const shots = cuts.map((c, i): CompiledShot => {
      if (i > 0) return { prompt: framed(c), duration: durations[i]! }
      const options = SETUP_LEVELS.map((level) => flat(`${stop(setup(level))} ${framed(c)}`))
      return { prompt: options.find((p) => !limit || p.length <= limit) ?? options.at(-1)!, duration: durations[0]! }
    })
    return { prompt: klingShotList(shots), shots }
  }

  const lines = cuts.map((c, i) => {
    const framing = framingOf(c.shot.shotType)
    return `Shot ${i + 1} (${framing ? `${framing}, ` : ''}${durations[i]}s): ${own(c)}`
  })
  return {
    // The setup shrinks with the ladder (short looks: the place by name too), before any line is dropped.
    prompt: [stop(setup(knobs.looks === 'none' ? 2 : knobs.looks === 'short' ? 1 : 0)), lines.join('\n')].filter(Boolean).join('\n\n'),
    shots: cuts.map((c, i) => ({ prompt: framed(c), duration: durations[i]! })),
  }
}

/** One shot as one paragraph: the scene setup, the framing and action, the camera, how it ends, the lines and sounds, one take. */
function klingShot({ shot, characters, style, camera, context, speaks, fromFrame, ending, fits }: ShotInput): string {
  const subjects = context.subjects?.size ? context.subjects : undefined
  const named = (text: string) => (subjects ? withSubjects(text, characters, subjects) : text)
  const paragraph = (knobs: ClipKnobs) => {
    const { place, light, blocking } = context
    const setup = sentences([
      style,
      placeText(place, true, context.scene),
      light && `Light: ${light}`,
      ...shotIntros(shot, characters, knobs.looks, subjects),
      blocking && named(blocking),
    ])
    const framing = framingOf(shot.shotType)
    const action = sentences([framing && capitalise(framing), named(shot.prompt), camera && cameraSentence(camera), ending && named(endingSentence(ending))])
    const track = klingSoundtrack(shot, characters, { dialogue: knobs.dialogue, sound: knobs.sound, subjects, language: context.language, speech: context.speech })
    return flat(`${stop(sentences([setup, action]))} ${track} One continuous take.`)
  }
  return firstFitting(shotLadder(speaks, fromFrame).map(paragraph), fits)
}

export const kling: DialectCompiler = {
  clip: klingClip,
  shot: klingShot,
  soundtrack: klingSoundtrack,
  clamp: (clip, limit) => {
    if (!clip.shots) return clip
    const shots = clip.shots.map((s) => ({ ...s, prompt: truncate(s.prompt, limit) }))
    return { prompt: klingShotList(shots), shots }
  },
}
