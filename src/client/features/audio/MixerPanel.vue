<script setup lang="ts">
import { AudioLines, RotateCcw, Volume2, VolumeX } from '@lucide/vue'
import { type MixSettings, type RoleMix, defaultMix } from '@shared/types/project-doc'
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { currentPlayer } from '@/features/editor/transport'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project'

const project = useProjectStore()
const mix = computed<MixSettings>(() => project.doc.mix ?? defaultMix())

const ROLES = [
  { id: 'dialogue', label: 'Dialogue', color: 'var(--role-dialogue)' },
  { id: 'music', label: 'Music', color: 'var(--role-music)' },
  { id: 'effects', label: 'Effects', color: 'var(--role-effects)' },
] as const

const FADER_MIN = -60
const FADER_MAX = 12

function roleMix(id: string): RoleMix {
  return mix.value.roles[id] ?? { gainDb: 0, mute: false, solo: false }
}

const anySolo = computed(() => ROLES.some((r) => roleMix(r.id).solo))
/** Silenced by mute, or by another channel's solo. */
const silenced = (id: string) => roleMix(id).mute || (anySolo.value && !roleMix(id).solo)

function recipe(patch: (m: MixSettings) => MixSettings) {
  return (draft: { mix?: MixSettings }) => {
    draft.mix = patch(JSON.parse(JSON.stringify(draft.mix ?? defaultMix())) as MixSettings)
  }
}

function live(label: string, patch: (m: MixSettings) => MixSettings) {
  if (!project.dragging()) project.beginDrag(label)
  project.previewDrag(recipe(patch))
}

function set(label: string, patch: (m: MixSettings) => MixSettings) {
  project.apply(recipe(patch), label)
}

function setRole(id: string, change: Partial<RoleMix>, liveEdit = false) {
  const patch = (m: MixSettings) => ({ ...m, roles: { ...m.roles, [id]: { ...roleMix(id), ...change } } })
  if (liveEdit) live('Mixer', patch)
  else set(change.mute !== undefined ? 'Mute' : change.solo !== undefined ? 'Solo' : 'Mixer', patch)
}

function resetAll() {
  set('Reset mixer', (m) => ({ ...m, masterDb: 0, roles: {} }))
}

const fmtDb = (v: number) => (v <= FADER_MIN ? '−∞' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`)
/** Where 0 dB (unity) sits on a fader, from the bottom. */
const unity = (min: number, max: number) => `${((0 - min) / (max - min)) * 100}%`

// ---- live meters: post-fader peak per bus, and the stereo output (60 dB scale, slow fall-off)
const meterEls = new Map<string, HTMLElement>()
const peaks = new Map<string, number>()
function bindMeter(key: string, el: unknown) {
  if (el instanceof HTMLElement) meterEls.set(key, el)
  else meterEls.delete(key)
}
let raf = 0
function tick() {
  raf = requestAnimationFrame(tick)
  const player = currentPlayer()
  const playing = Boolean(player?.playing)
  const out = playing ? player!.audio.levels() : [-Infinity, -Infinity]
  const levels: Record<string, number> = { masterL: out[0]!, masterR: out[1]! }
  for (const r of ROLES) levels[r.id] = playing ? player!.audio.roleLevel(r.id) : -Infinity
  for (const [key, el] of meterEls) {
    const db = Number.isFinite(levels[key]) ? levels[key]! : -60
    const shown = Math.max(db, (peaks.get(key) ?? -60) - 1.1)
    peaks.set(key, shown)
    el.style.height = `${Math.max(0, Math.min(1, (shown + 60) / 60)) * 100}%`
    el.dataset.hot = String(db > -3)
  }
}
onMounted(() => (raf = requestAnimationFrame(tick)))
onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<template>
  <div class="grid w-[440px] gap-3">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2 text-sm font-semibold"><AudioLines class="size-4 text-brand" /> Mixer</div>
      <button class="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" title="All faders to 0 dB, no mute/solo" @click="resetAll">
        <RotateCcw class="size-3" /> Reset
      </button>
    </div>

    <!-- Channel strips -->
    <div class="flex gap-1.5 rounded-xl bg-background/60 p-1.5">
      <div
        v-for="r in ROLES"
        :key="r.id"
        :class="cn('flex flex-1 flex-col items-center gap-2 rounded-lg bg-card px-2 pt-0 pb-2 transition-opacity', silenced(r.id) && 'opacity-50')"
      >
        <div class="h-1 w-full rounded-b-full" :style="{ background: r.color }" />
        <div class="text-[11px] font-medium">{{ r.label }}</div>
        <div class="relative flex h-36 items-stretch gap-2">
          <!-- meter -->
          <div class="relative w-1.5 overflow-hidden rounded-full bg-foreground/10">
            <div
              :ref="(el) => bindMeter(r.id, el)"
              class="absolute bottom-0 w-full rounded-full bg-gradient-to-t from-role-music via-role-music to-role-effects data-[hot=true]:to-destructive"
              style="height: 0%"
            />
          </div>
          <!-- fader -->
          <div class="fader relative h-36" :style="{ '--fader-color': r.color }">
            <div class="pointer-events-none absolute -left-1.5 h-px w-7 bg-foreground/35" :style="{ bottom: unity(FADER_MIN, FADER_MAX) }" title="0 dB" />
            <Slider
              orientation="vertical"
              class="data-[orientation=vertical]:h-36 data-[orientation=vertical]:min-h-0"
              :model-value="[roleMix(r.id).gainDb]"
              :min="FADER_MIN"
              :max="FADER_MAX"
              :step="0.5"
              @update:model-value="(v) => v && setRole(r.id, { gainDb: v[0]! }, true)"
              @value-commit="project.commitDrag()"
            />
          </div>
        </div>
        <button
          class="w-14 rounded px-1 text-center font-mono text-[11px] whitespace-nowrap tabular hover:bg-accent"
          title="Double-click: back to 0 dB"
          @dblclick="setRole(r.id, { gainDb: 0 })"
        >
          {{ fmtDb(roleMix(r.id).gainDb) }}
        </button>
        <div class="flex gap-1">
          <button
            type="button"
            :class="cn('h-6 w-7 rounded-md text-[10px] font-bold transition-colors', roleMix(r.id).mute ? 'bg-destructive text-white' : 'border border-border bg-background/70 text-muted-foreground hover:text-foreground')"
            :title="roleMix(r.id).mute ? 'Unmute' : 'Mute'"
            @click="setRole(r.id, { mute: !roleMix(r.id).mute })"
          >
            M
          </button>
          <button
            type="button"
            :class="cn('h-6 w-7 rounded-md text-[10px] font-bold transition-colors', roleMix(r.id).solo ? 'bg-role-captions text-black' : 'border border-border bg-background/70 text-muted-foreground hover:text-foreground')"
            :title="roleMix(r.id).solo ? 'Unsolo' : 'Solo'"
            @click="setRole(r.id, { solo: !roleMix(r.id).solo })"
          >
            S
          </button>
        </div>
      </div>

      <!-- Master -->
      <div class="flex w-[92px] flex-col items-center gap-2 rounded-lg bg-accent/60 px-2 pt-0 pb-2">
        <div class="h-1 w-full rounded-b-full bg-foreground/70" />
        <div class="text-[11px] font-semibold">Master</div>
        <div class="relative flex h-36 items-stretch gap-2">
          <div class="flex gap-0.5">
            <div v-for="ch in ['masterL', 'masterR']" :key="ch" class="relative w-1.5 overflow-hidden rounded-full bg-foreground/10">
              <div
                :ref="(el) => bindMeter(ch, el)"
                class="absolute bottom-0 w-full rounded-full bg-gradient-to-t from-role-music via-role-music to-role-effects data-[hot=true]:to-destructive"
                style="height: 0%"
              />
            </div>
          </div>
          <div class="fader relative h-36" style="--fader-color: var(--foreground)">
            <div class="pointer-events-none absolute -left-1.5 h-px w-7 bg-foreground/35" :style="{ bottom: unity(-30, 12) }" title="0 dB" />
            <Slider
              orientation="vertical"
              class="data-[orientation=vertical]:h-36 data-[orientation=vertical]:min-h-0"
              :model-value="[mix.masterDb]"
              :min="-30"
              :max="12"
              :step="0.5"
              @update:model-value="(v) => v && live('Master', (m) => ({ ...m, masterDb: v[0]! }))"
              @value-commit="project.commitDrag()"
            />
          </div>
        </div>
        <button class="w-14 rounded px-1 text-center font-mono text-[11px] whitespace-nowrap tabular hover:bg-accent" title="Double-click: back to 0 dB" @dblclick="set('Master', (m) => ({ ...m, masterDb: 0 }))">
          {{ fmtDb(mix.masterDb) }}
        </button>
        <div class="flex h-6 items-center text-muted-foreground">
          <VolumeX v-if="mix.masterDb <= -30" class="size-3.5" />
          <Volume2 v-else class="size-3.5" />
        </div>
      </div>
    </div>

    <!-- Automatic mixing -->
    <div class="grid gap-2 rounded-xl bg-card p-3">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-xs font-medium">Duck music under dialogue</div>
          <div class="text-[11px] leading-snug text-muted-foreground">Music dips automatically whenever someone speaks.</div>
        </div>
        <Switch :model-value="mix.ducking.enabled" @update:model-value="(v) => set('Ducking', (m) => ({ ...m, ducking: { ...m.ducking, enabled: Boolean(v) } }))" />
      </div>
      <div v-if="mix.ducking.enabled" class="grid gap-2 pt-1">
        <div class="grid grid-cols-[56px_1fr_64px] items-center gap-3">
          <span class="text-[11px] text-muted-foreground">Amount</span>
          <Slider
            :model-value="[mix.ducking.amountDb]"
            :min="-30"
            :max="-1"
            :step="0.5"
            @update:model-value="(v) => v && live('Ducking amount', (m) => ({ ...m, ducking: { ...m.ducking, amountDb: v[0]! } }))"
            @value-commit="project.commitDrag()"
          />
          <span class="text-right font-mono text-[11px] whitespace-nowrap tabular">{{ mix.ducking.amountDb.toFixed(1) }} dB</span>
        </div>
        <div class="grid grid-cols-[56px_1fr_64px] items-center gap-3">
          <span class="text-[11px] text-muted-foreground">Fade</span>
          <Slider
            :model-value="[mix.ducking.fadeSeconds]"
            :min="0.05"
            :max="2"
            :step="0.05"
            @update:model-value="(v) => v && live('Ducking fade', (m) => ({ ...m, ducking: { ...m.ducking, fadeSeconds: v[0]! } }))"
            @value-commit="project.commitDrag()"
          />
          <span class="text-right font-mono text-[11px] whitespace-nowrap tabular">{{ mix.ducking.fadeSeconds.toFixed(2) }} s</span>
        </div>
      </div>
    </div>
    <div class="flex items-start justify-between gap-3 rounded-xl bg-card p-3">
      <div>
        <div class="text-xs font-medium">Even out dialogue loudness</div>
        <div class="text-[11px] leading-snug text-muted-foreground">Brings every voice take to the same level (measured at import).</div>
      </div>
      <Switch :model-value="mix.normalizeDialogue" @update:model-value="(v) => set('Dialogue loudness', (m) => ({ ...m, normalizeDialogue: Boolean(v) }))" />
    </div>
  </div>
</template>

<style scoped>
/* Console-style faders: a thin groove, fill in the channel colour, a rectangular cap. */
.fader :deep([data-slot='slider-track']) {
  width: 4px;
  background: color-mix(in oklch, var(--foreground) 10%, transparent);
}
.fader :deep([data-slot='slider-range']) {
  background: var(--fader-color);
  opacity: 0.8;
}
.fader :deep([data-slot='slider-thumb']) {
  width: 26px;
  height: 14px;
  border-radius: 4px;
  border: 1px solid oklch(0 0 0 / 35%);
  background: linear-gradient(to bottom, oklch(0.97 0 0), oklch(0.82 0 0));
  box-shadow:
    0 1px 3px oklch(0 0 0 / 50%),
    inset 0 -1px 0 oklch(0 0 0 / 15%);
}
</style>
