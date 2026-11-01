<script setup lang="ts">
import { Copy, ListVideo, Pencil, SquarePlay, Trash2 } from '@lucide/vue'
import type { TimelineSummary } from '@shared/timeline/timelines'
import { formatDuration } from '@shared/time/timecode'
import type { AssetDTO } from '@shared/types/assets'
import { computed, ref, watch } from 'vue'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { aspectLabel } from '@/features/projects/formats'
import { cn } from '@/lib/utils'
import type { TimelineAction } from './types'

/** A timeline of the project as an Assets card: its first shot, format and length. Double-click opens it. */
const props = defineProps<{ timeline: TimelineSummary; poster?: AssetDTO; selected: boolean; canDelete: boolean }>()
const emit = defineEmits<{ select: []; action: [action: TimelineAction] }>()

const posterFailed = ref(false)
watch(
  () => props.poster?.id,
  () => (posterFailed.value = false),
)

const s = computed(() => props.timeline.settings)
const seconds = computed(() => props.timeline.durationFrames / s.value.fps)
const format = computed(() => `${aspectLabel(s.value.width, s.value.height)} · ${s.value.fps}p`)
/** The picture box takes the timeline's own aspect, so a 9:16 cut reads as one at a glance. */
const frameStyle = computed(() => {
  const landscape = s.value.width / s.value.height >= 16 / 9
  return { aspectRatio: `${s.value.width} / ${s.value.height}`, width: landscape ? '100%' : 'auto', height: landscape ? 'auto' : '100%' }
})
const posterUrl = computed(() => (props.poster?.variants.poster && !posterFailed.value ? `/media/${props.poster.id}/poster` : undefined))
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child>
      <div
        :class="
          cn(
            'group flex cursor-default flex-col overflow-hidden rounded-xl border border-transparent bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
            selected && 'border-selection ring-1 ring-selection',
          )
        "
        data-timeline-card
        :data-timeline-id="timeline.id"
        :data-active="timeline.active || undefined"
        tabindex="0"
        draggable="false"
        @dragstart.prevent
        @click="emit('select')"
        @dblclick="emit('action', 'open')"
        @keydown.enter.prevent="emit('action', 'open')"
      >
        <div class="relative flex aspect-video items-center justify-center overflow-hidden bg-viewer p-1.5">
          <div class="relative flex max-h-full max-w-full items-center justify-center overflow-hidden rounded-[5px] bg-black/40 ring-1 ring-white/10" :style="frameStyle">
            <img v-if="posterUrl" :src="posterUrl" class="size-full object-cover" draggable="false" alt="" @error="posterFailed = true" />
            <ListVideo v-else class="size-5 text-muted-foreground/60" />
          </div>
          <span class="absolute top-1.5 left-1.5 flex items-center gap-0.5 rounded-md bg-black/55 px-1 text-[10px] text-white/90 backdrop-blur-sm">
            <ListVideo class="size-2.5" /> Timeline
          </span>
          <span v-if="timeline.active" class="absolute top-1.5 right-1.5 rounded-md bg-brand px-1 text-[10px] font-medium text-brand-foreground">Open</span>
          <span class="absolute bottom-1.5 left-1.5 rounded-md bg-black/60 px-1 font-mono text-[10px] text-white/90 tabular backdrop-blur-sm">{{ format }}</span>
          <span class="absolute right-1.5 bottom-1.5 rounded-md bg-black/60 px-1 font-mono text-[10px] text-white tabular backdrop-blur-sm">
            {{ timeline.durationFrames > 0 ? formatDuration(seconds) : 'Empty' }}
          </span>
        </div>
        <div class="flex items-center gap-1.5 px-2 py-1.5">
          <ListVideo :class="cn('size-3 shrink-0', timeline.active ? 'text-brand' : 'text-muted-foreground')" />
          <span class="min-w-0 flex-1 truncate text-[11px]" :title="timeline.name">{{ timeline.name }}</span>
        </div>
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent class="w-56">
      <ContextMenuItem :disabled="timeline.active" @select="emit('action', 'open')">
        <SquarePlay /> Open <ContextMenuShortcut>double-click</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem @select="emit('action', 'rename')"><Pencil /> Rename…</ContextMenuItem>
      <ContextMenuItem @select="emit('action', 'duplicate')"><Copy /> Duplicate</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" :disabled="!canDelete" @select="emit('action', 'delete')"><Trash2 /> Delete…</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
</template>
