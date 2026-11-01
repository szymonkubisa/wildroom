<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { currentPlayer } from '@/features/editor/transport'

const left = ref<HTMLDivElement>()
const right = ref<HTMLDivElement>()
let raf = 0
const peaks = [-60, -60]

function toPercent(db: number) {
  return Math.max(0, Math.min(1, (db + 60) / 60)) * 100
}

function loop() {
  raf = requestAnimationFrame(loop)
  const player = currentPlayer()
  const levels = player?.playing ? player.audio.levels() : ([-Infinity, -Infinity] as const)
  ;[left.value, right.value].forEach((el, i) => {
    if (!el) return
    const db = Number.isFinite(levels[i]!) ? levels[i]! : -60
    peaks[i] = Math.max(db, peaks[i]! - 1.2) // fall-off
    el.style.height = `${toPercent(peaks[i]!)}%`
    el.dataset.clip = String(db > -0.5)
  })
}

onMounted(() => (raf = requestAnimationFrame(loop)))
onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<template>
  <div class="flex h-full w-3.5 shrink-0 gap-px py-1" title="Output level">
    <div v-for="i in [0, 1]" :key="i" class="relative w-1.5 overflow-hidden rounded-sm bg-foreground/10">
      <div
        :ref="(el) => (i === 0 ? (left = el as HTMLDivElement) : (right = el as HTMLDivElement))"
        class="absolute bottom-0 w-full rounded-sm bg-gradient-to-t from-role-music via-role-music to-role-effects transition-[height] duration-75 data-[clip=true]:to-destructive"
        style="height: 0%"
      />
    </div>
  </div>
</template>
