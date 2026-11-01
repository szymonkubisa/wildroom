/**
 * LTX-2.5 (and every model of no known family): Lightricks' prompting guide and Licon's MSR template — prose cuts
 * ("A hard cut transitions to…"), no labelled fields or seconds, "Image n" reference blocks, the camera axis held
 * across the cuts.
 */
import { audioBlock, castLooks, subjectsPreamble, withSubjects } from '../cast'
import { cameraProse, multishotPrompt, sentences, withoutBackdrop } from '../multishot'
import { soundtrackPrompt } from '../soundtrack'
import { type ClipContext, type DialectCompiler, type ShotInput, endingSentence } from './common'

/** The context as multishotPrompt reads it. */
const ltxContext = (c: ClipContext) => ({
  subjects: c.subjects,
  voices: c.voices,
  blocking: c.blocking,
  language: c.language,
  scene: c.scene,
  light: c.light,
  styleAsIs: c.styleAsIs,
  fromFrame: c.fromFrame,
})

/** A lip-synced shot's camera: Lightricks — no motion or pacing cues when the clip follows recorded lines. */
const STILL_CAMERA = 'The camera holds still.'

/** A close-up or an insert shows one face or a pair of hands: the whole scene's blocking pulled it wide. */
const CLOSE = /\bclose[- ]?up\b|\bCU\b|\bECU\b|\binsert\b|\bmacro\b/i
const OVER_SHOULDER = /over[- ]the[- ]shoulder|\bOTS\b/i

/**
 * One shot by Lightricks' prompting guide: the shot (framing), the action, how it ends, the scene (the story's look
 * and light), the characters (their looks from the Cast), where they stand, the camera, then the sound; from a start
 * frame only the action, how it ends, the camera and the sound. With references (no start frame) it opens with
 * Licon's "Image 1: …" blocks and the scene. When the dialogue runs past the model's prompt limit the sounds go first,
 * then the dialogue.
 */
function ltxShot({ shot, characters: chars, style, camera: phrase, context, speaks, fromFrame, ending, lipSync, fits }: ShotInput): string {
  const camera = lipSync ? STILL_CAMERA : phrase && cameraProse(phrase)
  const subjects = context.subjects?.size ? context.subjects : undefined
  const voices = context.voices?.size ? context.voices : undefined
  const named = (text: string) => (subjects ? withSubjects(text, chars, subjects) : text)
  const voiceLines =
    voices &&
    [...voices].map(([id, audio]) => audioBlock(audio, chars.find((c) => c.id === id), subjects!.get(id) ?? id)).join('. ')
  const sceneLine = context.scene && `${context.scene.token}: Scene, ${context.scene.description.trim().replace(/[.\s]+$/, '')}`
  const intro = subjects ? sentences([subjectsPreamble(chars, subjects), sceneLine, voiceLines]) : undefined
  const framing =
    shot.shotType?.trim() &&
    `${named(/\bshot$/i.test(shot.shotType.trim()) ? shot.shotType.trim() : `${shot.shotType.trim()} shot`)}${context.scene ? ` in ${context.scene.name} matching ${context.scene.token}` : ''}`
  const close = CLOSE.test(shot.shotType ?? '') && !OVER_SHOULDER.test(shot.shotType ?? '')
  const blocking = close ? undefined : context.blocking
  const light = context.light
  const lit = light && light.charAt(0).toUpperCase() + light.slice(1)
  const end = ending && named(endingSentence(ending))
  // The shot names its characters; their looks come from the Cast (in full, or who they are when that's too long). The
  // action comes right after the framing (the guide: it belongs at the front), how it ends after it, the camera move
  // last, all in prose. From a keyframe only what happens next: the frame already shows the place, the people and the
  // light — what is behind them too ("Behind him: …") — and describing them again makes the picture drift
  // (Lightricks' image-to-video advice).
  const base = (short: boolean) =>
    fromFrame
      ? `${sentences([named(withoutBackdrop(shot.prompt)), end, camera && named(camera)])}.`
      : `${sentences([intro, framing, named(shot.prompt), end, style, lit, castLooks(shot, chars, short, subjects), blocking && named(blocking), camera && named(camera)])}.`
  const candidates: string[] = []
  for (const short of fromFrame ? [true] : [false, true]) {
    if (speaks) {
      for (const sound of [true, false]) {
        const track = soundtrackPrompt(shot, chars, { sound, subjects, voices, language: context.language, brief: fromFrame, wordsOnly: lipSync })
        candidates.push(track ? `${base(short)}\n\n${track}` : base(short))
      }
    }
    candidates.push(base(short))
  }
  return candidates.find(fits) ?? candidates.at(-1)!
}

export const ltx: DialectCompiler = {
  // Each look once, by who they are: restated in every shot they made 456-word prompts (see multishotPrompt).
  clip: ({ cuts, total, characters, style, context }, knobs = {}) => ({
    prompt: multishotPrompt(cuts, total, characters, style, { ...knobs, looks: knobs.looks === 'none' ? 'none' : 'once', ...ltxContext(context) }),
  }),
  shot: ltxShot,
  soundtrack: (shot, characters, opts = {}) =>
    soundtrackPrompt(shot, characters, { dialogue: opts.dialogue, sound: opts.sound, subjects: opts.subjects, voices: opts.voices, language: opts.language }),
}
