<script setup lang="ts">
import { Loader2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * A question asked in place, under the button that asked it: what will happen line by line, what it costs and how
 * long it takes, then Cancel / the action — and, when there is one, the other way to do it on the left.
 */
defineProps<{
  title: string
  /** "$0.45 · ≈ 2 min", top right. */
  total?: string
  lines: { text: string; value?: string; warn?: boolean }[]
  note?: string
  /** What can't be done (shown as warnings). */
  problems?: string[]
  confirmText: string
  /** Replaces or deletes something: the button is red. */
  destructive?: boolean
  /** Nothing to confirm (only the other way, or Cancel). */
  disabled?: boolean
  busy?: boolean
  /** The other way ("Rebuild all scenes instead…"), on the left. */
  alt?: string
}>()
const emit = defineEmits<{ confirm: []; cancel: []; alt: [] }>()
</script>

<template>
  <div class="grid gap-2 rounded-xl border bg-card p-3 text-xs shadow-sm" role="group" :aria-label="title" data-inline-confirm="">
    <div class="flex items-baseline gap-2">
      <span class="text-[13px] font-semibold tracking-tight">{{ title }}</span>
      <span class="flex-1" />
      <span v-if="total" class="shrink-0 text-muted-foreground tabular" data-inline-confirm-total="">{{ total }}</span>
    </div>
    <div v-if="lines.length" class="grid divide-y rounded-lg bg-field/50">
      <div v-for="(l, i) in lines" :key="i" class="flex items-baseline gap-3 px-2.5 py-1.5">
        <span :class="cn('min-w-0 flex-1', l.warn && 'text-role-effects')">{{ l.text }}</span>
        <span v-if="l.value" class="shrink-0 text-right text-muted-foreground tabular">{{ l.value }}</span>
      </div>
    </div>
    <p v-if="note" class="leading-snug text-muted-foreground">{{ note }}</p>
    <p v-for="p in problems ?? []" :key="p" class="leading-snug text-role-effects">{{ p }}</p>
    <div class="flex flex-wrap items-center gap-2 pt-0.5">
      <button v-if="alt" type="button" class="text-left font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" data-inline-confirm-alt="" @click="emit('alt')">
        {{ alt }}
      </button>
      <span class="flex-1" />
      <Button size="sm" variant="ghost" :disabled="busy" @click="emit('cancel')">Cancel</Button>
      <Button size="sm" :variant="destructive ? 'destructive' : 'default'" :disabled="busy || disabled" data-inline-confirm-go="" @click="emit('confirm')">
        <Loader2 v-if="busy" class="animate-spin" />{{ confirmText }}
      </Button>
    </div>
  </div>
</template>
