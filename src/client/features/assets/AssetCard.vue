<script setup lang="ts">
import {
  ArrowRightToLine,
  AudioLines,
  Clapperboard,
  Film,
  FileSearch,
  FolderSearch,
  Heart,
  Image as ImageIcon,
  LayoutDashboard,
  Link2,
  ListPlus,
  Pencil,
  Replace,
  Sparkles,
  ThumbsDown,
  Trash2,
  Wand2, Captions, ScanEye, Tag, Type as TypeIcon } from '@lucide/vue'
import { canExtendWithVeo } from '@shared/models/catalog/fal'
import { flicksToSeconds } from '@shared/time/flicks'
import { formatDuration } from '@shared/time/timecode'
import type { AssetDTO } from '@shared/types/assets'
import { computed } from 'vue'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import AssetThumb from './AssetThumb.vue'
import type { AssetAction } from './types'

/** `order`: 1-based place in a multi-selection (drops and edits use that order). */
const props = defineProps<{ asset: AssetDTO; selected: boolean; order?: number; hint?: string; canvasMode?: boolean }>()
const emit = defineEmits<{
  select: [additive: boolean]
  /** The panel fills the payload (it knows the selection); emitted synchronously, so setData still works. */
  drag: [event: DragEvent]
  preview: []
  skim: [seconds: number | undefined]
  hover: [inside: boolean]
  action: [action: AssetAction]
}>()


const seconds = computed(() => flicksToSeconds(props.asset.durationFlicks ?? 0))
const kindIcon = computed(() => (props.asset.kind === 'video' ? Film : props.asset.kind === 'image' ? ImageIcon : props.asset.kind === 'font' ? TypeIcon : AudioLines))
const roleLabel = computed(() => (props.asset.kind === 'audio' ? (props.asset.role ?? 'audio').split('.')[0] : undefined))

function onDragStart(e: DragEvent) {
  if (!e.dataTransfer || props.asset.status !== 'ready') {
    e.preventDefault()
    return
  }
  emit('drag', e)
}
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child>
      <div
        :class="
          cn(
            'group flex cursor-default flex-col overflow-hidden rounded-xl border border-transparent bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
            selected && 'border-selection ring-1 ring-selection',
            asset.rating === -1 && 'opacity-50',
          )
        "
        :draggable="asset.status === 'ready' && asset.kind !== 'font'"
        tabindex="0"
        @dragstart="onDragStart"
        @pointerenter="emit('hover', true)"
        @pointerleave="emit('hover', false)"
        @click="emit('select', $event.metaKey || $event.shiftKey)"
        @keydown.enter.self.prevent="emit('select', $event.metaKey || $event.shiftKey)"
        @dblclick="emit('preview')"
      >
        <div class="relative aspect-video">
          <AssetThumb :asset="asset" :skim="asset.kind === 'video'" @skim="(s) => emit('skim', s)" />
          <span
            v-if="asset.kind !== 'image' && seconds > 0"
            class="absolute right-1.5 bottom-1.5 rounded-md bg-black/60 px-1 font-mono text-[10px] text-white tabular backdrop-blur-sm"
          >
            {{ formatDuration(seconds) }}
          </span>
          <span
            v-if="order"
            class="absolute bottom-1.5 left-1.5 flex size-4 items-center justify-center rounded-full bg-selection font-mono text-[10px] font-semibold text-black tabular"
          >
            {{ order }}
          </span>
          <Heart v-if="asset.rating === 1" class="absolute top-1 right-1 size-3.5 fill-role-effects text-role-effects" />
          <span
            v-if="asset.generation"
            class="absolute top-1.5 left-1.5 flex items-center gap-0.5 rounded-md bg-black/55 px-1 text-[10px] text-white/90 backdrop-blur-sm"
          >
            <Sparkles class="size-2.5" /> {{ asset.generation.modelLabel }}
          </span>
        </div>
        <div class="flex items-center gap-1.5 px-2 py-1.5">
          <component :is="kindIcon" class="size-3 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate text-[11px]" :title="asset.name">{{ asset.name }}</span>
          <span v-if="roleLabel" class="shrink-0 text-[10px] text-muted-foreground capitalize">{{ roleLabel }}</span>
        </div>
        <div v-if="hint" class="line-clamp-2 px-2 pb-1.5 text-[10px] leading-snug text-muted-foreground" :title="hint">{{ hint }}</div>
        <div v-else-if="asset.keywords.length" class="flex flex-wrap gap-0.5 px-2 pb-1.5">
          <span v-for="k in asset.keywords.slice(0, 3)" :key="k" class="rounded-full bg-field px-1.5 text-[9px] text-muted-foreground">{{ k }}</span>
        </div>
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent class="w-60">
      <template v-if="canvasMode && asset.kind !== 'audio' && asset.kind !== 'font'">
        <ContextMenuItem :disabled="asset.status !== 'ready'" @select="emit('action', 'addToCanvas')">
          <LayoutDashboard /> Add to board <ContextMenuShortcut>double-click</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
      </template>
      <ContextMenuItem :disabled="asset.status !== 'ready'" @select="emit('action', 'append')">
        <ListPlus /> Append to storyline <ContextMenuShortcut>E</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem :disabled="asset.status !== 'ready'" @select="emit('action', 'insert')">
        <ArrowRightToLine /> Insert at playhead <ContextMenuShortcut>W</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem :disabled="asset.status !== 'ready'" @select="emit('action', 'connect')">
        <Link2 /> Connect at playhead <ContextMenuShortcut>Q</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem :disabled="asset.status !== 'ready'" @select="emit('action', 'overwrite')">
        <Replace /> Overwrite at playhead <ContextMenuShortcut>D</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <template v-if="asset.kind === 'image'">
        <ContextMenuItem @select="emit('action', 'animate')"><Wand2 /> Animate (image → video)</ContextMenuItem>
        <ContextMenuItem @select="emit('action', 'startFrame')"><Clapperboard /> Use as start frame</ContextMenuItem>
      </template>
      <ContextMenuItem v-if="asset.kind === 'video'" @select="emit('action', 'extend')">
        <Wand2 /> Extend shot (from last frame)
      </ContextMenuItem>
      <ContextMenuItem v-if="canExtendWithVeo(asset)" inset @select="emit('action', 'extendVeo')">Extend with Veo (+7 s)…</ContextMenuItem>
      <ContextMenuItem v-if="asset.kind === 'image' || asset.kind === 'video'" @select="emit('action', 'upscale')">
        <Sparkles /> Upscale…
      </ContextMenuItem>
      <ContextMenuSeparator v-if="asset.kind === 'image' || asset.kind === 'video'" />
      <ContextMenuItem v-if="asset.rating !== 1" @select="emit('action', 'favorite')"><Heart /> Favorite</ContextMenuItem>
      <ContextMenuItem v-if="asset.rating !== -1" @select="emit('action', 'reject')"><ThumbsDown /> Reject</ContextMenuItem>
      <ContextMenuItem v-if="asset.rating !== 0" @select="emit('action', 'unrate')">Clear rating</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem @select="emit('action', 'rename')"><Pencil /> Rename…</ContextMenuItem>
      <ContextMenuItem @select="emit('action', 'keywords')"><Tag /> Keywords…</ContextMenuItem>
      <ContextMenuItem v-if="asset.kind === 'image' || asset.kind === 'video'" :disabled="asset.status !== 'ready'" @select="emit('action', 'describe')"><ScanEye /> Describe with AI (for search)</ContextMenuItem>
      <ContextMenuItem v-if="asset.hasAudio" :disabled="asset.status !== 'ready'" @select="emit('action', 'transcribe')"><Captions /> Transcribe speech</ContextMenuItem>
      <ContextMenuItem v-if="asset.generation?.generationId" @select="emit('action', 'details')"><FileSearch /> What was sent…</ContextMenuItem>
      <ContextMenuItem @select="emit('action', 'reveal')"><FolderSearch /> Reveal in Finder</ContextMenuItem>
      <ContextMenuItem v-if="asset.vector" @select="emit('action', 'revealVector')"><FolderSearch /> Reveal SVG in Finder</ContextMenuItem>
      <ContextMenuItem variant="destructive" @select="emit('action', 'remove')"><Trash2 /> Remove from project</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
</template>
