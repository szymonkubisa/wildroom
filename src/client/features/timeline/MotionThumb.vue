<script lang="ts">
import { ImageCache } from '@/engine/videoPool'

// One picture cache for every motion thumbnail; each loaded picture redraws the thumbnails waiting on it.
const redraws = new Set<() => void>()
const pictures = new ImageCache(() => {
  for (const redraw of redraws) redraw()
})
</script>

<script setup lang="ts">
import { motionSource, staticView } from '@shared/motion/evaluate'
import type { MotionClip } from '@shared/types/project-doc'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { type ItemSource, drawItems, fillRectWith, stillUrls } from '@/engine/canvasDraw'
import { useAssetsStore } from '@/stores/assets'
import { useProjectStore } from '@/stores/project'

/** The motion clip's frame as the board lays it out, drawn once at the clip's left edge (like an image clip's poster). */
const props = defineProps<{ clip: MotionClip; height: number; maxWidth: number }>()

const project = useProjectStore()
const assets = useAssetsStore()
const el = ref<HTMLCanvasElement>()
const source = computed(() => motionSource(props.clip, project.doc.canvas))
const width = computed(() => {
  const f = source.value.frame
  return f ? Math.max(1, Math.min(props.maxWidth, Math.round((props.height * f.w) / f.h))) : 0
})

function picture(assetId: string | undefined): ItemSource | undefined {
  const a = assetId ? assets.get(assetId) : undefined
  if (!a || a.kind === 'audio') return undefined
  // Posters are small: enough for a thumbnail, and every video has one.
  const urls = a.variants.poster ? [`/media/${a.id}/poster`] : stillUrls(a)
  const bmp = pictures.get(`thumb:${a.id}`, urls)
  return bmp && { image: bmp, width: bmp.width, height: bmp.height }
}

function draw() {
  const canvas = el.value
  const { frame, items } = source.value
  if (!canvas || !frame) return
  const dpr = window.devicePixelRatio || 1
  const h = props.height
  const w = Math.round((h * frame.w) / frame.h)
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const s = (h * dpr) / frame.h
  ctx.setTransform(s, 0, 0, s, 0, 0)
  if (frame.fill) fillRectWith(ctx, frame.fill, { x: 0, y: 0, w: frame.w, h: frame.h })
  drawItems(ctx, staticView(frame, items), (item) => picture(item.assetId))
}

watch([source, () => props.height], draw, { flush: 'post' })
onMounted(() => {
  redraws.add(draw)
  draw()
})
onBeforeUnmount(() => redraws.delete(draw))
</script>

<template>
  <div v-if="source.frame" class="pointer-events-none absolute left-0 overflow-hidden opacity-90" :style="{ width: `${width}px`, height: `${height}px` }">
    <canvas ref="el" class="h-full" />
  </div>
</template>
