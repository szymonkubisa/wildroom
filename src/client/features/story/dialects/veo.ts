/**
 * Veo 3.1, after Google's prompting guide: Cinematography + Subject + Action + Context + Style, then the audio. A
 * multi-shot clip is timestamped — `[00:00-00:03] framing: action. camera.` — the segments covering the clip from
 * 0 s to its end, in order. Dialogue reads `Name says in a <tone> voice, "line"` (a narrator: `A narrator says…`),
 * sounds as `SFX:` and the place's sound as `Ambient noise:`. Everything is phrased positively: what to avoid goes to
 * the negative prompt (NO_SUBTITLES, styleFor).
 */
import { cameraSentence } from '@/features/generate/camera'
import type { StoryCharacter, StoryShot } from '@shared/types/story'
import { withSubjects } from '../cast'
import { type ClipKnobs, sentences } from '../multishot'
import { quoted } from '../soundtrack'
import {
  type ClipContext,
  type ClipInput,
  type CompiledClip,
  type DialectCompiler,
  type DialectSoundtrackOptions,
  type ShotInput,
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
  timestamp,
  truncate,
  voicePhrase,
  wholeSeconds,
} from './common'

function veoSoundtrack(shot: StoryShot, characters: StoryCharacter[], opts: DialectSoundtrackOptions = {}): string {
  const language = opts.language && opts.language !== 'English' ? ` in ${opts.language}` : ''
  const parts = spokenLines(shot, characters, opts.dialogue !== false).map((l) => {
    const said = `${voicePhrase(l.delivery)}, ${quoted(l.parts)}`
    if (l.where === 'narrator') return `A narrator says${language} ${said}`
    const where = l.where === 'off' ? ', off-screen,' : l.where === 'behind' ? ', seen from behind,' : ''
    return `${nameOf(l.speaker!, opts.subjects)}${where} says${language} ${said}`
  })
  const sfx = opts.sound !== false && shot.sfx?.trim()
  if (sfx) parts.push(`SFX: ${sfx.replace(/[.\s]+$/, '')}.`)
  return parts.join(' ')
}

/** The place's sound, the same under every cut. */
const ambient = (context: ClipContext, clip: boolean) =>
  context.place?.name.trim() ? `Ambient noise: the natural ambience of ${context.place.name.trim()}${clip ? ', continuous across every cut' : ''}.` : ''

function veoClip({ cuts, total, characters, style, context }: ClipInput, knobs: ClipKnobs = {}): CompiledClip {
  const subjects = context.subjects?.size ? context.subjects : undefined
  const named = (text: string) => (subjects ? withSubjects(text, characters, subjects) : text)
  const durations = wholeSeconds(cuts, total)
  const looks = knobs.looks === 'none' ? [] : clipCast(cuts.map((c) => c.shot), characters).map((c) => introOf(c, knobs.looks === 'short', subjects?.get(c.id)))
  // Subject and context once, at the top: who they are, the place, its light, who stands where.
  const header = sentences([...looks, placeText(context.place, true), context.light && `Light: ${context.light}`, context.blocking && named(context.blocking)])
  let t = 0
  const segments = cuts.map((c, i) => {
    const start = t
    t += durations[i]!
    const framing = framingOf(c.shot.shotType)
    const action = truncate(named(c.shot.prompt).trim(), knobs.maxShotChars)
    const visual = sentences([framing ? `${capitalise(framing)}: ${action}` : action, c.shot.camera && cameraSentence(c.shot.camera)])
    const track = veoSoundtrack(c.shot, characters, { dialogue: knobs.dialogue, sound: knobs.sound, subjects, language: context.language })
    return { line: `[${timestamp(start)}-${timestamp(t)}] ${oneLine(`${stop(visual)} ${track}`)}`, prompt: oneLine(`${stop(visual)} ${track}`), duration: durations[i]! }
  })
  return {
    prompt: [stop(header), segments.map((s) => s.line).join('\n'), knobs.sound !== false && ambient(context, true), stop(style)].filter(Boolean).join('\n\n'),
    shots: segments.map((s) => ({ prompt: s.prompt, duration: s.duration })),
  }
}

/** One shot in the guide's order: cinematography, subject, action (and how it ends), context, style — then the dialogue and sounds. */
function veoShot({ shot, characters, style, camera, context, fromFrame, speaks, ending, fits }: ShotInput): string {
  const subjects = context.subjects?.size ? context.subjects : undefined
  const named = (text: string) => (subjects ? withSubjects(text, characters, subjects) : text)
  const paragraph = (knobs: ClipKnobs) => {
    const framing = framingOf(shot.shotType)
    const visual = sentences([
      framing && capitalise(framing),
      camera && cameraSentence(camera),
      ...shotIntros(shot, characters, knobs.looks, subjects),
      named(shot.prompt),
      ending && named(endingSentence(ending)),
      placeText(context.place, true),
      context.light && `Light: ${context.light}`,
      context.blocking && named(context.blocking),
      style,
    ])
    const track = [
      veoSoundtrack(shot, characters, { dialogue: knobs.dialogue, sound: knobs.sound, subjects, language: context.language }),
      knobs.sound !== false && ambient(context, false),
    ]
      .filter(Boolean)
      .join(' ')
    return track ? `${stop(visual)}\n\n${track}` : stop(visual)
  }
  return firstFitting(shotLadder(speaks, fromFrame).map(paragraph), fits)
}

export const veo: DialectCompiler = { clip: veoClip, shot: veoShot, soundtrack: veoSoundtrack }
