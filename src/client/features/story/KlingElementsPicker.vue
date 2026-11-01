<script setup lang="ts">
/**
 * Field for the `elements` param control (Kling element ids): toggles the cast characters that are synced to
 * Kling. Selection order = prompt handle order (`@element_1`, `@element_2`…), shown on each chip.
 */
import { klingElementRef } from '@shared/models/catalog/kling'
import { X } from '@lucide/vue'
import { computed } from 'vue'
import { cn } from '@/lib/utils'
import { useStory } from './useStory'

const props = defineProps<{ maxItems?: number }>()
const model = defineModel<string[] | undefined>()

const { story } = useStory()

const selected = computed(() => (Array.isArray(model.value) ? model.value : []))
const synced = computed(() =>
  story.value.characters.flatMap((c) => (c.kling?.elementId ? [{ id: c.id, name: c.name, elementId: c.kling.elementId }] : [])),
)
/** Selected ids no synced character has (re-synced or removed characters, pasted ids). */
const orphans = computed(() => selected.value.filter((id) => !synced.value.some((c) => c.elementId === id)))
const full = computed(() => props.maxItems !== undefined && selected.value.length >= props.maxItems)

function toggle(elementId: string) {
  const current = selected.value
  const next = current.includes(elementId) ? current.filter((id) => id !== elementId) : full.value ? current : [...current, elementId]
  model.value = next.length ? next : undefined
}

function handle(elementId: string): string | undefined {
  const index = selected.value.indexOf(elementId)
  return index >= 0 ? `@${klingElementRef(index)}` : undefined
}
</script>

<template>
  <div class="grid gap-1.5">
    <div v-if="synced.length || orphans.length" class="flex flex-wrap gap-1">
      <button
        v-for="c in synced"
        :key="c.id"
        type="button"
        :disabled="!selected.includes(c.elementId) && full"
        :class="
          cn(
            'flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors disabled:opacity-40',
            selected.includes(c.elementId) ? 'border-brand bg-brand/10 text-foreground' : 'text-muted-foreground hover:bg-accent',
          )
        "
        :title="`Kling element ${c.elementId}`"
        @click="toggle(c.elementId)"
      >
        {{ c.name }}
        <span v-if="handle(c.elementId)" class="font-mono text-[10px] text-brand">{{ handle(c.elementId) }}</span>
      </button>
      <button
        v-for="id in orphans"
        :key="id"
        type="button"
        class="flex h-7 items-center gap-1 rounded-md border border-dashed px-2 text-xs text-muted-foreground hover:bg-accent"
        title="No cast character uses this element any more — click to remove"
        @click="toggle(id)"
      >
        Element {{ id }} <span class="font-mono text-[10px]">{{ handle(id) }}</span><X class="size-3" />
      </button>
    </div>
    <p v-else class="text-[11px] text-muted-foreground">
      No characters synced to Kling yet — use “Sync to Kling” on a character in Plan → Cast & Places.
    </p>
  </div>
</template>
