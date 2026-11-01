<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import TimelineToolbar from './TimelineToolbar.vue'
import TimelineView from './TimelineView.vue'
import { registerTimelineZoom } from './zoom'

const view = ref<InstanceType<typeof TimelineView>>()

onMounted(() => {
  registerTimelineZoom({
    zoomBy: (f) => view.value?.zoomBy(f),
    setZoom: (ppf) => view.value?.setZoom(ppf),
    zoomToFit: () => view.value?.zoomToFit(),
  })
  requestAnimationFrame(() => view.value?.zoomToFit())
})
onBeforeUnmount(() => registerTimelineZoom(undefined))
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <TimelineToolbar />
    <TimelineView ref="view" class="min-h-0 flex-1" />
  </div>
</template>
