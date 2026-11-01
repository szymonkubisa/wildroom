import type { ModelSpec } from '../../shared/models/types'

/**
 * Nothing paid runs over MCP without the user agreeing to its price. A generate call first answers with the estimate;
 * Claude asks the user and calls again with `confirm_usd` at or above it. Every MCP session also has a spend cap
 * (Settings → Integrations): renders that would go over it are refused whatever was confirmed.
 */

/** Demo renders (ffmpeg) and models that run on this Mac cost nothing. A rented GPU (RunPod) is paid. */
export function isFreeModel(model: Pick<ModelSpec, 'provider'>): boolean {
  return model.provider === 'mock' || model.provider === 'local'
}

export interface SpendRequest {
  free: boolean
  /** The estimate for every variant together; null when the price table can't say. */
  estimateUsd: number | null
  /** What the user agreed to spend on this call. */
  confirmUsd?: number
  /** What this MCP session has spent already (estimates of the renders it started). */
  spentUsd: number
  capUsd: number
}

export type SpendVerdict = { run: true; chargeUsd: number } | { run: false; reason: 'needs_confirmation' | 'over_cap'; message: string }

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`

export function checkSpend(r: SpendRequest): SpendVerdict {
  if (r.free) return { run: true, chargeUsd: 0 }
  const confirmed = typeof r.confirmUsd === 'number' && Number.isFinite(r.confirmUsd) && r.confirmUsd > 0 ? r.confirmUsd : undefined
  // An unknown price is charged at what the user agreed to.
  const charge = r.estimateUsd ?? confirmed
  if (confirmed === undefined || charge === undefined || confirmed + 1e-9 < charge) {
    const price = r.estimateUsd == null ? 'an unknown price (the price table has no estimate for these settings)' : `about ${usd(r.estimateUsd)}`
    return {
      run: false,
      reason: 'needs_confirmation',
      message:
        `Not started: this render is paid — ${price}. Ask the user whether to spend it, then call again with ` +
        `confirm_usd set to the amount they agreed to${r.estimateUsd == null ? '' : ` (at least ${usd(r.estimateUsd)})`}.`,
    }
  }
  if (r.spentUsd + charge > r.capUsd + 1e-9) {
    return {
      run: false,
      reason: 'over_cap',
      message:
        `Not started: ${usd(charge)} would take this session's spend to ${usd(r.spentUsd + charge)}, over its cap of ` +
        `${usd(r.capUsd)} (Settings → Integrations in Wildroom). The user can raise the cap there.`,
    }
  }
  return { run: true, chargeUsd: charge }
}
