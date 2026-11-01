import { getModel } from '@shared/models/registry'
import type { ParamDef } from '@shared/models/types'
import type { GenerationDTO } from '@shared/types/jobs'

/** One setting of a past generation, ready to show: asset-valued settings carry asset ids instead of text. */
export interface SettingRow {
  key: string
  label: string
  value: string
  assetIds?: string[]
}

/** Shown on their own, above the settings. */
const PROMPT_KEYS = new Set(['prompt', 'text', 'lines'])

const ASSET_CONTROLS = new Set(['image', 'images', 'video', 'audio'])

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
}

function raw(value: unknown): string {
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function row(def: ParamDef, value: unknown): SettingRow {
  const { label, control, options, unit } = def.ui
  if (ASSET_CONTROLS.has(control)) return { key: def.key, label, value: '', assetIds: (Array.isArray(value) ? value : [value]).map(String) }
  if (control === 'switch') return { key: def.key, label, value: value ? 'On' : 'Off' }
  const option = options?.find((o) => String(o.value) === String(value))
  if (option) return { key: def.key, label, value: option.label }
  if (Array.isArray(value)) return { key: def.key, label, value: value.map(raw).join(', ') }
  return { key: def.key, label, value: `${raw(value)}${unit && typeof value === 'number' ? ` ${unit}` : ''}` }
}

/** A generation's settings in the model's own words (labels, option names, units), in the model's order. */
export function describeParams(job: Pick<GenerationDTO, 'modelId' | 'params'>): SettingRow[] {
  const defs = getModel(job.modelId)?.params ?? []
  const rows = defs.filter((d) => !PROMPT_KEYS.has(d.key) && !isEmpty(job.params[d.key])).map((d) => row(d, job.params[d.key]))
  // Settings the model no longer declares (older jobs, renamed params) still show, as they were sent.
  const known = new Set(defs.map((d) => d.key))
  for (const [key, value] of Object.entries(job.params)) {
    if (!known.has(key) && !PROMPT_KEYS.has(key) && !isEmpty(value)) rows.push({ key, label: key, value: raw(value) })
  }
  return rows
}

/** The text a generation was made from: its prompt, voice-over script or dialogue lines. */
export function promptText(params: Record<string, unknown>): string {
  if (typeof params.prompt === 'string') return params.prompt
  if (typeof params.text === 'string') return params.text
  if (Array.isArray(params.lines)) return (params.lines as { text?: string }[]).map((l) => l.text ?? '').join('\n')
  return ''
}

/** Render time from start to finish, when both are known. */
export function renderMs(job: Pick<GenerationDTO, 'startedAt' | 'finishedAt'>): number | undefined {
  if (!job.startedAt || !job.finishedAt) return undefined
  return Date.parse(job.finishedAt) - Date.parse(job.startedAt)
}
