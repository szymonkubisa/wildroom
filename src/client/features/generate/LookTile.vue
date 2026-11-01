<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useGenerateStore } from '@/stores/generate'
import ComposerTile from './ComposerTile.vue'
import LookOptions from './LookOptions.vue'
import LookThumb from './LookThumb.vue'
import { type LookAxis, lookAxis, lookOption } from './look'

/**
 * A look tile (Camera · Lighting · Color): Auto, or picked from miniatures; it goes with every prompt until set back.
 * `tabs`: the axes it holds (Camera: the framing and the lens), each a tab of its popover; the tile says all picked.
 */
const props = defineProps<{ axis: LookAxis; tabs?: LookAxis[] }>()
const generate = useGenerateStore()
const open = ref(false)

const axes = computed(() => props.tabs ?? [props.axis])
const tab = ref<LookAxis>(props.axis)
watch(open, (on) => {
  // Opens on the first tab with nothing picked yet after one that has (framing picked: the lens next).
  if (!on) return
  const firstPicked = axes.value.findIndex((a) => generate.look[a])
  tab.value = axes.value.find((a, i) => i > firstPicked && !generate.look[a]) ?? axes.value[Math.max(0, firstPicked)]!
})

const info = computed(() => lookAxis(props.axis))
const picked = computed(() => axes.value.map((a) => lookOption(a, generate.look[a])).filter((o) => o !== undefined))
/** The miniature: the picked ones together (the lens's blur under the framing). */
/** The miniature: the first picked axis's picture (the framing over the lens), or Auto's. */
const thumb = computed(() => {
  const axis = axes.value.find((a) => generate.look[a])
  return axis ? { axis, id: generate.look[axis] } : { axis: props.axis, id: undefined }
})
const title = computed(() =>
  picked.value.length ? `${info.value.label}: ${picked.value.map((o) => o.phrase).join('; ')} — goes with the prompt` : `${info.value.label}: Auto — the prompt and the model decide`,
)

function onPicked() {
  // One axis: done. Several: on to the next one, closing after the last.
  const i = axes.value.indexOf(tab.value)
  if (i < axes.value.length - 1) tab.value = axes.value[i + 1]!
  else open.value = false
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <ComposerTile
        :label="info.label"
        :value="picked.map((o) => (picked.length > 1 ? (o.short ?? o.label) : o.label)).join(' · ') || 'Auto'"
        :active="picked.length > 0"
        :title="title"
        :data-composer-look="axis"
      >
        <template #thumb><LookThumb :axis="thumb.axis" :id="thumb.id" /></template>
      </ComposerTile>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" class="w-[25rem] p-2.5">
      <div class="mb-2 flex items-center justify-between gap-2 px-0.5">
        <div v-if="axes.length > 1" class="flex gap-0.5 rounded-lg bg-field p-0.5" role="tablist">
          <button
            v-for="a in axes"
            :key="a"
            type="button"
            role="tab"
            :aria-selected="tab === a"
            :class="cn('rounded-md px-2.5 py-1 text-xs font-medium transition-colors', tab === a ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')"
            :data-look-tab="a"
            @click="tab = a"
          >
            {{ lookAxis(a).label }}<span v-if="generate.look[a]" class="ml-1 inline-block size-1.5 rounded-full bg-brand align-middle" />
          </button>
        </div>
        <span v-else class="text-xs font-medium">{{ info.label }}</span>
        <span class="text-[10.5px] text-muted-foreground">Goes with the prompt as it is sent</span>
      </div>
      <LookOptions :key="tab" :axis="tab" @picked="onPicked" />
    </PopoverContent>
  </Popover>
</template>
