<script setup lang="ts">
/**
 * CameraMovePreview — a tiny abstract scene (sky, hills, trees, a subject) that loops a ~2 s animation of one camera
 * move from `CAMERA_PRESETS`. Dependency-free: SVG + CSS transforms, theme colours from CSS vars.
 *
 * Props:
 *   presetId   camera preset id ('push-in', 'orbit', …)
 *   size?      width in px (height follows 16:9); omit to fill the container's width
 *   playing?   controlled play state; omit to play while the pointer is over the preview
 * At rest (and always under prefers-reduced-motion) it shows a still frame with a small glyph of the move.
 */
import { computed, ref, useId } from 'vue'

const props = withDefaults(defineProps<{ presetId: string; size?: number; playing?: boolean }>(), {
  size: undefined,
  playing: undefined, // keep `undefined` (not Vue's boolean-cast `false`) so hover-to-play works when uncontrolled
})

const hovered = ref(false)
const isPlaying = computed(() => props.playing ?? hovered.value)
const blurId = `cmp-blur-${useId()}`
const rack = computed(() => props.presetId === 'rack-focus')
const style = computed(() => (props.size ? { width: `${props.size}px` } : { width: '100%' }))

/** Repeating background pieces (period 32 / 16 units) so sliding layers loop seamlessly. */
const PERIODS = [-64, -32, 0, 32, 64, 96]
const hills = PERIODS.map((x) => `${x},20 ${x + 8},13 ${x + 15},19 ${x + 22},15.5`).join(' ') + ' 128,20 128,22 -64,22'
const TREES = Array.from({ length: 13 }, (_, i) => -56 + i * 16)
</script>

<template>
  <div
    class="cmp"
    :class="[`cmp--${presetId}`, { 'is-playing': isPlaying }]"
    :style="style"
    aria-hidden="true"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
  >
    <svg viewBox="0 0 64 36" preserveAspectRatio="xMidYMid slice">
      <defs>
        <filter :id="blurId" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="1.3" /></filter>
      </defs>

      <g class="cut">
        <g class="world">
          <g class="bg">
            <circle class="c-sun" cx="47" cy="8" r="3" />
            <g class="far">
              <template v-for="x in PERIODS" :key="x">
                <rect class="c-cloud" :x="x + 16" y="5" width="9" height="2.2" rx="1.1" />
                <circle class="c-cloud" :cx="x + 19.6" cy="5" r="1.7" />
                <rect class="c-cloud" :x="x + 2" y="-6" width="8" height="2" rx="1" />
                <circle class="c-cloud" :cx="x + 5" cy="-6" r="1.5" />
              </template>
              <polygon class="c-far" :points="hills" />
            </g>
            <rect class="c-ground" x="-64" y="20" width="192" height="64" />
            <line class="c-horizon" x1="-64" y1="20" x2="128" y2="20" />
            <g class="near">
              <g v-for="x in TREES" :key="x">
                <rect class="c-tree" :x="x - 0.4" y="28.4" width="0.8" height="2.4" />
                <polygon class="c-tree" :points="`${x},21.6 ${x + 2.3},28.6 ${x - 2.3},28.6`" />
              </g>
            </g>
          </g>

          <g class="subj">
            <ellipse class="c-shadow" cx="32" cy="27.4" rx="4.2" ry="0.9" />
            <g class="sharp">
              <rect class="c-subj" x="29.2" y="18.6" width="5.6" height="8.6" rx="2.5" />
              <circle class="c-subj" cx="32" cy="15.4" r="2.7" />
              <g class="face">
                <circle class="c-eye" cx="31.1" cy="15.2" r="0.5" />
                <circle class="c-eye" cx="32.9" cy="15.2" r="0.5" />
              </g>
            </g>
            <g v-if="rack" class="soft" :filter="`url(#${blurId})`">
              <rect class="c-subj" x="29.2" y="18.6" width="5.6" height="8.6" rx="2.5" />
              <circle class="c-subj" cx="32" cy="15.4" r="2.7" />
            </g>
          </g>
        </g>

        <g v-if="rack" class="fg">
          <g class="sharp">
            <ellipse class="c-fg" cx="7" cy="27" rx="3" ry="9" transform="rotate(-18 7 27)" />
            <ellipse class="c-fg" cx="13" cy="33" rx="2.6" ry="8" transform="rotate(24 13 33)" />
            <ellipse class="c-fg" cx="2" cy="17" rx="2.4" ry="7" transform="rotate(-38 2 17)" />
          </g>
          <g class="soft" :filter="`url(#${blurId})`">
            <ellipse class="c-fg" cx="7" cy="27" rx="3" ry="9" transform="rotate(-18 7 27)" />
            <ellipse class="c-fg" cx="13" cy="33" rx="2.6" ry="8" transform="rotate(24 13 33)" />
            <ellipse class="c-fg" cx="2" cy="17" rx="2.4" ry="7" transform="rotate(-38 2 17)" />
          </g>
        </g>
      </g>

      <!-- Still-frame glyph of the move (hidden while playing, except for Static). -->
      <g class="glyph">
        <rect class="glyph-chip" x="1.75" y="1.75" width="10" height="10" rx="2.6" />
        <g class="glyph-ink" transform="translate(1.75 1.75)">
          <template v-if="presetId === 'static'">
            <rect class="glyph-dot" x="3.4" y="2.2" width="3.2" height="2.1" rx="0.5" />
            <path d="M5 4.8 3.3 8M5 4.8 6.7 8M5 4.8V8" />
          </template>
          <path v-else-if="presetId === 'push-in'" d="M2.4 3 4.4 5 2.4 7M7.6 3 5.6 5 7.6 7" />
          <path v-else-if="presetId === 'pull-out'" d="M4.2 3 2.2 5 4.2 7M5.8 3 7.8 5 5.8 7" />
          <path v-else-if="presetId === 'pan-left'" d="M8 5H2.3M4.3 3 2.3 5 4.3 7" />
          <path v-else-if="presetId === 'pan-right'" d="M2 5h5.7M5.7 3 7.7 5 5.7 7" />
          <path v-else-if="presetId === 'tilt-up'" d="M5 8V2.3M3 4.3 5 2.3 7 4.3" />
          <path v-else-if="presetId === 'tilt-down'" d="M5 2v5.7M3 5.7 5 7.7 7 5.7" />
          <template v-else-if="presetId === 'orbit'">
            <path d="M7.9 6.2A3.1 3.1 0 1 1 7.6 3.4M5.8 2.6l1.8.8.1-1.9" />
            <circle class="glyph-dot" cx="5" cy="5" r="0.9" />
          </template>
          <template v-else-if="presetId === 'tracking'">
            <circle class="glyph-dot" cx="4.4" cy="3.3" r="1" />
            <path d="M2 6.6h5.6M5.8 4.9l1.8 1.7-1.8 1.7" />
          </template>
          <path v-else-if="presetId === 'crane-up'" d="M2.8 8.2Q2.8 3.6 7.4 2.8M5.5 1.8l1.9 1-1.2 1.7" />
          <path v-else-if="presetId === 'handheld'" d="M1.8 5 3.1 3.4 4.4 6.6 5.7 3.4 7 6.6 8.2 5" />
          <template v-else-if="presetId === 'fpv'">
            <circle cx="3" cy="3" r="1.15" /><circle cx="7" cy="3" r="1.15" />
            <circle cx="3" cy="7" r="1.15" /><circle cx="7" cy="7" r="1.15" />
            <path d="M3.9 3.9 6.1 6.1M6.1 3.9 3.9 6.1" />
          </template>
          <template v-else-if="presetId === 'dolly-zoom'">
            <rect class="glyph-dot" x="3.9" y="3.9" width="2.2" height="2.2" rx="0.4" />
            <path d="M2 2 3.1 3.1M8 2 6.9 3.1M2 8 3.1 6.9M8 8 6.9 6.9" />
          </template>
          <template v-else-if="presetId === 'rack-focus'">
            <circle cx="3.2" cy="5" r="1.7" stroke-dasharray="0.7 0.7" />
            <circle class="glyph-dot" cx="7" cy="5" r="1.7" />
          </template>
        </g>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.cmp {
  position: relative;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: 5px;
  background: var(--muted);
  flex-shrink: 0;
}
.cmp svg {
  display: block;
  width: 100%;
  height: 100%;
}

/* Scene colours — theme-aware via the app's tokens. */
.c-sun { fill: color-mix(in oklch, var(--brand) 32%, transparent); }
.c-cloud { fill: color-mix(in oklch, var(--foreground) 9%, transparent); }
.c-far { fill: color-mix(in oklch, var(--foreground) 10%, transparent); }
.c-ground { fill: color-mix(in oklch, var(--foreground) 6%, transparent); }
.c-horizon { stroke: color-mix(in oklch, var(--foreground) 22%, transparent); stroke-width: 0.35; }
.c-tree { fill: color-mix(in oklch, var(--foreground) 15%, transparent); }
.c-shadow { fill: color-mix(in oklch, var(--foreground) 12%, transparent); }
.c-subj { fill: var(--brand); }
.c-eye { fill: var(--background); }
.c-fg { fill: color-mix(in oklch, var(--foreground) 40%, transparent); }
.glyph-chip { fill: color-mix(in oklch, var(--background) 80%, transparent); }
.glyph-ink {
  fill: none;
  stroke: color-mix(in oklch, var(--foreground) 80%, transparent);
  stroke-width: 0.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.glyph-ink .glyph-dot { fill: color-mix(in oklch, var(--foreground) 80%, transparent); stroke: none; }
.glyph { transition: opacity 0.2s; }
.is-playing:not(.cmp--static) .glyph { opacity: 0; }

/* Transform frames: CSS lengths on SVG elements are user units of the 64×36 viewBox. */
.cut, .world, .bg, .far, .near, .subj, .face { transform-box: view-box; }
.world, .bg { transform-origin: 32px 20px; }
.subj { transform-origin: 32px 27px; }
.cmp--fpv .world { transform-origin: 32px 17px; }

/* Rack focus at rest: foreground sharp, subject soft. */
.cmp--rack-focus .bg { opacity: 0.75; }
.cmp--rack-focus .subj .sharp, .cmp--rack-focus .fg .soft { opacity: 0; }

/* ——— Playing ——— (negative delay starts inside the fade-in, so hovering doesn't blink) */
.is-playing * { animation-delay: -0.2s !important; }

/* One-way moves fade out/in at the loop seam, like a cut. */
.is-playing.cmp--push-in .cut,
.is-playing.cmp--pull-out .cut,
.is-playing.cmp--pan-left .cut,
.is-playing.cmp--pan-right .cut,
.is-playing.cmp--tilt-up .cut,
.is-playing.cmp--tilt-down .cut,
.is-playing.cmp--crane-up .cut,
.is-playing.cmp--fpv .cut {
  animation: cmp-cut 2s linear infinite;
}
.is-playing.cmp--push-in .world { animation: cmp-push 2s cubic-bezier(0.45, 0, 0.55, 1) infinite; }
.is-playing.cmp--pull-out .world { animation: cmp-pull 2s cubic-bezier(0.45, 0, 0.55, 1) infinite; }
.is-playing.cmp--pan-left .world { animation: cmp-pan-left 2s ease-in-out infinite; }
.is-playing.cmp--pan-right .world { animation: cmp-pan-right 2s ease-in-out infinite; }
.is-playing.cmp--tilt-up .world { animation: cmp-tilt-up 2s ease-in-out infinite; }
.is-playing.cmp--tilt-down .world { animation: cmp-tilt-down 2s ease-in-out infinite; }
.is-playing.cmp--crane-up .world { animation: cmp-crane 2s ease-in-out infinite; }
.is-playing.cmp--fpv .world { animation: cmp-fpv 2s cubic-bezier(0.5, 0, 0.9, 0.6) infinite; }
.is-playing.cmp--handheld .world { animation: cmp-shake 2s ease-in-out infinite; }
.is-playing.cmp--static .subj { animation: cmp-breathe 1s ease-in-out infinite alternate; }

/* Tracking: the subject walks in place while near trees rush past and the hills drift. */
.is-playing.cmp--tracking .near { animation: cmp-slide-16 0.8s linear infinite; }
.is-playing.cmp--tracking .far { animation: cmp-slide-32 4s linear infinite; }
.is-playing.cmp--tracking .subj { animation: cmp-walk 0.4s ease-in-out infinite alternate; }
.cmp--tracking .face { transform: translateX(1.2px); }

/* Orbit: background sweeps one way, the foreground the other, and the face turns. */
.is-playing.cmp--orbit .far { animation: cmp-slide-32 2s linear infinite; }
.is-playing.cmp--orbit .near { animation: cmp-slide-16r 1s linear infinite; }
.is-playing.cmp--orbit .face { animation: cmp-turn 2s linear infinite; }

/* Vertigo: the subject holds its size while the background stretches. */
.is-playing.cmp--dolly-zoom .bg { animation: cmp-vertigo 1s ease-in-out infinite alternate; }

/* Rack focus: sharpness crosses from the foreground to the subject. */
.is-playing.cmp--rack-focus .subj .sharp,
.is-playing.cmp--rack-focus .fg .soft { animation: cmp-focus-in 1s ease-in-out infinite alternate; }
.is-playing.cmp--rack-focus .subj .soft,
.is-playing.cmp--rack-focus .fg .sharp { animation: cmp-focus-out 1s ease-in-out infinite alternate; }

@keyframes cmp-cut { 0% { opacity: 0; } 10%, 88% { opacity: 1; } 100% { opacity: 0; } }
@keyframes cmp-push { 0%, 8% { transform: scale(1); } 85%, 100% { transform: scale(1.55); } }
@keyframes cmp-pull { 0%, 8% { transform: scale(1.55); } 85%, 100% { transform: scale(1); } }
@keyframes cmp-pan-left { 0%, 8% { transform: translateX(-12px); } 85%, 100% { transform: translateX(12px); } }
@keyframes cmp-pan-right { 0%, 8% { transform: translateX(12px); } 85%, 100% { transform: translateX(-12px); } }
@keyframes cmp-tilt-up { 0%, 8% { transform: translateY(-7px); } 85%, 100% { transform: translateY(11px); } }
@keyframes cmp-tilt-down { 0%, 8% { transform: translateY(11px); } 85%, 100% { transform: translateY(-7px); } }
@keyframes cmp-crane { 0%, 8% { transform: translateY(-2px) scale(1.1); } 85%, 100% { transform: translateY(9px) scale(0.78); } }
@keyframes cmp-fpv {
  0% { transform: scale(1) rotate(-7deg); }
  50% { transform: scale(1.45) rotate(5deg); }
  100% { transform: scale(2.6) rotate(-4deg); }
}
@keyframes cmp-shake {
  0%, 100% { transform: scale(1.08) translate(0, 0) rotate(0deg); }
  12% { transform: scale(1.08) translate(0.7px, -0.5px) rotate(0.7deg); }
  27% { transform: scale(1.08) translate(-0.6px, 0.4px) rotate(-0.5deg); }
  41% { transform: scale(1.08) translate(0.4px, 0.7px) rotate(0.3deg); }
  58% { transform: scale(1.08) translate(-0.8px, -0.3px) rotate(-0.7deg); }
  73% { transform: scale(1.08) translate(0.5px, -0.6px) rotate(0.5deg); }
  88% { transform: scale(1.08) translate(-0.3px, 0.5px) rotate(-0.2deg); }
}
@keyframes cmp-breathe { from { transform: scaleY(1); } to { transform: scaleY(1.035); } }
@keyframes cmp-walk { from { transform: translateY(0); } to { transform: translateY(-0.7px); } }
@keyframes cmp-slide-16 { from { transform: translateX(0); } to { transform: translateX(-16px); } }
@keyframes cmp-slide-16r { from { transform: translateX(0); } to { transform: translateX(16px); } }
@keyframes cmp-slide-32 { from { transform: translateX(0); } to { transform: translateX(-32px); } }
@keyframes cmp-turn {
  0% { transform: translateX(-2.6px); opacity: 0; }
  15%, 85% { opacity: 1; }
  100% { transform: translateX(2.6px); opacity: 0; }
}
@keyframes cmp-vertigo { 0%, 10% { transform: scale(1); } 90%, 100% { transform: scale(1.7); } }
@keyframes cmp-focus-in { 0%, 20% { opacity: 0; } 80%, 100% { opacity: 1; } }
@keyframes cmp-focus-out { 0%, 20% { opacity: 1; } 80%, 100% { opacity: 0; } }

@media (prefers-reduced-motion: reduce) {
  .cmp * { animation: none !important; }
  .is-playing .glyph { opacity: 1 !important; }
}
</style>
