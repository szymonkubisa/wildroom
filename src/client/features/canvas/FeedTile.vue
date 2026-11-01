<script setup lang="ts">
import { Check, Heart } from '@lucide/vue'
import { flicksToSeconds } from '@shared/time/flicks'
import type { AssetDTO } from '@shared/types/assets'
import { computed, ref } from 'vue'
import AssetThumb from '@/features/assets/AssetThumb.vue'
import { setAssetDrag } from '@/features/assets/drag'
import ResultActions from '@/features/generate/ResultActions.vue'
import { useResultActions } from '@/features/generate/resultActions'
import { formatUsd, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * One result in the Feed: the media is the card (a clip skims under the pointer), ♥ in its corner, the result's
 * actions on hover, and — in the grid — its prompt and model under it. Click opens it big; ⌘- or ⇧-click selects.
 */
const props = defineProps<{ asset: AssetDTO; selected?: boolean; selecting?: boolean; caption?: boolean }>()
const emit = defineEmits<{ open: []; select: [range: boolean] }>()
const results = useResultActions()
const hovered = ref(false)

const seconds = computed(() => (props.asset.durationFlicks ? `${Math.round(flicksToSeconds(props.asset.durationFlicks) * 10) / 10} s` : ''))
const favourite = computed(() => props.asset.rating === 1)

function onClick(e: MouseEvent) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || props.selecting) emit('select', e.shiftKey)
  else emit('open')
}
function onDrag(e: DragEvent) {
  if (e.dataTransfer && props.asset.status === 'ready') setAssetDrag(e.dataTransfer, [props.asset])
}
</script>

<template>
  <figure class="grid content-start gap-1.5" :data-feed-item="asset.id">
    <div
      :class="
        cn(
          'group/tile relative aspect-video cursor-pointer overflow-hidden rounded-xl bg-viewer ring-offset-2 ring-offset-background transition-[box-shadow,transform] duration-150 hover:-translate-y-px hover:shadow-[0_10px_30px_-12px_rgb(0_0_0/0.6)]',
          selected && 'ring-2 ring-selection',
        )
      "
      :draggable="asset.status === 'ready'"
      role="button"
      tabindex="0"
      :aria-label="`Open ${asset.name}`"
      @click="onClick"
      @keydown.enter.prevent="emit('open')"
      @keydown.space.prevent="emit('open')"
      @dragstart="onDrag"
      @pointerenter="hovered = true"
      @pointerleave="hovered = false"
    >
      <AssetThumb :asset="asset" :skim="asset.kind === 'video'" class="size-full" />
      <span v-if="seconds" class="absolute bottom-1.5 left-1.5 rounded-md bg-black/60 px-1.5 py-px font-mono text-[10px] text-white backdrop-blur group-hover/tile:opacity-0">{{ seconds }}</span>

      <!-- Selection: a check in the corner while anything is selected (or on hover). -->
      <button
        type="button"
        :class="
          cn(
            'absolute top-1.5 left-1.5 grid size-5.5 place-items-center rounded-full border border-white/60 bg-black/40 text-white backdrop-blur transition-opacity',
            selected ? 'border-selection bg-selection text-black opacity-100' : selecting ? 'opacity-100' : 'opacity-0 group-hover/tile:opacity-100',
          )
        "
        :aria-pressed="selected"
        :aria-label="selected ? 'Deselect' : 'Select'"
        data-feed-select=""
        @click.stop="emit('select', false)"
      >
        <Check v-if="selected" class="size-3.5" />
      </button>

      <button
        type="button"
        :class="
          cn(
            'absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-full bg-black/45 text-white backdrop-blur transition-opacity hover:bg-black/70',
            favourite ? 'opacity-100' : 'opacity-0 group-hover/tile:opacity-100',
          )
        "
        :aria-pressed="favourite"
        :title="favourite ? 'Favourite — click to unmark' : 'Mark as favourite'"
        data-feed-favourite=""
        @click.stop="results.setRating(asset, favourite ? 0 : 1)"
      >
        <Heart :class="cn('size-3.5', favourite && 'fill-rose-400 text-rose-400')" />
      </button>

      <div v-if="hovered && !selecting" class="absolute inset-x-1.5 bottom-1.5" @click.stop>
        <ResultActions :asset="asset" narrow />
      </div>
    </div>
    <figcaption v-if="caption" class="grid px-0.5 leading-tight">
      <span class="truncate text-[12px] font-medium" :title="asset.generation?.prompt ?? asset.name">{{ asset.generation?.prompt ?? asset.name }}</span>
      <span class="truncate font-mono text-[10.5px] text-muted-foreground">
        {{ asset.generation?.modelLabel }}<template v-if="asset.generation?.costUsd != null"> · {{ formatUsd(asset.generation.costUsd) }}</template> · {{ relativeTime(asset.createdAt) }}
      </span>
    </figcaption>
  </figure>
</template>
