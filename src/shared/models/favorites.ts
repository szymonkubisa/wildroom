import type { GenKind } from '../types/jobs'
import { getModel } from './registry'
import type { ModelSpec } from './types'

/** A list with `id` starred (added last) or unstarred. */
export const toggled = (list: readonly string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

/**
 * The first starred model of `kind` that `usable` accepts (ready to run): the Composer's default for that kind. A starred
 * model that can't run now (no key, not installed) is passed over for the next.
 */
export function firstFavorite(list: readonly string[], kind: GenKind, usable: (m: ModelSpec) => boolean): ModelSpec | undefined {
  for (const id of list) {
    const m = getModel(id)
    if (m?.kind === kind && usable(m)) return m
  }
  return undefined
}
