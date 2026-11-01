/**
 * What the storyboard's model pickers and notes say about a video model, pure: short names for take badges, the
 * identity sources a group can be made from and what each means for the model, capability chips, the languages it
 * speaks, how it uses the Cast. Everything comes from the model's workflow profile (see @shared/models/workflow).
 */
import { formatPerSecond, languageCode, perSecondUsd, shortModelLabel } from '@shared/models/info'
import type { ModelSpec, ParamValues } from '@shared/models/types'
import { type IdentitySource, type VideoWorkflow, workflowFor } from '@shared/models/workflow'
import { speaksAudio } from './soundtrack'

const listed = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : (xs[0] ?? ''))

// ------------------------------------------------------------------------------------ names

/** Short names, per-second prices and language codes: shared now (the Composer's model picker uses them too). */
export { formatPerSecond, languageCode, perSecondUsd, shortModelLabel }

/**
 * The models a "Render with…" choice offers: ready video models that can start a storyboard render — from a keyframe
 * or from the cast (not an extend-only model or a custom endpoint, whose workflow has no source).
 */
export function storyboardModels(models: ModelSpec[]): ModelSpec[] {
  return models.filter((m) => m.kind === 'video' && workflowFor(m).sources.length > 0)
}

// ------------------------------------------------------------------------------------ identity sources

/** What a source is called for the model: "First keyframe", its cast's name ("Kling elements", "Ingredients"…), or both. */
export function sourceLabel(source: IdentitySource, workflow: VideoWorkflow): string {
  const cast = workflow.cast?.label
  if (source === 'keyframe') return 'First still'
  if (source === 'references') return cast ?? 'References'
  return `Still + ${cast ?? 'cast'}`
}

/** How the cuts go in, for the explanations: "Kling's native shot list", "timestamps"… */
function cutsText(workflow: VideoWorkflow): string {
  switch (workflow.multishot.method) {
    case 'native':
      return workflow.dialect === 'kling' ? 'the cuts as Kling’s native shot list' : 'the cuts as the model’s own shot list'
    case 'timestamps':
      return 'the cuts as timestamps ([00:00-00:03] …)'
    case 'beats':
      return 'the cuts as beats (“Begin with… Cut to… End on…”)'
    default:
      return 'the cuts written out in the prompt'
  }
}

/**
 * What a group made from `source` gets with this model, short and factual. `first` is the group's first shot number
 * (its keyframe starts the clip).
 */
export function sourceExplanation(source: IdentitySource, workflow: VideoWorkflow, first: number | string): string {
  const cast = workflow.cast
  const cuts = cutsText(workflow)
  const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  switch (workflow.dialect) {
    case 'ltx':
      if (source === 'references')
        return 'From the cast’s and the place’s reference images (Licon MSR): one scene with its cuts, faces and sides kept; the stills aren’t used. No stills go in at the cuts or the end — LTX would morph towards them instead of cutting.'
      return `From shot ${first}’s still, the later shots from the prompt: the first shot looks like its still, but LTX tends to add cuts of its own and drift after them. For shots that must match their stills, break the group up and animate each shot. No stills go in at the cuts or the end — LTX would morph towards them instead of cutting.`
    case 'kling':
      if (source === 'both')
        return `The first still starts the clip; characters with extra angles go in as Kling elements and ${cuts}.`
      if (source === 'references')
        return cast?.param === 'elements'
          ? `No start frame: characters synced to Kling’s element library go in as elements, ${cuts}; the stills aren’t used.`
          : `No start frame: characters with extra angles go in as Kling elements, the place’s photo and front-only characters as reference images, ${cuts}; the stills aren’t used.`
      return `From shot ${first}’s still as the start frame, ${cuts}; the cast is described in words.`
    case 'veo':
      if (source === 'references')
        return `Up to ${cast?.max ?? 3} character pictures; Veo renders exactly ${cast?.fixedSeconds ?? 8} s and takes no start frame. ${capital(cuts)}.`
      return `From shot ${first}’s still as the start frame, ${cuts}; the cast is described in words.`
    case 'happyhorse':
      if (source === 'references')
        return `Up to ${cast?.max ?? 9} character pictures, named character1…; no start frame with references. ${capital(cuts)}.`
      return `From shot ${first}’s still as the start frame — with a start frame Happy Horse takes no character pictures. ${capital(cuts)}.`
    default:
      if (source === 'references') return `From the cast’s reference pictures, no start frame; the stills aren’t used. ${capital(cuts)}.`
      if (source === 'both') return `From shot ${first}’s still as the start frame, with the cast’s pictures as references; ${cuts}.`
      return `From shot ${first}’s still as the start frame, the later shots from the prompt.`
  }
}

/** Why a group can't be made from `source` with this model (what the story is missing). */
export function sourceBlocker(source: IdentitySource, workflow: VideoWorkflow, opts: { first: number | string; hasKeyframe: boolean }): string {
  if (!workflow.sources.includes(source)) return 'this model doesn’t offer it'
  if (source !== 'references' && !opts.hasKeyframe) return `needs shot ${opts.first}’s still`
  if (source === 'keyframe') return `needs shot ${opts.first}’s still`
  const cast = workflow.cast
  if (cast?.param === 'elements') return 'needs a character synced to Kling (Cast panel)'
  if (cast?.needsAngles) return 'needs a character with a front view and another angle (Cast panel)'
  return 'needs a picture of someone in these shots (Cast panel)'
}

// ------------------------------------------------------------------------------------ capabilities

export interface Chip {
  text: string
  title: string
}



/** The cast chip: "Elements 3", "Ingredients 3", "Refs 9". */
function castChip(workflow: VideoWorkflow): Chip | undefined {
  const cast = workflow.cast
  if (!cast) return undefined
  const n = Math.max(cast.max, cast.maxWithKeyframe)
  if (cast.param === 'elements' || cast.param === 'elementImages')
    return { text: `Elements ${n}`, title: `Up to ${n} characters as Kling elements (a front view plus 1–3 angles each)` }
  if (cast.label === 'Ingredients') return { text: `Ingredients ${n}`, title: `Up to ${n} character pictures as Veo ingredients` }
  return { text: `Refs ${n}`, title: `Up to ${n} character pictures (${cast.label})` }
}

/**
 * What a model can do, as small chips beside its name: shots per clip, how many characters go in as pictures, the
 * languages it speaks (when it makes sound and not every language), about what a second costs.
 */
export function capabilityChips(model: ModelSpec, settings: ParamValues = {}, workflow: VideoWorkflow = workflowFor(model)): Chip[] {
  const out: Chip[] = []
  const { maxShots, maxSeconds, method } = workflow.multishot
  out.push({
    text: `Multi-shot ≤${maxShots}`,
    title: `Up to ${maxShots} shots and ${maxSeconds} s per clip${method === 'native' ? ', as its own shot list' : ''}`,
  })
  const cast = castChip(workflow)
  if (cast) out.push(cast)
  const languages = workflow.speech.languages
  if (Array.isArray(languages) && languages.length && speaksAudio(model, settings))
    out.push({ text: `${languages.map(languageCode).join('/')} speech`, title: `Speaks ${listed(languages)}; lines in other languages get translated` })
  const usd = perSecondUsd(model, settings)
  if (usd !== undefined) out.push({ text: formatPerSecond(usd), title: 'About what a second of video costs with the story’s render settings' })
  return out
}

/** A one-line hint for a model in a "Render with…" menu: "≤6 shots · 15 s · Elements 3" (a single shot: "≤15 s · Refs 4"). */
export function modelHint(workflow: VideoWorkflow, opts: { group?: boolean } = {}): string {
  const { maxShots, maxSeconds } = workflow.multishot
  const cast = castChip(workflow)?.text
  return [opts.group ? `≤${maxShots} shots · ${maxSeconds} s` : `≤${maxSeconds} s`, cast].filter(Boolean).join(' · ')
}

// ------------------------------------------------------------------------------------ speech

/** The model voices lines in `language` (no language known, or a model that speaks any, counts as yes). */
export function speaksLanguage(workflow: VideoWorkflow, language?: string): boolean {
  const languages = workflow.speech.languages
  return !language || languages === 'any' || languages.includes(language)
}

/** "Kling 3.0 speaks English and Chinese — Polish lines will be translated." when it doesn't speak the story's language. */
export function speechWarning(model: ModelSpec, workflow: VideoWorkflow, language?: string): string | undefined {
  if (!language || speaksLanguage(workflow, language)) return undefined
  const languages = workflow.speech.languages as string[]
  return `${shortModelLabel(model)} speaks ${listed(languages)} — ${language} lines will be translated.`
}

/**
 * A ready model that voices `language` itself, to switch a group or shot to: the preferred one (the story's model)
 * when it does, else the first that does.
 */
export function modelSpeaking(
  language: string,
  models: ModelSpec[],
  opts: { preferred?: ModelSpec; except?: ModelSpec; settingsFor?: (m: ModelSpec) => ParamValues } = {},
): ModelSpec | undefined {
  const ok = (m: ModelSpec) =>
    m.id !== opts.except?.id && speaksLanguage(workflowFor(m), language) && speaksAudio(m, opts.settingsFor?.(m) ?? {}) && workflowFor(m).sources.length > 0
  if (opts.preferred && ok(opts.preferred)) return opts.preferred
  return models.find(ok)
}

// ------------------------------------------------------------------------------------ the cast

/** How the model uses each character's pictures, for the Cast panel ("Kling elements: front + 1–3 angles…"). */
export function castUsage(model: ModelSpec | undefined, workflow: VideoWorkflow = workflowFor(model)): string | undefined {
  if (!model) return undefined
  const cast = workflow.cast
  const name = shortModelLabel(model)
  if (!cast) return `${name} takes no character pictures — they shape the stills only.`
  const n = Math.max(cast.max, cast.maxWithKeyframe)
  if (cast.param === 'elements') return 'Kling elements: front + 1–3 angles, synced to Kling below (characters without angles stay text).'
  if (cast.param === 'elementImages')
    return workflow.scene?.param === 'referenceImages'
      ? `Kling elements: front + 1–3 angles, up to ${n} characters (a front view alone goes in as a reference picture).`
      : `Kling elements: front + 1–3 angles, up to ${n} characters (characters without angles stay text).`
  switch (workflow.dialect) {
    case 'veo':
      return `Veo ingredients: up to ${n} pictures (front views${cast.fixedSeconds ? `; clips from them run ${cast.fixedSeconds} s` : ''}).`
    case 'happyhorse':
      return `Happy Horse: up to ${n} characters (front views), as character1…`
    case 'ltx':
      return `LTX: front view as Image N, up to ${n}${cast.voices ? '; the voice sample as Audio N' : ''}.`
    default:
      return workflow.scene?.param === 'referenceImages'
        ? `${name}: front view as a reference picture, up to ${n}, then the place’s photo (from references only, not with a start frame).`
        : `${name}: front view as a reference picture, up to ${n}.`
  }
}
