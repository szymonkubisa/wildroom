import { computed, shallowReactive } from 'vue'
import { formatUsd } from '@/lib/format'
import { type Planned, useStory } from '../useStory'

/**
 * Shots with a paid render being started from their details (still, end frame, take, final, lines): their buttons wait
 * for it — a double click, both clicks in before the first job was made, rendered two takes. Kept per shot, not per
 * component: the still, the prompts and the lines are parts of their own.
 */
const startingShots = shallowReactive(new Set<string>())

export function useShotRender(shotId: () => string) {
  const s = useStory()
  const starting = computed(() => startingShots.has(shotId()))
  async function startRender(plans: () => (Planned | string)[] | Promise<(Planned | string)[]>): Promise<number> {
    const id = shotId()
    if (startingShots.has(id)) return 0
    startingShots.add(id)
    try {
      return await s.run(await plans())
    } finally {
      startingShots.delete(id)
    }
  }
  return { starting, startRender }
}

/** "· $0.15" for a button: what these plans cost, or nothing when they can't be priced (or can't run). */
export function costLabel(plans: (Planned | string)[]): string {
  const s = useStory()
  const ok = plans.filter((p): p is Planned => typeof p !== 'string')
  if (!ok.length) return ''
  const usd = s.estimate(ok)
  return usd == null ? '' : ` · ${formatUsd(usd)}`
}
