<script setup lang="ts">
import { useEventListener, useLocalStorage } from '@vueuse/core'
import { ref } from 'vue'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import TimelinePanel from '@/features/timeline/TimelinePanel.vue'
import Viewer from '@/features/viewer/Viewer.vue'
import { cn } from '@/lib/utils'
import StorySteps from './StorySteps.vue'
import { drawerActive, storySkim } from './timelineDrawer'

/**
 * Plan, step by step — script, cast & places, shots scene by scene, the film. The timeline slides up from the bottom: a
 * small bar at the bottom centre opens it (Update timeline opens it too, on the Story cut), the plan above makes room.
 */
const open = useLocalStorage('story.timelineOpen', false)
const height = useLocalStorage('story.timelineHeight', 300)
/** Mounted on first open and kept: the timeline keeps its zoom and scroll while folded away. */
const mounted = ref(open.value)
function toggle(value = !open.value) {
  if (value) mounted.value = true
  open.value = value
}

// A click inside the drawer gives its keys to the timeline (Delete, Space, blade…), a click anywhere else takes them back.
const drawer = ref<HTMLElement>()
useEventListener(window, 'pointerdown', (e: PointerEvent) => (drawerActive.value = Boolean(open.value && drawer.value?.contains(e.target as Node))), { capture: true })

// The drawer's top edge resizes it (no slide while dragging).
const dragging = ref(false)
function startResize(e: PointerEvent) {
  if (!open.value) return
  const startY = e.clientY
  const startHeight = height.value
  const max = () => Math.max(200, Math.round(window.innerHeight * 0.75))
  dragging.value = true
  const move = (ev: PointerEvent) => (height.value = Math.min(max(), Math.max(140, startHeight + startY - ev.clientY)))
  const up = () => {
    dragging.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
</script>

<template>
  <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
    <!-- No Composer here: an open shot card has its own prompts and New still · Animate · Final. -->
    <StorySteps class="min-h-0 flex-1 pb-3" @assembled="toggle(true)" />

    <div
      ref="drawer"
      :class="cn('relative shrink-0 overflow-hidden', !dragging && 'transition-[height] duration-300 ease-out')"
      :style="{ height: open ? `${height}px` : '0px' }"
      data-story-timeline=""
    >
      <!-- The gutter above the timeline: drag to resize. -->
      <div class="absolute inset-x-0 top-0 z-10 h-2 cursor-row-resize" @pointerdown.prevent="startResize" />
      <!-- The viewer beside the timeline, as in Video: the timeline's picture, or the clip skimmed in Assets. -->
      <ResizablePanelGroup v-if="mounted" direction="horizontal" auto-save-id="story-timeline-horizontal" class="h-full pt-2">
        <ResizablePanel :default-size="32" :min-size="18">
          <Viewer :browser-skim="storySkim" class="panel-card" data-story-viewer="" />
        </ResizablePanel>
        <ResizableHandle class="panel-gutter" />
        <ResizablePanel :default-size="68" :min-size="35">
          <TimelinePanel class="panel-card bg-timeline" />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>

    <!--
      The handle: on the window's bottom edge while folded, in the gutter above the timeline while open (the drawer sits
      on the workspace's bottom padding, so the gutter's middle is about `height` above the bottom).
    -->
    <button
      type="button"
      :class="
        cn(
          'absolute left-1/2 z-20 h-[5px] w-[100px] -translate-x-1/2 rounded-full bg-foreground/25 hover:bg-foreground/55',
          dragging ? 'transition-colors' : 'transition-[bottom,background-color] duration-300 ease-out',
        )
      "
      :style="{ bottom: open ? `${height}px` : '0px' }"
      :title="open ? 'Hide the timeline' : 'Show the timeline'"
      :aria-label="open ? 'Hide the timeline' : 'Show the timeline'"
      :aria-expanded="open"
      data-story-timeline-handle=""
      @click="toggle()"
    />

  </div>
</template>
