<script setup lang="ts">
import { flicksToSeconds } from '@shared/time/flicks'
import type { AssetDTO } from '@shared/types/assets'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * Filmstrip for the visible part of a clip. Tiles come from the asset's filmstrip sprite; each tile shows
 * the source frame at that timeline position (so trims, slips and speed changes are reflected).
 */
const props = defineProps<{
  asset: AssetDTO
  /** Visible window inside the clip, in px relative to the clip's left edge. */
  visibleLeft: number
  visibleWidth: number
  height: number
  /** Source seconds at the clip's left edge and seconds per px. */
  sourceStart: number
  secondsPerPx: number
}>()

const canvas = ref<HTMLCanvasElement>()
const sprites = new Map<string, HTMLImageElement>()
let raf = 0

function sprite(id: string): HTMLImageElement {
  let img = sprites.get(id)
  if (!img) {
    img = new Image()
    img.src = `/media/${id}/filmstrip`
    img.onload = () => schedule()
    sprites.set(id, img)
  }
  return img
}

function draw() {
  const c = canvas.value
  const f = props.asset.filmstrip
  if (!c || !f) return
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(props.visibleWidth * dpr))
  const h = Math.max(1, Math.round(props.height * dpr))
  if (c.width !== w) c.width = w
  if (c.height !== h) c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, w, h)
  const img = sprite(props.asset.id)
  if (!img.complete || !img.naturalWidth) return
  const tileW = (f.tileWidth / f.tileHeight) * props.height
  const duration = flicksToSeconds(props.asset.durationFlicks ?? 0)
  // Align tiles to multiples of tileW in clip space so they don't swim while scrolling.
  const first = Math.floor(props.visibleLeft / tileW) * tileW
  for (let x = first; x < props.visibleLeft + props.visibleWidth; x += tileW) {
    const center = x + tileW / 2
    const seconds = Math.min(Math.max(0, props.sourceStart + center * props.secondsPerPx), Math.max(0, duration - 1e-3))
    const index = Math.min(f.count - 1, Math.max(0, Math.floor(seconds / f.interval)))
    const col = index % f.columns
    const row = Math.floor(index / f.columns)
    ctx.drawImage(img, col * f.tileWidth, row * f.tileHeight, f.tileWidth, f.tileHeight, (x - props.visibleLeft) * dpr, 0, tileW * dpr, h)
  }
}

function schedule() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(draw)
}

onMounted(schedule)
onBeforeUnmount(() => cancelAnimationFrame(raf))
watch(() => [props.visibleLeft, props.visibleWidth, props.height, props.sourceStart, props.secondsPerPx, props.asset.filmstrip], schedule)
</script>

<template>
  <canvas
    ref="canvas"
    class="pointer-events-none absolute top-0"
    :style="{ left: `${visibleLeft}px`, width: `${visibleWidth}px`, height: `${height}px` }"
  />
</template>
