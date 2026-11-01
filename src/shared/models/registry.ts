import type { GenKind } from '../types/jobs'
import { elevenLabsModels } from './catalog/elevenlabs'
import { falModels } from './catalog/fal'
import { klingModels } from './catalog/kling'
import { localModels } from './catalog/local'
import { mockModels } from './catalog/mock'
import { openRouterModels } from './catalog/openrouter'
import { runpodModels } from './catalog/runpod'
import type { ModelSpec } from './types'

/**
 * All generation models. Each provider has a catalog file in ./catalog; add it to this list.
 * Local models come first: they are free, so they top the model menus and are the default when installed.
 * The Generate panel and the server job engine both read it, so a new model never needs new UI.
 */
const MODELS: ModelSpec[] = [...localModels, ...runpodModels, ...klingModels, ...falModels, ...openRouterModels, ...elevenLabsModels, ...mockModels]

export function allModels(): ModelSpec[] {
  return MODELS
}

export function getModel(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id)
}

export function modelsForKind(kind: GenKind): ModelSpec[] {
  return MODELS.filter((m) => m.kind === kind)
}

export const KIND_LABELS: Record<GenKind, string> = {
  video: 'Video',
  image: 'Image',
  speech: 'Voice',
  dialogue: 'Dialogue',
  music: 'Music',
  sfx: 'SFX',
  lipsync: 'Lip-sync',
  upscale: 'Upscale',
  foley: 'Foley',
  cutout: 'Remove BG',
  vectorize: 'Vectorize',
}
