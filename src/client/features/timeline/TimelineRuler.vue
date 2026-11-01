<script setup lang="ts">
import { formatTimecode } from '@shared/time/timecode'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { resolvedTheme } from '@/lib/theme'
import { PAD_X, RULER_HEIGHT, tickSteps } from './geometry'

const props = defineProps<{
  pxPerFrame: number
  fps: number
  scrollLeft: number
  width: number
  duration: number
  markers: { id: string; frame: number; kind: string; name: string }[]
  rangeIn?: number
  rangeOut?: number
}>()

const canvas = ref<HTMLCanvasElement>()
let raf = 0

function label(frame: number, major: number) {
  const tc = formatTimecode(frame, props.fps)
  // Drop the hour field and, when majors are whole seconds, the frame field.
  const trimmed = tc.startsWith('00:') ? tc.slice(3) : tc
  return major % Math.round(props.fps) === 0 ? trimmed.slice(0, trimmed.lastIndexOf(':')) : trimmed
}

function draw() {
  const c = canvas.value
  if (!c) return
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(props.width * dpr))
  const h = Math.round(RULER_HEIGHT * dpr)
  if (c.width !== w) c.width = w
  if (c.height !== h) c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, props.width, RULER_HEIGHT)
  const css = getComputedStyle(document.documentElement)
  const fg = css.getPropertyValue('--muted-foreground').trim() || '#999'
  const ppf = props.pxPerFrame
  const { major, minor } = tickSteps(ppf, props.fps)
  const firstFrame = Math.max(0, Math.floor((props.scrollLeft - PAD_X) / ppf))
  const lastFrame = Math.ceil((props.scrollLeft + props.width - PAD_X) / ppf)

  // Content past the end is dimmed.
  const endX = PAD_X + props.duration * ppf - props.scrollLeft
  if (endX < props.width) {
    ctx.fillStyle = resolvedTheme.value === 'dark' ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.06)'
    ctx.fillRect(Math.max(0, endX), 0, props.width, RULER_HEIGHT)
  }
  if (props.rangeIn !== undefined || props.rangeOut !== undefined) {
    const a = PAD_X + (props.rangeIn ?? 0) * ppf - props.scrollLeft
    const b = PAD_X + (props.rangeOut ?? props.duration) * ppf - props.scrollLeft
    ctx.fillStyle = 'rgba(234, 179, 8, 0.25)'
    ctx.fillRect(a, RULER_HEIGHT - 6, Math.max(1, b - a), 6)
  }

  ctx.strokeStyle = fg
  ctx.fillStyle = fg
  // Quiet ruler: short hairline ticks along the bottom, small muted sans labels beside the major ticks.
  ctx.font = '500 10px Inter, ui-sans-serif, system-ui, -apple-system, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.28
  ctx.beginPath()
  for (let f = Math.floor(firstFrame / minor) * minor; f <= lastFrame; f += minor) {
    const x = Math.round(PAD_X + f * ppf - props.scrollLeft) + 0.5
    const isMajor = f % major === 0
    ctx.moveTo(x, RULER_HEIGHT)
    ctx.lineTo(x, RULER_HEIGHT - (isMajor ? 8 : 4))
  }
  ctx.stroke()
  ctx.globalAlpha = 0.75
  for (let f = Math.floor(firstFrame / major) * major; f <= lastFrame; f += major) {
    const x = Math.round(PAD_X + f * ppf - props.scrollLeft)
    ctx.fillText(label(f, major), x + 4, RULER_HEIGHT / 2 - 2)
  }
  ctx.globalAlpha = 1
  for (const m of props.markers) {
    const x = PAD_X + m.frame * ppf - props.scrollLeft
    if (x < -8 || x > props.width + 8) continue
    ctx.fillStyle = m.kind === 'todo' ? '#ef4444' : m.kind === 'chapter' ? '#f97316' : '#60a5fa'
    ctx.beginPath()
    ctx.moveTo(x - 4, RULER_HEIGHT - 12)
    ctx.lineTo(x + 4, RULER_HEIGHT - 12)
    ctx.lineTo(x + 4, RULER_HEIGHT - 5)
    ctx.lineTo(x, RULER_HEIGHT - 1)
    ctx.lineTo(x - 4, RULER_HEIGHT - 5)
    ctx.closePath()
    ctx.fill()
  }
}

function schedule() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(draw)
}

onMounted(schedule)
onBeforeUnmount(() => cancelAnimationFrame(raf))
// The tick colour comes from the theme (macOS can switch it while the editor is open with "System").
watch(() => [props.pxPerFrame, props.fps, props.scrollLeft, props.width, props.duration, props.markers, props.rangeIn, props.rangeOut, resolvedTheme.value], schedule)
</script>

<template>
  <canvas ref="canvas" class="block" :style="{ width: `${width}px`, height: `${RULER_HEIGHT}px` }" />
</template>
