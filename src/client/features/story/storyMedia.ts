import type { AssetDTO } from '@shared/types/assets'
import { TERMINAL_JOB_STATUSES } from '@shared/types/jobs'
import type { useAssetsStore } from '@/stores/assets'
import type { useJobsStore } from '@/stores/jobs'

/**
 * What a generation made and how it stands, from the jobs and the assets alone — no settings, no models: the
 * timeline names a split take's pieces with it (storyNaming) without the rest of the storyboard.
 */

/** Finished without a result (failed, canceled, needs attention): nothing is coming from the generation. */
export const DEAD_JOB_STATUSES: readonly string[] = TERMINAL_JOB_STATUSES.filter((x) => x !== 'succeeded')
/** A generation (its jobState) still queued or rendering. */
export const inFlight = (state?: { status: string }) => Boolean(state && !(TERMINAL_JOB_STATUSES as readonly string[]).includes(state.status))
/** A generation (its jobState) that finished without a result. */
export const isDead = (state?: { status: string }) => Boolean(state && DEAD_JOB_STATUSES.includes(state.status))

// ---- resolve generated media from jobs
export function generatedMedia(jobs: ReturnType<typeof useJobsStore>, assets: ReturnType<typeof useAssetsStore>) {
  function outputOf(generationId?: string): AssetDTO | undefined {
    if (!generationId) return undefined
    const job = jobs.byId[generationId]
    if (job) return job.status === 'succeeded' ? assets.get(job.outputAssetIds[0]) : undefined
    // Older than the newest 300 jobs the client is sent: its file is still among the project's assets, which record
    // the generation that made them. Without this, a long project's first keyframes and takes went blank.
    return assets.byGeneration.get(generationId)
  }

  function jobState(generationId?: string) {
    if (!generationId) return undefined
    const job = jobs.byId[generationId]
    if (job) return { status: job.status, progress: job.progress, error: job.error?.message }
    // An old job known only by its output (see outputOf): it succeeded.
    return assets.byGeneration.has(generationId) ? { status: 'succeeded' as const, progress: 1, error: undefined } : undefined
  }

  return { outputOf, jobState }
}
