<script setup lang="ts">
import { ChevronDown, ChevronRight, Clock, Eye, EyeOff, Frame, Group, Image, Lock, Shapes, StickyNote, Type, Unlock } from '@lucide/vue'
import type { CanvasItem } from '@shared/types/canvas'
import { computed, ref } from 'vue'
import { transport } from '@/features/editor/transport'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { useCanvasStore } from '@/stores/canvas'
import { updateItem } from './useCanvasDoc'

/**
 * The board's layers: frames with their contents, groups with their members, topmost first. Each can be hidden
 * (nowhere drawn, exports and videos included) or locked; in animation mode the clock jumps to its first key.
 */
const canvas = useCanvasStore()
const assets = useAssetsStore()
const collapsed = ref(new Set<string>())

const rows = computed(() => {
  const items = canvas.items
  const ids = new Set(items.map((i) => i.id))
  const parentOf = (i: CanvasItem) => (i.groupId && ids.has(i.groupId) ? i.groupId : i.frameId && ids.has(i.frameId) ? i.frameId : undefined)
  const out: { item: CanvasItem; depth: number; parent: boolean }[] = []
  const add = (parent: string | undefined, depth: number, list: CanvasItem[]) => {
    for (const i of list) {
      if (parentOf(i) !== parent) continue
      const kids = i.kind === 'frame' || i.kind === 'group'
      out.push({ item: i, depth, parent: kids })
      if (kids && !collapsed.value.has(i.id)) add(i.id, depth + 1, list)
    }
  }
  // Top of the paint order first, like a design tool's layers; free items above the frames (they draw over them).
  const top = [...items].reverse()
  add(undefined, 0, [...top.filter((i) => i.kind !== 'frame'), ...top.filter((i) => i.kind === 'frame')])
  return out
})

function label(i: CanvasItem): string {
  if (i.name) return i.name
  switch (i.kind) {
    case 'text':
    case 'note':
      return i.text.trim().split('\n')[0]!.slice(0, 40) || (i.kind === 'text' ? 'Text' : 'Note')
    case 'shape':
      return i.shape === 'rect' ? 'Rectangle' : i.shape[0]!.toUpperCase() + i.shape.slice(1)
    case 'asset':
      return (i.assetId && assets.get(i.assetId)?.name) || 'Picture'
    case 'group':
      return 'Group'
    case 'frame':
      return 'Frame'
  }
}
const ICONS = { text: Type, note: StickyNote, shape: Shapes, asset: Image, group: Group, frame: Frame } as const

function pick(i: CanvasItem) {
  // A group's member is picked inside its group.
  canvas.enteredGroupId = i.groupId
  canvas.select([i.id])
}
function toggleCollapsed(id: string) {
  const next = new Set(collapsed.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsed.value = next
}

/** In animation mode: the animation frame of an element's first key, if it has keys. */
function firstKey(id: string): number | undefined {
  const track = canvas.anim?.clip.tracks[id]
  if (!track) return undefined
  const frames = (['opacity', 'transform', 'reveal', 'trim', 'stretch', 'color', 'blur'] as const).flatMap((k) => (track[k] ?? []).map((key) => key.frame))
  if (track.follow) frames.push(...track.follow.progress.map((k) => k.frame))
  return frames.length ? Math.min(...frames) : undefined
}
function goTo(frame: number) {
  const a = canvas.anim
  if (a) transport.seek(a.start + Math.max(0, Math.min(a.clip.duration - 1, frame - (a.clip.offset ?? 0))))
}
</script>

<template>
  <div class="pointer-events-auto flex max-h-full w-60 flex-col overflow-hidden rounded-xl border bg-background/95 shadow-lg backdrop-blur" data-layers-panel="">
    <div class="border-b px-3 py-2 text-xs font-semibold">Layers</div>
    <div class="min-h-0 flex-1 overflow-y-auto p-1">
      <p v-if="!rows.length" class="p-2 text-[11px] text-muted-foreground">Nothing on this board yet.</p>
      <div
        v-for="{ item, depth, parent } in rows"
        :key="item.id"
        :class="
          cn(
            'group flex h-7 cursor-default items-center gap-1 rounded-md pr-1 text-[11px]',
            canvas.selection.includes(item.id) ? 'bg-selection/15 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            item.hidden && 'opacity-50',
          )
        "
        :style="{ paddingLeft: `${4 + depth * 12}px` }"
        @click="pick(item)"
      >
        <button v-if="parent" type="button" class="flex size-4 shrink-0 items-center justify-center" @click.stop="toggleCollapsed(item.id)">
          <component :is="collapsed.has(item.id) ? ChevronRight : ChevronDown" class="size-3" />
        </button>
        <span v-else class="w-4 shrink-0" />
        <component :is="ICONS[item.kind]" class="size-3.5 shrink-0" />
        <span class="min-w-0 flex-1 truncate">{{ label(item) }}</span>
        <button
          v-if="canvas.anim && firstKey(item.id) !== undefined"
          type="button"
          title="Go to its first key"
          class="flex size-5 items-center justify-center rounded opacity-70 hover:opacity-100"
          @click.stop="goTo(firstKey(item.id)!)"
        >
          <Clock class="size-3" />
        </button>
        <button
          v-if="item.kind !== 'frame'"
          type="button"
          :title="item.hidden ? 'Show' : 'Hide (also in exports and videos)'"
          :class="cn('flex size-5 items-center justify-center rounded', !item.hidden && 'opacity-0 group-hover:opacity-70')"
          @click.stop="updateItem(canvas.board.id, item.id, { hidden: item.hidden ? undefined : true }, item.hidden ? 'Show' : 'Hide')"
        >
          <component :is="item.hidden ? EyeOff : Eye" class="size-3" />
        </button>
        <button
          type="button"
          :title="item.locked ? 'Unlock' : 'Lock'"
          :class="cn('flex size-5 items-center justify-center rounded', !item.locked && 'opacity-0 group-hover:opacity-70')"
          @click.stop="updateItem(canvas.board.id, item.id, { locked: item.locked ? undefined : true }, item.locked ? 'Unlock' : 'Lock')"
        >
          <component :is="item.locked ? Lock : Unlock" class="size-3" />
        </button>
      </div>
    </div>
  </div>
</template>
