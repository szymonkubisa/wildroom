<script lang="ts">
/** Last preview command already acted on (shared by every AssetPreview instance). */
let lastHandled = 0
</script>

<script setup lang="ts">
import { flicksToSeconds } from '@shared/time/flicks'
import type { AssetDTO } from '@shared/types/assets'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { drawWaveform, loadWaveform, roleColor } from '@/lib/waveforms'
import { useEditorStore } from '@/stores/editor'

const props = defineProps<{ asset: AssetDTO; skimSeconds?: number }>()
const editor = useEditorStore()
const video = ref<HTMLVideoElement>()
const audio = ref<HTMLAudioElement>()
const canvas = ref<HTMLCanvasElement>()

const media = () => video.value ?? audio.value

watch(
  () => props.skimSeconds,
  (s) => {
    const el = video.value
    // Skimming positions a paused clip; a playing one keeps playing (Space pauses it).
    if (s !== undefined && el && el.paused) el.currentTime = s
  },
)

/** Space over a clip in Assets: play from the skim position, or toggle when no position is given. */
watch(
  () => [editor.previewCommand?.nonce, props.asset.id] as const,
  async () => {
    const cmd = editor.previewCommand
    // Also runs when the asset switches (the command can arrive before the new asset's props do); each command
    // is handled once, so remounting the preview never replays an old one.
    if (!cmd || cmd.assetId !== props.asset.id || cmd.nonce <= lastHandled) return
    lastHandled = cmd.nonce
    await nextTick()
    const el = media()
    if (!el) return
    if (cmd.from !== undefined) {
      el.currentTime = Math.max(0, cmd.from)
      void el.play().catch(() => {})
    } else if (el.paused) {
      if (el.ended) el.currentTime = 0
      void el.play().catch(() => {})
    } else el.pause()
  },
  { immediate: true },
)

function onPlayState() {
  const el = media()
  editor.previewPlaying = Boolean(el && !el.paused && !el.ended)
}
watch(
  () => props.asset.id,
  () => (editor.previewPlaying = false),
)
onBeforeUnmount(() => (editor.previewPlaying = false))

async function paint() {
  if (props.asset.kind !== 'audio' || !canvas.value || !props.asset.variants.waveform) return
  const peaks = await loadWaveform(props.asset.id)
  if (peaks && canvas.value) {
    drawWaveform(canvas.value, peaks, props.asset.waveformRate ?? 100, 0, flicksToSeconds(props.asset.durationFlicks ?? 0), roleColor(props.asset.role))
  }
}
onMounted(paint)
watch(() => props.asset.id, paint)

defineExpose({
  /** Where the previewed video stands (seconds), for "Save frame to Assets"; undefined for images and audio. */
  currentSeconds: () => video.value?.currentTime,
  pause: () => video.value?.pause(),
})
</script>

<template>
  <div class="flex size-full flex-col items-center justify-center gap-2 p-3">
    <video
      v-if="asset.kind === 'video'"
      ref="video"
      :key="asset.id"
      :src="`/media/${asset.id}/${asset.variants.proxy ? 'proxy' : 'original'}`"
      class="max-h-full max-w-full bg-black"
      controls
      playsinline
      @play="onPlayState"
      @pause="onPlayState"
      @ended="onPlayState"
    />
    <img v-else-if="asset.kind === 'image'" :src="`/media/${asset.id}/original`" class="max-h-full max-w-full object-contain" alt="" />
    <template v-else>
      <canvas ref="canvas" class="h-32 w-full max-w-xl" />
      <audio
        ref="audio"
        :key="asset.id"
        :src="`/media/${asset.id}/original`"
        controls
        class="w-full max-w-xl"
        @play="onPlayState"
        @pause="onPlayState"
        @ended="onPlayState"
      />
    </template>
  </div>
</template>
