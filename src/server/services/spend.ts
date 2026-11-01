import type { ProjectSpendDTO } from '../../shared/types/api'
import type { GenerationRow } from '../storage/records'

type SpendRow = Pick<GenerationRow, 'provider' | 'modelId' | 'status' | 'costUsd' | 'createdAt'>

/** Provider prices go to fractions of a cent (per-second GPU time, per-token text). */
const round4 = (n: number) => Math.round(n * 10_000) / 10_000

/**
 * What a project's generations cost: every succeeded job (free local renders count with $0), plus failed or stuck
 * ones that report a charge. `costUsd` is the provider's figure, or the estimate when the provider doesn't report one.
 * The paid editor-tool calls (voice isolation, transcription, AI descriptions…) are recorded as succeeded generations
 * too (routes/tools.ts); without a USD price (ElevenLabs credits, text models) they count with $0, like other unpriced jobs.
 */
export function summarizeSpend(rows: Iterable<SpendRow>): ProjectSpendDTO {
  let total = 0
  let count = 0
  let since: string | undefined
  const byProvider: Record<string, number> = {}
  const byModel: Record<string, { usd: number; count: number }> = {}
  for (const row of rows) {
    const cost = typeof row.costUsd === 'number' && Number.isFinite(row.costUsd) && row.costUsd > 0 ? row.costUsd : 0
    if (row.status !== 'succeeded' && !cost) continue
    total += cost
    count++
    byProvider[row.provider] = (byProvider[row.provider] ?? 0) + cost
    const model = (byModel[row.modelId] ??= { usd: 0, count: 0 })
    model.usd += cost
    model.count++
    if (!since || row.createdAt < since) since = row.createdAt
  }
  for (const key of Object.keys(byProvider)) byProvider[key] = round4(byProvider[key]!)
  for (const m of Object.values(byModel)) m.usd = round4(m.usd)
  return { totalUsd: round4(total), byProvider, byModel, count, ...(since ? { since } : {}) }
}

/**
 * RunPod pod time billed on this machine: the session log plus the pod running now. Sessions aren't tied to a
 * project (one pod serves every open project), so this is machine-wide. Undefined when RunPod was never used.
 */
export function gpuSessionsTotal(sessions: readonly { costUsd: number }[], liveUsd?: number): number | undefined {
  if (!sessions.length && liveUsd === undefined) return undefined
  const logged = sessions.reduce((sum, s) => sum + (Number.isFinite(s.costUsd) ? s.costUsd : 0), 0)
  return Math.round((logged + (liveUsd ?? 0)) * 100) / 100
}
