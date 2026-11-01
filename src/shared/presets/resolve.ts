import { fitValue, isBlank } from '../models/fit'
import { allModels, getModel } from '../models/registry'
import type { ModelSpec, ParamValues } from '../models/types'
import type { GenPreset, PresetCandidate } from './types'

export interface PresetOption {
  model: ModelSpec
  candidate: PresetCandidate
  ready: boolean
}

export interface ResolvedPreset extends PresetOption {
  params: ParamValues
  /** The preset's other usable models, in rank order. */
  alternatives: PresetOption[]
}

/**
 * The preset's candidates that exist and take every input the job needs, in rank order. A candidate whose provider
 * isn't connected is swapped for its twin from a connected one (e.g. fal's GPT Image 2.5 → OpenRouter's).
 */
export function presetOptions(preset: GenPreset, isReady: (model: ModelSpec) => boolean): PresetOption[] {
  const out: PresetOption[] = []
  for (const candidate of preset.candidates) {
    const ranked = getModel(candidate.modelId)
    if (!ranked || ranked.kind !== preset.kind) continue
    const model = isReady(ranked) ? ranked : (allModels().find((m) => m.twinOf === ranked.id && isReady(m)) ?? ranked)
    if (!(preset.needs ?? []).every((key) => model.params.some((p) => p.key === key))) continue
    if (out.some((o) => o.model.id === model.id)) continue
    out.push({ model, candidate, ready: isReady(model) })
  }
  return out
}

/** The values a preset sets on one of its models — only the keys it names, so the model's other settings stay as they are. */
export function presetParams(preset: GenPreset, option: Pick<PresetOption, 'model' | 'candidate'>): ParamValues {
  const desired: Record<string, unknown> = { ...preset.params, ...option.candidate.params }
  const out: ParamValues = {}
  for (const p of option.model.params) {
    const fitted = isBlank(desired[p.key]) ? undefined : fitValue(p, desired[p.key])
    if (fitted !== undefined) out[p.key] = fitted
  }
  return out
}

/**
 * Picks the best ready model for a preset; when none is ready, the top-ranked one (the panel then asks for its key).
 * `preferId` keeps a model the user already switched to. Returns undefined only when no candidate model exists.
 */
export function resolvePreset(preset: GenPreset, isReady: (model: ModelSpec) => boolean, preferId?: string): ResolvedPreset | undefined {
  const options = presetOptions(preset, isReady)
  const chosen = options.find((o) => o.model.id === preferId) ?? options.find((o) => o.ready) ?? options[0]
  if (!chosen) return undefined
  return { ...chosen, params: presetParams(preset, chosen), alternatives: options.filter((o) => o !== chosen) }
}
