<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { useSlots } from "vue"
import { cn } from "@/lib/utils"
import { shortcutParts, slotText } from "./keys"

const props = withDefaults(defineProps<{
  class?: HTMLAttributes["class"]
  /** Extra classes for every key cap. */
  capClass?: HTMLAttributes["class"]
  /** What a label that is not a plain shortcut becomes: one key cap, or muted text. */
  fallback?: "cap" | "text"
}>(), { fallback: "text" })

const slots = useSlots()

/** Read in render so it follows the slot content. */
function parts() {
  const text = slotText(slots.default?.())
  return text === undefined ? undefined : shortcutParts(text)
}

const CAP = cn(
  "pointer-events-none inline-flex h-5 min-w-5 items-center justify-center rounded-[6px] bg-field px-1 font-sans text-[11px] leading-none font-medium text-muted-foreground select-none",
  "[&_svg:not([class*='size-'])]:size-3",
  "[[data-highlighted]_&]:bg-field-hover [[data-highlighted]_&]:text-foreground",
)
</script>

<template>
  <span v-if="parts()" data-slot="kbd-keys" :class="cn('inline-flex shrink-0 items-center gap-1', props.class)">
    <template v-for="(part, i) in parts()" :key="i">
      <span v-if="'sep' in part" class="text-[10px] text-muted-foreground/70">{{ part.sep }}</span>
      <span v-else class="inline-flex items-center gap-0.5">
        <kbd v-for="(key, j) in part.keys" :key="j" :class="cn(CAP, capClass)">{{ key }}</kbd>
      </span>
    </template>
  </span>
  <kbd v-else-if="fallback === 'cap'" :class="cn(CAP, capClass, props.class)"><slot /></kbd>
  <span v-else :class="cn('shrink-0 text-[11px] text-muted-foreground', props.class)"><slot /></span>
</template>
