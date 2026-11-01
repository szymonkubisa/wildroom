<script setup lang="ts">
import { BookOpen, Frame, Grid3x3, Heart, ImagePlus, Layers, LayoutDashboard, LayoutGrid, Rows3, Search, Sparkles, Upload, X } from '@lucide/vue'
import { FRAME_PRESETS } from '@shared/canvas/framePresets'
import { useElementSize, useLocalStorage } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import RightPanel from '@/features/editor/RightPanel.vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import Composer from '@/features/generate/Composer.vue'
import CoverageDialog from '@/features/generate/CoverageDialog.vue'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { useCanvasStore } from '@/stores/canvas'
import { type GenerateTarget, useGenerateStore } from '@/stores/generate'
import { useProjectStore } from '@/stores/project'
import AnimationBar from './AnimationBar.vue'
import AssetSetDialog from './AssetSetDialog.vue'
import BoardBar from './BoardBar.vue'
import CanvasToolbar from './CanvasToolbar.vue'
import CanvasExportDialog from './CanvasExportDialog.vue'
import CanvasView from './CanvasView.vue'
import CreateFeed, { type FeedFilter } from './CreateFeed.vue'
import { FEED_SIZES, useFeedView } from './feedView'
import FaviconDialog from './FaviconDialog.vue'
import LayersPanel from './LayersPanel.vue'
import RecipeCatalog from './RecipeCatalog.vue'
import { addFrame } from './frames'
import { BOARD_KINDS } from './useCanvasDoc'
import { useCanvasHotkeys } from './useCanvasHotkeys'

/**
 * Create: the infinite board, or the Feed of everything generated in the project — and the Composer floating at the
 * bottom with the board's tools. The project's media is in the Library (⌘L), as in Plan and Edit.
 */
const emit = defineEmits<{ import: [] }>()
const canvas = useCanvasStore()
const generate = useGenerateStore()
const project = useProjectStore()
const assets = useAssetsStore()

useCanvasHotkeys()

/** Board or Feed, remembered in this browser. */
const mode = useLocalStorage<'board' | 'feed'>('create.mode', 'board')
const showLayers = useLocalStorage('create.layers', false)
const recipesOpen = ref(false)
const feed = useFeedView()
const feedFilter = feed.filter
// Open in Canvas animates on the board.
watch(
  () => canvas.animClipId,
  (id) => id && (mode.value = 'board'),
  { immediate: true },
)
const generatedCount = computed(() => assets.list.filter((a) => a.source === 'generation' && a.status !== 'missing' && a.rating !== -1).length)
const FILTERS: { id: FeedFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Clips' },
  { id: 'audio', label: 'Audio' },
]

// While Create is on screen, results without an explicit target land on the board (a sound as a player card); in the
// Feed they show up at the top of the Feed — nothing is placed.
const boardTarget = (): GenerateTarget => (mode.value === 'board' && BOARD_KINDS.has(generate.kind) ? canvas.defaultTarget() : { label: 'Feed · newest first' })
onMounted(() => {
  // The Composer stays on what the user left it on (music stays music after a trip to Edit): no kind is forced here.
  generate.defaultTarget = boardTarget
})
onBeforeUnmount(() => {
  if (generate.defaultTarget === boardTarget) generate.defaultTarget = undefined
  canvas.clearLive()
  canvas.editingId = undefined
})

// Placeholders and freshly imported images take their real aspect ratio as soon as the size is known.
const waiting = computed(() => canvas.items.some((i) => i.kind === 'asset' && (i.fit || !i.assetId)))
watch(
  () => (waiting.value ? assets.list : undefined),
  () => waiting.value && project.resolvePendingTakes(),
)

const quickFrames = ['og', 'ig-post', 'story', 'logo'].map((id) => FRAME_PRESETS.find((p) => p.id === id)!)

/**
 * The floating dock (the board's tools and the Composer, which grows for audio and attachments) covers the bottom of
 * the board and the Feed: its height — plus its gap to the edge — is the Feed's bottom padding and the board's inset.
 */
const dock = ref<HTMLElement>()
const { height: dockHeight } = useElementSize(dock, undefined, { box: 'border-box' })
const dockSpace = computed(() => Math.round(dockHeight.value) + 24)
watch(dockSpace, (px) => (canvas.dockInset = px), { immediate: true })
onBeforeUnmount(() => (canvas.dockInset = 0))
const segment = 'flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground'
</script>

<template>
  <ResizablePanelGroup direction="horizontal" auto-save-id="create-horizontal" class="min-h-0 min-w-0 flex-1 pr-1.5 pb-1.5">
    <ResizablePanel :default-size="74" :min-size="40">
      <div data-tour="canvas" class="panel-card relative h-full" :style="{ '--dock-space': `${dockSpace}px` }">
        <CanvasView v-if="mode === 'board'" />
        <CreateFeed v-else />

        <!-- Board · Feed, and the board's name (or the Feed's filters). -->
        <div class="pointer-events-none absolute inset-x-2 top-2 flex flex-wrap items-center gap-2">
          <div class="pointer-events-auto flex items-center gap-0.5 rounded-xl border bg-background/95 p-1 shadow-lg backdrop-blur" role="group" aria-label="Create view" data-create-toggle="">
            <button type="button" :class="cn(segment, mode === 'board' && 'bg-accent text-foreground')" :aria-pressed="mode === 'board'" data-create-mode="board" @click="mode = 'board'">
              <LayoutDashboard class="size-3.5" /> Board
            </button>
            <button type="button" :class="cn(segment, mode === 'feed' && 'bg-accent text-foreground')" :aria-pressed="mode === 'feed'" data-create-mode="feed" @click="mode = 'feed'">
              <Grid3x3 class="size-3.5" /> Feed <span class="font-mono text-[10.5px] text-muted-foreground tabular">{{ generatedCount }}</span>
            </button>
          </div>
          <BoardBar v-if="mode === 'board'" />
          <!-- Recipes: starting points with a miniature each (the same catalog as the empty Feed). -->
          <Popover v-model:open="recipesOpen">
            <PopoverTrigger as-child>
              <button
                type="button"
                :class="cn('pointer-events-auto flex h-9 items-center gap-1.5 rounded-xl border bg-background/95 px-2.5 text-xs font-medium text-muted-foreground shadow-lg backdrop-blur hover:text-foreground', recipesOpen && 'text-foreground')"
                title="Recipes: starting points that fill the Composer, and Shots from an image"
                data-recipes-toggle=""
              >
                <BookOpen class="size-3.5" /> Recipes
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" class="max-h-[min(40rem,75vh)] w-[40rem] overflow-y-auto p-3">
              <RecipeCatalog :columns="3" @picked="recipesOpen = false" />
            </PopoverContent>
          </Popover>
          <button
            v-if="mode === 'board'"
            type="button"
            :class="cn('pointer-events-auto flex h-9 items-center gap-1.5 rounded-xl border bg-background/95 px-2.5 text-xs font-medium text-muted-foreground shadow-lg backdrop-blur hover:text-foreground', showLayers && 'text-foreground')"
            :aria-pressed="showLayers"
            data-layers-toggle=""
            @click="showLayers = !showLayers"
          >
            <Layers class="size-3.5" /> Layers
          </button>
          <div v-else class="pointer-events-auto flex items-center gap-0.5 rounded-xl border bg-background/95 p-1 shadow-lg backdrop-blur" role="group" aria-label="Show">
            <button
              v-for="f in FILTERS"
              :key="f.id"
              type="button"
              :class="cn(segment, feedFilter === f.id && 'bg-accent text-foreground')"
              :aria-pressed="feedFilter === f.id"
              :data-feed-filter="f.id"
              @click="feedFilter = f.id"
            >
              {{ f.label }}
            </button>
          </div>
          <template v-if="mode === 'feed'">
            <button
              type="button"
              :class="cn('pointer-events-auto flex h-9 items-center gap-1.5 rounded-xl border bg-background/95 px-2.5 text-xs font-medium text-muted-foreground shadow-lg backdrop-blur hover:text-foreground', feed.favourites.value && 'text-rose-400 hover:text-rose-300')"
              :aria-pressed="feed.favourites.value"
              title="Favourites only"
              data-feed-favourites=""
              @click="feed.favourites.value = !feed.favourites.value"
            >
              <Heart :class="cn('size-3.5', feed.favourites.value && 'fill-current')" /> Favourites
            </button>
            <label class="pointer-events-auto flex h-9 w-56 items-center gap-1.5 rounded-xl border bg-background/95 px-2.5 text-xs shadow-lg backdrop-blur focus-within:border-foreground/30">
              <Search class="size-3.5 shrink-0 text-muted-foreground" />
              <input v-model="feed.search.value" type="search" placeholder="Search prompts…" class="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground" data-feed-search="" @keydown.esc="feed.search.value = ''" />
              <button v-if="feed.search.value" type="button" class="text-muted-foreground hover:text-foreground" aria-label="Clear the search" @click="feed.search.value = ''"><X class="size-3.5" /></button>
            </label>
            <div class="pointer-events-auto ml-auto flex items-center gap-2 rounded-xl border bg-background/95 p-1 pl-2.5 shadow-lg backdrop-blur">
              <input
                v-model.number="feed.size.value"
                type="range"
                :min="FEED_SIZES.min"
                :max="FEED_SIZES.max"
                step="10"
                class="w-20 accent-foreground"
                aria-label="Tile size"
                data-feed-size=""
              />
              <div class="flex items-center gap-0.5" role="group" aria-label="Layout">
                <button type="button" :class="cn(segment, 'px-2', feed.layout.value === 'batches' && 'bg-accent text-foreground')" :aria-pressed="feed.layout.value === 'batches'" title="By batch: one row per Generate" data-feed-layout="batches" @click="feed.layout.value = 'batches'">
                  <Rows3 class="size-3.5" />
                </button>
                <button type="button" :class="cn(segment, 'px-2', feed.layout.value === 'grid' && 'bg-accent text-foreground')" :aria-pressed="feed.layout.value === 'grid'" title="One grid" data-feed-layout="grid" @click="feed.layout.value = 'grid'">
                  <LayoutGrid class="size-3.5" />
                </button>
              </div>
            </div>
          </template>
          <span v-if="mode === 'board' && canvas.items.length" class="hidden text-[11px] text-muted-foreground xl:inline">Click to select, Shift-click for more, hover a picture for its actions</span>
        </div>

        <div v-if="mode === 'board'" class="pointer-events-none absolute inset-x-2 top-14 flex justify-center"><AnimationBar /></div>
        <div v-if="mode === 'board' && showLayers" class="pointer-events-none absolute top-14 left-2 flex" :style="{ bottom: `${dockSpace}px` }"><LayersPanel /></div>

        <div v-if="mode === 'board' && !canvas.items.length" class="pointer-events-none absolute inset-0 flex items-center justify-center p-6 pb-[var(--dock-space,13rem)]">
          <div class="pointer-events-auto grid max-w-md gap-4 rounded-2xl border bg-background/95 p-6 text-center shadow-xl backdrop-blur">
            <div class="mx-auto flex size-11 items-center justify-center rounded-xl bg-brand/15 text-brand"><ImagePlus class="size-5" /></div>
            <div>
              <h2 class="text-base font-semibold">An empty board</h2>
              <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
                Describe an image in the Composer below, drop or paste images here, or start from a frame of an exact size. Select anything to use it as
                a reference for the next generation.
              </p>
            </div>
            <div class="flex flex-wrap justify-center gap-2">
              <Button size="sm" variant="outline" @click="emit('import')"><Upload /> Import images</Button>
              <Button size="sm" class="bg-brand text-brand-foreground hover:bg-brand/90" @click="canvas.dialog = 'asset-set'"><Sparkles /> Plan assets from a brief</Button>
            </div>
            <div class="flex flex-wrap justify-center gap-1.5">
              <button
                v-for="p in quickFrames"
                :key="p.id"
                class="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                @click="addFrame(p)"
              >
                <Frame class="size-3" /> {{ p.label.split(' (')[0] }} <span class="opacity-60">{{ p.w }}×{{ p.h }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- The board's tools, and the Composer floating at the bottom. -->
        <div ref="dock" class="pointer-events-none absolute inset-x-0 bottom-3 flex flex-col items-center gap-2 px-3.5" data-create-dock="">
          <CanvasToolbar v-if="mode === 'board'" />
          <Composer floating />
        </div>
      </div>
    </ResizablePanel>
    <ResizableHandle class="panel-gutter" />
    <ResizablePanel :default-size="26" :min-size="16" collapsible :collapsed-size="0">
      <RightPanel data-tour="right-panel" class="panel-card" />
    </ResizablePanel>
  </ResizablePanelGroup>
  <CanvasExportDialog />
  <FaviconDialog />
  <AssetSetDialog />
  <CoverageDialog />
</template>
