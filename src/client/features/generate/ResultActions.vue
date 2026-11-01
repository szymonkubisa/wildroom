<script setup lang="ts">
import type { AssetDTO } from '@shared/types/assets'
import type { CanvasAssetItem } from '@shared/types/canvas'
import { computed } from 'vue'
import { cn } from '@/lib/utils'
import { useResultActions } from './resultActions'

/** The actions bar a result shows on hover (board items, Feed tiles): Vary · Animate · Upscale · Remove BG · Start frame · To timeline. */
const props = defineProps<{ asset: AssetDTO; item?: CanvasAssetItem; narrow?: boolean }>()
const results = useResultActions()
const actions = computed(() => results.actionsFor(props.asset, props.item))
</script>

<template>
  <div
    v-if="actions.length"
    class="pointer-events-auto flex flex-wrap items-center gap-0.5 rounded-lg border border-white/10 bg-black/75 p-0.5 text-white shadow-lg backdrop-blur"
    data-result-actions=""
    @pointerdown.stop
    @dblclick.stop
    @contextmenu.stop
  >
    <button
      v-for="a in actions"
      :key="a.id"
      type="button"
      :class="cn('flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium whitespace-nowrap hover:bg-white/15', narrow && 'px-1')"
      :title="a.title"
      :aria-label="a.label"
      :data-result-action="a.id"
      @click.stop="a.run()"
    >
      <component :is="a.icon" class="size-3.5 shrink-0" />
      <span v-if="!narrow">{{ a.label }}</span>
    </button>
  </div>
</template>
