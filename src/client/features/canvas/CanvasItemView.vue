<script setup lang="ts">
import { AlertTriangle, Film, ImageOff, Loader2 } from '@lucide/vue'
import { toMarkup } from '@shared/canvas/richText'
import { type CanvasItem, pictureHasLook } from '@shared/types/canvas'
import type { AssetDTO } from '@shared/types/assets'
import type { GenerationDTO } from '@shared/types/jobs'
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import type { ResolvedItem } from '@shared/motion/evaluate'
import type { ItemSource } from '@/engine/canvasDraw'
import { ancestorGroups } from '@shared/canvas/groups'
import { useCanvasStore } from '@/stores/canvas'
import { cn } from '@/lib/utils'
import CanvasAudioCard from './CanvasAudioCard.vue'
import { fillToCss } from './fillCss'
import ItemCanvas from './ItemCanvas.vue'
import { startPlanned } from './useAssetSet'

const props = defineProps<{
  item: CanvasItem
  asset?: AssetDTO
  job?: GenerationDTO
  editing?: boolean
  /** Board zoom: text and shapes draw at a pixel density that follows it. */
  zoom?: number
  /** In animation mode: how the clip draws it at the playhead. */
  anim?: ResolvedItem
}>()
const emit = defineEmits<{ commit: [text: string]; cancel: [] }>()

const NOTE_BG: Record<string, string> = {
  yellow: '#fde68a',
  pink: '#fbcfe8',
  blue: '#bfdbfe',
  green: '#bbf7d0',
  purple: '#ddd6fe',
}

/** Browser-friendly originals can be drawn directly when the display copy isn't there (yet). */
const DRAWABLE = /^image\/(png|jpe?g|webp|gif|avif|svg\+xml)$/
/** Candidate files, best first: the light display copy, the original, the (alpha-less) poster. */
const sources = computed(() => {
  const a = props.asset
  if (!a || a.status === 'missing') return []
  if (a.kind === 'video') return a.variants.poster ? [`/media/${a.id}/poster`] : []
  return [
    a.variants.display && `/media/${a.id}/display`,
    a.mime && DRAWABLE.test(a.mime) && `/media/${a.id}/original`,
    a.variants.poster && `/media/${a.id}/poster`,
  ].filter((x): x is string => Boolean(x))
})
const sourceIndex = ref(0)
const retries = ref(0)
let retryTimer: ReturnType<typeof setTimeout> | undefined
watch(sources, () => {
  sourceIndex.value = 0
  retries.value = 0
})
// A file can fail while its project is still opening on the server: fall back, then try the list again a few times.
function onImageError() {
  if (sourceIndex.value < sources.value.length - 1) return void sourceIndex.value++
  if (retries.value >= 3) return
  clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    retries.value++
    sourceIndex.value = 0
  }, 1500 * (retries.value + 1))
}
const imageSrc = computed(() => {
  const src = sources.value[sourceIndex.value]
  return src && retries.value ? `${src}?retry=${retries.value}` : src
})
const hovering = ref(false)

/** The picture has a look of its own (mask, crop, border) or is in a clipped group: the shared renderer draws it. */
const board = useCanvasStore()
const shaped = computed(
  () =>
    props.item.kind === 'asset' &&
    (pictureHasLook(props.item) || Boolean(props.anim?.revealMode || props.anim?.blur) || ancestorGroups(board.byId, props.item).some((g) => g.clipBy)),
)
const picture = shallowRef<ItemSource>()
function onImageLoad(img: HTMLImageElement) {
  picture.value = { image: img, width: img.naturalWidth, height: img.naturalHeight }
}
watch(imageSrc, () => (picture.value = undefined))

const pendingText = computed(() => {
  const j = props.job
  if (!j) return 'Waiting for the generation…'
  if (j.status === 'queued') return 'Queued'
  if (j.status === 'failed' || j.status === 'needs_attention' || j.status === 'canceled') return j.error?.message ?? 'Generation failed'
  return j.progress != null ? `Generating… ${Math.round(j.progress * 100)}%` : 'Generating…'
})
const jobFailed = computed(() => ['failed', 'needs_attention', 'canceled'].includes(props.job?.status ?? ''))
/** A render on its way (or one not known yet): the placeholder glows rather than shimmers. */
const glowing = computed(() => !jobFailed.value)

const textStyle = computed(() => {
  const it = props.item
  if (it.kind !== 'text') return {}
  return {
    fontFamily: `"${it.fontFamily}", Inter, system-ui, sans-serif`,
    fontSize: `${it.fontSize}px`,
    fontWeight: it.fontWeight,
    fontStyle: it.fontStyle,
    color: it.color,
    textAlign: it.align,
    lineHeight: it.lineHeight,
    letterSpacing: it.letterSpacing ? `${it.letterSpacing}px` : undefined,
    textTransform: it.textTransform,
  }
})

const draft = ref('')
const editor = ref<HTMLTextAreaElement>()
watch(
  () => props.editing,
  async (on) => {
    if (!on || (props.item.kind !== 'text' && props.item.kind !== 'note')) return
    // Rich text edits as markup: **bold**, *italic*, ==highlight==, {#hex|colour}.
    draft.value = props.item.kind === 'text' ? toMarkup(props.item) : props.item.text
    await nextTick()
    editor.value?.focus()
    editor.value?.select()
    autoGrow()
  },
  { immediate: true },
)

function autoGrow() {
  const el = editor.value
  if (!el || props.item.kind !== 'text') return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

/** The text box then takes the height of its text, as drawn (see `textFit`). */
function commit() {
  if (props.editing) emit('commit', draft.value)
}

function onKey(e: KeyboardEvent) {
  e.stopPropagation()
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('cancel')
  } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    commit()
  }
}
</script>

<template>
  <!-- Image / video -->
  <div
    v-if="item.kind === 'asset'"
    class="relative size-full overflow-hidden"
    @pointerenter="hovering = true"
    @pointerleave="hovering = false"
  >
    <template v-if="item.assetId">
      <!-- A sound: a player card. -->
      <CanvasAudioCard v-if="asset?.kind === 'audio' && asset.status === 'ready'" :asset="asset" />
      <video
        v-else-if="asset?.kind === 'video' && hovering && asset.variants.proxy"
        :src="`/media/${asset.id}/proxy`"
        class="pointer-events-none size-full object-cover"
        autoplay
        muted
        loop
        playsinline
      />
      <img
        v-else-if="imageSrc"
        :src="imageSrc"
        :alt="asset?.name ?? ''"
        draggable="false"
        decoding="async"
        :class="cn('pointer-events-none size-full object-cover select-none', shaped && 'hidden')"
        @load="(e) => onImageLoad(e.target as HTMLImageElement)"
        @error="onImageError"
      />
      <div v-else class="flex size-full flex-col items-center justify-center gap-2 bg-muted text-muted-foreground">
        <Loader2 v-if="asset?.status === 'processing'" class="size-[max(16px,6%)] animate-spin" />
        <ImageOff v-else class="size-[max(16px,6%)]" />
        <span class="text-[max(11px,2.5cqw)]">{{ asset ? (asset.status === 'processing' ? 'Processing…' : 'Media missing') : 'Not in this project' }}</span>
      </div>
      <!-- A mask, crop or border: drawn like the export draws it, from the picture above (after the placeholder, so its
           v-else stays with the picture). -->
      <ItemCanvas v-if="shaped && picture && !(asset?.kind === 'video' && hovering && asset.variants.proxy)" :item="item" :zoom="zoom ?? 1" :picture="picture" :anim="anim" class="absolute top-0 left-0" />
      <span v-if="asset?.kind === 'video'" class="absolute top-[2%] left-[2%] rounded bg-black/60 p-[0.6%] text-white">
        <Film class="size-[max(12px,4cqw)]" />
      </span>
    </template>
    <div v-else-if="item.planned && !item.generationId" class="canvas-pending flex size-full flex-col items-center justify-center gap-2 p-[6%] text-center [animation:none]">
      <span class="text-[max(11px,3.2cqw)] font-medium">Not generated yet</span>
      <span class="line-clamp-3 max-w-[90%] text-[max(10px,2.6cqw)] text-muted-foreground">{{ item.planned.prompt }}</span>
      <button
        class="mt-1 rounded-md bg-brand px-[4cqw] py-[1.5cqw] text-[max(11px,3cqw)] font-medium text-brand-foreground hover:bg-brand/90"
        @pointerdown.stop
        @click.stop="startPlanned(item.id)"
      >
        Generate
      </button>
    </div>
    <div
      v-else
      :class="cn('canvas-pending relative flex size-full flex-col items-center justify-center gap-2 overflow-hidden p-[6%] text-center', jobFailed ? 'canvas-pending-failed' : glowing && '[animation:none]')"
    >
      <!-- On its way: colour drifting under a blur (the shimmer stops); what is written stays over it. -->
      <div v-if="glowing" class="render-glow" data-render-glow="" />
      <AlertTriangle v-if="jobFailed" class="relative size-[max(16px,7cqw)] text-destructive" />
      <Loader2 v-else class="relative size-[max(16px,7cqw)] animate-spin text-brand" />
      <span class="relative line-clamp-3 text-[max(11px,3.2cqw)] font-medium">{{ pendingText }}</span>
      <span v-if="job?.label" class="relative line-clamp-2 max-w-[90%] text-[max(10px,2.6cqw)] text-muted-foreground">{{ job.label }}</span>
      <div v-if="!jobFailed && job?.progress != null" class="relative h-[max(3px,0.8cqw)] w-3/4 overflow-hidden rounded-full bg-brand/20">
        <div class="h-full bg-brand transition-[width]" :style="{ width: `${Math.round((job.progress ?? 0) * 100)}%` }" />
      </div>
    </div>
  </div>

  <!-- Frame background -->
  <div v-else-if="item.kind === 'frame'" class="size-full shadow-sm" :style="{ background: item.fill ? fillToCss(item.fill) : 'transparent' }" :class="!item.fill && 'canvas-checker'" />

  <!-- Text -->
  <div v-else-if="item.kind === 'text'" class="size-full">
    <textarea
      v-if="editing"
      ref="editor"
      v-model="draft"
      class="block w-full resize-none overflow-hidden border-0 bg-transparent p-0 outline-none"
      :style="textStyle"
      spellcheck="false"
      @input="autoGrow"
      @blur="commit"
      @keydown="onKey"
      @pointerdown.stop
    />
    <ItemCanvas v-else :item="item" :zoom="zoom ?? 1" :anim="anim" />
  </div>

  <!-- Sticky note -->
  <div
    v-else-if="item.kind === 'note'"
    class="flex size-full flex-col rounded-sm p-[7%] text-[16px] leading-snug text-neutral-900 shadow-md"
    :style="{ background: NOTE_BG[item.color] ?? NOTE_BG.yellow }"
  >
    <textarea
      v-if="editing"
      ref="editor"
      v-model="draft"
      class="size-full resize-none border-0 bg-transparent p-0 text-[16px] leading-snug outline-none"
      spellcheck="false"
      @blur="commit"
      @keydown="onKey"
      @pointerdown.stop
    />
    <div v-else class="size-full overflow-hidden break-words whitespace-pre-wrap select-none">{{ item.text || 'Note' }}</div>
  </div>

  <!-- Shape: drawn like the export draws it -->
  <ItemCanvas v-else-if="item.kind === 'shape'" :item="item" :zoom="zoom ?? 1" :anim="anim" />
</template>
