import { aspectValue } from '../canvas/geometry'
import { defaultValues } from './params'
import type { ModelSpec, ParamDef, ParamValues } from './types'

/** No value given: undefined, null, '' or an empty list. */
export const isBlank = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)

/** A value snapped onto one param: nearest allowed option, image lists capped. Undefined when no option fits. */
export function fitValue(p: ParamDef, v: unknown): unknown {
  const options = p.ui.options
  if ((p.ui.control === 'select' || p.ui.control === 'segmented') && options?.length) {
    if (typeof v === 'number' && options.every((o) => typeof o.value === 'number')) {
      return options.reduce((best, o) => (Math.abs(Number(o.value) - v) < Math.abs(Number(best.value) - v) ? o : best)).value
    }
    // A twin model may name the same option differently (fal '0.5K' vs OpenRouter '512' labelled "0.5K").
    return options.some((o) => o.value === v) ? v : options.find((o) => o.label === v)?.value
  }
  // Image lists (references, Kling element views) and Kling element ids: never more than the model takes.
  if (p.ui.control === 'images') return (Array.isArray(v) ? v : [v]).slice(0, p.ui.maxItems ?? 4)
  if (p.ui.control === 'elements' && Array.isArray(v)) return p.ui.maxItems ? v.slice(0, p.ui.maxItems) : v
  // Sliders and numbers: onto the model's range and step (a 12 s shot asks an 8 s model for 8 s, not a rejected 12).
  if ((p.ui.control === 'slider' || p.ui.control === 'number') && typeof v === 'number' && Number.isFinite(v)) {
    const { min = -Infinity, max = Infinity, step } = p.ui
    const stepped = step && Number.isFinite(min) ? min + Math.round((v - min) / step) * step : v
    return Math.min(max, Math.max(min, stepped))
  }
  return v
}

/** Maps desired values onto a model's own params: nearest allowed option, only keys the model knows. */
export function fitParams(model: ModelSpec, desired: Record<string, unknown>): ParamValues {
  const out = defaultValues(model)
  for (const p of model.params) {
    const v = desired[p.key]
    if (isBlank(v)) continue
    const fitted = fitValue(p, v)
    if (fitted !== undefined) out[p.key] = fitted
  }
  return out
}

/**
 * The model's aspect option closest to a `w`×`h` box (e.g. a 1200×630 frame → "16:9"), compared on a log scale so
 * 2:1 and 1:2 are equally far from 1:1. Undefined when the model has no aspect choice.
 */
export function nearestAspect(model: ModelSpec, w: number, h: number): string | undefined {
  const p = model.params.find((x) => x.key === 'aspectRatio')
  if (!p?.ui.options?.length || w <= 0 || h <= 0) return undefined
  return closestAspect(
    p.ui.options.map((o) => o.value),
    w / h,
  )
}

/** The aspect option ("16:9"; "auto" skipped) closest to `want` (width ÷ height), on the same log scale. */
export function closestAspect(options: readonly unknown[], want: number): string | undefined {
  if (!(want > 0)) return undefined
  let best: { value: string; d: number } | undefined
  for (const o of options) {
    const r = aspectValue(o)
    if (!r) continue
    const d = Math.abs(Math.log(r / want))
    if (!best || d < best.d) best = { value: String(o), d }
  }
  return best?.value
}
