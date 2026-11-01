<script setup lang="ts">
import { Check } from '@lucide/vue'
import { computed } from 'vue'
import { cn } from '@/lib/utils'
import { useGenerateStore } from '@/stores/generate'
import LookThumb from './LookThumb.vue'
import { type LookAxis, lookAxis, lookOption } from './look'

/** One look axis as a grid of miniatures — Auto and its options; a click sets it (the Composer's look) and emits `picked`. */
const props = defineProps<{ axis: LookAxis }>()
const emit = defineEmits<{ picked: [id: string | undefined] }>()
const generate = useGenerateStore()

const info = computed(() => lookAxis(props.axis))
const picked = computed(() => lookOption(props.axis, generate.look[props.axis]))

function pick(id: string | undefined) {
  const next = { ...generate.look }
  if (id) next[props.axis] = id
  else delete next[props.axis]
  generate.look = next
  emit('picked', id)
}
</script>

<template>
  <div class="grid grid-cols-3 gap-1.5" role="listbox" :aria-label="info.label">
    <button
      v-for="o in [undefined, ...info.options]"
      :key="o?.id ?? 'auto'"
      type="button"
      role="option"
      :aria-selected="picked?.id === o?.id"
      :title="o?.phrase ?? 'Nothing added: the prompt and the model decide'"
      :class="cn('group/opt grid gap-1 rounded-lg p-1 text-left transition-colors hover:bg-accent', picked?.id === o?.id && 'bg-accent ring-1 ring-brand/60')"
      :data-look-option="o?.id ?? 'auto'"
      @click="pick(o?.id)"
    >
      <span class="relative block aspect-video overflow-hidden rounded-md">
        <LookThumb :axis="axis" :id="o?.id" />
        <span v-if="!o" class="absolute inset-0 grid place-items-center bg-black/45 text-[11px] font-semibold tracking-wide text-white">AUTO</span>
      </span>
      <span class="flex items-center gap-1 px-0.5 text-[11.5px]">
        <span class="truncate">{{ o?.label ?? 'Auto' }}</span>
        <Check v-if="picked?.id === o?.id" class="ml-auto size-3 shrink-0 text-brand" />
      </span>
    </button>
  </div>
</template>
