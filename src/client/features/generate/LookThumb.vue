<script setup lang="ts">
import { computed } from 'vue'
import { type LookAxis, lookOption } from './look'
import LookPreview from './LookPreview.vue'

/**
 * A look option's miniature: its picture (look-images/<axis>-<id>.jpg, "auto" for Auto) when there is one, else the
 * drawn scene (LookPreview) from its spec. Fills its container.
 */
const props = defineProps<{ axis: LookAxis; id?: string }>()

const PICTURES = import.meta.glob<string>('./look-images/*.jpg', { eager: true, query: '?url', import: 'default' })
const src = computed(() => PICTURES[`./look-images/${props.axis}-${props.id ?? 'auto'}.jpg`])
</script>

<template>
  <img v-if="src" :src="src" alt="" class="block size-full object-cover" draggable="false" />
  <LookPreview v-else :spec="lookOption(axis, id)?.preview" />
</template>
