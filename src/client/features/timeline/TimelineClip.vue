<script setup lang="ts">
import { AlertTriangle, Layers, Loader2, Shapes, Type } from '@lucide/vue'
import { flicksToSeconds } from '@shared/time/flicks'
import type { AssetDTO } from '@shared/types/assets'
import type { GenerationDTO } from '@shared/types/jobs'
import { type Clip, activeTake } from '@shared/types/project-doc'
import { computed } from 'vue'
import { dbToGain } from '@/engine/scene'
import { roleColor } from '@/lib/waveforms'
import { cn } from '@/lib/utils'
import ClipThumbs from './ClipThumbs.vue'
import ClipWave from './ClipWave.vue'
import MotionThumb from './MotionThumb.vue'
import { CLIP_LABEL_HEIGHT, PAD_X, audioBand, dbToPos } from './geometry'

const props = defineProps<{
  clip: Clip
  start: number
  end: number
  top: number
  height: number
  fps: number
  pxPerFrame: number
  selected: boolean
  asset?: AssetDTO
  job?: GenerationDTO
  viewLeft: number
  viewRight: number
  hanging?: boolean
}>()

const left = computed(() => PAD_X + props.start * props.pxPerFrame)
const width = computed(() => Math.max(1, (props.end - props.start) * props.pxPerFrame))
/** Trim handles on every clip: 6 px, or a third of a narrow clip each, so its middle still moves it. */
const edgeWidth = computed(() => Math.max(2, Math.min(6, Math.floor(width.value / 3))))
const visLeft = computed(() => Math.max(0, props.viewLeft - left.value))
const visWidth = computed(() => Math.max(0, Math.min(width.value, props.viewRight - left.value) - visLeft.value))

const take = computed(() => (props.clip.kind === 'media' ? activeTake(props.clip) : undefined))
const takes = computed(() => (props.clip.kind === 'media' ? props.clip.takes.length : 0))
const speed = computed(() => (props.clip.kind === 'media' ? props.clip.speed : 1))
const sourceStart = computed(() => flicksToSeconds(take.value?.sourceIn ?? 0))
const secondsPerPx = computed(() => speed.value / (props.fps * props.pxPerFrame))
const pending = computed(() => props.clip.kind === 'media' && !take.value?.assetId)
const failed = computed(() => props.job && ['failed', 'canceled', 'needs_attention'].includes(props.job.status))

const hasPicture = computed(() => props.clip.kind === 'media' && props.clip.video && props.asset && props.asset.kind !== 'audio')
const hasSound = computed(() => props.clip.kind === 'media' && props.clip.audio?.enabled && props.asset?.hasAudio && props.asset.variants.waveform)
const audioOnly = computed(() => props.clip.kind === 'media' && !props.clip.video)
const role = computed(() => (props.clip.kind === 'media' ? (props.clip.audio?.role ?? 'video') : props.clip.kind === 'title' || props.clip.kind === 'motion' ? 'titles' : 'video'))
const waveColor = computed(() => roleColor(role.value))
const gain = computed(() => (props.clip.kind === 'media' && props.clip.audio ? dbToGain(props.clip.audio.gainDb) : 1))

const labelH = CLIP_LABEL_HEIGHT
const audioProps = computed(() => (props.clip.kind === 'media' && props.clip.audio?.enabled ? props.clip.audio : undefined))
const band = computed(() => (audioProps.value ? audioBand(props.height, audioOnly.value) : undefined))
const waveH = computed(() => (band.value && hasSound.value ? band.value.height : 0))
const thumbsH = computed(() => Math.max(0, props.height - labelH - (band.value && !audioOnly.value ? band.value.height : 0)))

/** Volume line, keyframes and fade ramps inside the audio band (clip-local px). */
const volume = computed(() => {
  const a = audioProps.value
  const b = band.value
  if (!a || !b || width.value < 20) return undefined
  const h = b.height
  const ppf = props.pxPerFrame
  const y = (db: number) => Math.round((1 - dbToPos(db)) * (h - 4) + 2)
  const keys = [...(a.gainKeys ?? [])].sort((p, q) => p.frame - q.frame)
  const points = keys.length
    ? [[0, y(keys[0]!.value)], ...keys.map((k) => [k.frame * ppf, y(k.value)]), [width.value, y(keys.at(-1)!.value)]]
    : [
        [0, y(a.gainDb)],
        [width.value, y(a.gainDb)],
      ]
  const lineAt = (x: number) => {
    for (let i = 1; i < points.length; i++) {
      const [x1, y1] = points[i]! as [number, number]
      const [x0, y0] = points[i - 1]! as [number, number]
      if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / Math.max(1e-6, x1 - x0)
    }
    return (points.at(-1) as [number, number])[1]
  }
  const fadeInX = Math.min(width.value, a.fadeIn * ppf)
  const fadeOutX = Math.max(0, width.value - a.fadeOut * ppf)
  return {
    h,
    points: points.map((pt) => pt.join(',')).join(' '),
    keys: keys.map((k, i) => ({ x: k.frame * ppf, y: y(k.value), index: i })),
    fadeIn: { x: fadeInX, lineY: lineAt(fadeInX) },
    fadeOut: { x: fadeOutX, lineY: lineAt(fadeOutX) },
  }
})

/** Where the active take's media runs out (clip longer than its media) — drawn hatched. */
const tailFrom = computed(() => {
  const dur = props.asset?.durationFlicks
  if (!dur || props.asset?.kind === 'image') return undefined
  const usable = (flicksToSeconds(dur) - sourceStart.value) / speed.value
  const px = usable * props.fps * props.pxPerFrame
  return px < width.value - 1 ? Math.max(0, px) : undefined
})

/** Detected music beats inside the clip (clip-local px); downbeats are drawn taller. */
const beatMarks = computed(() => {
  const b = props.asset?.beats
  if (!b || props.clip.kind !== 'media' || !props.clip.audio?.enabled) return []
  const down = new Set(b.downbeats)
  const pxPerSecond = (props.fps * props.pxPerFrame) / speed.value
  if (pxPerSecond * (60 / Math.max(1, b.bpm)) < 4) return []
  return b.beats
    .map((t) => ({ x: (t - sourceStart.value) * pxPerSecond, down: down.has(t) }))
    .filter((m) => m.x >= 0 && m.x <= width.value)
})

/** Opacity/transform keyframes, drawn as small diamonds along the bottom of the picture. */
const videoKeys = computed(() => {
  const v = props.clip.kind !== 'gap' ? props.clip.video : undefined
  if (!v || width.value < 20) return []
  const frames = new Set([...(v.opacityKeys ?? []), ...(v.transformKeys ?? [])].map((k) => k.frame))
  return [...frames].map((f) => f * props.pxPerFrame).filter((x) => x <= width.value)
})

/** Clip body by role: a soft tint of the role colour (thumbnails / waveform sit on top); titles are near-solid. */
const tone = computed(() => {
  if (props.clip.kind === 'gap') return 'bg-foreground/[0.025] outline-1 -outline-offset-1 outline-dashed outline-foreground/15'
  if (props.clip.kind === 'title') return 'bg-role-titles/70'
  if (props.clip.kind === 'motion') return 'bg-role-motion/35'
  if (props.clip.kind === 'generator') return 'bg-foreground/15'
  if (pending.value) return 'bg-brand/20'
  if (audioOnly.value) {
    const base = role.value.split('.')[0]
    return base === 'music' ? 'bg-role-music/30' : base === 'effects' ? 'bg-role-effects/30' : 'bg-role-dialogue/30'
  }
  return 'bg-role-video/30'
})

/** The solid role colour of the small label pill at the clip's top-left. */
const pillTone = computed(() => {
  if (failed.value) return 'bg-destructive'
  if (props.clip.kind === 'title') return 'bg-role-titles'
  if (props.clip.kind === 'motion') return 'bg-role-motion'
  if (props.clip.kind === 'generator') return 'bg-foreground/45'
  if (pending.value) return 'bg-brand'
  if (audioOnly.value) {
    const base = role.value.split('.')[0]
    return base === 'music' ? 'bg-role-music' : base === 'effects' ? 'bg-role-effects' : 'bg-role-dialogue'
  }
  return 'bg-role-video'
})

const label = computed(() => {
  if (props.clip.kind === 'title') return props.clip.text || 'Title'
  if (props.clip.kind === 'gap') return ''
  return props.clip.name ?? props.asset?.name ?? take.value?.label ?? 'Clip'
})
</script>

<template>
  <div
    :data-clip-id="clip.id"
    :class="
      cn(
        // The transparent side borders leave a hairline gap between neighbouring clips (the box itself is unchanged).
        'group/clip absolute overflow-hidden rounded-[7px] border-x border-transparent bg-clip-padding text-[10px] select-none',
        tone,
        selected && 'z-10 ring-2 ring-selection',
        !clip.enabled && 'opacity-40 grayscale',
        hanging && 'ring-1 ring-destructive/80',
      )
    "
    :style="{ left: `${left}px`, width: `${width}px`, top: `${top}px`, height: `${height}px` }"
  >
    <template v-if="clip.kind === 'media' && asset && !pending">
      <ClipThumbs
        v-if="hasPicture && asset.variants.filmstrip && thumbsH > 8 && visWidth > 0"
        :asset="asset"
        :visible-left="visLeft"
        :visible-width="visWidth"
        :height="thumbsH"
        :source-start="sourceStart"
        :seconds-per-px="secondsPerPx"
        :style="{ top: `${labelH}px` }"
      />
      <img
        v-else-if="hasPicture && asset.kind === 'image' && asset.variants.poster"
        :src="`/media/${asset.id}/poster`"
        class="pointer-events-none absolute left-0 h-[calc(100%-16px)] opacity-90"
        :style="{ top: `${labelH}px`, height: `${thumbsH}px` }"
        alt=""
      />
      <ClipWave
        v-if="hasSound && waveH > 4 && visWidth > 0"
        :asset="asset"
        :visible-left="visLeft"
        :visible-width="visWidth"
        :top="band!.top"
        :height="waveH"
        :source-start="sourceStart"
        :seconds-per-px="secondsPerPx"
        :color="waveColor"
        :gain="gain"
      />
    </template>

    <!-- Label: a small solid pill in the role colour at the clip's top-left (name, take and speed chips). -->
    <div class="pointer-events-none relative flex h-4 items-center px-[3px] whitespace-nowrap" :style="{ maxWidth: `${width}px` }">
      <span
        v-if="label || pending || failed"
        :class="cn('flex h-[13px] max-w-full min-w-0 items-center gap-1 rounded-[4px] px-1.5 leading-none font-medium text-white shadow-[0_1px_2px_oklch(0_0_0/0.25)]', pillTone)"
      >
        <Type v-if="clip.kind === 'title'" class="size-2.5 shrink-0" />
        <Shapes v-if="clip.kind === 'motion'" class="size-2.5 shrink-0" />
        <Loader2 v-if="pending && !failed" class="size-2.5 shrink-0 animate-spin" />
        <AlertTriangle v-if="failed" class="size-2.5 shrink-0" />
        <span class="truncate">{{ label }}</span>
        <span v-if="takes > 1" class="flex shrink-0 items-center gap-0.5 rounded-[3px] bg-black/25 px-1">
          <Layers class="size-2.5" /> {{ (clip.kind === 'media' ? clip.active : 0) + 1 }}/{{ takes }}
        </span>
        <span v-if="speed !== 1" class="shrink-0 rounded-[3px] bg-black/25 px-1">{{ Math.round(speed * 100) }}%</span>
      </span>
    </div>

    <div v-if="pending" class="pointer-events-none absolute inset-x-0 top-4 bottom-0 hatched">
      <div v-if="job?.progress != null" class="absolute bottom-1 left-1.5 h-0.5 rounded-full bg-brand" :style="{ width: `${Math.max(4, (width - 12) * job.progress)}px` }" />
      <span v-if="failed" class="absolute bottom-1 left-1.5 truncate text-destructive">{{ job?.error?.message ?? 'Generation failed' }}</span>
    </div>
    <MotionThumb v-if="clip.kind === 'motion' && thumbsH > 8" :clip="clip" :height="thumbsH" :max-width="width" :style="{ top: `${labelH}px` }" />
    <div v-if="clip.kind === 'generator'" class="pointer-events-none absolute inset-x-1 top-4 bottom-1 rounded-[4px]" :style="{ background: clip.params.color }" />
    <div v-if="tailFrom !== undefined" class="pointer-events-none absolute top-0 bottom-0 right-0 hatched bg-destructive/15" :style="{ left: `${tailFrom}px` }" />

    <svg
      v-if="volume && band"
      class="pointer-events-none absolute left-0 overflow-visible"
      :style="{ top: `${band.top}px`, height: `${band.height}px` }"
      :width="width"
      :height="band.height"
    >
      <path
        v-if="volume.fadeIn.x > 0"
        :d="`M0,${volume.h} L${volume.fadeIn.x},${volume.fadeIn.lineY}`"
        class="stroke-white/50"
        stroke-width="1"
        stroke-dasharray="2 2"
        fill="none"
      />
      <path
        v-if="volume.fadeOut.x < width"
        :d="`M${width},${volume.h} L${volume.fadeOut.x},${volume.fadeOut.lineY}`"
        class="stroke-white/50"
        stroke-width="1"
        stroke-dasharray="2 2"
        fill="none"
      />
      <polyline :points="volume.points" fill="none" class="stroke-white/85" stroke-width="1.25" />
      <polyline data-volume="line" :points="volume.points" fill="none" stroke="transparent" stroke-width="9" pointer-events="stroke" class="cursor-ns-resize" />
      <rect
        v-for="k in volume.keys"
        :key="k.index"
        :data-key-index="k.index"
        :x="k.x - 3.5"
        :y="k.y - 3.5"
        width="7"
        height="7"
        :transform="`rotate(45 ${k.x} ${k.y})`"
        class="pointer-events-auto cursor-move fill-role-effects stroke-black/60"
      />
      <circle data-fade="in" :cx="Math.max(4, volume.fadeIn.x)" cy="4" r="3.5" class="pointer-events-auto cursor-ew-resize fill-white/90 stroke-black/50 opacity-0 group-hover/clip:opacity-100" />
      <circle data-fade="out" :cx="Math.min(width - 4, volume.fadeOut.x)" cy="4" r="3.5" class="pointer-events-auto cursor-ew-resize fill-white/90 stroke-black/50 opacity-0 group-hover/clip:opacity-100" />
    </svg>

    <div
      v-for="m in beatMarks"
      :key="`b${m.x}`"
      class="pointer-events-none absolute bottom-0 w-px bg-white/60"
      :class="m.down ? 'h-2.5' : 'h-1.5'"
      :style="{ left: `${m.x}px` }"
    />
    <div
      v-for="x in videoKeys"
      :key="x"
      class="pointer-events-none absolute size-[7px] rotate-45 border border-black/60 bg-role-effects"
      :style="{ left: `${x - 3.5}px`, top: `${Math.max(labelH + 2, thumbsH + labelH - 9)}px` }"
    />

    <template v-if="width >= 4">
      <div data-edge="start" class="absolute inset-y-0 left-0 cursor-ew-resize hover:bg-selection/60" :style="{ width: `${edgeWidth}px` }" />
      <div data-edge="end" class="absolute inset-y-0 right-0 cursor-ew-resize hover:bg-selection/60" :style="{ width: `${edgeWidth}px` }" />
    </template>
  </div>
</template>
