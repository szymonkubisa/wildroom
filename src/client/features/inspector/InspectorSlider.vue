<script setup lang="ts">
import { computed } from 'vue'
import { Slider } from '@/components/ui/slider'

const props = defineProps<{
  label: string
  value: number
  min: number
  max: number
  step: number
  format?: (v: number) => string
  resetTo?: number
}>()
const emit = defineEmits<{ live: [value: number]; commit: [] }>()

const text = computed(() => (props.format ? props.format(props.value) : String(Math.round(props.value * 100) / 100)))

function reset() {
  if (props.resetTo === undefined) return
  emit('live', props.resetTo)
  emit('commit')
}
</script>

<template>
  <div class="grid grid-cols-[88px_1fr_56px] items-center gap-2.5">
    <span class="truncate text-[11px] font-medium text-muted-foreground" :class="resetTo !== undefined && 'cursor-pointer hover:text-foreground'" :title="resetTo !== undefined ? 'Double-click to reset' : undefined" @dblclick="reset">
      {{ label }}
    </span>
    <Slider
      :model-value="[value]"
      :min="min"
      :max="max"
      :step="step"
      @update:model-value="(v) => v && emit('live', v[0]!)"
      @value-commit="emit('commit')"
    />
    <span class="rounded-md bg-field px-1.5 py-[3px] text-right font-mono text-[11px] leading-none tabular">{{ text }}</span>
  </div>
</template>
