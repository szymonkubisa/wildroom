<script setup lang="ts">
import type { AssetDTO } from '@shared/types/assets'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { drawWaveform, loadWaveform } from '@/lib/waveforms'

const props = defineProps<{
  asset: AssetDTO
  visibleLeft: number
  visibleWidth: number
  top: number
  height: number
  sourceStart: number
  secondsPerPx: number
  color: string
  gain: number
}>()

const canvas = ref<HTMLCanvasElement>()
let peaks: Uint8Array | undefined
let raf = 0
let loads = 0

function draw() {
  const c = canvas.value
  if (!c) return
  if (!peaks) {
    c.getContext('2d')?.clearRect(0, 0, c.width, c.height)
    return
  }
  const start = props.sourceStart + props.visibleLeft * props.secondsPerPx
  const end = start + props.visibleWidth * props.secondsPerPx
  drawWaveform(c, peaks, props.asset.waveformRate ?? 100, start, end, props.color, props.gain)
}

function schedule() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(draw)
}

async function load() {
  const id = ++loads
  peaks = undefined
  const next = await loadWaveform(props.asset.id)
  // Switching takes reuses this component: a slower load for the previous take mustn't land over the new one.
  if (id !== loads) return
  peaks = next
  schedule()
}

onMounted(load)
onBeforeUnmount(() => cancelAnimationFrame(raf))
watch([() => props.asset.id, () => props.asset.variants.waveform], load)
watch(() => [props.visibleLeft, props.visibleWidth, props.height, props.sourceStart, props.secondsPerPx, props.gain, props.color], schedule)
</script>

<template>
  <canvas
    ref="canvas"
    class="pointer-events-none absolute"
    :style="{ left: `${visibleLeft}px`, top: `${top}px`, width: `${visibleWidth}px`, height: `${height}px` }"
  />
</template>
