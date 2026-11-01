/** Budget math for the storyboard: how close the project is to its budget and what a batch of renders would cost in time. */

/** Above this share of the budget the chip turns amber. */
export const BUDGET_WARN_SHARE = 0.8

export type BudgetLevel = 'ok' | 'near' | 'over'

/** Spent vs. budget; undefined without a (positive) budget. */
export function budgetLevel(spent: number, budget?: number): { share: number; level: BudgetLevel } | undefined {
  if (!budget || !(budget > 0)) return undefined
  const share = spent / budget
  return { share, level: share > 1 ? 'over' : share > BUDGET_WARN_SHARE ? 'near' : 'ok' }
}

/** How far (USD) spending `estimate` more would go past the budget; undefined when it stays within or can't be told. */
export function overBudgetBy(spent: number, estimate: number | null, budget?: number): number | undefined {
  if (!budget || !(budget > 0) || estimate == null) return undefined
  const over = spent + estimate - budget
  return over > 0.005 ? over : undefined
}

export interface TimedPlan {
  provider: string
  /** The model's render-time estimate for this job, when it has one. */
  seconds?: number
}

/**
 * Rough wall-clock time for a batch: this Mac renders one job at a time, as does a RunPod pod (one GPU); other cloud
 * providers take several at once, so the longest job is about how long they all take. `unknown` jobs had no estimate.
 */
export function batchTimes(plans: readonly TimedPlan[]): { mac?: number; cloud?: number; unknown: number } {
  let mac: number | undefined
  let pod: number | undefined
  let parallel: number | undefined
  let unknown = 0
  for (const p of plans) {
    if (p.seconds === undefined) {
      unknown++
      continue
    }
    if (p.provider === 'local') mac = (mac ?? 0) + p.seconds
    else if (p.provider === 'runpod') pod = (pod ?? 0) + p.seconds
    else parallel = Math.max(parallel ?? 0, p.seconds)
  }
  const cloud = pod === undefined && parallel === undefined ? undefined : Math.max(pod ?? 0, parallel ?? 0)
  return { mac, cloud, unknown }
}
