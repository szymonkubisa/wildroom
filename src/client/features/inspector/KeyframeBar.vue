<script setup lang="ts">
import { ChevronLeft, ChevronRight, Diamond, X } from '@lucide/vue'
import type { KeyEase, KeyEasePreset } from '@shared/types/project-doc'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

defineProps<{
  /** Number of keys on this track. */
  count: number
  /** A key sits exactly on the playhead. */
  onKey: boolean
  ease?: KeyEase
  hasPrev: boolean
  hasNext: boolean
}>()
const emit = defineEmits<{ prev: []; next: []; toggle: []; ease: [value: KeyEase]; clear: [] }>()

const EASES: { value: KeyEasePreset; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'ease-in', label: 'Ease in' },
  { value: 'ease-out', label: 'Ease out' },
  { value: 'ease-in-out', label: 'Ease in-out' },
  { value: 'back', label: 'Overshoot' },
  { value: 'elastic', label: 'Elastic' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'hold', label: 'Hold' },
]
</script>

<template>
  <div class="flex items-center gap-0.5">
    <Select v-if="onKey && count > 1" :model-value="typeof ease === 'object' ? 'custom' : (ease ?? 'linear')" @update:model-value="(v) => emit('ease', v as KeyEase)">
      <SelectTrigger size="sm" class="mr-1 h-6 w-auto gap-1 px-1.5 text-[10px]"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem v-for="e in EASES" :key="e.value" :value="e.value">{{ e.label }}</SelectItem>
        <SelectItem v-if="typeof ease === 'object'" value="custom" disabled>Smooth (preset)</SelectItem>
      </SelectContent>
    </Select>
    <Button variant="ghost" size="icon-xs" :disabled="!hasPrev" title="Previous keyframe" @click="emit('prev')"><ChevronLeft /></Button>
    <Tooltip>
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon-xs" @click="emit('toggle')">
          <Diamond :class="cn('size-3', onKey ? 'fill-role-effects text-role-effects' : count ? 'text-role-effects' : 'text-muted-foreground')" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{{ onKey ? 'Remove keyframe' : 'Add keyframe at playhead' }}</TooltipContent>
    </Tooltip>
    <Button variant="ghost" size="icon-xs" :disabled="!hasNext" title="Next keyframe" @click="emit('next')"><ChevronRight /></Button>
    <Button v-if="count" variant="ghost" size="icon-xs" title="Remove all keyframes" @click="emit('clear')"><X /></Button>
  </div>
</template>
