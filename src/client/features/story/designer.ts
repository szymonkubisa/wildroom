import { computed, ref } from 'vue'
import { formatUsd } from '@/lib/format'
import type { DesignKind } from './design'
import { useStory } from './useStory'

/**
 * The hero or place the look designer is open for: one at a time, over the whole Story workspace. `angles`: the other
 * angles to have ticked (a place's views its shots look toward).
 */
export const designing = ref<{ kind: DesignKind; id: string; angles?: string[] }>()
export const openDesigner = (kind: DesignKind, id: string, angles?: string[]) => (designing.value = { kind, id, ...(angles?.length ? { angles } : {}) })
export const closeDesigner = () => (designing.value = undefined)

/**
 * A quick look for one hero or place, without the designer: one picture, used as its front view (main view) once
 * drawn. What stops it, its price, whether one is being drawn, and starting it.
 */
export function useQuickLook(kind: DesignKind, id: () => string) {
  const s = useStory()
  const plan = computed(() => s.planDesign(kind, id(), { auto: true }))
  const blocker = computed(() => (typeof plan.value === 'string' ? plan.value : undefined))
  const cost = computed(() => {
    if (typeof plan.value === 'string') return undefined
    const usd = s.estimate([plan.value])
    return usd == null ? undefined : formatUsd(usd)
  })
  const drawing = computed(() => s.quickLooking(kind, id()))
  const start = () => void s.run([s.planDesign(kind, id(), { auto: true })])
  return { blocker, cost, drawing, start }
}
