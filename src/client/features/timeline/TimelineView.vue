<script setup lang="ts">
import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpFromLine,
  AudioLines,
  Blend,
  Bookmark,
  ClipboardPaste,
  Columns2,
  Copy,
  CopyPlus,
  Eye,
  EyeOff,
  FastForward,
  ImageUpscale,
  Layers,
  MoveHorizontal,
  Scissors,
  ScissorsLineDashed,
  Sparkles,
  SquareDashed,
  Trash2,
  Type,
  Wand2,
  Wrench,
} from '@lucide/vue'
import { canExtendWithVeo } from '@shared/models/catalog/fal'
import * as ops from '@shared/timeline'
import { flicksToSeconds, framesToFlicks } from '@shared/time/flicks'
import type { AssetDTO } from '@shared/types/assets'
import { type Clip, type Keyframe, activeTake } from '@shared/types/project-doc'
import { useResizeObserver } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { playheadBus } from '@/engine/playhead'
import { ASSET_DRAG_TYPE, AUDIO_DRAG_TYPE, readAssetDrag } from '@/features/assets/drag'
import { transport } from '@/features/editor/transport'
import { useAssetsStore } from '@/stores/assets'
import { useEditorStore } from '@/stores/editor'
import { useJobsStore } from '@/stores/jobs'
import { useProjectStore } from '@/stores/project'
import { useTimelineCommands } from './commands'
import { useSplitShots } from './splitShots'
import { useClipTools } from '@/features/tools/useClipTools'
import {
  MAX_DB,
  MAX_ZOOM,
  MIN_DB,
  MIN_ZOOM,
  PAD_X,
  RULER_HEIGHT,
  type Row,
  buildRows,
  frameToX,
  laneSpan,
  rowAtY,
  xToFrame,
} from './geometry'
import TimelineClip from './TimelineClip.vue'
import TimelineRuler from './TimelineRuler.vue'

const project = useProjectStore()
const editor = useEditorStore()
const assets = useAssetsStore()
const jobs = useJobsStore()
const commands = useTimelineCommands()
const { splitIntoShots } = useSplitShots()
const clipTools = useClipTools()

const scroller = ref<HTMLDivElement>()
const content = ref<HTMLDivElement>()
const playheadLine = ref<HTMLDivElement>()
const playheadHead = ref<HTMLDivElement>()
const scrollLeft = ref(0)
const viewportWidth = ref(800)

const ppf = computed(() => editor.pxPerFrame)
const fps = computed(() => project.doc.settings.fps)
const layout = computed(() => project.layout)
/** While a clip is dragged the lanes stay as they were when it was picked up (see buildRows). */
const frozenLanes = computed(() => (drag.value?.kind === 'move' ? laneSpan(drag.value.base) : undefined))
const rowsInfo = computed(() => buildRows(layout.value, frozenLanes.value))
const rows = computed(() => rowsInfo.value.rows)
const rowByLane = computed(() => new Map(rows.value.map((r) => [r.lane, r])))
const spineRow = computed(() => rowByLane.value.get(0)!)
const contentWidth = computed(() => Math.max(viewportWidth.value, frameToX(layout.value.duration, ppf.value) + viewportWidth.value * 0.6))

interface ViewItem {
  id: string
  clip: Clip
  start: number
  end: number
  lane: number
  spine: boolean
  hanging: boolean
  overlapOut: number
}

const items = computed<ViewItem[]>(() => [
  ...layout.value.spine.map((s) => ({ id: s.id, clip: s.item, start: s.start, end: s.end, lane: 0, spine: true, hanging: false, overlapOut: s.overlapOut })),
  ...layout.value.connected.map((c) => ({
    id: c.id,
    clip: c.item.clip,
    start: c.start,
    end: c.end,
    lane: c.lane,
    spine: false,
    hanging: c.hanging,
    overlapOut: 0,
  })),
])

const viewLeft = computed(() => scrollLeft.value)
const viewRight = computed(() => scrollLeft.value + viewportWidth.value)
const visibleItems = computed(() =>
  items.value.filter((i) => frameToX(i.end, ppf.value) >= viewLeft.value - 300 && frameToX(i.start, ppf.value) <= viewRight.value + 300),
)
const selected = computed(() => new Set(editor.selection))

function rowFor(item: ViewItem): Row {
  return rowByLane.value.get(item.lane) ?? spineRow.value
}

function assetFor(clip: Clip) {
  return clip.kind === 'media' ? assets.get(activeTake(clip)?.assetId) : undefined
}

function jobFor(clip: Clip) {
  const gen = clip.kind === 'media' ? activeTake(clip)?.generationId : undefined
  return gen ? jobs.byId[gen] : undefined
}

// ---------------------------------------------------------------- playhead + scrolling

function positionPlayhead(frame: number) {
  const x = frameToX(frame, ppf.value)
  if (playheadLine.value) playheadLine.value.style.transform = `translateX(${x}px)`
  if (playheadHead.value) playheadHead.value.style.transform = `translateX(${x - scrollLeft.value}px)`
  // Page the view while playing so the playhead stays visible.
  const el = scroller.value
  if (el && editor.playing && (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft)) {
    el.scrollLeft = Math.max(0, x - 80)
  }
}

let unsubscribe: (() => void) | undefined
onMounted(() => {
  unsubscribe = playheadBus.subscribe((frame) => {
    positionPlayhead(frame)
    // The viewer now shows the playhead, not the skimmed frame (see Player.seek): the skimmer waits for the pointer.
    if (!drag.value) skimX.value = undefined
  })
})
onBeforeUnmount(() => unsubscribe?.())
watch([ppf, scrollLeft], () => positionPlayhead(playheadBus.frame))

useResizeObserver(scroller, () => {
  viewportWidth.value = scroller.value?.clientWidth ?? 800
})

function onScroll() {
  scrollLeft.value = scroller.value?.scrollLeft ?? 0
}

function setZoom(next: number, anchorClientX?: number) {
  const el = scroller.value
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
  if (!el) {
    editor.pxPerFrame = clamped
    return
  }
  const rect = el.getBoundingClientRect()
  const anchorX = anchorClientX !== undefined ? anchorClientX - rect.left : frameToX(playheadBus.frame, ppf.value) - el.scrollLeft
  const frameAtAnchor = (el.scrollLeft + anchorX - PAD_X) / ppf.value
  editor.pxPerFrame = clamped
  requestAnimationFrame(() => {
    el.scrollLeft = Math.max(0, PAD_X + frameAtAnchor * clamped - anchorX)
  })
}

function zoomToFit() {
  const frames = Math.max(fps.value * 5, layout.value.duration)
  // On mount this runs before the resize observer has reported the real width (it was fitted to 800 px).
  const width = scroller.value?.clientWidth || viewportWidth.value
  setZoom((width - PAD_X * 2 - 40) / frames)
  requestAnimationFrame(() => scroller.value && (scroller.value.scrollLeft = 0))
}

function onWheel(e: WheelEvent) {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    setZoom(ppf.value * Math.exp(-e.deltaY * 0.01), e.clientX)
  }
}

defineExpose({ setZoom, zoomToFit, zoomBy: (factor: number) => setZoom(ppf.value * factor) })

// ---------------------------------------------------------------- coordinates & snapping

function localPoint(e: { clientX: number; clientY: number }) {
  const rect = content.value!.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

const snapLine = ref<number>()

/** Timeline frames of detected beats in enabled music/audio clips (they attract like edit points). */
const beatFrames = computed(() => {
  const out: number[] = []
  for (const i of items.value) {
    if (i.clip.kind !== 'media' || !i.clip.audio?.enabled || i.hanging) continue
    const beats = assetFor(i.clip)?.beats?.beats
    if (!beats) continue
    const src = flicksToSeconds(activeTake(i.clip)?.sourceIn ?? 0)
    for (const b of beats) {
      const f = Math.round(i.start + ((b - src) / i.clip.speed) * fps.value)
      if (f >= i.start && f < i.end) out.push(f)
    }
  }
  return out
})

function snap(frame: number, base: ops.TimelineLayout, exclude: Set<string>): number {
  if (!editor.snapping) {
    snapLine.value = undefined
    return frame
  }
  const points = ops.collectSnapPoints(base, { playhead: editor.playhead, exclude, extra: beatFrames.value })
  const res = ops.snapFrame(frame, points, Math.max(1, Math.round(8 / ppf.value)))
  snapLine.value = res.snapped ? res.frame : undefined
  return res.frame
}

/** Nearest boundary of the primary storyline (for magnetic inserts/reorders). */
function nearestSpineBoundary(frame: number, base: ops.TimelineLayout, exclude?: string): number {
  const points = [0]
  for (const s of base.spine) if (s.id !== exclude) points.push(s.start, s.end)
  return points.reduce((best, p) => (Math.abs(p - frame) < Math.abs(best - frame) ? p : best), points[0]!)
}

// ---------------------------------------------------------------- pointer interactions

type Drag =
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; additive: boolean; before: string[] }
  | { kind: 'trim'; id: string; edge: 'start' | 'end'; x0: number; start: number; end: number; base: ops.TimelineLayout; moved: boolean; extend?: number }
  | { kind: 'roll'; leftId: string; x0: number; cut: number; base: ops.TimelineLayout; moved: boolean }
  | { kind: 'slip'; id: string; x0: number; speed: number; moved: boolean }
  | { kind: 'slide'; id: string; x0: number; moved: boolean }
  | { kind: 'move'; id: string; spine: boolean; x0: number; y0: number; start: number; end: number; lane: number; audioOnly: boolean; grab: number; base: ops.TimelineLayout; moved: boolean }
  | { kind: 'gain'; id: string; y0: number; startDb: number; keys?: Keyframe<number>[]; moved: boolean }
  | { kind: 'fade'; id: string; which: 'in' | 'out'; clipLeft: number; frames: number; other: number; moved: boolean }
  | { kind: 'gainKey'; id: string; index: number; clipLeft: number; frames: number; y0: number; startValue: number; keys: Keyframe<number>[]; moved: boolean }

const drag = ref<Drag>()
const skimX = ref<number>()

function findItem(id: string) {
  return items.value.find((i) => i.id === id)
}

/** Pointer capture can throw when the pointer is already gone; dragging still works without it. */
function capture(e: PointerEvent) {
  try {
    content.value?.setPointerCapture(e.pointerId)
  } catch {
    // ignore
  }
}

/** Floating value label while dragging volume/fades. */
const dragInfo = ref<{ x: number; y: number; text: string }>()

/** FCP-like relative sensitivity: 0.5 dB per pixel, ⇧ for 0.1 dB fine control (independent of band height). */
const dbPerPx = (e: { shiftKey: boolean }) => (e.shiftKey ? 0.1 : 0.5)
const clampDb = (db: number) => Math.max(MIN_DB, Math.min(MAX_DB, Math.round(db * 2) / 2))
const fmtDb = (db: number) => (db <= MIN_DB ? '−∞ dB' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`)

/** Volume line, keyframes and fade handles inside a clip's audio band. Returns true when handled. */
function startVolumeDrag(e: PointerEvent, target: Element, pt: { x: number; y: number }): boolean {
  const fadeEl = target.closest('[data-fade]')
  const keyEl = target.closest('[data-key-index]')
  const lineEl = target.closest('[data-volume]')
  if (!fadeEl && !keyEl && !lineEl) return false
  const clipEl = target.closest('[data-clip-id]') as HTMLElement | null
  const item = clipEl ? findItem(clipEl.dataset.clipId!) : undefined
  if (!item || item.clip.kind !== 'media' || !item.clip.audio) return false
  const audio = item.clip.audio
  editor.select([item.id])
  const clipLeft = frameToX(item.start, ppf.value)
  const frames = item.end - item.start
  if (fadeEl) {
    const which = (fadeEl as SVGElement).dataset.fade as 'in' | 'out'
    drag.value = { kind: 'fade', id: item.id, which, clipLeft, frames, other: which === 'in' ? audio.fadeOut : audio.fadeIn, moved: false }
  } else if (keyEl) {
    const index = Number((keyEl as SVGElement).dataset.keyIndex)
    const keys = ops.sortKeys(audio.gainKeys)
    drag.value = { kind: 'gainKey', id: item.id, index, clipLeft, frames, y0: pt.y, startValue: keys[index]?.value ?? 0, keys, moved: false }
  } else if (e.altKey) {
    // ⌥-click on the line adds a keyframe at that point with the current level.
    const frame = Math.max(0, Math.min(frames, Math.round((pt.x - clipLeft) / ppf.value)))
    const keys = ops.sortKeys(audio.gainKeys)
    const gainKeys = ops.upsertKey(keys, frame, ops.keyframeValue(keys, frame, audio.gainDb))
    project.apply(ops.setProps(item.id, { audio: { gainKeys } }), 'Add volume keyframe')
    return true
  } else {
    drag.value = { kind: 'gain', id: item.id, y0: pt.y, startDb: audio.gainDb, keys: audio.gainKeys?.length ? ops.sortKeys(audio.gainKeys) : undefined, moved: false }
  }
  capture(e)
  return true
}

function moveVolumeDrag(d: Extract<Drag, { kind: 'gain' | 'fade' | 'gainKey' }>, pt: { x: number; y: number }, e: PointerEvent) {
  if (!d.moved) {
    d.moved = true
    project.beginDrag(d.kind === 'fade' ? 'Fade' : 'Volume')
  }
  if (d.kind === 'gain') {
    const delta = -(pt.y - d.y0) * dbPerPx(e)
    if (d.keys) {
      const keys = d.keys.map((k) => ({ ...k, value: clampDb(k.value + delta) }))
      project.previewDrag(ops.setProps(d.id, { audio: { gainKeys: keys } }))
      dragInfo.value = { x: pt.x, y: pt.y, text: `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} dB` }
    } else {
      const db = clampDb(d.startDb + delta)
      project.previewDrag(ops.setProps(d.id, { audio: { gainDb: db } }))
      dragInfo.value = { x: pt.x, y: pt.y, text: fmtDb(db) }
    }
  } else if (d.kind === 'fade') {
    const local = (pt.x - d.clipLeft) / ppf.value
    const raw = d.which === 'in' ? local : d.frames - local
    const frames = Math.max(0, Math.min(Math.round(raw), d.frames - d.other))
    project.previewDrag(ops.setProps(d.id, { audio: d.which === 'in' ? { fadeIn: frames } : { fadeOut: frames } }))
    dragInfo.value = { x: pt.x, y: pt.y, text: `Fade ${d.which}: ${(frames / fps.value).toFixed(2)} s` }
  } else {
    const prev = d.keys[d.index - 1]
    const next = d.keys[d.index + 1]
    const frame = Math.max(prev ? prev.frame + 1 : 0, Math.min(next ? next.frame - 1 : d.frames, Math.round((pt.x - d.clipLeft) / ppf.value)))
    const value = clampDb(d.startValue - (pt.y - d.y0) * dbPerPx(e))
    const keys = d.keys.map((k, i) => (i === d.index ? { frame, value } : k))
    project.previewDrag(ops.setProps(d.id, { audio: { gainKeys: keys } }))
    dragInfo.value = { x: pt.x, y: pt.y, text: fmtDb(value) }
  }
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0 || !content.value) return
  const target = e.target as HTMLElement
  // The Blade tool cuts wherever it clicks, the volume line included.
  if (editor.tool !== 'blade' && startVolumeDrag(e, target, localPoint(e))) return
  const pt = localPoint(e)
  const frame = xToFrame(pt.x, ppf.value)
  editor.focus = 'timeline'
  editor.previewAssetId = undefined
  const transitionEl = target.closest('[data-transition]') as HTMLElement | null
  if (transitionEl) {
    // The clip stays selected for its transition settings in the Inspector; Delete removes only the transition.
    const id = transitionEl.dataset.transition!
    editor.select([id])
    editor.selectedTransition = id
    return
  }
  const clipEl = target.closest('[data-clip-id]') as HTMLElement | null
  capture(e)
  if (!clipEl) {
    transport.seek(frame)
    const additive = e.metaKey || e.shiftKey
    if (!additive) editor.select([])
    drag.value = { kind: 'marquee', x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, additive, before: [...editor.selection] }
    return
  }
  const id = clipEl.dataset.clipId!
  const item = findItem(id)
  if (!item) return
  if (editor.tool === 'blade') {
    project.apply(ops.blade(id, snap(frame, layout.value, new Set())), 'Blade')
    snapLine.value = undefined
    return
  }
  if (e.metaKey || e.shiftKey) editor.toggleSelect(id)
  else if (!selected.value.has(id)) editor.select([id])
  const edge = (target.closest('[data-edge]') as HTMLElement | null)?.dataset.edge as 'start' | 'end' | undefined
  const base = layout.value
  if (edge) {
    if (editor.tool === 'trim' && item.spine) {
      const index = base.spine.findIndex((s) => s.id === id)
      const left = edge === 'end' ? base.spine[index] : base.spine[index - 1]
      if (left && base.spine[base.spine.indexOf(left) + 1]) {
        drag.value = { kind: 'roll', leftId: left.id, x0: pt.x, cut: left.end - left.overlapOut, base, moved: false }
        return
      }
    }
    drag.value = { kind: 'trim', id, edge, x0: pt.x, start: item.start, end: item.end, base, moved: false }
    return
  }
  if (editor.tool === 'trim' && e.altKey && item.spine) {
    drag.value = { kind: 'slide', id, x0: pt.x, moved: false }
    return
  }
  if (editor.tool === 'trim' && item.clip.kind === 'media') {
    drag.value = { kind: 'slip', id, x0: pt.x, speed: item.clip.speed, moved: false }
    return
  }
  drag.value = {
    kind: 'move',
    id,
    spine: item.spine,
    x0: pt.x,
    y0: pt.y,
    start: item.start,
    end: item.end,
    lane: item.lane,
    audioOnly: item.clip.kind === 'media' && !item.clip.video,
    grab: frame - item.start,
    base,
    moved: false,
  }
}

function onPointerMove(e: PointerEvent) {
  if (!content.value) return
  const pt = localPoint(e)
  const d = drag.value
  if (!d) {
    if (editor.skimming && !editor.playing) {
      skimX.value = pt.x
      transport.skim(xToFrame(pt.x, ppf.value))
    }
    return
  }
  if (d.kind === 'gain' || d.kind === 'fade' || d.kind === 'gainKey') {
    moveVolumeDrag(d, pt, e)
    return
  }
  if (d.kind === 'marquee') {
    d.x1 = pt.x
    d.y1 = pt.y
    const f0 = xToFrame(Math.min(d.x0, d.x1), ppf.value)
    const f1 = xToFrame(Math.max(d.x0, d.x1), ppf.value)
    const y0 = Math.min(d.y0, d.y1)
    const y1 = Math.max(d.y0, d.y1)
    if (Math.abs(d.x1 - d.x0) < 3 && Math.abs(d.y1 - d.y0) < 3) return
    const hits = items.value
      .filter((i) => i.clip.kind !== 'gap' && i.end > f0 && i.start < f1)
      .filter((i) => {
        const r = rowFor(i)
        return r.top < y1 && r.top + r.height > y0
      })
      .map((i) => i.id)
    editor.select(d.additive ? [...new Set([...d.before, ...hits])] : hits)
    return
  }
  const dx = pt.x - d.x0
  if (!d.moved) {
    const dy = d.kind === 'move' ? pt.y - d.y0 : 0
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return
    d.moved = true
    project.beginDrag({ trim: 'Trim', roll: 'Roll', slip: 'Slip', slide: 'Slide', move: 'Move' }[d.kind])
  }
  const delta = Math.round(dx / ppf.value)
  switch (d.kind) {
    case 'trim': {
      const original = d.edge === 'start' ? d.start : d.end
      const target = snap(original + delta, d.base, new Set([d.id]))
      project.previewDrag(ops.trimEdge(d.id, d.edge, target - original))
      // Dragging a video clip's end past its media offers a generated continuation (generative extend).
      d.extend = undefined
      const now = project.layout.byId.get(d.id)
      // How much longer or shorter it got, and when the hidden media has run out. On the storyline a start trim
      // keeps the clip's start and pushes what follows (ripple), so the edge itself doesn't follow the pointer.
      if (now && now.type !== 'marker') {
        const asked = d.edge === 'start' ? original - target : target - original
        const got = now.end - now.start - (d.end - d.start)
        const sign = got > 0 ? '+' : got < 0 ? '−' : '±'
        const limit = asked > got && asked > 0 ? ` · ${d.edge === 'start' ? 'start' : 'end'} of the media` : ''
        dragInfo.value = { x: pt.x, y: pt.y, text: `${sign}${(Math.abs(got) / fps.value).toFixed(2)} s${limit}` }
      }
      const clip = findItem(d.id)?.clip
      if (d.edge === 'end' && now && now.type !== 'marker' && clip?.kind === 'media' && assetFor(clip)?.kind === 'video') {
        const missing = target - now.end
        if (missing >= Math.round(fps.value / 2)) {
          d.extend = missing
          dragInfo.value = { x: pt.x, y: pt.y, text: `Release to generate +${(missing / fps.value).toFixed(1)} s` }
        }
      }
      break
    }
    case 'roll': {
      const target = snap(d.cut + delta, d.base, new Set([d.leftId]))
      project.previewDrag(ops.roll(d.leftId, target - d.cut))
      break
    }
    case 'slip':
      project.previewDrag(ops.slip(d.id, -framesToFlicks(delta * d.speed, fps.value)))
      break
    case 'slide':
      project.previewDrag(ops.slide(d.id, delta))
      break
    case 'move': {
      // The row under the pointer: the storyline, or a lane above or below it (Final Cut's connected clips). An
      // audio-only clip can't go above the storyline.
      const row = rowAtY(rows.value, pt.y)
      let lane = row ? row.lane : d.lane
      if (d.audioOnly && lane > 0) lane = d.lane
      if (lane === 0) {
        // Into (or along) the storyline: dropped at a clip boundary, the rest pushed along.
        const target = nearestSpineBoundary(xToFrame(pt.x, ppf.value), d.base, d.id)
        snapLine.value = target
        project.previewDrag(ops.moveAcross(d.id, target, 0))
      } else {
        // On a lane: anywhere, snapped by either edge; a storyline clip leaves it and the storyline closes up.
        snapLine.value = undefined
        let start = d.start + delta
        const snappedStart = snap(start, d.base, new Set([d.id]))
        if (snappedStart !== start) start = snappedStart
        else {
          const snappedEnd = snap(d.end + delta, d.base, new Set([d.id]))
          start = snappedEnd - (d.end - d.start)
        }
        project.previewDrag(ops.moveAcross(d.id, Math.max(0, start), lane))
      }
      break
    }
  }
}

function onPointerUp(e: PointerEvent) {
  try {
    content.value?.releasePointerCapture?.(e.pointerId)
  } catch {
    // ignore
  }
  const d = drag.value
  drag.value = undefined
  snapLine.value = undefined
  dragInfo.value = undefined
  if (d && d.kind !== 'marquee' && d.moved) project.commitDrag()
  if (d?.kind === 'trim' && d.extend) void clipTools.extendClip(d.id, d.extend / fps.value)
}

/** The browser took the pointer away mid-drag (a system gesture, a touch turned scroll): back out of the edit. */
function onPointerCancel() {
  const d = drag.value
  drag.value = undefined
  snapLine.value = undefined
  dragInfo.value = undefined
  if (d && d.kind !== 'marquee' && d.moved) project.cancelDrag()
}

function onPointerLeave() {
  skimX.value = undefined
  if (!drag.value) transport.skim(undefined)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && drag.value) {
    project.cancelDrag()
    drag.value = undefined
    snapLine.value = undefined
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))

function onDoubleClick(e: MouseEvent) {
  const keyEl = (e.target as Element).closest('[data-key-index]') as SVGElement | null
  if (keyEl) {
    const clipEl = keyEl.closest('[data-clip-id]') as HTMLElement | null
    const item = clipEl ? findItem(clipEl.dataset.clipId!) : undefined
    if (item?.clip.kind === 'media' && item.clip.audio?.gainKeys) {
      const index = Number(keyEl.dataset.keyIndex)
      const keys = ops.sortKeys(item.clip.audio.gainKeys).filter((_, i) => i !== index)
      project.apply(ops.setProps(item.id, { audio: { gainKeys: keys } }), 'Remove volume keyframe')
    }
    return
  }
  const clipEl = (e.target as HTMLElement).closest('[data-clip-id]') as HTMLElement | null
  if (!clipEl) return
  editor.select([clipEl.dataset.clipId!])
  editor.rightTab = 'inspector'
}

// ---------------------------------------------------------------- ruler scrubbing

const scrubbing = ref(false)
function rulerFrame(e: PointerEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return xToFrame(e.clientX - rect.left + scrollLeft.value, ppf.value)
}
function onRulerDown(e: PointerEvent) {
  scrubbing.value = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  editor.focus = 'timeline'
  transport.pause()
  transport.seek(rulerFrame(e))
}
function onRulerMove(e: PointerEvent) {
  if (scrubbing.value) transport.seek(rulerFrame(e))
}
function onRulerUp() {
  scrubbing.value = false
}

// ---------------------------------------------------------------- drop from Assets

const dropHint = ref<{ frame: number; lane: number }>()

function dropTarget(e: DragEvent, audioOnly: boolean): { frame: number; lane: number } {
  const pt = localPoint(e)
  const row = rowAtY(rows.value, pt.y)
  const frame = xToFrame(pt.x, ppf.value)
  if (row?.lane === 0 && !audioOnly) return { frame: nearestSpineBoundary(frame, layout.value), lane: 0 }
  let lane = row?.lane ?? (pt.y < spineRow.value.top ? 1 : -1)
  if (lane === 0) lane = audioOnly ? -1 : 1
  if (audioOnly && lane > 0) lane = -1
  return { frame: snap(frame, layout.value, new Set()), lane }
}

let draggedAudioOnly = false
function onDragOver(e: DragEvent) {
  if (!e.dataTransfer?.types.includes(ASSET_DRAG_TYPE)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  dropHint.value = dropTarget(e, draggedAudioOnly)
}

function onDragEnter(e: DragEvent) {
  const types = e.dataTransfer?.types
  if (!types?.includes(ASSET_DRAG_TYPE)) return
  draggedAudioOnly = types.includes(AUDIO_DRAG_TYPE)
}

function onDragLeave(e: DragEvent) {
  if (!content.value?.contains(e.relatedTarget as Node)) {
    dropHint.value = undefined
    snapLine.value = undefined
  }
}

/** Drops one asset or a whole multi-selection: the clips land back to back, in the order they were selected. */
function onDrop(e: DragEvent) {
  const ids = readAssetDrag(e.dataTransfer)
  dropHint.value = undefined
  snapLine.value = undefined
  if (!ids) return
  e.preventDefault()
  const list = ids.map((id) => assets.get(id)).filter((a): a is AssetDTO => a?.status === 'ready')
  if (!list.length) return
  const target = dropTarget(e, list.every((a) => a.kind === 'audio'))
  const ctx = project.opContext()
  const clips = list.map((asset) =>
    ops.makeMediaClip({
      assetId: asset.id,
      media: ctx.media(asset.id)!,
      fps: fps.value,
      role: asset.kind === 'audio' ? (asset.role ?? 'dialogue') : 'effects',
      newId: ctx.newId,
      name: asset.name,
    }),
  )
  if (target.lane === 0) {
    const end = layout.value.spine.at(-1)?.end ?? 0
    project.apply(target.frame >= end ? ops.appendToSpine(clips) : ops.insertAt(target.frame, clips), 'Insert')
  } else {
    project.apply(ops.connectAt(target.frame, clips, target.lane), 'Connect')
  }
  editor.select(clips.map((c) => c.id))
}

// ---------------------------------------------------------------- context menu

const menuClipId = ref<string>()
const menuClip = computed(() => (menuClipId.value ? findItem(menuClipId.value) : undefined))

function onContextMenu(e: MouseEvent) {
  const clipEl = (e.target as HTMLElement).closest('[data-clip-id]') as HTMLElement | null
  const pt = localPoint(e)
  menuFrame.value = xToFrame(pt.x, ppf.value)
  menuClipId.value = clipEl?.dataset.clipId
  if (menuClipId.value && !selected.value.has(menuClipId.value)) editor.select([menuClipId.value])
}
const menuFrame = ref(0)

/** Previous/next picture clips on the storyline (colour-match references). */
function neighbours(id: string): { id: string; label: string }[] {
  const spine = layout.value.spine
  const i = spine.findIndex((x) => x.id === id)
  const pick = (from: number, dir: -1 | 1) => {
    for (let j = from; j >= 0 && j < spine.length; j += dir) if (spine[j]!.item.kind === 'media' && assetFor(spine[j]!.item)?.kind !== 'audio') return spine[j]
    return undefined
  }
  const out: { id: string; label: string }[] = []
  const prev = i >= 0 ? pick(i - 1, -1) : undefined
  const next = i >= 0 ? pick(i + 1, 1) : undefined
  if (prev) out.push({ id: prev.id, label: `previous shot (${prev.item.name ?? 'clip'})` })
  if (next) out.push({ id: next.id, label: `next shot (${next.item.name ?? 'clip'})` })
  return out
}

function selectTake(index: number) {
  if (menuClipId.value) project.apply(ops.audition(menuClipId.value, { type: 'select', index }), 'Switch take')
}

// ---------------------------------------------------------------- transitions (spine)

const transitions = computed(() =>
  layout.value.spine
    .map((s, i) => {
      if (!s.item.transitionOut) return undefined
      const isLast = i === layout.value.spine.length - 1
      const d = isLast ? Math.min(s.item.transitionOut.duration, s.end - s.start) : s.overlapOut
      if (d <= 0) return undefined
      return { id: s.id, start: s.end - d, end: s.end, type: s.item.transitionOut.type }
    })
    .filter((t): t is NonNullable<typeof t> => Boolean(t)),
)

const marquee = computed(() => {
  const d = drag.value
  if (d?.kind !== 'marquee' || (Math.abs(d.x1 - d.x0) < 3 && Math.abs(d.y1 - d.y0) < 3)) return undefined
  return { left: Math.min(d.x0, d.x1), top: Math.min(d.y0, d.y1), width: Math.abs(d.x1 - d.x0), height: Math.abs(d.y1 - d.y0) }
})

const cursor = computed(() => (editor.tool === 'blade' ? 'cursor-crosshair' : 'cursor-default'))
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-timeline">
    <!-- Ruler -->
    <div
      class="relative shrink-0 cursor-text border-b border-border"
      :style="{ height: `${RULER_HEIGHT}px` }"
      @pointerdown="onRulerDown"
      @pointermove="onRulerMove"
      @pointerup="onRulerUp"
      @pointercancel="onRulerUp"
      @lostpointercapture="onRulerUp"
    >
      <TimelineRuler
        :px-per-frame="ppf"
        :fps="fps"
        :scroll-left="scrollLeft"
        :width="viewportWidth"
        :duration="layout.duration"
        :markers="layout.markers"
        :range-in="editor.rangeIn"
        :range-out="editor.rangeOut"
      />
      <!-- Playhead head: a round grab handle on the ruler with the line running down into the tracks. -->
      <div ref="playheadHead" class="pointer-events-none absolute top-0 left-0 z-20 h-full">
        <div class="absolute top-[13px] bottom-0 left-0 w-px bg-playhead" />
        <div class="absolute top-[3px] left-[0.5px] size-[11px] -translate-x-1/2 rounded-full bg-playhead shadow-[0_1px_3px_oklch(0_0_0/0.45)] ring-[2.5px] ring-timeline" />
      </div>
    </div>

    <!-- Tracks -->
    <ContextMenu>
      <ContextMenuTrigger as-child>
        <div ref="scroller" class="relative min-h-0 flex-1 overflow-auto" @scroll="onScroll" @wheel="onWheel">
          <div
            ref="content"
            :class="['relative', cursor]"
            :style="{ width: `${contentWidth}px`, height: `${rowsInfo.height}px` }"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerCancel"
            @lostpointercapture="onPointerUp"
            @pointerleave="onPointerLeave"
            @dblclick="onDoubleClick"
            @dragenter="onDragEnter"
            @dragover="onDragOver"
            @dragleave="onDragLeave"
            @drop="onDrop"
            @contextmenu="onContextMenu"
          >
            <!-- lane backgrounds -->
            <div
              v-for="row in rows"
              :key="row.lane"
              class="pointer-events-none absolute inset-x-0"
              :class="row.lane === 0 ? 'bg-foreground/[0.035]' : ''"
              :style="{ top: `${row.top}px`, height: `${row.height}px` }"
            />
            <!-- range -->
            <div
              v-if="editor.rangeIn !== undefined || editor.rangeOut !== undefined"
              class="pointer-events-none absolute inset-y-0 bg-yellow-500/10"
              :style="{
                left: `${frameToX(editor.rangeIn ?? 0, ppf)}px`,
                width: `${Math.max(1, ((editor.rangeOut ?? layout.duration) - (editor.rangeIn ?? 0)) * ppf)}px`,
              }"
            />

            <TimelineClip
              v-for="item in visibleItems"
              :key="item.id"
              v-memo="[item.clip, item.start, item.end, item.lane, item.hanging, ppf, selected.has(item.id), assetFor(item.clip), jobFor(item.clip)?.progress, jobFor(item.clip)?.status, rowFor(item).top, viewLeft, viewRight]"
              :clip="item.clip"
              :start="item.start"
              :end="item.end"
              :top="rowFor(item).top"
              :height="rowFor(item).height"
              :fps="fps"
              :px-per-frame="ppf"
              :selected="selected.has(item.id)"
              :asset="assetFor(item.clip)"
              :job="jobFor(item.clip)"
              :view-left="viewLeft"
              :view-right="viewRight"
              :hanging="item.hanging"
            />

            <!-- transitions -->
            <div
              v-for="t in transitions"
              :key="`tr-${t.id}`"
              :data-transition="t.id"
              class="absolute z-20 flex cursor-pointer items-center justify-center rounded-[5px] bg-black/65 text-white/85 ring-1 ring-white/25 backdrop-blur-sm hover:bg-black/80"
              :class="editor.selectedTransition === t.id && 'ring-2 ring-selection'"
              :style="{ left: `${frameToX(t.start, ppf)}px`, width: `${Math.max(8, (t.end - t.start) * ppf)}px`, top: `${spineRow.top + 2}px`, height: '14px' }"
              :title="t.type"
            >
              <Blend class="size-2.5" />
            </div>

            <!-- snapping + drop indicators -->
            <div v-if="snapLine !== undefined" class="pointer-events-none absolute inset-y-0 z-30 w-px bg-selection" :style="{ left: `${frameToX(snapLine, ppf)}px` }" />
            <div
              v-if="dropHint"
              class="pointer-events-none absolute z-30 w-0.5 rounded bg-brand shadow-[0_0_8px] shadow-brand"
              :style="{
                left: `${frameToX(dropHint.frame, ppf) - 1}px`,
                top: `${(rowByLane.get(dropHint.lane) ?? spineRow).top}px`,
                height: `${(rowByLane.get(dropHint.lane) ?? spineRow).height}px`,
              }"
            />
            <div
              v-if="marquee"
              class="pointer-events-none absolute z-30 border border-brand/70 bg-brand/10"
              :style="{ left: `${marquee.left}px`, top: `${marquee.top}px`, width: `${marquee.width}px`, height: `${marquee.height}px` }"
            />

            <div
              v-if="dragInfo"
              class="pointer-events-none absolute z-50 -translate-x-1/2 -translate-y-full rounded-md bg-black/85 px-2 py-0.5 font-mono text-[10px] whitespace-nowrap text-white tabular ring-1 ring-white/10"
              :style="{ left: `${dragInfo.x}px`, top: `${dragInfo.y - 6}px` }"
            >
              {{ dragInfo.text }}
            </div>

            <!-- skimmer + playhead -->
            <div
              v-if="skimX !== undefined && editor.skimming && !editor.playing && !drag"
              class="pointer-events-none absolute inset-y-0 z-30 w-px bg-skimmer/80"
              :style="{ left: `${skimX}px` }"
            />
            <div ref="playheadLine" class="pointer-events-none absolute inset-y-0 left-0 z-40 w-px bg-playhead" />

            <div
              v-if="!items.length"
              class="pointer-events-none absolute flex items-center gap-2 text-xs text-muted-foreground"
              :style="{ left: `${PAD_X + 8}px`, top: `${spineRow.top + spineRow.height / 2 - 8}px` }"
            >
              <Sparkles class="size-3.5" /> Drag clips here — or right-click to generate a shot
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent class="w-[21.5rem]">
        <template v-if="menuClip">
          <ContextMenuItem @select="commands.bladeAtPlayhead()"><Scissors /> Blade at playhead <ContextMenuShortcut>⌘B</ContextMenuShortcut></ContextMenuItem>
          <ContextMenuItem @select="project.apply(ops.blade(menuClip.id, menuFrame), 'Blade')"><Scissors /> Blade here</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem @select="commands.copySelection()"><Copy /> Copy <ContextMenuShortcut>⌘C</ContextMenuShortcut></ContextMenuItem>
          <ContextMenuItem @select="commands.cutSelection()"><ScissorsLineDashed /> Cut <ContextMenuShortcut>⌘X</ContextMenuShortcut></ContextMenuItem>
          <ContextMenuItem @select="commands.duplicateSelection()"><CopyPlus /> Duplicate <ContextMenuShortcut>⌘D</ContextMenuShortcut></ContextMenuItem>
          <ContextMenuItem :disabled="!editor.clipboard.length" @select="commands.paste(menuFrame)"><ClipboardPaste /> Paste here</ContextMenuItem>
          <ContextMenuSeparator />
          <template v-if="menuClip.clip.kind === 'media'">
            <ContextMenuItem @select="commands.newTake(menuClip.id)"><Wand2 /> Generate new take… <span class="menu-badge ml-auto">AI</span></ContextMenuItem>
            <template v-if="assetFor(menuClip.clip)?.kind === 'video'">
              <ContextMenuItem @select="clipTools.extendClip(menuClip.id)"><ArrowRightToLine /> Generate more after the last frame… <span class="menu-badge ml-auto">AI</span></ContextMenuItem>
              <ContextMenuItem @select="clipTools.extendBeforeClip(menuClip.id)"><ArrowLeftToLine /> Generate more before the first frame… <span class="menu-badge ml-auto">AI</span></ContextMenuItem>
              <ContextMenuItem v-if="canExtendWithVeo(assetFor(menuClip.clip)!)" @select="commands.extendWithVeo(menuClip.id)">
                <FastForward /> Extend with Veo (+7 s, as a new take)… <span class="menu-badge ml-auto">AI</span>
              </ContextMenuItem>
            </template>
            <ContextMenuSub v-if="menuClip.clip.takes.length > 1">
              <ContextMenuSubTrigger><Layers /> Takes ({{ menuClip.clip.takes.length }})</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem v-for="(take, i) in menuClip.clip.takes" :key="take.id" @select="selectTake(i)">
                  <span :class="i === menuClip.clip.active && 'font-semibold'">Take {{ i + 1 }}</span>
                  <span class="ml-2 truncate text-muted-foreground">{{ take.label ?? '' }}</span>
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem @select="commands.finalizeAudition(menuClip.id)">Keep only the active take</ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuItem v-if="assetFor(menuClip.clip)?.kind === 'video'" @select="splitIntoShots(menuClip.id)"><Columns2 /> Split into shots (scene detection)</ContextMenuItem>
            <ContextMenuItem @select="commands.upscaleClip(menuClip.id)"><ImageUpscale /> Upscale (as a new take)… <span class="menu-badge ml-auto">AI</span></ContextMenuItem>
            <ContextMenuItem @select="commands.fitToMedia(menuClip.id)"><MoveHorizontal /> Fit to media length</ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger><Wrench /> Clip tools</ContextMenuSubTrigger>
              <ContextMenuSubContent class="w-60">
                <ContextMenuItem v-if="assetFor(menuClip.clip)?.kind === 'video'" @select="editor.select([menuClip.id]); editor.dialog = 'edit-shot'">Edit inside the shot at playhead…</ContextMenuItem>
                <ContextMenuItem v-if="assetFor(menuClip.clip)?.kind === 'video'" @select="clipTools.freezeFrame()">Freeze frame at playhead <ContextMenuShortcut>⌥F</ContextMenuShortcut></ContextMenuItem>
                <ContextMenuItem v-if="assetFor(menuClip.clip) && assetFor(menuClip.clip)?.kind !== 'image'" @select="clipTools.reverseClip(menuClip.id)">Reverse clip</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem v-if="assetFor(menuClip.clip)?.hasAudio" @select="clipTools.isolateVoice(menuClip.id)">Isolate voice (remove noise &amp; music)</ContextMenuItem>
                <ContextMenuItem v-if="assetFor(menuClip.clip)?.hasAudio" @select="clipTools.transcribeAsset(assetFor(menuClip.clip)!.id)">Transcribe speech</ContextMenuItem>
                <ContextMenuItem v-if="assetFor(menuClip.clip)?.hasAudio" @select="clipTools.detectBeats(menuClip.id)">Detect beats (snap cuts to music)</ContextMenuItem>
                <template v-if="menuClip.clip.video && neighbours(menuClip.id).length">
                  <ContextMenuSeparator />
                  <ContextMenuItem v-for="n in neighbours(menuClip.id)" :key="n.id" @select="clipTools.matchColor(menuClip.id, n.id)">Match colour to {{ n.label }}</ContextMenuItem>
                </template>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuItem v-if="menuClip.clip.video && menuClip.clip.audio?.enabled" @select="commands.detachAudio()">
              <AudioLines /> Detach audio <ContextMenuShortcut>⌃⇧S</ContextMenuShortcut>
            </ContextMenuItem>
          </template>
          <ContextMenuItem v-if="menuClip.spine" @select="commands.addTransition('dissolve')">
            <Blend /> Add cross dissolve <ContextMenuShortcut>⌘T</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem v-if="menuClip.spine && menuClip.clip.kind !== 'gap'" @select="commands.liftFromStoryline()">
            <ArrowUpFromLine /> Lift from storyline
          </ContextMenuItem>
          <ContextMenuItem v-if="!menuClip.spine" @select="commands.overwriteToPrimary()">
            <ArrowDownToLine /> Overwrite to primary storyline
          </ContextMenuItem>
          <ContextMenuItem @select="commands.toggleEnabled()"><EyeOff v-if="menuClip.clip.enabled" /><Eye v-else /> {{ menuClip.clip.enabled ? 'Disable' : 'Enable' }} <ContextMenuShortcut>V</ContextMenuShortcut></ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem v-if="menuClip.clip.kind === 'gap'" @select="clipTools.fillGap(menuClip.id)"><Sparkles /> Fill gap with a generated shot… <span class="menu-badge ml-auto">AI</span></ContextMenuItem>
          <ContextMenuItem v-if="menuClip.spine" @select="commands.deleteSelection('gap')"><SquareDashed /> Replace with gap <ContextMenuShortcut>⇧⌫</ContextMenuShortcut></ContextMenuItem>
          <ContextMenuItem variant="destructive" @select="commands.deleteSelection('ripple')"><Trash2 /> Delete <ContextMenuShortcut>⌫</ContextMenuShortcut></ContextMenuItem>
        </template>
        <template v-else>
          <ContextMenuItem @select="commands.generateHere(menuFrame)"><Sparkles /> Generate shot here… <span class="menu-badge ml-auto">AI</span></ContextMenuItem>
          <ContextMenuItem :disabled="!editor.clipboard.length" @select="commands.paste(menuFrame)"><ClipboardPaste /> Paste here <ContextMenuShortcut>⌘V</ContextMenuShortcut></ContextMenuItem>
          <ContextMenuItem @select="transport.seek(menuFrame); commands.addTitle('basic')"><Type /> Add title here</ContextMenuItem>
          <ContextMenuItem @select="transport.seek(menuFrame); commands.addMarker()"><Bookmark /> Add marker <ContextMenuShortcut>M</ContextMenuShortcut></ContextMenuItem>
        </template>
      </ContextMenuContent>
    </ContextMenu>
  </div>
</template>
