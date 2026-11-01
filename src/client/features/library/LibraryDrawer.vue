<script setup lang="ts">
import { X } from '@lucide/vue'
import { useLocalStorage } from '@vueuse/core'
import { computed, reactive, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import AssetsPanel from '@/features/assets/AssetsPanel.vue'
import BrandKitForm from '@/features/brand/BrandKitForm.vue'
import { useStory } from '@/features/story/useStory'
import { cn } from '@/lib/utils'
import { type LibraryTab, useLibrary } from './library'
import LibraryElements from './LibraryElements.vue'

/**
 * The Library: a panel docked on the left of the work area in Plan, Create and Edit — Media (the Assets browser:
 * search, filters, drag onto the board or a slot; not in Edit, whose own browser sits beside the viewer), Cast and
 * Places (the story's characters and places) and the Brand kit. It takes its width from the work instead of covering it, so the timeline's start, the scene list
 * and the viewer stay in sight while dragging from it.
 * `skim`: the clip skimmed in Media, for the open workspace's viewer.
 */
const skim = defineModel<{ assetId: string; seconds: number } | undefined>('skim')
const library = useLibrary()
const { story } = useStory()

// Each tab mounts the first time it is shown and stays (Media keeps its search and scroll while the drawer is closed).
const seen = reactive(new Set<LibraryTab>())
watch(
  () => (library.open ? library.shown : undefined),
  (tab) => tab && seen.add(tab),
  { immediate: true },
)

const counts = computed<Partial<Record<LibraryTab, number>>>(() => ({
  cast: story.value.characters.length,
  places: story.value.places?.length ?? 0,
}))

// The right edge resizes it.
const width = useLocalStorage('library.width', 380)
const dragging = ref(false)
function startResize(e: PointerEvent) {
  const startX = e.clientX
  const start = width.value
  dragging.value = true
  const move = (ev: PointerEvent) => (width.value = Math.min(720, Math.max(300, Math.round(start + ev.clientX - startX))))
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
  <Transition enter-from-class="opacity-0" leave-to-class="opacity-0" enter-active-class="transition-opacity duration-150 ease-out" leave-active-class="transition-opacity duration-100 ease-in">
    <!-- mb-1.5 mr-1.5: the same gutters as the workspace's cards; at most half the work area, so the work keeps room. -->
    <aside
      v-show="library.open"
      :class="cn('panel-card relative mr-1.5 mb-1.5 flex min-h-0 max-w-[50%] shrink-0 flex-col border bg-sidebar', dragging && 'select-none')"
      :style="{ width: `${width}px` }"
      aria-label="Library"
      data-library=""
      data-tour="library-drawer"
    >
      <header class="flex shrink-0 items-center gap-2 border-b py-2 pr-1.5 pl-3">
        <span class="text-sm font-semibold">Library</span>
        <Tabs :model-value="library.shown" class="min-w-0 flex-1" @update:model-value="(v) => (library.tab = v as LibraryTab)">
          <TabsList class="h-8 w-full">
            <TabsTrigger v-for="t in library.tabs" :key="t.id" :value="t.id" class="gap-1 px-1.5 text-xs" :data-library-tab="t.id">
              {{ t.label }}<span v-if="counts[t.id]" class="text-[10px] text-muted-foreground tabular">{{ counts[t.id] }}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button variant="ghost" size="icon-sm" aria-label="Close the Library" title="Close the Library (⌘L)" @click="library.close()"><X /></Button>
      </header>
      <div class="relative min-h-0 flex-1">
        <div v-if="seen.has('media')" v-show="library.shown === 'media'" class="absolute inset-0"><AssetsPanel v-model:skim="skim" /></div>
        <div v-if="seen.has('cast')" v-show="library.shown === 'cast'" class="absolute inset-0"><LibraryElements kind="character" /></div>
        <div v-if="seen.has('places')" v-show="library.shown === 'places'" class="absolute inset-0"><LibraryElements kind="place" /></div>
        <div v-if="seen.has('brand')" v-show="library.shown === 'brand'" class="absolute inset-0"><BrandKitForm /></div>
      </div>
      <!-- The right edge: drag to resize. -->
      <div class="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize" aria-hidden="true" @pointerdown.prevent="startResize" />
    </aside>
  </Transition>
</template>
