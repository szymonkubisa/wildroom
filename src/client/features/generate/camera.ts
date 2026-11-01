import { type ModelLike, modelFamily } from '@shared/models/workflow'

/**
 * Camera-move presets (Kling-style camera controls, expressed as prompt language every video model follows).
 *
 * Each preset has a model-neutral `phrase` (what story shot cards store, kept stable for saved data) plus optional
 * per-family wording in the vocabulary each model's prompt guide uses — see `cameraPhrase(presetId, model)`.
 */
export type CameraFamily = 'ltx' | 'veo' | 'kling' | 'seedance'

export interface CameraPreset {
  id: string
  label: string
  /** Model-neutral phrase; the fallback when the model is unknown or has no variant. */
  phrase: string
  /** Wording tuned per model family (LTX: plain cinematic prose; Veo: "the camera slowly dollies in"; Kling: "camera pushes in"). */
  phrases?: Partial<Record<CameraFamily, string>>
  /** One-line, plain-English description of the move (tooltips). */
  hint: string
}

// Phrases must not contain "." (the prompt's camera sentence ends at the first full stop).
export const CAMERA_PRESETS: CameraPreset[] = [
  {
    id: 'static',
    label: 'Static',
    phrase: 'locked-off static camera on a tripod',
    hint: 'The camera does not move',
    phrases: {
      ltx: 'static locked-off shot, the camera stays completely still',
      veo: 'a static shot on a tripod, the camera does not move',
      kling: 'fixed camera, no camera movement',
      seedance: 'fixed lens, the camera stays still',
    },
  },
  {
    id: 'push-in',
    label: 'Push in',
    phrase: 'slow dolly push-in towards the subject',
    hint: 'Moves closer to the subject',
    phrases: {
      ltx: 'slow dolly push-in toward the subject',
      veo: 'the camera slowly dollies in toward the subject',
      kling: 'camera slowly pushes in on the subject',
      seedance: 'the camera slowly pushes in toward the subject',
    },
  },
  {
    id: 'pull-out',
    label: 'Pull out',
    phrase: 'slow dolly pull-out revealing the surroundings',
    hint: 'Moves away, revealing more of the scene',
    phrases: {
      ltx: 'slow dolly pull-back, gradually revealing the surroundings',
      veo: 'the camera slowly dollies out, revealing the wider scene',
      kling: 'camera slowly pulls back to reveal the surroundings',
      seedance: 'the camera slowly pulls out to reveal the surroundings',
    },
  },
  {
    id: 'pan-left',
    label: 'Pan left',
    phrase: 'smooth pan from right to left',
    hint: 'Turns to the left on the spot',
    phrases: {
      ltx: 'the camera pans slowly to the left',
      veo: 'the camera slowly pans left across the scene',
      kling: 'camera pans left',
      seedance: 'the camera pans to the left',
    },
  },
  {
    id: 'pan-right',
    label: 'Pan right',
    phrase: 'smooth pan from left to right',
    hint: 'Turns to the right on the spot',
    phrases: {
      ltx: 'the camera pans slowly to the right',
      veo: 'the camera slowly pans right across the scene',
      kling: 'camera pans right',
      seedance: 'the camera pans to the right',
    },
  },
  {
    id: 'tilt-up',
    label: 'Tilt up',
    phrase: 'slow tilt up',
    hint: 'Tips upward on the spot',
    phrases: {
      ltx: 'the camera tilts slowly upward',
      veo: 'the camera slowly tilts up',
      kling: 'camera tilts up',
      seedance: 'the camera tilts upward',
    },
  },
  {
    id: 'tilt-down',
    label: 'Tilt down',
    phrase: 'slow tilt down',
    hint: 'Tips downward on the spot',
    phrases: {
      ltx: 'the camera tilts slowly downward',
      veo: 'the camera slowly tilts down',
      kling: 'camera tilts down',
      seedance: 'the camera tilts downward',
    },
  },
  {
    id: 'orbit',
    label: 'Orbit',
    phrase: 'camera orbits around the subject in a smooth arc',
    hint: 'Circles around the subject',
    phrases: {
      ltx: 'the camera circles slowly around the subject in a smooth arc',
      veo: 'the camera arcs smoothly around the subject',
      kling: 'camera orbits around the subject',
      seedance: 'surround shot, the camera circles around the subject',
    },
  },
  {
    id: 'tracking',
    label: 'Tracking',
    phrase: 'tracking shot following the subject at walking pace',
    hint: 'Travels alongside a moving subject',
    phrases: {
      ltx: 'the camera tracks alongside the subject at walking pace',
      veo: 'a tracking shot, the camera follows the subject at walking pace',
      kling: 'camera follows the subject, tracking shot',
      seedance: 'follow shot, the camera follows the subject as it moves',
    },
  },
  {
    id: 'crane-up',
    label: 'Crane up',
    phrase: 'crane shot rising up and over the scene',
    hint: 'Rises up high above the scene',
    phrases: {
      ltx: 'the camera cranes up, rising high above the scene',
      veo: 'a crane shot, the camera rises up and over the scene',
      kling: 'camera rises upward in a crane shot',
      seedance: 'the camera rises into a high aerial view of the scene',
    },
  },
  {
    id: 'handheld',
    label: 'Handheld',
    phrase: 'handheld camera with subtle natural shake',
    hint: 'Slight, natural shake',
    phrases: {
      ltx: 'handheld camera with subtle, natural shake',
      veo: 'handheld camera with a subtle, natural shake',
      kling: 'handheld camera, slight shake',
      seedance: 'handheld shot with slight natural shake',
    },
  },
  {
    id: 'fpv',
    label: 'FPV drone',
    phrase: 'fast FPV drone flight swooping through the scene',
    hint: 'Fast drone flight that banks through the scene',
    phrases: {
      ltx: 'fast FPV drone shot, diving and banking through the scene',
      veo: 'a fast FPV drone shot swooping and banking through the scene',
      kling: 'FPV drone shot, camera flies fast through the scene',
      seedance: 'fast FPV drone shot flying through the scene',
    },
  },
  {
    id: 'dolly-zoom',
    label: 'Dolly zoom',
    phrase: 'vertigo dolly zoom, the background stretches while the subject stays the same size',
    hint: 'Subject stays the same size while the background warps',
    phrases: {
      ltx: 'vertigo dolly zoom, the subject stays the same size while the background stretches away',
      veo: 'a dolly zoom, the subject stays the same size while the background warps behind them',
      kling: 'dolly zoom, the background stretches while the subject stays the same size',
      seedance: 'dolly zoom, the background stretches while the subject stays the same size',
    },
  },
  {
    id: 'rack-focus',
    label: 'Rack focus',
    phrase: 'rack focus from the foreground to the subject',
    hint: 'Focus shifts from the foreground to the subject',
    phrases: {
      ltx: 'shallow depth of field, focus shifts from the blurred foreground to the subject',
      veo: 'a rack focus shifts from the foreground to the subject',
      kling: 'rack focus, focus shifts from the foreground to the subject',
      seedance: 'focus pulls from the foreground to the subject',
    },
  },
]

/** Which prompt dialect a model speaks for camera moves (its model family, see modelFamily); `undefined` → the neutral default. */
export function cameraFamily(model?: ModelLike): CameraFamily | undefined {
  const family = modelFamily(model)
  return family === 'happyhorse' ? undefined : family
}

export const CAMERA_FAMILY_LABELS: Record<CameraFamily, string> = { ltx: 'LTX', veo: 'Veo', kling: 'Kling', seedance: 'Seedance' }

/** The phrase for a preset in the model's own camera vocabulary (falls back to the neutral phrase). */
export function cameraPhrase(presetId: string, model?: ModelLike): string | undefined {
  const preset = CAMERA_PRESETS.find((p) => p.id === presetId)
  if (!preset) return undefined
  const family = cameraFamily(model)
  return (family && preset.phrases?.[family]) || preset.phrase
}

/** Every wording of a preset (neutral first), so prompts written for another model are still recognised. */
function phrasesOf(preset: CameraPreset): string[] {
  return [preset.phrase, ...Object.values(preset.phrases ?? {})]
}

/** Phrases that read as a sentence of their own ("The camera slowly dollies in.") instead of after a "Camera:" label. */
const SELF_STANDING = /^(the )?camera\b/i

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** How a phrase reads in a prompt: "The camera slowly dollies in." or "Camera: slow dolly push-in." */
export function cameraSentence(phrase: string): string {
  return SELF_STANDING.test(phrase) ? `${capitalise(phrase)}.` : `Camera: ${phrase}.`
}

/** A self-standing preset phrase as a whole sentence (start of prompt or after . ! ?, ending in a full stop or the end). */
function sentenceRe(phrase: string, flags = 'i'): RegExp {
  return new RegExp(`(?:^|(?<=[.!?]))\\s*${escapeRe(phrase)}(?:\\.(?=\\s|$)|$)`, flags)
}

const CAMERA_SENTENCE = /\s*Camera:[^.]*\.?/gi
const SELF_STANDING_PHRASES = CAMERA_PRESETS.flatMap(phrasesOf).filter((p) => SELF_STANDING.test(p))

/** Replaces (or adds) the camera sentence at the end of a prompt; `undefined` removes it. */
export function withCamera(prompt: string, phrase: string | undefined): string {
  let base = prompt.replace(CAMERA_SENTENCE, '')
  for (const p of SELF_STANDING_PHRASES) base = base.replace(sentenceRe(p, 'gi'), '')
  base = base.trim()
  if (!phrase) return base
  return `${base}${base && !/[.!?]$/.test(base) ? '.' : ''}${base ? ' ' : ''}${cameraSentence(phrase)}`
}

/** The preset the prompt currently uses and the exact wording it uses, if any. */
export function cameraMatch(prompt: string): { preset: CameraPreset; phrase: string } | undefined {
  const m = /Camera:\s*([^.]*)/i.exec(prompt)
  if (m) {
    const said = m[1]!.trim().toLowerCase()
    for (const preset of CAMERA_PRESETS) {
      const phrase = phrasesOf(preset).find((p) => p.toLowerCase() === said)
      if (phrase) return { preset, phrase }
    }
  }
  for (const preset of CAMERA_PRESETS) {
    const phrase = phrasesOf(preset).find((p) => SELF_STANDING.test(p) && sentenceRe(p).test(prompt))
    if (phrase) return { preset, phrase }
  }
  return undefined
}

/** The preset whose phrase (in any model's wording) the prompt currently uses, if any. */
export function cameraOf(prompt: string): CameraPreset | undefined {
  return cameraMatch(prompt)?.preset
}
