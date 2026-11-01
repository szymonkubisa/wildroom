<script setup lang="ts">
import { computed, useId } from 'vue'
import type { LookPreviewSpec } from './look'

/**
 * A look's miniature: one small scene — sky, sun, hills, a figure — framed (Camera), seen through a lens (Lens), lit
 * (Lighting) or graded (Color) as the option describes. Dependency-free SVG with a CSS filter and a blended tint; fills its container.
 */
const props = defineProps<{ spec?: LookPreviewSpec }>()
const id = useId()

const s = computed(() => props.spec ?? {})
const sky = computed(() => s.value.sky ?? ['#38bdf8', '#e0f2fe'])
const sun = computed(() => (s.value.sky || s.value.backdrop ? s.value.sun : { color: '#fef08a', x: 49, y: 8, r: 2.6, glow: 5 }))
const ground = computed(() => s.value.ground ?? '#4d7c0f')
const figure = computed(() => s.value.figure ?? '#be123c')
const skin = computed(() => (s.value.figure ? s.value.figure : '#e0ac85'))

/** The scene zoomed into its focus point (the figure's face, its waist…). */
const frame = computed(() => {
  const z = s.value.zoom ?? 1
  const [fx, fy] = s.value.focus ?? [32, 18]
  return `translate(32 18) scale(${z}) translate(${-fx} ${-fy})`
})
/** Tilt and roll on the picture as a whole (a perspective SVG groups can't do). */
const camera = computed(() => {
  const parts: string[] = []
  if (s.value.tilt) parts.push(`perspective(90px) rotateX(${s.value.tilt}deg) scale(1.35)`)
  if (s.value.roll) parts.push(`rotate(${s.value.roll}deg) scale(1.3)`)
  return parts.join(' ') || undefined
})
/** A long lens brings the background closer: scaled about the horizon behind the figure. */
const backdrop = computed(() => (s.value.bgScale ? `translate(32 23) scale(${s.value.bgScale}) translate(-32 -23)` : undefined))
const BOKEH = [
  [8, 9, 1.6, '#fde68a'],
  [16, 5, 1.1, '#fef3c7'],
  [45, 7, 1.4, '#fcd34d'],
  [56, 12, 1.8, '#fef9c3'],
  [22, 13, 0.9, '#fde68a'],
] as const
const rimShift = computed(() => (s.value.rim?.side === 'left' ? -0.6 : s.value.rim?.side === 'right' ? 0.6 : 0))
</script>

<template>
  <div class="relative size-full overflow-hidden bg-black" aria-hidden="true">
    <div class="absolute inset-0" :style="{ transform: camera, filter: s.filter }">
      <svg viewBox="0 0 64 36" preserveAspectRatio="xMidYMid slice" class="block size-full">
        <defs>
          <linearGradient :id="`${id}-sky`" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" :stop-color="sky[0]" />
            <stop offset="1" :stop-color="sky[1]" />
          </linearGradient>
          <radialGradient v-if="sun?.glow" :id="`${id}-glow`">
            <stop offset="0" :stop-color="sun.color" stop-opacity="0.85" />
            <stop offset="1" :stop-color="sun.color" stop-opacity="0" />
          </radialGradient>
          <filter :id="`${id}-blur`" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6" /></filter>
          <filter v-if="s.dof" :id="`${id}-dof`" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur :stdDeviation="s.dof" /></filter>
        </defs>
        <g :transform="frame">
          <g :transform="backdrop" :filter="s.dof ? `url(#${id}-dof)` : undefined">
          <template v-if="s.backdrop">
            <rect x="-64" y="-40" width="192" height="120" :fill="s.backdrop" />
            <ellipse cx="32" cy="31" rx="14" ry="2" fill="black" opacity="0.18" />
          </template>
          <template v-else>
            <rect x="-64" y="-40" width="192" height="66" :fill="`url(#${id}-sky)`" />
            <circle v-if="sun?.glow" :cx="sun.x" :cy="sun.y" :r="sun.glow" :fill="`url(#${id}-glow)`" />
            <circle v-if="sun" :cx="sun.x" :cy="sun.y" :r="sun.r" :fill="sun.color" />
            <polygon points="-64,24 -20,17 0,21 14,16 30,22 46,15 62,21 80,17 128,23 128,26 -64,26" :fill="ground" opacity="0.6" />
            <rect x="-64" y="24" width="192" height="60" :fill="ground" />
            <rect x="10" y="20.5" width="1.2" height="4" fill="black" opacity="0.35" /><circle cx="10.6" cy="19.5" r="2.2" :fill="ground" />
            <rect x="52" y="19.5" width="1.4" height="5" fill="black" opacity="0.35" /><circle cx="52.7" cy="18.3" r="2.6" :fill="ground" />
          </template>
          <circle v-for="(b, i) in s.bokeh ? BOKEH : []" :key="i" :cx="b[0]" :cy="b[1]" :r="b[2]" :fill="b[3]" opacity="0.7" />
          </g>
          <!-- The figure, a rim of light on one side (or all round when backlit). -->
          <g v-if="s.rim" :filter="s.rim.side === 'back' ? `url(#${id}-blur)` : undefined" :transform="`translate(${rimShift} 0)`">
            <circle cx="32" cy="14" r="2.9" :fill="s.rim.color" />
            <path d="M26.4 31 L27.4 19.6 Q32 16.6 36.6 19.6 L37.6 31 Z" :fill="s.rim.color" />
          </g>
          <path d="M26.6 31 L27.6 19.8 Q32 17 36.4 19.8 L37.4 31 Z" :fill="figure" />
          <circle cx="32" cy="14" r="2.6" :fill="skin" />
          <circle cx="31.1" cy="13.8" r="0.28" fill="#111" /><circle cx="32.9" cy="13.8" r="0.28" fill="#111" />
          <path d="M29.4 12.6 Q32 10 34.6 12.6 Q34 11 32 10.9 Q30 11 29.4 12.6 Z" fill="#3f2a1d" />
        </g>
        <!-- Over the shoulder: someone's soft shoulder in front. -->
        <g v-if="s.shoulder" :filter="`url(#${id}-blur)`">
          <ellipse cx="8" cy="40" rx="20" ry="22" fill="#111827" />
          <circle cx="12" cy="10" r="9" fill="#1f2937" />
        </g>
      </svg>
    </div>
    <div v-if="s.tint" class="absolute inset-0" :style="{ background: s.tint.color, mixBlendMode: s.tint.blend, opacity: 0.55 }" />
    <!-- The lens over the picture: glowing highlights, a flare across it, soft top and bottom, dark corners, bars. -->
    <div v-if="s.halation" class="absolute inset-0 mix-blend-screen" style="background: radial-gradient(circle at 76% 22%, rgb(255 110 70 / 0.8), transparent 45%)" />
    <div
      v-if="s.flare"
      class="absolute inset-x-0 top-[22%] h-[3px] mix-blend-screen blur-[0.5px]"
      :style="{ background: `linear-gradient(90deg, transparent, ${s.flare} 35%, white 50%, ${s.flare} 65%, transparent)` }"
    />
    <template v-if="s.tiltShift">
      <div class="absolute inset-x-0 top-0 h-[42%] backdrop-blur-[3px]" style="mask-image: linear-gradient(black 40%, transparent)" />
      <div class="absolute inset-x-0 bottom-0 h-[34%] backdrop-blur-[3px]" style="mask-image: linear-gradient(transparent, black 60%)" />
    </template>
    <div v-if="s.vignette" class="absolute inset-0" :style="{ background: `radial-gradient(ellipse at center, transparent 45%, rgb(0 0 0 / ${s.vignette}) 100%)` }" />
    <template v-if="s.letterbox">
      <div class="absolute inset-x-0 top-0 h-[13%] bg-black" />
      <div class="absolute inset-x-0 bottom-0 h-[13%] bg-black" />
    </template>
  </div>
</template>
