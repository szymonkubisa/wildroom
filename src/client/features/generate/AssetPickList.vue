<script setup lang="ts">
import { AudioLines, Film, ImagePlus } from '@lucide/vue'
import type { AssetKind } from '@shared/types/assets'
import { computed } from 'vue'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'

/** The project's ready assets of one kind as a pickable grid (rejected ones left out); `large`: big pictures (the Composer's). */
const props = defineProps<{ kind: AssetKind; selected?: string | string[]; large?: boolean }>()
const emit = defineEmits<{ pick: [assetId: string] }>()

const assets = useAssetsStore()
const candidates = computed(() => assets.list.filter((a) => a.kind === props.kind && a.status === 'ready' && a.rating !== -1))
const isSelected = (id: string) => (Array.isArray(props.selected) ? props.selected.includes(id) : props.selected === id)
const icon = computed(() => (props.kind === 'video' ? Film : props.kind === 'audio' ? AudioLines : ImagePlus))
</script>

<template>
  <ScrollArea :class="large ? 'h-[min(28rem,55vh)]' : 'h-56'">
    <div v-if="!candidates.length" class="p-4 text-center text-xs text-muted-foreground">No {{ kind }} assets in this project yet.</div>
    <div :class="cn('grid', large ? 'grid-cols-4 gap-2.5 pr-2' : 'grid-cols-3 gap-1.5')">
      <button
        v-for="a in candidates"
        :key="a.id"
        type="button"
        :class="cn('overflow-hidden border text-left hover:border-foreground/40', large ? 'rounded-lg' : 'rounded', isSelected(a.id) && 'border-selection')"
        :title="a.name"
        @click="emit('pick', a.id)"
      >
        <div class="flex aspect-video items-center justify-center bg-viewer">
          <img v-if="a.variants.poster" :src="`/media/${a.id}/poster`" :class="large ? 'size-full object-cover' : 'max-h-full max-w-full object-contain'" alt="" />
          <component :is="icon" v-else class="size-4 text-muted-foreground" />
        </div>
        <div :class="cn('truncate', large ? 'px-1.5 py-1 text-[11px]' : 'px-1 py-0.5 text-[10px]')">{{ a.name }}</div>
      </button>
    </div>
  </ScrollArea>
</template>
