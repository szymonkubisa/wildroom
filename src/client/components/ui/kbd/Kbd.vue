<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import ShortcutKeys from "./ShortcutKeys.vue"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <!-- One rounded cap per key ("⇧⌘Z" → three caps); anything else stays a single cap. -->
  <ShortcutKeys fallback="cap" :cap-class="props.class">
    <slot />
  </ShortcutKeys>
</template>
