<script setup lang="ts">
import { computed, useId } from 'vue'
import LookPreview from '@/features/generate/LookPreview.vue'
import { lookOption } from '@/features/generate/look'

/**
 * A recipe's miniature: what it makes, drawn small — a product on a backdrop, a character sheet, a contact sheet of
 * angles… It moves while the pointer is over its card (`.recipe-card:hover`): the push-in, the speaking mouth, the
 * particles finding the logo. Still under prefers-reduced-motion.
 */
const props = defineProps<{ id: string }>()
const uid = useId()
/** A recipe's picture (recipe-images/<id>.jpg), over the drawing; Shots shows the Camera tile's pictures as a contact sheet. */
const PICTURES = import.meta.glob<string>('./recipe-images/*.jpg', { eager: true, query: '?url', import: 'default' })
const CAMERA = import.meta.glob<string>('../generate/look-images/camera-*.jpg', { eager: true, query: '?url', import: 'default' })
const picture = computed(() => PICTURES[`./recipe-images/${props.id}.jpg`])
const shotPictures = ['wide', 'medium', 'close', 'low', 'shoulder', 'extreme'].map((id) => CAMERA[`../generate/look-images/camera-${id}.jpg`])
const SHOTS = ['wide', 'medium', 'close', 'low', 'shoulder', 'extreme'].map((id) => lookOption('camera', id)?.preview)
const BARS = [5, 9, 13, 8, 16, 11, 7, 14, 10, 6, 12, 15, 8, 5]
const DOTS = Array.from({ length: 16 }, (_, i) => {
  const a = (i / 16) * Math.PI * 2
  return { x: 32 + Math.cos(a) * 7, y: 18 + Math.sin(a) * 7, dx: Math.cos(a * 3 + i) * 22, dy: Math.sin(a * 2 + i) * 14 }
})
</script>

<template>
  <div class="rp relative size-full overflow-hidden bg-black" aria-hidden="true">
    <!-- Shots from one image: a contact sheet of the same moment from six cameras. -->
    <div v-if="id === 'shots'" class="grid size-full grid-cols-3 grid-rows-2 gap-px bg-black">
      <div v-for="(spec, i) in SHOTS" :key="i" class="rp-pop relative overflow-hidden" :style="{ animationDelay: `${i * 90}ms` }">
        <img v-if="shotPictures[i]" :src="shotPictures[i]" alt="" class="block size-full object-cover" draggable="false" />
        <LookPreview v-else :spec="spec" />
      </div>
    </div>

    <!-- A picture of what it makes: a slow push-in while the card is hovered. -->
    <img v-else-if="picture" :src="picture" alt="" class="rp-zoom block size-full object-cover" draggable="false" />

    <svg v-else viewBox="0 0 64 36" preserveAspectRatio="xMidYMid slice" class="block size-full">
      <defs>
        <linearGradient :id="`${uid}-a`" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#c4b5fd" /><stop offset="1" stop-color="#6d28d9" />
        </linearGradient>
        <linearGradient :id="`${uid}-dawn`" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#1e3a8a" /><stop offset="0.6" stop-color="#f472b6" /><stop offset="1" stop-color="#fde68a" />
        </linearGradient>
        <linearGradient :id="`${uid}-gold`" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#f59e0b" /><stop offset="1" stop-color="#fef3c7" />
        </linearGradient>
        <radialGradient :id="`${uid}-glow`"><stop offset="0" stop-color="#a78bfa" stop-opacity="0.9" /><stop offset="1" stop-color="#a78bfa" stop-opacity="0" /></radialGradient>
        <linearGradient :id="`${uid}-win`" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#fde68a" stop-opacity="0.55" /><stop offset="1" stop-color="#fde68a" stop-opacity="0" />
        </linearGradient>
      </defs>

      <!-- Product hero: a bottle on a seamless backdrop, its reflection, a light sweeping over it. -->
      <template v-if="id === 'product'">
        <rect width="64" height="36" :fill="`url(#${uid}-a)`" />
        <ellipse cx="32" cy="29" rx="13" ry="2.4" fill="black" opacity="0.25" />
        <g>
          <rect x="27.5" y="9" width="9" height="19" rx="2.2" fill="#f5f3ff" />
          <rect x="30" y="5.5" width="4" height="4" rx="0.8" fill="#1e1b4b" />
          <rect x="28.8" y="15" width="6.4" height="5" rx="0.6" fill="#7c3aed" />
        </g>
        <g opacity="0.22" transform="translate(0 57) scale(1 -1)"><rect x="27.5" y="9" width="9" height="19" rx="2.2" fill="#f5f3ff" /></g>
        <rect class="rp-sweep" x="-12" y="-4" width="5" height="44" fill="white" opacity="0.45" transform="skewX(-18)" />
      </template>

      <!-- Character sheet: front, three-quarter and side on plain grey. -->
      <template v-else-if="id === 'character'">
        <rect width="64" height="36" fill="#d4d4d8" />
        <g v-for="(f, i) in [{ x: 17, w: 7, hx: 0 }, { x: 32, w: 5.6, hx: 0.9 }, { x: 47, w: 3.6, hx: 1.4 }]" :key="i" class="rp-bob" :style="{ animationDelay: `${i * 150}ms` }">
          <circle :cx="f.x + f.hx" cy="8.5" r="2.6" fill="#e0ac85" />
          <path :d="`M${f.x - f.w / 2} 30 L${f.x - f.w / 2 + 0.6} 12.8 Q${f.x} 11 ${f.x + f.w / 2 - 0.6} 12.8 L${f.x + f.w / 2} 30 Z`" fill="#3f3f46" />
          <rect :x="f.x - f.w / 2 + 0.6" y="30" :width="f.w - 1.2" height="3" fill="#18181b" />
        </g>
      </template>

      <!-- Location plate: an empty valley at dawn, slowly panned. -->
      <g v-else-if="id === 'place'" class="rp-pan">
        <rect x="-20" width="104" height="36" :fill="`url(#${uid}-dawn)`" />
        <polygon points="-20,24 0,12 14,20 26,9 42,21 56,13 84,23 84,36 -20,36" fill="#312e81" />
        <polygon points="-20,28 6,20 22,26 38,19 58,27 84,22 84,36 -20,36" fill="#1e1b4b" />
        <rect x="-20" y="30" width="104" height="6" fill="#0f172a" />
        <rect x="-20" y="30" width="104" height="0.6" fill="#fde68a" opacity="0.5" />
      </g>

      <!-- Establishing shot: mist in the valleys at golden hour, a slow push-in. -->
      <g v-else-if="id === 'establishing'" class="rp-push">
        <rect width="64" height="36" :fill="`url(#${uid}-gold)`" />
        <circle cx="44" cy="13" r="3.4" fill="#fffbeb" />
        <polygon points="0,22 12,11 22,19 34,8 48,20 64,12 64,36 0,36" fill="#7c2d12" opacity="0.75" />
        <rect y="21" width="64" height="4" fill="#fff7ed" opacity="0.55" />
        <polygon points="0,28 14,20 28,27 44,19 64,26 64,36 0,36" fill="#431407" />
        <rect y="27" width="64" height="3" fill="#fff7ed" opacity="0.35" />
      </g>

      <!-- Talking portrait: a close-up in window light, speaking. -->
      <template v-else-if="id === 'portrait'">
        <rect width="64" height="36" fill="#1c1917" />
        <rect width="34" height="36" :fill="`url(#${uid}-win)`" />
        <path d="M14 36 Q16 25 32 24 Q48 25 50 36 Z" fill="#44403c" />
        <ellipse cx="32" cy="15" rx="8" ry="9.5" fill="#d6a17a" />
        <path d="M24 13 Q25 4 32 4.6 Q39 4 40 13 Q38 8 32 8.4 Q26 8 24 13 Z" fill="#292524" />
        <ellipse cx="28.8" cy="14" rx="0.8" ry="0.6" fill="#1c1917" /><ellipse cx="35.2" cy="14" rx="0.8" ry="0.6" fill="#1c1917" />
        <ellipse class="rp-talk" cx="32" cy="20" rx="2.2" ry="0.9" fill="#7f1d1d" />
      </template>

      <!-- Social vertical: a 9:16 frame, handheld. -->
      <template v-else-if="id === 'vertical'">
        <rect width="64" height="36" fill="#18181b" />
        <g class="rp-shake">
          <rect x="24.5" y="3" width="15" height="30" rx="2.4" fill="#0ea5e9" />
          <rect x="24.5" y="22" width="15" height="11" fill="#16a34a" />
          <circle cx="32" cy="15" r="2.2" fill="#e0ac85" />
          <path d="M28.6 28 L29.2 19 Q32 17.6 34.8 19 L35.4 28 Z" fill="#f43f5e" />
          <rect x="24.5" y="3" width="15" height="30" rx="2.4" fill="none" stroke="#fafafa" stroke-width="0.8" />
        </g>
      </template>

      <!-- Logo sting: particles on black find the mark. -->
      <template v-else-if="id === 'sting'">
        <rect width="64" height="36" fill="#09090b" />
        <circle class="rp-glow" cx="32" cy="18" r="14" :fill="`url(#${uid}-glow)`" />
        <circle
          v-for="(d, i) in DOTS"
          :key="i"
          class="rp-gather"
          :cx="d.x"
          :cy="d.y"
          r="1"
          fill="#ddd6fe"
          :style="{ '--dx': `${d.dx}px`, '--dy': `${d.dy}px`, animationDelay: `${(i % 4) * 60}ms` }"
        />
        <rect class="rp-mark" x="28.5" y="14.5" width="7" height="7" rx="1.6" fill="#a78bfa" />
      </template>

      <!-- Music bed: an equaliser. -->
      <template v-else-if="id === 'music'">
        <rect width="64" height="36" fill="#1e1b4b" />
        <rect
          v-for="(h, i) in BARS"
          :key="i"
          class="rp-bar"
          :x="6 + i * 3.8"
          :y="30 - h"
          width="2.4"
          :height="h"
          rx="1"
          fill="#a78bfa"
          :style="{ animationDelay: `${(i * 97) % 600}ms` }"
        />
      </template>
    </svg>
  </div>
</template>

<style scoped>
/* Moving only while its card is hovered (the card is `.recipe-card`), never with reduced motion. */
.rp :is(.rp-sweep, .rp-bob, .rp-pan, .rp-push, .rp-talk, .rp-shake, .rp-gather, .rp-mark, .rp-glow, .rp-bar, .rp-pop) {
  animation-play-state: paused;
  transform-box: fill-box;
}
:global(.recipe-card:hover) .rp :is(.rp-sweep, .rp-bob, .rp-pan, .rp-push, .rp-talk, .rp-shake, .rp-gather, .rp-mark, .rp-glow, .rp-bar, .rp-pop) {
  animation-play-state: running;
}
@media (prefers-reduced-motion: reduce) {
  .rp * {
    animation: none !important;
  }
}
.rp-zoom {
  transition: transform 2.4s cubic-bezier(0.2, 0.7, 0.2, 1);
}
:global(.recipe-card:hover) .rp-zoom {
  transform: scale(1.09);
}
@media (prefers-reduced-motion: reduce) {
  .rp-zoom {
    transition: none;
  }
}
.rp-sweep {
  animation: rp-sweep 1.8s ease-in-out infinite;
}
@keyframes rp-sweep {
  from { transform: skewX(-18deg) translateX(0); }
  to { transform: skewX(-18deg) translateX(90px); }
}
.rp-bob {
  animation: rp-bob 1.4s ease-in-out infinite alternate;
}
@keyframes rp-bob {
  to { transform: translateY(-1.2px); }
}
.rp-pan {
  animation: rp-pan 6s ease-in-out infinite alternate;
}
@keyframes rp-pan {
  from { transform: translateX(8px); }
  to { transform: translateX(-12px); }
}
.rp-push {
  transform-origin: 50% 50%;
  transform-box: view-box;
  animation: rp-push 4s ease-in-out infinite alternate;
}
@keyframes rp-push {
  to { transform: scale(1.3); }
}
.rp-talk {
  transform-origin: center;
  animation: rp-talk 0.28s ease-in-out infinite alternate;
}
@keyframes rp-talk {
  to { transform: scaleY(2.2); }
}
.rp-shake {
  transform-origin: center;
  animation: rp-shake 0.9s ease-in-out infinite;
}
@keyframes rp-shake {
  0%, 100% { transform: translate(0, 0) rotate(0deg); }
  25% { transform: translate(0.6px, -0.4px) rotate(1deg); }
  50% { transform: translate(-0.5px, 0.3px) rotate(-0.8deg); }
  75% { transform: translate(0.3px, 0.5px) rotate(0.6deg); }
}
.rp-gather {
  transform: translate(var(--dx), var(--dy));
  animation: rp-gather 1.6s cubic-bezier(0.2, 0.8, 0.2, 1) infinite;
}
@keyframes rp-gather {
  0% { transform: translate(var(--dx), var(--dy)); opacity: 0.4; }
  60%, 100% { transform: translate(0, 0); opacity: 1; }
}
.rp-mark {
  transform-origin: center;
  transform: scale(0.4);
  opacity: 0.3;
  animation: rp-mark 1.6s ease-out infinite;
}
@keyframes rp-mark {
  0%, 55% { transform: scale(0.4); opacity: 0.3; }
  75%, 100% { transform: scale(1); opacity: 1; }
}
.rp-glow {
  opacity: 0.35;
  animation: rp-glow 1.6s ease-out infinite;
}
@keyframes rp-glow {
  0%, 55% { opacity: 0.2; }
  80% { opacity: 1; }
  100% { opacity: 0.6; }
}
.rp-bar {
  transform-origin: bottom;
  animation: rp-bar 0.7s ease-in-out infinite alternate;
}
@keyframes rp-bar {
  to { transform: scaleY(0.35); }
}
.rp-pop {
  animation: rp-pop 1.8s ease-out infinite;
}
@keyframes rp-pop {
  0% { opacity: 0.35; transform: scale(0.94); }
  25%, 100% { opacity: 1; transform: scale(1); }
}
</style>
