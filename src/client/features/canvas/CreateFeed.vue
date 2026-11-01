<script setup lang="ts">
import { Check, Clapperboard, Copy, EyeOff, Heart, ImagePlus, RotateCcw, Shuffle, Sparkles, X } from '@lucide/vue'
import { useEventListener } from '@vueuse/core'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useResultActions } from '@/features/generate/resultActions'
import { errorMessage } from '@/lib/api'
import { formatUsd, relativeTime } from '@/lib/format'
import { isTyping } from '@/lib/shortcuts'
import { useAssetsStore } from '@/stores/assets'
import { useGenerateStore } from '@/stores/generate'
import { useJobsStore } from '@/stores/jobs'
import { type FeedFilter, filterFeed, groupBatches } from './feed'
import FeedPending from './FeedPending.vue'
import FeedTile from './FeedTile.vue'
import { useFeedView } from './feedView'
import RecipeCatalog from './RecipeCatalog.vue'
import ResultViewer from './ResultViewer.vue'

/**
 * Create's Feed: everything generated in the project, newest first — pictures, clips and sound — with the renders
 * still on their way (or that just failed) at the top. By batch (one row per Generate, its takes side by side, with
 * Reuse and Again on the row) or as one grid; filtered by kind, ♥ and a search. Click a result to see it big,
 * ⌘/⇧-click to select several for the bar at the top. An empty Feed offers recipes that fill the Composer.
 */
export type { FeedFilter }

const assets = useAssetsStore()
const jobs = useJobsStore()
const generate = useGenerateStore()
const results = useResultActions()
const view = useFeedView()

const shown = computed(() => filterFeed(assets.list, { kind: view.filter.value, favourites: view.favourites.value, search: view.search.value }))
const jobOf = (id: string) => jobs.byId[id]
const batches = computed(() => groupBatches(shown.value, jobOf))
/** What the viewer steps through and ⇧-click selects across: the results in the order they are shown. */
const order = computed(() => (view.layout.value === 'batches' ? batches.value.flatMap((b) => b.assets.map((a) => a.id)) : shown.value.map((a) => a.id)))

const KIND_OF_JOB: Record<string, FeedFilter> = { image: 'image', video: 'video', upscale: 'video', lipsync: 'video', cutout: 'image', vectorize: 'image' }
/** Renders on their way (or that failed just now): the top of the Feed until they land. */
const pending = computed(() =>
  jobs.list
    .filter((j) => !jobs.isTerminal(j) || ((j.status === 'failed' || j.status === 'needs_attention') && !j.outputAssetIds.length && Date.now() - Date.parse(j.updatedAt) < 10 * 60_000))
    .filter((j) => view.filter.value === 'all' || (KIND_OF_JOB[j.kind] ?? 'audio') === view.filter.value),
)

const filtered = computed(() => view.filter.value !== 'all' || view.favourites.value || Boolean(view.search.value.trim()))
const nothingYet = computed(() => !shown.value.length && !pending.value.length && !filtered.value)
const columns = computed(() => `repeat(auto-fill, minmax(${view.size.value}px, 1fr))`)

/** The batch whose prompt was just copied: its button shows a tick for a moment. */
const copied = ref<string>()
let copiedTimer: ReturnType<typeof setTimeout> | undefined
async function copyPrompt(key: string, prompt: string) {
  try {
    await navigator.clipboard.writeText(prompt)
    copied.value = key
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = undefined), 1500)
    toast.success('Prompt copied')
  } catch (err) {
    toast.error('Couldn’t copy', { description: errorMessage(err) })
  }
}

// ------------------------------------------------------------------------------------ selection

const selecting = computed(() => view.selected.value.length > 0)
function select(id: string, range: boolean) {
  const sel = view.selected.value
  const last = sel.at(-1)
  if (range && last) {
    const [a, b] = [order.value.indexOf(last), order.value.indexOf(id)].sort((x, y) => x - y)
    if (a !== undefined && a >= 0 && b !== undefined) return void (view.selected.value = [...new Set([...sel, ...order.value.slice(a, b + 1)])])
  }
  view.selected.value = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]
}
const selectedAssets = computed(() => view.selected.value.map((id) => assets.get(id)).filter((a) => a !== undefined))

async function rateSelected(rating: -1 | 1) {
  const list = selectedAssets.value
  const before = new Map(list.map((a) => [a.id, a.rating]))
  try {
    await Promise.all(list.map((a) => assets.update(a.id, { rating })))
    view.selected.value = []
    toast.success(rating === 1 ? `${list.length} marked as favourite` : `${list.length} hidden`, {
      action: { label: 'Undo', onClick: () => void Promise.all(list.map((a) => assets.update(a.id, { rating: before.get(a.id) ?? 0 }))) },
    })
  } catch (err) {
    toast.error('Couldn’t change the rating', { description: errorMessage(err) })
  }
}
function selectedToTimeline() {
  results.toTimeline(view.selected.value)
  view.selected.value = []
}
function selectedAsReferences() {
  const ids = selectedAssets.value.filter((a) => a.kind === 'image').map((a) => a.id)
  if (!ids.length) return void toast('Only pictures can be references')
  generate.open('image', { params: { referenceImages: ids } })
  view.selected.value = []
}
const selectedImages = computed(() => selectedAssets.value.filter((a) => a.kind === 'image').length)

useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  if (e.key !== 'Escape' || !selecting.value || view.viewing.value || isTyping(e.target)) return
  view.selected.value = []
})
</script>

<template>
  <div class="relative h-full">
    <ScrollArea class="h-full" data-create-feed="" :data-layout="view.layout.value">
      <!-- The bottom padding is the floating Composer's height (CanvasWorkspace's --dock-space): the last row scrolls clear of it. -->
      <div class="px-4 pt-16 pb-[calc(var(--dock-space,14rem)+1rem)]">
        <!-- On its way, and failed just now. -->
        <section v-if="pending.length" class="mb-6 grid gap-2" data-feed-pending-row="">
          <h3 v-if="view.layout.value === 'batches'" class="px-0.5 font-mono text-[10.5px] font-medium tracking-widest text-muted-foreground uppercase">On its way</h3>
          <div class="grid gap-3" :style="{ gridTemplateColumns: columns }">
            <FeedPending v-for="j in pending" :key="j.id" :job="j" :caption="true" />
          </div>
        </section>

        <!-- By batch: one row per Generate. -->
        <template v-if="view.layout.value === 'batches'">
          <section v-for="b in batches" :key="b.key" class="group/batch mb-7 grid gap-2.5" data-feed-batch="">
            <header class="flex items-start gap-3 px-0.5">
              <div class="grid min-w-0 flex-1 gap-0.5">
                <p class="line-clamp-2 text-[13px] leading-snug select-text" :title="b.prompt">{{ b.prompt }}</p>
                <p class="truncate font-mono text-[10.5px] text-muted-foreground">
                  {{ b.modelLabel }}<template v-if="b.assets.length > 1"> · {{ b.assets.length }} takes</template><template v-if="b.costUsd != null"> · {{ formatUsd(b.costUsd) }}</template> ·
                  {{ relativeTime(b.createdAt) }}
                </p>
              </div>
              <div class="flex shrink-0 gap-1 opacity-60 transition-opacity group-hover/batch:opacity-100">
                <button
                  type="button"
                  class="flex h-7 items-center gap-1.5 rounded-full bg-field px-2.5 text-xs font-medium hover:bg-field-hover"
                  title="Copy the whole prompt"
                  data-batch-copy=""
                  @click="copyPrompt(b.key, b.prompt)"
                >
                  <Check v-if="copied === b.key" class="size-3.5" /><Copy v-else class="size-3.5" /> Copy
                </button>
                <button
                  type="button"
                  class="flex h-7 items-center gap-1.5 rounded-full bg-field px-2.5 text-xs font-medium hover:bg-field-hover"
                  title="Prompt, model, settings and inputs back in the Composer"
                  data-batch-reuse=""
                  @click="results.reuse(b.assets[0]!)"
                >
                  <RotateCcw class="size-3.5" /> Reuse
                </button>
                <button
                  type="button"
                  class="flex h-7 items-center gap-1.5 rounded-full bg-field px-2.5 text-xs font-medium hover:bg-field-hover"
                  title="Again with the same model and settings (a new seed)"
                  data-batch-again=""
                  @click="results.vary(b.assets[0]!)"
                >
                  <Shuffle class="size-3.5" /> Again
                </button>
              </div>
            </header>
            <div class="grid gap-3" :style="{ gridTemplateColumns: columns }">
              <FeedTile
                v-for="a in b.assets"
                :key="a.id"
                :asset="a"
                :selected="view.selected.value.includes(a.id)"
                :selecting="selecting"
                @open="view.viewing.value = a.id"
                @select="(range) => select(a.id, range)"
              />
            </div>
          </section>
        </template>

        <!-- One grid. -->
        <div v-else class="grid gap-3" :style="{ gridTemplateColumns: columns }">
          <FeedTile
            v-for="a in shown"
            :key="a.id"
            :asset="a"
            caption
            :selected="view.selected.value.includes(a.id)"
            :selecting="selecting"
            @open="view.viewing.value = a.id"
            @select="(range) => select(a.id, range)"
          />
        </div>

        <!-- Nothing yet: recipes that fill the Composer. -->
        <div v-if="nothingYet" class="mx-auto grid max-w-3xl gap-5 py-10 text-center" data-feed-empty="">
          <div class="grid justify-items-center gap-2">
            <span class="grid size-11 place-items-center rounded-2xl bg-brand/15 text-brand"><Sparkles class="size-5" /></span>
            <h3 class="text-base font-semibold">Start from a recipe</h3>
            <p class="max-w-md text-xs text-muted-foreground">
              Each one fills the Composer with a prompt to finish — replace the [brackets], check the cost, then Generate. Everything you make in this
              project lands here, newest first.
            </p>
          </div>
          <RecipeCatalog :columns="4" />
        </div>
        <div v-else-if="!shown.length && !pending.length" class="grid justify-items-center gap-2 py-20 text-center">
          <h3 class="text-sm font-medium">Nothing matches</h3>
          <p class="max-w-xs text-xs text-muted-foreground">Try another word, or clear the filters above.</p>
        </div>
      </div>
    </ScrollArea>

    <!-- Several selected: what to do with all of them, just above the Composer. -->
    <div v-if="selecting" class="pointer-events-none absolute inset-x-0 bottom-[calc(var(--dock-space,14rem)+0.25rem)] flex justify-center px-3">
      <div class="pointer-events-auto flex items-center gap-1 rounded-full border bg-popover p-1 pl-3 text-xs shadow-pop" data-feed-bulk="">
        <span class="mr-1 font-medium tabular">{{ view.selected.value.length }} selected</span>
        <button type="button" class="flex h-7 items-center gap-1.5 rounded-full px-2.5 hover:bg-accent" @click="rateSelected(1)"><Heart class="size-3.5" /> Favourite</button>
        <button type="button" class="flex h-7 items-center gap-1.5 rounded-full px-2.5 hover:bg-accent" data-bulk-timeline="" @click="selectedToTimeline"><Clapperboard class="size-3.5" /> To timeline</button>
        <button v-if="selectedImages" type="button" class="flex h-7 items-center gap-1.5 rounded-full px-2.5 hover:bg-accent" data-bulk-refs="" @click="selectedAsReferences">
          <ImagePlus class="size-3.5" /> As references
        </button>
        <button type="button" class="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-muted-foreground hover:bg-accent hover:text-foreground" data-bulk-hide="" @click="rateSelected(-1)">
          <EyeOff class="size-3.5" /> Hide
        </button>
        <button type="button" class="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Clear the selection (Esc)" @click="view.selected.value = []">
          <X class="size-3.5" />
        </button>
      </div>
    </div>

    <ResultViewer :order="order" />
  </div>
</template>
