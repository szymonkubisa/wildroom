/**
 * What the app says about a model in any picker — a short name, about what a second costs, a language's code — pure,
 * from the catalog entry and its workflow profile. (The storyboard's own notes are in features/story/modelInfo.)
 */
import { defaultValues } from './params'
import type { ModelSpec, ParamValues } from './types'
import { type ModelLike, clipSeconds, modelFamily } from './workflow'

/** A short name for a take's badge: "LTX", "Kling 3.0", "Veo 3.1 Fast", "Happy Horse" (the full label goes in the title). */
export function shortModelLabel(model: ModelLike & { label: string }): string {
  const family = modelFamily(model)
  if (family === 'ltx') return 'LTX'
  if (family === 'happyhorse') return 'Happy Horse'
  // "Kling 3.0 (fal)" → "Kling 3.0": where it runs isn't what tells takes apart.
  return model.label.replace(/\s*\([^)]*\)/g, '').trim() || model.label
}

const LANGUAGE_CODES: Record<string, string> = {
  English: 'EN',
  Chinese: 'ZH',
  Polish: 'PL',
  Spanish: 'ES',
  French: 'FR',
  German: 'DE',
  Italian: 'IT',
  Portuguese: 'PT',
  Japanese: 'JA',
  Korean: 'KO',
}

/** "EN" for "English" (the first two letters for a language not listed). */
export const languageCode = (name: string) => LANGUAGE_CODES[name] ?? name.slice(0, 2).toUpperCase()

/**
 * About what a second of the model costs with these settings: the estimate for a clip of about 5 s (one it renders)
 * divided by its length. Undefined when the model has no length or its price isn't known.
 */
export function perSecondUsd(model: ModelSpec, settings: ParamValues = {}): number | undefined {
  if (!model.params.some((p) => p.key === 'duration')) return undefined
  const seconds = clipSeconds(model, 5)
  try {
    const usd = model.estimateCost({ ...defaultValues(model), ...settings, duration: seconds }).usd
    return usd == null || !(seconds > 0) ? undefined : usd / seconds
  } catch {
    return undefined
  }
}

/** "$0.17/s", "$0.004/s", "Free". */
export function formatPerSecond(usd: number): string {
  if (usd === 0) return 'Free'
  return `$${usd.toFixed(usd < 0.01 ? 3 : 2)}/s`
}
