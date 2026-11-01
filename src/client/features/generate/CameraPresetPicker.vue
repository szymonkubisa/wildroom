<script setup lang="ts">
/**
 * CameraPresetPicker — a compact grid of camera-move tiles (animated preview + label). Reusable: the Generate
 * panel shows it in a popover under the video prompt; story shot cards can use it the same way.
 *
 * Props:
 *   model?     ModelSpec used for wording: the emitted phrase is in that model family's camera vocabulary
 *              (LTX / Veo / Kling / Seedance via `cameraPhrase`), else the neutral `preset.phrase`
 *   active?    id of the preset currently applied (highlighted, aria-pressed)
 *   activePhrase? the exact wording currently applied (lets the footer say "click to remove" vs "click to reword")
 *   columns?   grid columns (default 4)
 *   showPhrase? show the hovered/focused/active tile's exact wording under the grid (default true)
 * Emits:
 *   select(phrase: string, preset: CameraPreset) — on click / Enter / Space. The parent applies it, e.g.
 *   `withCamera(prompt, phrase)`. Clicking the active tile emits too, so the parent can toggle it off.
 *
 * Previews play on hover and keyboard focus; arrow keys move between tiles.
 * Exposes `focus()`: focuses the active tile, or the grid itself when nothing is active (so no preview starts).
 */
import type { ModelSpec } from '@shared/models/types'
import { computed, ref } from 'vue'
import CameraMovePreview from './CameraMovePreview.vue'
import { CAMERA_PRESETS, type CameraPreset, cameraPhrase } from './camera'

const props = withDefaults(
  defineProps<{ model?: ModelSpec; active?: string; activePhrase?: string; columns?: number; showPhrase?: boolean }>(),
  { model: undefined, active: undefined, activePhrase: undefined, columns: 4, showPhrase: true },
)
const emit = defineEmits<{ select: [phrase: string, preset: CameraPreset] }>()

const live = ref<string>()
const grid = ref<HTMLElement>()

const phraseFor = (p: CameraPreset) => cameraPhrase(p.id, props.model) ?? p.phrase
const shown = computed(() => CAMERA_PRESETS.find((p) => p.id === (live.value ?? props.active)))
/** What clicking the shown tile does: add it, or (for the applied move) remove it / swap in this model's wording. */
const action = computed(() => {
  const p = shown.value
  if (!p) return ''
  const phrase = phraseFor(p)
  if (p.id !== props.active) return `Adds “${phrase}”`
  if (!props.activePhrase || props.activePhrase.toLowerCase() === phrase.toLowerCase()) return 'In the prompt — click again to remove it.'
  return `Click to reword it as “${phrase}”`
})

function leave(id: string) {
  if (live.value === id) live.value = undefined
}

const tiles = () => [...(grid.value?.querySelectorAll<HTMLButtonElement>('button[data-camera]') ?? [])]

function onKey(e: KeyboardEvent, i: number) {
  const step = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: props.columns, ArrowUp: -props.columns } as Record<string, number>)[e.key]
  if (step === undefined) return
  const next = i + step
  if (next < 0 || next >= CAMERA_PRESETS.length) return
  e.preventDefault()
  tiles()[next]?.focus()
}

function focus() {
  const i = CAMERA_PRESETS.findIndex((p) => p.id === props.active)
  ;(i >= 0 ? tiles()[i] : grid.value)?.focus()
}
defineExpose({ focus })
</script>

<template>
  <div class="grid gap-2">
    <div ref="grid" role="group" aria-label="Camera moves" tabindex="-1" class="grid gap-1 outline-none" :style="{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }">
      <button
        v-for="(p, i) in CAMERA_PRESETS"
        :key="p.id"
        type="button"
        data-camera
        :aria-pressed="active === p.id"
        :aria-label="`${p.label} camera move: ${p.hint}`"
        :class="[
          'group grid gap-1 rounded-md p-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60',
          active === p.id ? 'bg-brand/15 hover:bg-brand/20' : 'bg-field hover:bg-field-hover',
        ]"
        @mouseenter="live = p.id"
        @mouseleave="leave(p.id)"
        @focus="live = p.id"
        @blur="leave(p.id)"
        @keydown="onKey($event, i)"
        @click="emit('select', phraseFor(p), p)"
      >
        <CameraMovePreview :preset-id="p.id" :playing="live === p.id" />
        <span
          :class="[
            'truncate px-0.5 text-[10px] leading-tight',
            active === p.id ? 'font-medium text-foreground' : 'text-muted-foreground group-hover:text-foreground group-focus-visible:text-foreground',
          ]"
        >
          {{ p.label }}
        </span>
      </button>
    </div>
    <p v-if="showPhrase" class="min-h-[2lh] text-[10px] leading-snug text-muted-foreground" aria-live="polite">
      <template v-if="shown">
        <span class="text-foreground">{{ shown.hint }}.</span> {{ action }}
      </template>
      <template v-else>Hover a move to preview it; click to add it to the prompt.</template>
    </p>
  </div>
</template>
