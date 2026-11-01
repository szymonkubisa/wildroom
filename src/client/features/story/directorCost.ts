import type { TextModelInfo } from '@shared/types/llm'

/**
 * What a few Director calls cost, roughly, for a confirm card: the scene-shots system prompt is about 5k tokens, a
 * request adds its own size (≈ 4 characters a token), and a scene's shots come back in about 3k. An estimate — the
 * provider bills what was used — and nothing when the model's prices aren't known (Anthropic's own route, or the
 * catalogue not loaded).
 */
const SYSTEM_TOKENS = 5000
const OUTPUT_TOKENS = 3000

export function directorUsd(requests: readonly object[], model: Pick<TextModelInfo, 'inputPrice' | 'outputPrice'> | undefined): number | undefined {
  if (!requests.length || model?.inputPrice === undefined || model.outputPrice === undefined) return undefined
  const input = requests.reduce<number>((n, r) => n + SYSTEM_TOKENS + JSON.stringify(r).length / 4, 0)
  return (input * model.inputPrice + requests.length * OUTPUT_TOKENS * model.outputPrice) / 1_000_000
}
