import type { z } from 'zod'
import type { GenKind, ProviderId } from '../types/jobs'
import type { RoleId } from '../types/project-doc'
import type { WorkflowOverrides } from './workflow'

export type ParamControl =
  | 'prompt'
  | 'text'
  | 'textarea'
  | 'select'
  | 'segmented'
  | 'slider'
  | 'number'
  | 'switch'
  | 'seed'
  | 'image' // asset id of an image (or a frame grabbed from the timeline)
  | 'images' // several asset ids (reference images)
  | 'audio' // asset id of an audio asset
  | 'video' // asset id of a video asset
  | 'voice' // provider voice id
  | 'elements' // Kling element ids (story characters synced to Kling's element library), in prompt order
  | 'openrouterImageModel' // an OpenRouter image model id ("vendor/model"), picked from OpenRouter's live list

export interface ParamOption {
  value: string | number
  label: string
}

export type ParamValues = Record<string, unknown>

export interface ParamUi {
  label: string
  control: ParamControl
  help?: string
  placeholder?: string
  options?: ParamOption[]
  min?: number
  max?: number
  step?: number
  unit?: string
  maxItems?: number
  /** Image slot that holds the picture being transformed (edited, remixed, restyled), not references to follow. */
  source?: boolean
  advanced?: boolean
  /** Param is shown and validated only when this returns true. */
  visibleIf?: (values: ParamValues) => boolean
  /** Validated and sent like any other param, but never drawn: set by other features (e.g. storyboard multi-shots). */
  hidden?: boolean
}

export interface ParamDef {
  key: string
  schema: z.ZodType
  default?: unknown
  ui: ParamUi
}

export interface CostEstimate {
  usd: number | null
  detail: string
  /** Date of the price table this estimate is based on. */
  asOf: string
}

export interface ModelSpec {
  id: string
  label: string
  vendor: string
  provider: ProviderId
  kind: GenKind
  description: string
  badges: string[]
  output: 'video' | 'image' | 'audio'
  /** Default timeline role for audio outputs. */
  defaultRole?: RoleId
  params: ParamDef[]
  /** Cross-field rules; return an error message or null. */
  validate?: (values: ParamValues) => string | null
  estimateCost: (values: ParamValues) => CostEstimate
  /** Rough render time in seconds, when it is predictable (local models); shown in the queue. */
  estimateSeconds?: (values: ParamValues) => number
  /** Provider-side maximum number of outputs per request (otherwise one job per variant). */
  maxVariants?: number
  /** Only available when demo mode (mock provider) is on. */
  demoOnly?: boolean
  /**
   * The same model served by another provider (e.g. GPT Image 2.5 on OpenRouter is the twin of fal's): presets that
   * rank the original fall back to this one when only this provider is connected. Param keys match the original's.
   */
  twinOf?: string
  /**
   * How the storyboard works with this video model, where its params and family don't say it all (see workflowFor in
   * ./workflow): e.g. how the prompt names reference images, the shot limits, the languages it speaks.
   */
  workflow?: WorkflowOverrides
}
