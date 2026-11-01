import { defaultValues } from '@shared/models/params'
import { getModel } from '@shared/models/registry'
import type { GenerationDTO } from '@shared/types/jobs'
import { useLocalStorage } from '@vueuse/core'
import { effectScope, ref, watch } from 'vue'
import { medianSeconds } from '@/features/generate/useGenerateForm'
import { useAssetsStore } from '@/stores/assets'
import { useJobsStore } from '@/stores/jobs'
import { useProjectStore } from '@/stores/project'
import type { FeedFilter, FeedLayout } from './feed'

export const FEED_SIZES = { min: 140, max: 420 }

/**
 * How the Feed is looked at, shared by its bar (in CanvasWorkspace), the Feed itself, the result viewer and the right
 * panel: kind, favourites only, the search, rows by batch or one grid, the tile size (remembered in this browser), what
 * is open in the viewer and what is selected. Made once, in a scope of its own: it outlives the component that first
 * asks for it (stored settings keep saving, the watchers keep watching).
 */
function makeView() {
  const search = ref('')
  /** The result open in the viewer. */
  const viewing = ref<string>()
  /** Results picked with ⌘/⇧-click, in the order picked. */
  const selected = ref<string[]>([])

  // Another project: its results aren't these — nothing stays selected, open or searched for.
  watch(
    () => useProjectStore().id,
    () => {
      selected.value = []
      viewing.value = undefined
      search.value = ''
    },
  )
  // A result hidden or removed (here, in the Library, by Undo) leaves the selection.
  const assets = useAssetsStore()
  watch(
    () => assets.list,
    () => {
      const kept = selected.value.filter((id) => {
        const a = assets.get(id)
        return a && a.rating !== -1 && a.status !== 'missing'
      })
      if (kept.length !== selected.value.length) selected.value = kept
    },
  )

  return {
    filter: useLocalStorage<FeedFilter>('create.feedFilter', 'all'),
    layout: useLocalStorage<FeedLayout>('create.feedLayout', 'batches'),
    favourites: useLocalStorage('create.feedFavourites', false),
    size: useLocalStorage('create.feedSize', 220),
    search,
    viewing,
    selected,
  }
}

let view: ReturnType<typeof makeView> | undefined

export function useFeedView() {
  view ??= effectScope(true).run(makeView)!
  return view
}

/** About how long a job's model takes: its own estimate for these settings, else the median of its renders here. */
export function typicalSeconds(job: GenerationDTO): number | undefined {
  const model = getModel(job.modelId)
  if (!model) return undefined
  try {
    const own = model.estimateSeconds?.({ ...defaultValues(model), ...job.params })
    if (own) return own
  } catch {
    // No estimate for these values.
  }
  const jobs = useJobsStore()
  return medianSeconds([...jobs.history, ...jobs.sharedHistory], job.modelId)
}
