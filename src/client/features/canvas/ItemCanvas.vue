<script setup lang="ts">
import type { ResolvedItem } from '@shared/motion/evaluate'
import type { CanvasAssetItem, CanvasShapeItem, CanvasTextItem } from '@shared/types/canvas'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ancestorGroups } from '@shared/canvas/groups'
import { type MotionItem, isMotionItem } from '@shared/motion/evaluate'
import { type ItemSource, applyMask, drawItem, itemOverhang, textBlock, textFonts } from '@/engine/canvasDraw'
import { useCanvasStore } from '@/stores/canvas'

/**
 * A board element drawn by the same Canvas2D code as the PNG export and the video (`canvasDraw`), so what the board
 * shows is what renders. The pixel density follows the zoom in powers of two: zooming redraws only when it crosses one.
 */
const props = defineProps<{
  item: CanvasTextItem | CanvasShapeItem | CanvasAssetItem
  zoom: number
  picture?: ItemSource
  /** In animation mode: the element as the clip has it at the playhead (reveal, colour, blur…); place and turn are CSS. */
  anim?: ResolvedItem
}>()

/** Board units per canvas side are capped, so a huge element zoomed in doesn't take hundreds of MB. */
const MAX_PIXELS = 4_000_000

const el = ref<HTMLCanvasElement>()
// Fonts that finish loading change how text measures and draws.
const fontsVersion = ref(0)
let measureCtx: OffscreenCanvasRenderingContext2D | null = null
const measure = () => (measureCtx ??= new OffscreenCanvas(1, 1).getContext('2d'))

const density = computed(() => {
  const s = props.zoom * (window.devicePixelRatio || 1)
  return Math.min(4, Math.max(1 / 8, 2 ** Math.ceil(Math.log2(Math.max(s, 1e-3)))))
})

/** A stroke is centred on the outline: half of it (and line caps) fall outside the box; so do text effects and italics. */
const pad = computed(() => {
  const it = props.item
  if (it.kind === 'asset') return (it.stroke ? Math.ceil(it.stroke.width) + 1 : 0) + itemOverhang(it) + Math.ceil((props.anim?.blur ?? 0) * 2)
  const blur = Math.ceil((props.anim?.blur ?? 0) * 2)
  if (it.kind === 'text') return itemOverhang(it) + Math.ceil(it.fontSize * 0.15) + blur
  const width = it.stroke?.width ?? (['line', 'polyline', 'arc'].includes(it.shape) ? Math.max(2, Math.min(it.w, it.h) * 0.03) : 0)
  return Math.ceil(width) + 1 + itemOverhang(it) + Math.ceil((props.anim?.blur ?? 0) * 2)
})

/** Text runs past a box that's too short (as it did in the DOM); shapes fill theirs. */
const height = computed(() => {
  void fontsVersion.value
  const it = props.item
  const ctx = it.kind === 'text' ? measure() : null
  return ctx && it.kind === 'text' ? Math.max(it.h, textBlock(ctx, it).height) : it.h
})

function draw() {
  const canvas = el.value
  const it = props.item
  if (!canvas) return
  const h = height.value
  const p = pad.value
  const s = Math.min(density.value, Math.sqrt(MAX_PIXELS / Math.max(1, (it.w + 2 * p) * (h + 2 * p))))
  canvas.width = Math.max(1, Math.ceil((it.w + 2 * p) * s))
  canvas.height = Math.max(1, Math.ceil((h + 2 * p) * s))
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(s, 0, 0, s, p * s, p * s)
  ctx.clearRect(-p, -p, it.w + 2 * p, h + 2 * p)
  const a = props.anim
  const resolved: ResolvedItem = {
    item: a?.item ?? it,
    rect: { x: 0, y: 0, w: it.w, h: it.h },
    scale: 1,
    rotation: 0,
    opacity: 1,
    reveal: a?.reveal ?? 1,
    revealMode: a?.revealMode,
    rollFrom: a?.rollFrom,
    trim: a?.trim,
    blur: a?.blur,
  }
  drawItem(ctx, resolved, () => props.picture)
  const clip = clipping.value
  if (clip) {
    // The element is turned and scaled by CSS around its centre: the mask is drawn through the inverse, so it stays
    // where it is (in animation mode, where the clip has it) while the element moves under it.
    const e = clip.element
    ctx.save()
    ctx.translate(it.w / 2, it.h / 2)
    ctx.scale(1 / e.sx, 1 / e.sy)
    ctx.rotate((-e.rotation * Math.PI) / 180)
    ctx.translate(-e.cx, -e.cy)
    applyMask(ctx, clip.masks, clip.invert, maskPicture)
    ctx.restore()
  }
}

/**
 * The mask the element is clipped by (its own, else its group's) and where the element is, in one space: on the board
 * relative to the element's box; in animation mode the clip's frame at the playhead, masks and element as it has them.
 */
const clipping = computed(() => {
  const it = props.item
  const board = useCanvasStore()
  const clipper = [it, ...ancestorGroups(board.byId, it)].find((i) => i.clipBy && board.byId.has(i.clipBy))
  if (!clipper) return undefined
  const by = clipper.clipBy!
  const invert = Boolean(clipper.clipInvert)
  const view = board.animView
  const a = props.anim
  if (a && view) {
    const masks = view.view.items.filter((r) => r.item.id === by || r.groupIds?.includes(by)).map((r) => ({ ...r, matte: false, trail: undefined }))
    const element = { cx: a.rect.x + it.w / 2, cy: a.rect.y + it.h / 2, rotation: a.rotation, sx: a.scale * (a.stretch?.x ?? 1), sy: a.scale * (a.stretch?.y ?? 1) }
    return masks.length ? { masks, invert, element } : undefined
  }
  const masks: ResolvedItem[] = board.items
    .filter((m): m is MotionItem => isMotionItem(m) && (m.id === by || ancestorGroups(board.byId, m).some((g) => g.id === by)))
    .map((m) => ({ item: m, rect: { x: m.x - it.x, y: m.y - it.y, w: m.w, h: m.h }, scale: 1, rotation: m.rotation ?? 0, opacity: 1, reveal: 1 }))
  const element = { cx: it.w / 2, cy: it.h / 2, rotation: it.rotation ?? 0, sx: 1, sy: 1 }
  return masks.length ? { masks, invert, element } : undefined
})

/**
 * A picture used as a mask, loaded for the board as the export has it (display, else poster, else original); the
 * element redraws when it arrives. Without it a picture mask would be empty and wipe the element.
 */
const maskPictures = new Map<string, ItemSource | null>()
const masksLoaded = ref(0)
function maskPicture(item: CanvasAssetItem): ItemSource | undefined {
  const id = item.assetId
  if (!id) return undefined
  const hit = maskPictures.get(id)
  if (hit !== undefined) return hit ?? undefined
  maskPictures.set(id, null)
  const urls = ['display', 'poster', 'original'].map((v) => `/media/${id}/${v}`)
  const img = new Image()
  img.decoding = 'async'
  img.onload = () => {
    maskPictures.set(id, { image: img, width: img.naturalWidth, height: img.naturalHeight })
    masksLoaded.value++
  }
  img.onerror = () => {
    const next = urls[urls.indexOf(new URL(img.src).pathname) + 1]
    if (next) img.src = next
  }
  img.src = urls[0]!
  return undefined
}

const onFonts = () => fontsVersion.value++
watch([() => props.item, density, height, pad, () => props.picture, clipping, () => props.anim, masksLoaded], draw, { flush: 'post' })
onMounted(() => {
  draw()
  document.fonts.addEventListener('loadingdone', onFonts)
  if (props.item.kind === 'text') void Promise.all(textFonts(props.item).map((f) => document.fonts.load(f))).then(onFonts, () => {})
})
onBeforeUnmount(() => document.fonts.removeEventListener('loadingdone', onFonts))
</script>

<template>
  <canvas
    ref="el"
    class="pointer-events-none relative block max-w-none select-none"
    :style="{ left: `${-pad}px`, top: `${-pad}px`, width: `calc(100% + ${2 * pad}px)`, height: `${height + 2 * pad}px` }"
  />
</template>
