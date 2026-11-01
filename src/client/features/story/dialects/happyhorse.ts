/**
 * Alibaba's Happy Horse 1.1: prose beats — "Begin with <shot 1>… Cut to <shot 2>… End on <last shot>…" — with the
 * reference images named character1…characterN in the order they are sent, dialogue as
 * `characterN says in a <tone> voice: "line"` (the lip-sync follows the line's language), and the closing
 * "Preserve the exact appearance of each character." It takes references or a start frame, never both (the planner
 * falls back to the start frame alone).
 */
import { cameraSentence } from '@/features/generate/camera'
import type { StoryCharacter, StoryShot } from '@shared/types/story'
import { withSubjects } from '../cast'
import { type ClipKnobs, sentences } from '../multishot'
import { quoted } from '../soundtrack'
import {
  type ClipInput,
  type CompiledClip,
  type DialectCompiler,
  type DialectSoundtrackOptions,
  type ShotInput,
  article,
  capitalise,
  clipCast,
  endingSentence,
  firstFitting,
  framingOf,
  introOf,
  nameOf,
  oneLine,
  placeText,
  shotIntros,
  shotLadder,
  spokenLines,
  stop,
  truncate,
  voicePhrase,
} from './common'

export const PRESERVE_CHARACTERS = 'Preserve the exact appearance of each character.'

function happyHorseSoundtrack(shot: StoryShot, characters: StoryCharacter[], opts: DialectSoundtrackOptions = {}): string {
  const language = opts.language && opts.language !== 'English' ? ` in ${opts.language}` : ''
  const parts = spokenLines(shot, characters, opts.dialogue !== false).map((l) => {
    const said = `${voicePhrase(l.delivery)}: ${quoted(l.parts)}`
    if (l.where === 'narrator') return `A narrator says${language} ${said}`
    const where = l.where === 'off' ? ', off-screen,' : l.where === 'behind' ? ', seen from behind,' : ''
    return `${nameOf(l.speaker!, opts.subjects)}${where} says${language} ${said}`
  })
  const sfx = opts.sound !== false && shot.sfx?.trim()
  if (sfx) parts.push(`Sound: ${sfx.replace(/[.\s]+$/, '')}.`)
  return parts.join(' ')
}

function happyHorseClip({ cuts, characters, style, context }: ClipInput, knobs: ClipKnobs = {}): CompiledClip {
  const subjects = context.subjects?.size ? context.subjects : undefined
  const named = (text: string) => (subjects ? withSubjects(text, characters, subjects) : text)
  const cast = clipCast(cuts.map((c) => c.shot), characters)
  const looks = knobs.looks === 'none' ? [] : cast.map((c) => introOf(c, knobs.looks === 'short', subjects?.get(c.id)))
  const intro = sentences([style, placeText(context.place, true), context.light && `Light: ${context.light}`, ...looks, context.blocking && named(context.blocking)])
  const beats = cuts.map((c, i) => {
    const lead = i === 0 ? 'Begin with' : i === cuts.length - 1 ? 'End on' : 'Cut to'
    const framing = framingOf(c.shot.shotType)
    const what = framing ? `${article(framing)} ${framing}` : i === 0 ? 'the opening shot' : 'the next shot'
    const seconds = Math.max(1, Math.round(c.end - c.start))
    const body = truncate(sentences([named(c.shot.prompt), c.shot.camera && cameraSentence(c.shot.camera)]), knobs.maxShotChars)
    const track = happyHorseSoundtrack(c.shot, characters, { dialogue: knobs.dialogue, sound: knobs.sound, subjects, language: context.language })
    return oneLine(`${lead} ${what}, about ${seconds} second${seconds === 1 ? '' : 's'}: ${stop(body)} ${track}`)
  })
  return { prompt: [stop(intro), ...beats, cast.length ? PRESERVE_CHARACTERS : ''].filter(Boolean).join('\n\n') }
}

/** One shot as one paragraph: the look and place, who is who, the framing and action, the camera, how it ends, the lines, the closing. */
function happyHorseShot({ shot, characters, style, camera, context, fromFrame, speaks, ending, fits }: ShotInput): string {
  const subjects = context.subjects?.size ? context.subjects : undefined
  const named = (text: string) => (subjects ? withSubjects(text, characters, subjects) : text)
  const closing = clipCast([shot], characters).length ? PRESERVE_CHARACTERS : ''
  const paragraph = (knobs: ClipKnobs) => {
    const framing = framingOf(shot.shotType)
    const visual = sentences([
      style,
      placeText(context.place, true),
      context.light && `Light: ${context.light}`,
      ...shotIntros(shot, characters, knobs.looks, subjects),
      context.blocking && named(context.blocking),
      framing && capitalise(framing),
      named(shot.prompt),
      camera && cameraSentence(camera),
      ending && named(endingSentence(ending)),
    ])
    const track = happyHorseSoundtrack(shot, characters, { dialogue: knobs.dialogue, sound: knobs.sound, subjects, language: context.language })
    return oneLine(`${stop(visual)} ${track} ${closing}`)
  }
  return firstFitting(shotLadder(speaks, fromFrame).map(paragraph), fits)
}

export const happyhorse: DialectCompiler = { clip: happyHorseClip, shot: happyHorseShot, soundtrack: happyHorseSoundtrack }
