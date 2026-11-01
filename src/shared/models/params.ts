import { z } from 'zod'
import type { ModelSpec, ParamDef, ParamOption, ParamUi, ParamValues } from './types'

export function param(key: string, schema: z.ZodType, ui: ParamUi, defaultValue?: unknown): ParamDef {
  return { key, schema, ui, default: defaultValue }
}

/** A param that is set: a non-empty string (an asset id, a text) or a non-empty list (reference images). */
export const hasValue = (v: unknown): boolean => (typeof v === 'string' || Array.isArray(v)) && v.length > 0

/** A single-asset param (a start frame, an audio track) that is set: a non-empty id — a list is no such value. */
export const hasAsset = (v: unknown): boolean => typeof v === 'string' && v.length > 0

const options = <T extends string | number>(values: readonly T[], label?: (v: T) => string): ParamOption[] =>
  values.map((v) => ({ value: v, label: label ? label(v) : String(v) }))

/** Reusable param builders so every model spells common inputs the same way. */
export const P = {
  prompt: (opts: { key?: string; max?: number; label?: string; placeholder?: string; help?: string } = {}) =>
    param(opts.key ?? 'prompt', z.string().trim().min(1, 'Prompt is required').max(opts.max ?? 2500), {
      label: opts.label ?? 'Prompt',
      control: 'prompt',
      placeholder: opts.placeholder,
      help: opts.help,
    }),
  negativePrompt: (max = 2500) =>
    param('negativePrompt', z.string().max(max).optional(), {
      label: 'Negative prompt',
      control: 'textarea',
      advanced: true,
      placeholder: 'What to avoid',
    }),
  select: <T extends string | number>(
    key: string,
    label: string,
    values: readonly T[],
    def: T,
    extra: Partial<ParamUi> & { labels?: (v: T) => string } = {},
  ) => {
    const { labels, ...ui } = extra
    const schema =
      typeof def === 'number'
        ? z.coerce.number().refine((v) => (values as readonly number[]).includes(v), 'Unsupported value')
        : z.enum(values as unknown as [string, ...string[]])
    return param(key, schema, { label, control: 'select', options: options(values, labels), ...ui }, def)
  },
  segmented: <T extends string | number>(
    key: string,
    label: string,
    values: readonly T[],
    def: T,
    extra: Partial<ParamUi> & { labels?: (v: T) => string } = {},
  ) => {
    const d = P.select(key, label, values, def, extra)
    d.ui.control = 'segmented'
    return d
  },
  slider: (key: string, label: string, min: number, max: number, step: number, def: number, extra: Partial<ParamUi> = {}) =>
    param(key, z.coerce.number().min(min).max(max), { label, control: 'slider', min, max, step, ...extra }, def),
  number: (key: string, label: string, min: number, max: number, def: number | undefined, extra: Partial<ParamUi> = {}) =>
    param(key, def === undefined ? z.coerce.number().min(min).max(max).optional() : z.coerce.number().min(min).max(max), {
      label,
      control: 'number',
      min,
      max,
      ...extra,
    }, def),
  toggle: (key: string, label: string, def: boolean, extra: Partial<ParamUi> = {}) =>
    param(key, z.boolean(), { label, control: 'switch', ...extra }, def),
  seed: () =>
    param('seed', z.coerce.number().int().min(0).max(2_147_483_647).optional(), {
      label: 'Seed',
      control: 'seed',
      advanced: true,
      help: 'Same seed + same inputs ≈ same result',
    }),
  image: (key: string, label: string, extra: Partial<ParamUi> & { required?: boolean } = {}) => {
    const { required, ...ui } = extra
    return param(key, required ? z.string().min(1, `${label} is required`) : z.string().optional(), {
      label,
      control: 'image',
      ...ui,
    })
  },
  images: (key: string, label: string, maxItems: number, extra: Partial<ParamUi> = {}) =>
    param(key, z.array(z.string()).max(maxItems).optional(), { label, control: 'images', maxItems, ...extra }),
  audio: (key: string, label: string, required = true) =>
    param(key, required ? z.string().min(1, `${label} is required`) : z.string().optional(), { label, control: 'audio' }),
  video: (key: string, label: string, required = true) =>
    param(key, required ? z.string().min(1, `${label} is required`) : z.string().optional(), { label, control: 'video' }),
  voice: (key = 'voiceId', label = 'Voice') =>
    param(key, z.string().min(1, 'Pick a voice'), { label, control: 'voice' }),
  text: (key: string, label: string, max: number, extra: Partial<ParamUi> & { required?: boolean } = {}) => {
    const { required, ...ui } = extra
    return param(key, required ? z.string().trim().min(1, `${label} is required`).max(max) : z.string().max(max).optional(), {
      label,
      control: 'textarea',
      ...ui,
    })
  },
}

export function visibleParams(model: ModelSpec, values: ParamValues): ParamDef[] {
  return model.params.filter((p) => !p.ui.visibleIf || p.ui.visibleIf(values))
}

export function defaultValues(model: ModelSpec): ParamValues {
  const out: ParamValues = {}
  for (const p of model.params) if (p.default !== undefined) out[p.key] = p.default
  return out
}

export type ParseResult =
  | { ok: true; values: ParamValues }
  | { ok: false; errors: Record<string, string>; message: string }

/** Validates only the currently visible params, then the model's cross-field rule. */
export function parseParams(model: ModelSpec, input: ParamValues): ParseResult {
  const values = { ...defaultValues(model), ...input }
  const visible = visibleParams(model, values)
  const shape: Record<string, z.ZodType> = {}
  for (const p of visible) shape[p.key] = p.schema
  const result = z.object(shape).safeParse(values)
  if (!result.success) {
    const errors: Record<string, string> = {}
    for (const issue of result.error.issues) {
      const key = String(issue.path[0] ?? '_')
      errors[key] ??= issue.message
    }
    return { ok: false, errors, message: Object.values(errors)[0] ?? 'Invalid parameters' }
  }
  const parsed = result.data as ParamValues
  const cross = model.validate?.(parsed)
  if (cross) return { ok: false, errors: { _: cross }, message: cross }
  return { ok: true, values: parsed }
}

/** Keys whose values are asset ids (inputs the server must resolve to files). */
export function assetParamKeys(model: ModelSpec): string[] {
  return model.params
    .filter((p) => ['image', 'images', 'audio', 'video'].includes(p.ui.control))
    .map((p) => p.key)
}
