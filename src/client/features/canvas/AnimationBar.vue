<script setup lang="ts">
import { Check, Circle, Pause, Play, Shapes } from '@lucide/vue'
import { formatTimecode } from '@shared/time/timecode'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { transport } from '@/features/editor/transport'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/stores/canvas'
import { useEditorStore } from '@/stores/editor'
import { useProjectStore } from '@/stores/project'
import { closeAnimation } from './animate'

/** Animation mode's bar: the motion clip's own scrubber (it moves the timeline's playhead), play, record, done. */
const canvas = useCanvasStore()
const editor = useEditorStore()
const project = useProjectStore()
const fps = computed(() => project.doc.settings.fps)
const a = computed(() => canvas.anim)

// The clip went away (deleted, detached by undo…): leave animation mode.
watch(a, (v) => {
  if (!v && canvas.animClipId) closeAnimation()
})

const playing = ref(false)
let raf = 0
let from = { wall: 0, local: 0 }
function tick(now: number) {
  const clip = a.value
  if (!clip || !playing.value) return
  const local = Math.floor(from.local + ((now - from.wall) / 1000) * fps.value) % clip.clip.duration
  transport.seek(clip.start + local)
  raf = requestAnimationFrame(tick)
}
function togglePlay() {
  playing.value = !playing.value
  cancelAnimationFrame(raf)
  if (playing.value && a.value) {
    from = { wall: performance.now(), local: a.value.local }
    raf = requestAnimationFrame(tick)
  }
}
function scrub(local: number) {
  if (playing.value) togglePlay()
  if (a.value) transport.seek(a.value.start + local)
}
function done() {
  if (playing.value) togglePlay()
  closeAnimation()
  editor.workspace = 'edit'
}
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  closeAnimation()
})
</script>

<template>
  <div v-if="a" class="pointer-events-auto flex w-[min(560px,100%)] items-center gap-2 rounded-xl border bg-background/95 px-2 py-1.5 shadow-lg backdrop-blur" data-animation-bar="">
    <span class="flex max-w-36 min-w-0 items-center gap-1.5 text-xs font-medium"><Shapes class="size-3.5 shrink-0 text-role-motion" /><span class="truncate">{{ a.clip.name ?? 'Motion' }}</span></span>
    <Button variant="ghost" size="icon-xs" :title="playing ? 'Pause' : 'Play the clip'" @click="togglePlay"><component :is="playing ? Pause : Play" /></Button>
    <Slider class="min-w-24 flex-1" :model-value="[a.local]" :min="0" :max="Math.max(1, a.clip.duration - 1)" :step="1" @update:model-value="(v) => v && scrub(v[0]!)" />
    <span class="w-20 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular">{{ formatTimecode(a.local, fps) }}</span>
    <Button
      size="xs"
      variant="outline"
      :class="cn(canvas.recording && 'border-destructive text-destructive')"
      :title="canvas.recording ? 'Moving an element keys it at this frame' : 'Moving an element moves it on the board'"
      @click="canvas.recording = !canvas.recording"
    >
      <Circle :class="cn('size-3', canvas.recording && 'fill-destructive')" /> {{ canvas.recording ? 'Recording' : 'Record' }}
    </Button>
    <Button size="xs" @click="done"><Check /> Done</Button>
  </div>
</template>
