<script setup lang="ts">
import { cn } from '@/lib/utils'

/**
 * One tile in the row above the Composer's prompt: a miniature, what it is and what it is set to — a look (Camera ·
 * Lighting · Color), the camera move, the pictures that go with the prompt. The tiles share the row in equal widths
 * (up to 10rem; narrower when the row is full, before anything wraps). A button: a Popover trigger as-child.
 */
defineProps<{ label: string; value: string; active?: boolean; over?: boolean }>()
</script>

<template>
  <button
    type="button"
    :class="
      cn(
        'group/tile flex h-10 max-w-40 min-w-30 flex-1 basis-0 items-center gap-2 rounded-[10px] border bg-field py-1 pr-2.5 pl-1 text-left transition-colors hover:border-foreground/25 hover:bg-field-hover',
        active && 'border-brand/50',
        over && 'border-brand bg-brand/10',
      )
    "
  >
    <span class="relative h-8 w-11 shrink-0 overflow-hidden rounded-md bg-muted"><slot name="thumb" /></span>
    <span class="grid min-w-0 leading-tight">
      <span class="truncate font-mono text-[9px] font-medium tracking-wider text-muted-foreground uppercase">{{ label }}</span>
      <span :class="cn('truncate text-[12px] font-medium', !active && 'text-foreground/80')">{{ value }}</span>
    </span>
  </button>
</template>
