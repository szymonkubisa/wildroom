<script setup lang="ts">
import { AudioLines, Music, Pause, Play } from '@lucide/vue'
import { flicksToSeconds } from '@shared/time/flicks'
import type { AssetDTO } from '@shared/types/assets'
import { useResizeObserver } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { drawWaveform, loadWaveform, roleColor } from '@/lib/waveforms'

/**
 * A sound on the board: its name, length and waveform, and a play button (the board's other media are pictures, so a
 * sound gets a card to see and hear it by). Clicking the waveform plays from there.
 */
const props = defineProps<{ asset: AssetDTO }>()

const duration = computed(() => (props.asset.durationFlicks ? flicksToSeconds(props.asset.durationFlicks) : 0))
const music = computed(() => props.asset.role?.startsWith('music'))
const color = computed(() => roleColor(props.asset.role))
const name = computed(() => props.asset.name.replace(/\.[a-z0-9]{2,4}$/i, ''))
const length = computed(() => {
  const s = Math.round(duration.value)
  return s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : ''
})

const canvas = ref<HTMLCanvasElement>()
async function paint() {
  if (!props.asset.variants.waveform || !canvas.value || !duration.value) return
  const peaks = await loadWaveform(props.asset.id)
  if (peaks && canvas.value) drawWaveform(canvas.value, peaks, props.asset.waveformRate ?? 100, 0, duration.value, color.value)
}
onMounted(paint)
watch(() => [props.asset.variants.waveform, duration.value], paint)
useResizeObserver(canvas, paint)

const audio = ref<HTMLAudioElement>()
const playing = ref(false)
const played = ref(0)
function toggle() {
  const el = audio.value
  if (!el) return
  if (el.paused) void el.play()
  else el.pause()
}
/** A click on the waveform plays from that point. */
function seek(e: MouseEvent) {
  const el = audio.value
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
  if (!el || !duration.value || !box.width) return
  el.currentTime = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) * duration.value
  if (el.paused) void el.play()
}
function onTime() {
  const el = audio.value
  played.value = el && duration.value ? el.currentTime / duration.value : 0
}
onBeforeUnmount(() => audio.value?.pause())
</script>

<template>
  <div class="flex size-full items-center gap-[4cqw] rounded-[3cqw] border bg-card p-[4cqw] text-card-foreground shadow-sm" data-canvas-audio="">
    <button
      type="button"
      class="grid aspect-square h-[58cqh] shrink-0 place-items-center rounded-full bg-brand text-brand-foreground shadow hover:bg-brand/90"
      :aria-label="playing ? `Pause ${name}` : `Play ${name}`"
      data-canvas-audio-play=""
      @pointerdown.stop
      @click.stop="toggle"
    >
      <Pause v-if="playing" class="size-[45%]" />
      <Play v-else class="size-[45%] translate-x-[6%]" />
    </button>
    <div class="flex h-full min-w-0 flex-1 flex-col justify-center gap-[2cqh]">
      <div class="flex items-center gap-[1.5cqw] text-[max(10px,3.2cqw)] leading-tight">
        <Music v-if="music" class="size-[1.1em] shrink-0 text-muted-foreground" />
        <AudioLines v-else class="size-[1.1em] shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate font-medium">{{ name }}</span>
        <span class="shrink-0 font-mono text-[0.85em] text-muted-foreground tabular-nums">{{ length }}</span>
      </div>
      <div class="relative h-[42cqh] w-full cursor-pointer" @pointerdown.stop @click.stop="seek">
        <canvas ref="canvas" class="size-full opacity-80" />
        <div v-if="!asset.variants.waveform" class="absolute inset-x-0 top-1/2 h-px bg-border" />
        <div v-if="played > 0" class="pointer-events-none absolute inset-y-0 left-0 bg-foreground/10" :style="{ width: `${played * 100}%` }" />
        <div v-if="played > 0" class="pointer-events-none absolute inset-y-0 w-px bg-foreground" :style="{ left: `${played * 100}%` }" />
      </div>
    </div>
    <audio
      ref="audio"
      :src="`/media/${asset.id}/original`"
      preload="none"
      class="hidden"
      @play="playing = true"
      @pause="playing = false"
      @ended="(playing = false), (played = 0)"
      @timeupdate="onTime"
    />
  </div>
</template>
