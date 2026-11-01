<script setup lang="ts">
import { AudioLines, Crosshair, Film, ImagePlus, Loader2, Plus, Upload, X } from '@lucide/vue'
import type { AssetKind } from '@shared/types/assets'
import { computed, ref, useAttrs } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ASSET_DRAG_TYPE, readAssetDrag } from '@/features/assets/drag'
import { useTimelineCommands } from '@/features/timeline/commands'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { useEditorStore } from '@/stores/editor'
import AssetPickList from './AssetPickList.vue'

/**
 * One asset to drop or pick. `compact`: a short row; `cover`: a picture tile as wide as its container (the Cast's
 * front views), `aspect` its shape; `tile`: a Composer tile (a miniature, what it is, its name or Add). Classes go
 * onto the tile (the Popover around it renders no element).
 */
defineOptions({ inheritAttrs: false })
const props = defineProps<{ kind: AssetKind; label: string; compact?: boolean; cover?: boolean; tile?: boolean; aspect?: string }>()
const model = defineModel<string | undefined>()
const attrs = useAttrs()

const assets = useAssetsStore()
const editor = useEditorStore()
const commands = useTimelineCommands()
const open = ref(false)
const over = ref(false)
const grabbing = ref(false)

const asset = computed(() => assets.get(model.value))
const icon = computed(() => (props.kind === 'video' ? Film : props.kind === 'audio' ? AudioLines : ImagePlus))

const fileInput = ref<HTMLInputElement>()
const uploading = ref(false)
const accept = computed(() => `${props.kind}/*`)

async function uploadFiles(files: File[]) {
  const file = files.find((f) => f.type.startsWith(`${props.kind}/`))
  if (!file) {
    toast.warning(`Drop ${props.kind === 'image' ? 'an image' : `a ${props.kind}`} file here`)
    return
  }
  uploading.value = true
  try {
    const [uploaded] = await assets.importFiles([file])
    if (uploaded) model.value = uploaded.id
    open.value = false
  } finally {
    uploading.value = false
  }
}

function onFileInput(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files?.length) void uploadFiles([...input.files])
  input.value = ''
}

function onDrop(e: DragEvent) {
  over.value = false
  if (e.dataTransfer?.files.length) {
    void uploadFiles([...e.dataTransfer.files])
    return
  }
  const ids = readAssetDrag(e.dataTransfer)
  if (!ids) return
  // One slot: from a multi-asset drag take the first asset of the right kind.
  const dropped = ids.map((id) => assets.get(id)).find((a) => a?.kind === props.kind)
  if (!dropped) {
    toast.warning(`Drop ${props.kind === 'image' ? 'an image' : `a ${props.kind}`} here`)
    return
  }
  model.value = dropped.id
}

function onDragOver(e: DragEvent) {
  const types = e.dataTransfer?.types
  if (types?.includes(ASSET_DRAG_TYPE) || types?.includes('Files')) {
    e.preventDefault()
    over.value = true
  }
}

async function grabFrame() {
  grabbing.value = true
  try {
    const id = await commands.grabFrameAtPlayhead()
    if (id) model.value = id
    open.value = false
  } catch (err) {
    toast.error('Could not grab frame', { description: errorMessage(err) })
  } finally {
    grabbing.value = false
  }
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        v-bind="{ ...attrs, class: undefined }"
        type="button"
        :title="asset ? `${label}: ${asset.name} — click to replace` : `${label}: drop ${kind === 'image' ? 'an image' : `a ${kind} file`} here, or click to pick`"
        :class="
          cn(
            'group relative overflow-hidden rounded-lg border border-dashed border-border text-left text-xs transition-colors hover:border-foreground/30 hover:bg-field/40',
            // A tile shares the row like the Composer's other tiles (a size container would collapse it).
            tile
              ? 'flex h-10 max-w-40 min-w-30 flex-1 basis-0 items-center gap-2 rounded-[10px] bg-field py-1 pr-2.5 pl-1 hover:bg-field-hover'
              : cover
                ? '@container block w-full'
                : ['@container flex items-center gap-2', compact ? 'h-14' : 'h-20'],
            asset && 'border-solid',
            over && 'border-brand bg-brand/10',
            attrs.class as string | undefined,
          )
        "
        :style="cover && !tile ? { aspectRatio: aspect ?? '4 / 5' } : undefined"
        @dragover="onDragOver"
        @dragleave="over = false"
        @drop.prevent="onDrop"
      >
        <!-- A Composer tile: the miniature (or +), what it is, its name or Add. -->
        <template v-if="tile">
          <span class="relative grid h-8 w-11 shrink-0 place-items-center overflow-hidden rounded-md bg-muted text-muted-foreground group-hover:text-foreground">
            <img v-if="asset?.variants.poster" :src="`/media/${asset.id}/poster`" class="absolute inset-0 size-full object-cover" alt="" />
            <Loader2 v-else-if="uploading" class="size-3.5 animate-spin" />
            <component :is="asset ? icon : Plus" v-else class="size-3.5" />
          </span>
          <span class="grid min-w-0 leading-tight">
            <span class="truncate font-mono text-[9px] font-medium tracking-wider text-muted-foreground uppercase">{{ label }}</span>
            <span class="truncate text-[12px] font-medium text-foreground/80">{{ uploading ? 'Uploading…' : (asset?.name ?? 'Add') }}</span>
          </span>
        </template>
        <!-- A picture tile: the picture fills it, its name over a shade at the bottom. -->
        <template v-else-if="cover && asset">
          <img v-if="asset.variants.poster" :src="`/media/${asset.id}/poster`" class="absolute inset-0 size-full bg-viewer object-cover" alt="" />
          <span v-else class="absolute inset-0 flex items-center justify-center bg-viewer"><component :is="icon" class="size-5 text-muted-foreground" /></span>
          <span class="absolute inset-x-0 bottom-0 hidden bg-linear-to-t from-black/70 to-transparent px-2 pt-6 pb-1.5 text-white @[8rem]:block">
            <span class="block text-[10px] opacity-75">{{ label }}</span>
            <span class="block truncate text-[11px]">{{ asset.name }}</span>
          </span>
        </template>
        <template v-else-if="asset">
          <img
            v-if="asset.variants.poster"
            :src="`/media/${asset.id}/poster`"
            class="h-full w-auto max-w-[45%] bg-viewer object-contain"
            alt=""
          />
          <component :is="icon" v-else class="mx-3 size-4 text-muted-foreground" />
          <div class="min-w-0 flex-1 pr-7">
            <div class="text-[10px] text-muted-foreground">{{ label }}</div>
            <div class="truncate">{{ asset.name }}</div>
          </div>
        </template>
        <!-- Empty: what goes here, and how. Side by side when there is room, else stacked and centred. -->
        <span
          v-else
          :class="
            cn(
              'flex size-full min-w-0 items-center text-muted-foreground',
              // A tile stacks and centres; a row keeps the icon at its left — only the icon when it is very narrow.
              cover ? 'flex-col justify-center gap-1 px-2 text-center' : 'gap-2.5 px-3 text-left @max-[6rem]:justify-center @max-[6rem]:px-1',
            )
          "
        >
          <span :class="cn('flex shrink-0 items-center justify-center rounded-md bg-field transition-colors group-hover:text-foreground', cover ? 'size-9 @[8rem]:size-10' : 'size-8')">
            <Loader2 v-if="uploading" class="size-4 animate-spin" />
            <component :is="icon" v-else class="size-4" />
          </span>
          <span :class="cn('grid min-w-0 gap-0.5 leading-tight', !cover && '@max-[6rem]:hidden')">
            <span class="truncate text-[11px] font-medium text-foreground/80">{{ uploading ? 'Uploading…' : label }}</span>
            <span :class="cn('hidden truncate text-[10px]', cover ? '@[7.5rem]:block' : '@[9rem]:block')">Drop or click to pick</span>
          </span>
        </span>
        <span
          v-if="asset"
          :class="
            cn(
              'absolute top-1 right-1 rounded p-0.5 opacity-0 group-hover:opacity-100',
              cover ? 'bg-black/55 text-white hover:bg-black/75' : 'text-muted-foreground hover:bg-accent',
            )
          "
          role="button"
          title="Remove"
          @click.stop="model = undefined"
        >
          <X class="size-3.5" />
        </span>
      </button>
    </PopoverTrigger>
    <!-- In the Composer: as wide as the Composer, with big pictures; elsewhere a small list. -->
    <PopoverContent :class="tile ? 'w-[min(880px,calc(100vw-2rem))] p-3' : 'w-72 p-2'" :side="tile ? 'top' : undefined" align="start">
      <div class="mb-2 grid gap-1.5">
        <Button variant="outline" size="sm" class="w-full" :disabled="uploading" @click="fileInput?.click()">
          <Loader2 v-if="uploading" class="animate-spin" />
          <Upload v-else /> Upload from computer
        </Button>
        <Button v-if="kind === 'image' && editor.workspace === 'edit'" variant="outline" size="sm" class="w-full" :disabled="grabbing" @click="grabFrame">
          <Crosshair /> Frame at playhead
        </Button>
      </div>
      <input ref="fileInput" type="file" :accept="accept" class="hidden" @change="onFileInput" />
      <AssetPickList
        :kind="kind"
        :large="tile"
        :selected="model"
        @pick="
          (id) => {
            model = id
            open = false
          }
        "
      />
    </PopoverContent>
  </Popover>
</template>
