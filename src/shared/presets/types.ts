/** A model that suits a preset, with the settings that make it fit the job. */
export interface PresetCandidate {
  modelId: string
  /** One line shown under the model picker: why this model for this job. */
  why: string
  /** Model-specific overrides on top of the preset's params, e.g. `{ resolution: '4MP' }`. */
  params?: Record<string, unknown>
  /** Caveat shown with the pick (cost, licence, limits). */
  note?: string
}

export type PresetGroup = 'Photo' | 'Design & text' | 'Marketing' | 'Film' | 'Edit & reference' | 'Drafts'

export type PresetInput = 'firstFrame' | 'lastFrame' | 'referenceImages' | 'video'

/** A job ("Product shot", "Animate a still"…) mapped to ranked models and starting settings. */
export interface GenPreset {
  id: string
  kind: 'image' | 'video'
  group: PresetGroup
  label: string
  blurb: string
  /** Inputs the job needs; only models with these params are candidates, and Generate refuses to start without them. */
  needs?: PresetInput[]
  /** Model-agnostic starting values (aspectRatio, duration, audio…), snapped onto each model's own options. */
  params?: Record<string, unknown>
  /** Shown as the prompt placeholder. */
  promptExample?: string
  /** Best first; later ones are fallbacks when a provider isn't connected. */
  candidates: PresetCandidate[]
}
