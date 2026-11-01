<script setup lang="ts">
import { AudioLines, FileX, Image as ImageIcon, Loader2, TriangleAlert, Video } from '@lucide/vue'
import { flicksToSeconds } from '@shared/time/flicks'
import type { AssetDTO } from '@shared/types/assets'
import { computed, onMounted, ref, watch } from 'vue'
import { assetFontFace } from '@/engine/fonts'
import { drawWaveform, loadWaveform, roleColor } from '@/lib/waveforms'

const props = defineProps<{ asset: AssetDTO; skim?: boolean }>()
const emit = defineEmits<{ skim: [seconds: number | undefined] }>()

const box = ref<HTMLDivElement>()
const canvas = ref<HTMLCanvasElement>()
const hoverFraction = ref<number>()
const posterFailed = ref(false)

const face = computed(() => assetFontFace(props.asset))
const duration = computed(() => flicksToSeconds(props.asset.durationFlicks ?? 0))
const film = computed(() => (props.asset.variants.filmstrip ? props.asset.filmstrip : undefined))

const skimStyle = computed(() => {
  const f = film.value
  const el = box.value
  if (!f || hoverFraction.value === undefined || !el) return undefined
  const index = Math.min(f.count - 1, Math.floor(hoverFraction.value * f.count))
  const col = index % f.columns
  const row = Math.floor(index / f.columns)
  // Fit the tile into the box (contain).
  const scale = Math.min(el.clientWidth / f.tileWidth, el.clientHeight / f.tileHeight)
  const w = f.tileWidth * scale
  const h = f.tileHeight * scale
  return {
    width: `${w}px`,
    height: `${h}px`,
    backgroundImage: `url(/media/${props.asset.id}/filmstrip)`,
    backgroundSize: `${f.columns * w}px auto`,
    backgroundPosition: `-${col * w}px -${row * h}px`,
  }
})

/**
 * Skimming a video: the filmstrip (a dozen frames) answers at once, then the proxy itself, sought to the pointer —
 * every frame, as sharp as the card is big. Seeks don't pile up: while one runs only the latest position waits.
 */
const video = ref<HTMLVideoElement>()
const videoReady = ref(false)
const scrubVideo = computed(() => props.skim && props.asset.kind === 'video' && props.asset.variants.proxy && hoverFraction.value !== undefined)
let seeking = false
let pending: number | undefined
function seek(seconds: number) {
  const v = video.value
  if (!v || v.readyState < 1 || seeking) {
    pending = seconds
    return
  }
  seeking = true
  v.currentTime = Math.min(Math.max(0, seconds), Math.max(0, (v.duration || duration.value) - 0.05))
}
function onSeeked() {
  seeking = false
  videoReady.value = true
  if (pending === undefined) return
  const next = pending
  pending = undefined
  seek(next)
}
function onMetadata() {
  if (pending === undefined) return
  const next = pending
  pending = undefined
  seek(next)
}

function onMove(e: PointerEvent) {
  if (!props.skim || !box.value) return
  const rect = box.value.getBoundingClientRect()
  hoverFraction.value = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  const seconds = hoverFraction.value * duration.value
  seek(seconds)
  emit('skim', seconds)
}

function onLeave() {
  hoverFraction.value = undefined
  videoReady.value = false
  seeking = false
  pending = undefined
  emit('skim', undefined)
}

async function paintWaveform() {
  if (props.asset.kind !== 'audio' || !props.asset.variants.waveform || !canvas.value) return
  const peaks = await loadWaveform(props.asset.id)
  if (peaks && canvas.value) drawWaveform(canvas.value, peaks, props.asset.waveformRate ?? 100, 0, duration.value, roleColor(props.asset.role))
}

onMounted(paintWaveform)
watch(() => props.asset.variants.waveform, paintWaveform)
</script>

<template>
  <div
    ref="box"
    class="relative flex size-full items-center justify-center overflow-hidden bg-viewer"
    @pointermove="onMove"
    @pointerleave="onLeave"
  >
    <!-- A font: a sample in the font itself (the editor registers project fonts). -->
    <span v-if="asset.kind === 'font'" class="text-[min(42px,30cqw)] leading-none text-foreground/85 select-none" :style="{ fontFamily: `&quot;${face.family}&quot;`, fontWeight: face.weight.includes(' ') ? 400 : face.weight, fontStyle: face.style }">Aa</span>
    <template v-else-if="asset.kind === 'audio'">
      <canvas v-if="asset.variants.waveform" ref="canvas" class="size-full px-1.5 py-3" />
      <AudioLines v-else class="size-6 text-muted-foreground/50" />
    </template>
    <template v-else>
      <div v-if="skimStyle" class="bg-no-repeat" :style="skimStyle" />
      <img
        v-else-if="asset.variants.poster && !posterFailed && asset.status !== 'missing'"
        :src="`/media/${asset.id}/poster`"
        class="max-h-full max-w-full object-contain"
        draggable="false"
        alt=""
        @error="posterFailed = true"
      />
      <component :is="asset.kind === 'video' ? Video : ImageIcon" v-else class="size-6 text-muted-foreground/50" />
      <video
        v-if="scrubVideo"
        ref="video"
        :src="`/media/${asset.id}/proxy`"
        muted
        playsinline
        preload="auto"
        :class="['pointer-events-none absolute inset-0 size-full object-contain', !videoReady && 'opacity-0']"
        @loadedmetadata="onMetadata"
        @seeked="onSeeked"
      />
    </template>
    <div
      v-if="hoverFraction !== undefined && asset.kind === 'video'"
      class="pointer-events-none absolute inset-y-0 w-px bg-skimmer"
      :style="{ left: `${hoverFraction * 100}%` }"
    />
    <div v-if="asset.status === 'processing'" class="absolute inset-0 flex items-center justify-center bg-black/40">
      <Loader2 class="size-5 animate-spin text-white/80" />
    </div>
    <div v-else-if="asset.status === 'error'" class="absolute inset-0 flex items-center justify-center bg-destructive/30" :title="asset.error">
      <TriangleAlert class="size-5 text-white" />
    </div>
    <!-- Its file is gone from the project folder: say so, rather than a plain picture icon that looks like loading. -->
    <div
      v-else-if="asset.status === 'missing'"
      class="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-destructive/20 text-[10px] font-medium text-foreground"
      :title="asset.error ?? 'The original file is missing from the project folder'"
    >
      <FileX class="size-5" />
      File missing
    </div>
  </div>
</template>
