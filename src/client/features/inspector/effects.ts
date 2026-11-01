import type { EffectInstance } from '@shared/types/project-doc'

export interface EffectParamDef {
  key: string
  label: string
  min: number
  max: number
  step: number
  default: number
  format?: (v: number) => string
}

export interface EffectDef {
  type: string
  label: string
  params: EffectParamDef[]
}

const pct = (v: number) => `${Math.round(v * 100)}%`

/** Built-in effects the compositor knows how to draw (identical in preview and export). */
export const EFFECTS: EffectDef[] = [
  {
    type: 'color',
    label: 'Color',
    params: [
      { key: 'exposure', label: 'Exposure', min: -1, max: 1, step: 0.01, default: 0, format: (v) => v.toFixed(2) },
      { key: 'contrast', label: 'Contrast', min: 0, max: 2, step: 0.01, default: 1, format: pct },
      { key: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.01, default: 1, format: pct },
      { key: 'hue', label: 'Hue', min: -180, max: 180, step: 1, default: 0, format: (v) => `${Math.round(v)}°` },
    ],
  },
  {
    type: 'balance',
    label: 'Color balance',
    params: [
      { key: 'r', label: 'Red', min: 0.5, max: 1.6, step: 0.01, default: 1, format: pct },
      { key: 'g', label: 'Green', min: 0.5, max: 1.6, step: 0.01, default: 1, format: pct },
      { key: 'b', label: 'Blue', min: 0.5, max: 1.6, step: 0.01, default: 1, format: pct },
    ],
  },
  { type: 'bw', label: 'Black & White', params: [{ key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 1, format: pct }] },
  { type: 'sepia', label: 'Sepia', params: [{ key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.8, format: pct }] },
  { type: 'blur', label: 'Blur', params: [{ key: 'radius', label: 'Radius', min: 0, max: 40, step: 0.5, default: 6, format: (v) => `${v}px` }] },
  {
    type: 'tilt-blur',
    label: 'Tilt-shift blur',
    params: [
      { key: 'radius', label: 'Blur', min: 0, max: 40, step: 0.5, default: 12, format: (v) => `${v}px` },
      { key: 'focus', label: 'Focus at', min: 0, max: 1, step: 0.01, default: 0.5, format: pct },
      { key: 'size', label: 'Sharp band', min: 0, max: 1, step: 0.01, default: 0.3, format: pct },
    ],
  },
  { type: 'vignette', label: 'Vignette', params: [{ key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.5, format: pct }] },
  { type: 'grain', label: 'Film grain', params: [{ key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.25, format: pct }] },
  { type: 'letterbox', label: 'Letterbox', params: [{ key: 'aspect', label: 'Aspect', min: 1.5, max: 2.76, step: 0.01, default: 2.39, format: (v) => `${v.toFixed(2)}:1` }] },
]

export function effectDef(type: string) {
  return EFFECTS.find((e) => e.type === type)
}

export function newEffect(type: string, id: string): EffectInstance {
  const def = effectDef(type)
  const params: EffectInstance['params'] = {}
  for (const p of def?.params ?? []) params[p.key] = p.default
  return { id, type, enabled: true, params }
}
