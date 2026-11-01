<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import ShortcutKeys from "@/components/ui/kbd/ShortcutKeys.vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <!-- Rendered as small rounded key caps (each modifier its own cap); other labels stay muted text. -->
  <ShortcutKeys data-slot="command-shortcut" :class="cn('ml-auto pl-4', props.class)">
    <slot />
  </ShortcutKeys>
</template>
