<script setup lang="ts">
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Clapperboard,
  Copy,
  Crop,
  Download,
  Film,
  FolderSearch,
  Frame,
  Group,
  Layers,
  ImagePlus,
  Lock,
  Maximize,
  PenTool,
  Scissors,
  ScanLine,
  Sparkles,
  StickyNote,
  Trash2,
  Ungroup,
  Unlock,
  Upload,
  Wand2,
} from '@lucide/vue'
import { FRAME_GROUPS, FRAME_PRESETS } from '@shared/canvas/framePresets'
import { computed } from 'vue'
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu'
import { useCanvasStore } from '@/stores/canvas'
import { useGenerateStore } from '@/stores/generate'
import { animate, assetItems, frameToTimeline, isCropped, reveal, runImageTool, saveCrop, toolCost, upscale, useAsReference, useInVideo } from './canvasActions'
import { addFrame } from './frames'
import { addItems, duplicateItems, groupItems, newItemId, removeItems, reorder, ungroupItems, updateItems } from './useCanvasDoc'

const emit = defineEmits<{ upload: [] }>()
const canvas = useCanvasStore()
const generate = useGenerateStore()

const sel = computed(() => canvas.selectedItems)
const images = computed(() => assetItems(sel.value, 'image'))
const media = computed(() => assetItems(sel.value, 'any'))
const frame = computed(() => (sel.value.length === 1 && sel.value[0]!.kind === 'frame' ? sel.value[0] : undefined))
const locked = computed(() => sel.value.length > 0 && sel.value.every((i) => i.locked))
const ids = computed(() => sel.value.map((i) => i.id))
const boardId = computed(() => canvas.board.id)
const cutoutCost = computed(() => toolCost('cutout'))
const vectorCost = computed(() => toolCost('vectorize'))

function generateIntoFrame() {
  generate.open('image')
}

function addNote() {
  const c = canvas.viewCenter()
  addItems(boardId.value, [{ kind: 'note', id: newItemId(), text: '', color: 'yellow', x: Math.round(c.x - 130), y: Math.round(c.y - 130), w: 260, h: 260 }], 'Add note')
  canvas.editingId = canvas.selection[0]
}
</script>

<template>
  <template v-if="sel.length">
    <template v-if="images.length">
      <ContextMenuLabel class="text-[11px] text-muted-foreground">{{ images.length === 1 ? 'Image' : `${images.length} images` }}</ContextMenuLabel>
      <ContextMenuItem @select="useAsReference(images.map((i) => i.assetId!))"><Sparkles /> Generate from {{ images.length === 1 ? 'this' : 'these' }}…</ContextMenuItem>
      <ContextMenuItem v-if="images.length === 1" @select="animate(images[0]!.assetId!)"><Wand2 /> Animate (image → video)…</ContextMenuItem>
      <ContextMenuItem @select="runImageTool('cutout', images)">
        <Scissors /> Remove background <ContextMenuShortcut v-if="cutoutCost">{{ cutoutCost }}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem @select="runImageTool('vectorize', images)">
        <PenTool /> Vectorize to SVG <ContextMenuShortcut v-if="vectorCost">{{ vectorCost }}</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem v-if="images.length === 1" @select="upscale(images[0]!.assetId!)"><ScanLine /> Upscale…</ContextMenuItem>
      <ContextMenuItem v-if="images.length === 1 && isCropped(images[0]!)" @select="saveCrop(images[0]!)"><Crop /> Save crop as new image</ContextMenuItem>
      <ContextMenuItem v-if="images.length === 1" @select="canvas.dialog = 'favicon'"><ImagePlus /> Favicon & app icons…</ContextMenuItem>
      <ContextMenuSeparator />
    </template>
    <template v-else-if="media.length === 1">
      <ContextMenuItem @select="upscale(media[0]!.assetId!)"><ScanLine /> Upscale…</ContextMenuItem>
      <ContextMenuSeparator />
    </template>
    <template v-if="frame">
      <ContextMenuItem @select="generateIntoFrame"><Sparkles /> Generate into this frame…</ContextMenuItem>
      <ContextMenuItem @select="frameToTimeline(boardId, frame.id)"><Film /> Add to timeline</ContextMenuItem>
      <ContextMenuItem @select="frameToTimeline(boardId, frame.id, true)"><Layers /> Add as overlay over the whole timeline</ContextMenuItem>
      <ContextMenuItem @select="canvas.dialog = 'export'"><Download /> Export frame…</ContextMenuItem>
      <ContextMenuSeparator />
    </template>
    <template v-if="media.length">
      <ContextMenuItem @select="useInVideo(media.map((i) => i.assetId!))"><Clapperboard /> Use in video</ContextMenuItem>
      <ContextMenuItem v-if="media.length === 1" @select="reveal(media[0]!.assetId!)"><FolderSearch /> Reveal in Finder</ContextMenuItem>
      <ContextMenuSeparator />
    </template>
    <ContextMenuItem @select="duplicateItems(boardId, ids)"><Copy /> Duplicate <ContextMenuShortcut>⌘D</ContextMenuShortcut></ContextMenuItem>
    <ContextMenuItem v-if="sel.length > 1" @select="groupItems(boardId, ids)"><Group /> Group <ContextMenuShortcut>⌘G</ContextMenuShortcut></ContextMenuItem>
    <ContextMenuItem v-if="sel.some((i) => i.kind === 'group')" @select="ungroupItems(boardId, ids)"><Ungroup /> Ungroup <ContextMenuShortcut>⇧⌘G</ContextMenuShortcut></ContextMenuItem>
    <ContextMenuItem @select="reorder(boardId, ids, 'front')"><ArrowUpToLine /> Bring to front <ContextMenuShortcut>]</ContextMenuShortcut></ContextMenuItem>
    <ContextMenuItem @select="reorder(boardId, ids, 'back')"><ArrowDownToLine /> Send to back <ContextMenuShortcut>[</ContextMenuShortcut></ContextMenuItem>
    <ContextMenuItem @select="updateItems(boardId, ids, { locked: !locked }, locked ? 'Unlock' : 'Lock')">
      <component :is="locked ? Unlock : Lock" /> {{ locked ? 'Unlock' : 'Lock' }}
    </ContextMenuItem>
    <ContextMenuItem @select="canvas.requestZoom('selection')"><Maximize /> Zoom to selection <ContextMenuShortcut>⇧2</ContextMenuShortcut></ContextMenuItem>
    <ContextMenuSeparator />
    <ContextMenuItem class="text-destructive focus:text-destructive" @select="removeItems(boardId, ids)">
      <Trash2 /> Delete from board <ContextMenuShortcut>⌫</ContextMenuShortcut>
    </ContextMenuItem>
  </template>
  <template v-else>
    <ContextMenuSub>
      <ContextMenuSubTrigger><Frame /> Add frame</ContextMenuSubTrigger>
      <ContextMenuSubContent class="max-h-[70vh] w-72 overflow-y-auto">
        <template v-for="g in FRAME_GROUPS" :key="g">
          <ContextMenuLabel class="text-[11px] text-muted-foreground">{{ g }}</ContextMenuLabel>
          <ContextMenuItem v-for="p in FRAME_PRESETS.filter((x) => x.group === g)" :key="p.id" @select="addFrame(p)">
            {{ p.label }} <ContextMenuShortcut>{{ p.w }}×{{ p.h }}</ContextMenuShortcut>
          </ContextMenuItem>
        </template>
      </ContextMenuSubContent>
    </ContextMenuSub>
    <ContextMenuItem data-canvas-upload="" @select="emit('upload')"><Upload /> Upload images, videos or sounds…</ContextMenuItem>
    <ContextMenuItem @select="addNote"><StickyNote /> Add note</ContextMenuItem>
    <ContextMenuItem @select="generate.open('image')"><Sparkles /> Generate an image…</ContextMenuItem>
    <ContextMenuItem @select="generate.open('video')"><Film /> Generate a video…</ContextMenuItem>
    <ContextMenuSeparator />
    <ContextMenuItem @select="canvas.select(canvas.items.filter((i) => !i.locked && !i.frameId).map((i) => i.id))">Select all <ContextMenuShortcut>⌘A</ContextMenuShortcut></ContextMenuItem>
    <ContextMenuItem @select="canvas.requestZoom('fit')"><Maximize /> Zoom to fit <ContextMenuShortcut>⇧1</ContextMenuShortcut></ContextMenuItem>
  </template>
</template>
