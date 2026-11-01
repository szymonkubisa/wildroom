<script setup lang="ts">
import { computed } from 'vue'
import AssetThumb from '@/features/assets/AssetThumb.vue'
import { formatUsd } from '@/lib/format'
import { useAssetsStore } from '@/stores/assets'
import { generatedResults, totalCost } from './feed'
import { useFeedView } from './feedView'

/**
 * The right panel while Create shows the Feed: what is in it (results, favourites, what they cost), what is selected,
 * and how to work it — instead of the board's help.
 */
const assets = useAssetsStore()
const view = useFeedView()

const all = computed(() => generatedResults(assets.list))
const favourites = computed(() => all.value.filter((a) => a.rating === 1).length)
const spent = computed(() => totalCost(all.value) ?? 0)
const picked = computed(() => view.selected.value.map((id) => assets.get(id)).filter((a) => a !== undefined))
const pickedCost = computed(() => totalCost(picked.value) ?? 0)
</script>

<template>
  <div class="grid content-start gap-5 overflow-y-auto px-3.5 py-3 text-xs" data-feed-inspector="">
    <div>
      <div class="font-mono text-[10.5px] font-medium tracking-widest text-muted-foreground uppercase">Feed</div>
      <div class="mt-1.5 grid grid-cols-3 gap-1.5">
        <div class="rounded-lg bg-field p-2">
          <div class="text-base font-semibold tabular">{{ all.length }}</div>
          <div class="text-[10.5px] text-muted-foreground">results</div>
        </div>
        <div class="rounded-lg bg-field p-2">
          <div class="text-base font-semibold tabular">{{ favourites }}</div>
          <div class="text-[10.5px] text-muted-foreground">favourites</div>
        </div>
        <div class="rounded-lg bg-field p-2">
          <div class="text-base font-semibold tabular">{{ formatUsd(spent) }}</div>
          <div class="text-[10.5px] text-muted-foreground">spent</div>
        </div>
      </div>
    </div>

    <div v-if="picked.length" class="grid gap-2">
      <div class="flex items-baseline justify-between">
        <span class="font-medium">{{ picked.length }} selected</span>
        <span class="font-mono text-muted-foreground">{{ formatUsd(pickedCost) }}</span>
      </div>
      <div class="grid grid-cols-3 gap-1.5">
        <AssetThumb v-for="a in picked.slice(0, 9)" :key="a.id" :asset="a" class="aspect-video overflow-hidden rounded-md bg-viewer" />
      </div>
      <p class="text-muted-foreground">Use the bar above the Composer — or drag them onto the board, the Composer or the timeline.</p>
    </div>

    <div class="grid gap-2 leading-relaxed text-muted-foreground">
      <p><span class="font-medium text-foreground">Click</span> a result to see it big, with its prompt and what to do next (← → to browse).</p>
      <p><span class="font-medium text-foreground">⌘- or ⇧-click</span> to select several; Esc clears.</p>
      <p><span class="font-medium text-foreground">Reuse</span> on a row brings its prompt, model and settings back to the Composer; <span class="font-medium text-foreground">Again</span> runs it with a new seed.</p>
      <p><span class="font-medium text-foreground">♥</span> marks favourites; Hide keeps a result in Library › Media but out of the Feed.</p>
    </div>
  </div>
</template>
