import type { OpenRouterImageModel } from '@shared/models/catalog/openrouter'
import { api } from '@/lib/api'
import { sharedList } from '@/lib/sharedList'

// One shared copy of OpenRouter's image-model list per page load.
const imageModels = sharedList<OpenRouterImageModel>(() => api.openrouter.imageModels())

export const loadImageModels = imageModels.load

export function useImageModels() {
  return { models: imageModels.items, error: imageModels.error }
}

const prices = new Map<string, Promise<string[]>>()

/** One model's price list in words ("$0.045 per image"…), fetched once per page load. */
export function imageModelPricing(id: string): Promise<string[]> {
  let hit = prices.get(id)
  if (!hit) {
    hit = api.openrouter.imagePricing(id).then((r) => r.lines)
    hit.catch(() => prices.delete(id))
    prices.set(id, hit)
  }
  return hit
}

/** What a model can do, in a few words: "Up to 14 refs", "1K–4K", "Transparent", "SVG". */
export function imageModelTraits(m: OpenRouterImageModel): string[] {
  const out: string[] = []
  const { min, max } = m.refs
  out.push(max === 0 ? 'Text only' : min > 0 ? (min === max ? `${min} ref${min === 1 ? '' : 's'} needed` : `${min}–${max} refs`) : `Up to ${max} ref${max === 1 ? '' : 's'}`)
  const res = m.resolutions ?? []
  if (res.length) out.push(res.length > 1 ? `${res[0]}–${res.at(-1)}` : res[0]!)
  if (m.svg) out.push('SVG')
  if (m.transparent) out.push('Transparent')
  if (m.qualities?.length) out.push('Quality')
  return out
}
