<script setup lang="ts">
import { ChevronLeft, ChevronRight, Copy, Download, EyeOff, Heart, Info, RotateCcw, X } from '@lucide/vue'
import { flicksToSeconds } from '@shared/time/flicks'
import { useEventListener } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { useResultActions } from '@/features/generate/resultActions'
import GenerationDetailsDialog from '@/features/jobs/GenerationDetailsDialog.vue'
import AssetPreview from '@/features/viewer/AssetPreview.vue'
import { errorMessage } from '@/lib/api'
import { formatUsd, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { downloadName } from './feed'
import { useFeedView } from './feedView'

/**
 * A result, big: the picture or clip on black, and beside it what it was made from (prompt, model, cost, size, when)
 * with what to do next — Reuse (all of it back in the Composer), the result's actions (Vary, Animate, Upscale…),
 * ♥, Hide, Copy prompt, Download and the full record. ← → step through the Feed as it is shown; Esc closes.
 */
const props = defineProps<{ order: string[] }>()
const view = useFeedView()
const assets = useAssetsStore()
const results = useResultActions()

const asset = computed(() => assets.get(view.viewing.value))
const index = computed(() => props.order.indexOf(view.viewing.value ?? ''))
const actions = computed(() => (asset.value ? results.actionsFor(asset.value) : []))
const detailsFor = ref<string>()

/** Where the open result was in the Feed: it can leave it while open (un-♥ with Favourites on) and ← → go on from there. */
const lastIndex = ref(0)
watch(index, (i) => i >= 0 && (lastIndex.value = i), { immediate: true })

function step(by: number) {
  const n = props.order.length
  if (!n) return
  // Gone from the list: the one after it now stands where it was.
  const from = index.value >= 0 ? index.value : lastIndex.value - (by > 0 ? 1 : 0)
  view.viewing.value = props.order[(((from + by) % n) + n) % n]
}
function close() {
  view.viewing.value = undefined
}
/** An action that loads the Composer closes the viewer, so the Composer is in sight. */
function run(fn: () => unknown) {
  fn()
  close()
}

/** A text field (isTyping counts the whole dialog as one, and the viewer is a dialog). */
const inField = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))

useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  if (!asset.value || detailsFor.value || inField(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault()
    step(e.key === 'ArrowRight' ? 1 : -1)
  } else if (e.key.toLowerCase() === 'f') {
    e.preventDefault()
    void results.setRating(asset.value, asset.value.rating === 1 ? 0 : 1)
  }
})

const facts = computed(() => {
  const a = asset.value
  if (!a) return []
  const g = a.generation
  return [
    ['Model', g?.modelLabel],
    ['Cost', g?.costUsd != null ? formatUsd(g.costUsd) : undefined],
    ['Size', a.width && a.height ? `${a.width} × ${a.height}` : undefined],
    ['Length', a.durationFlicks ? `${Math.round(flicksToSeconds(a.durationFlicks) * 10) / 10} s` : undefined],
    ['Seed', g?.params.seed != null ? String(g.params.seed) : undefined],
    ['Made', relativeTime(a.createdAt)],
  ].filter((r): r is [string, string] => Boolean(r[1]))
})

async function copyPrompt() {
  try {
    await navigator.clipboard.writeText(asset.value?.generation?.prompt ?? '')
    toast.success('Prompt copied')
  } catch (err) {
    toast.error('Couldn’t copy', { description: errorMessage(err) })
  }
}
async function hide() {
  const a = asset.value
  if (!a) return
  const next = props.order[index.value + 1] ?? props.order[index.value - 1]
  await results.setRating(a, -1)
  view.viewing.value = next !== a.id ? next : undefined
}
</script>

<template>
  <Dialog :open="Boolean(asset)" @update:open="(v) => !v && close()">
    <DialogContent
      v-if="asset"
      :show-close-button="false"
      class="top-4 right-4 bottom-4 left-4 grid h-auto w-auto max-w-none translate-x-0 translate-y-0 grid-cols-[minmax(0,1fr)_340px] gap-0 overflow-hidden p-0 sm:max-w-none"
      data-result-viewer=""
    >
      <div class="group/stage relative min-h-0 bg-black">
        <AssetPreview :key="asset.id" :asset="asset" />
        <template v-if="order.length > 1">
          <button
            type="button"
            class="absolute top-1/2 left-3 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white opacity-0 backdrop-blur transition-opacity group-hover/stage:opacity-100 hover:bg-white/20 focus-visible:opacity-100"
            aria-label="Previous result"
            data-viewer-prev=""
            @click="step(-1)"
          >
            <ChevronLeft class="size-5" />
          </button>
          <button
            type="button"
            class="absolute top-1/2 right-3 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white opacity-0 backdrop-blur transition-opacity group-hover/stage:opacity-100 hover:bg-white/20 focus-visible:opacity-100"
            aria-label="Next result"
            data-viewer-next=""
            @click="step(1)"
          >
            <ChevronRight class="size-5" />
          </button>
          <span class="absolute top-3 left-3 rounded-full bg-black/60 px-2.5 py-1 font-mono text-[11px] text-white/80 tabular">{{ index >= 0 ? `${index + 1} / ${order.length}` : `${order.length} in the Feed` }}</span>
        </template>
      </div>

      <aside class="flex min-h-0 flex-col gap-4 overflow-y-auto border-l bg-sidebar p-5">
        <div class="flex items-start gap-2">
          <div class="grid min-w-0 flex-1 gap-0.5">
            <DialogTitle class="truncate text-sm font-semibold">{{ asset.name }}</DialogTitle>
            <DialogDescription class="text-xs text-muted-foreground">{{ asset.generation?.modelLabel ?? 'Imported' }}</DialogDescription>
          </div>
          <button
            type="button"
            :class="cn('grid size-8 place-items-center rounded-full hover:bg-accent', asset.rating === 1 ? 'text-rose-400' : 'text-muted-foreground')"
            :aria-pressed="asset.rating === 1"
            :title="asset.rating === 1 ? 'Favourite — click to unmark (F)' : 'Mark as favourite (F)'"
            data-viewer-favourite=""
            @click="results.setRating(asset, asset.rating === 1 ? 0 : 1)"
          >
            <Heart :class="cn('size-4', asset.rating === 1 && 'fill-current')" />
          </button>
          <button type="button" class="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Close" @click="close">
            <X class="size-4" />
          </button>
        </div>

        <div v-if="asset.generation?.prompt" class="group/prompt relative rounded-xl bg-field p-3 text-[13px] leading-relaxed">
          <p class="max-h-48 overflow-y-auto pr-6 whitespace-pre-wrap" data-viewer-prompt="">{{ asset.generation.prompt }}</p>
          <button type="button" class="absolute top-2 right-2 grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" title="Copy the prompt" @click="copyPrompt">
            <Copy class="size-3.5" />
          </button>
        </div>

        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
          <template v-for="[k, v] in facts" :key="k">
            <dt class="text-muted-foreground">{{ k }}</dt>
            <dd class="truncate text-right font-mono tabular">{{ v }}</dd>
          </template>
        </dl>

        <Button v-if="asset.generation" class="w-full rounded-full" data-viewer-reuse="" @click="run(() => results.reuse(asset!))">
          <RotateCcw /> Reuse — prompt, model and settings
        </Button>

        <div class="grid grid-cols-2 gap-1.5">
          <button
            v-for="a in actions"
            :key="a.id"
            type="button"
            class="flex h-9 items-center gap-2 rounded-lg bg-field px-2.5 text-left text-xs font-medium transition-colors hover:bg-field-hover"
            :title="a.title"
            :data-viewer-action="a.id"
            @click="run(a.run)"
          >
            <component :is="a.icon" class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="truncate">{{ a.label }}</span>
          </button>
        </div>

        <div class="mt-auto flex flex-wrap gap-1.5 border-t pt-4">
          <Button variant="ghost" size="sm" as="a" :href="`/media/${asset.id}/original`" :download="downloadName(asset)"><Download /> Download</Button>
          <Button v-if="asset.generation" variant="ghost" size="sm" @click="detailsFor = asset.generation.generationId"><Info /> Details</Button>
          <Button variant="ghost" size="sm" class="text-muted-foreground" data-viewer-hide="" @click="hide"><EyeOff /> Hide</Button>
        </div>
        <p class="text-[11px] text-muted-foreground"><Kbd>←</Kbd> <Kbd>→</Kbd> browse · <Kbd>F</Kbd> favourite · <Kbd>Esc</Kbd> close</p>
      </aside>
    </DialogContent>
  </Dialog>
  <GenerationDetailsDialog v-model:id="detailsFor" />
</template>
