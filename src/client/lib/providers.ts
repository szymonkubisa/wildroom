import type { ModelSpec } from '@shared/models/types'

/** How the app names each provider: where a model runs, or which key pays for it. */
export const PROVIDER_NAMES: Record<string, string> = {
  local: 'This Mac',
  runpod: 'RunPod',
  fal: 'fal.ai',
  openrouter: 'OpenRouter',
  kling: 'Kling',
  elevenlabs: 'ElevenLabs',
  anthropic: 'Anthropic',
  mock: 'Demo mode',
}

/** A model menu's order: this Mac and the GPU first, then the services, demo last. */
const ORDER = ['local', 'runpod', 'fal', 'openrouter', 'kling', 'elevenlabs', 'anthropic', 'mock']

/**
 * Models grouped by where they run, for a model menu: the same model on fal.ai and on OpenRouter (GPT Image 2.5, Nano
 * Banana Pro…) read as duplicates in one flat list. The models' order is kept within each group; the groups follow
 * ORDER, or with `keepOrder` the order they first appear in (a list sorted connected-first stays so).
 */
export function groupByProvider(models: readonly ModelSpec[], opts: { keepOrder?: boolean } = {}): { provider: string; name: string; models: ModelSpec[] }[] {
  const groups = new Map<string, ModelSpec[]>()
  for (const m of models) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m])
  const rank = (p: string) => (ORDER.includes(p) ? ORDER.indexOf(p) : ORDER.length)
  const list = opts.keepOrder ? [...groups] : [...groups].sort(([a], [b]) => rank(a) - rank(b))
  return list.map(([provider, ms]) => ({ provider, name: PROVIDER_NAMES[provider] ?? provider, models: ms }))
}
