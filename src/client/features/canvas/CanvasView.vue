<script setup lang="ts">
import {
  type Handle,
  fitRect,
  intersects,
  itemsInRect,
  paintOrder,
  rectFromPoints,
  resizeRotated,
  rotateAround,
  snapRect,
  toBoard,
  toScreen,
  unionRect,
  visibleRect,
  withFrameContents,
  zoomAt,
} from '@shared/canvas/geometry'
import { ancestorGroups, pickTarget } from '@shared/canvas/groups'
import { parseMarkup } from '@shared/canvas/richText'
import { FONT_FILE, IMPORTABLE_FILE } from '@shared/types/assets'
import { type CanvasItem, DEFAULT_TEXT, type Rect, sanitizeCanvas } from '@shared/types/canvas'
import { useElementSize, useEventListener } from '@vueuse/core'
import { type CSSProperties, computed, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { ASSET_DRAG_TYPE, readAssetDrag } from '@/features/assets/drag'
import { errorMessage } from '@/lib/api'
import { isTyping } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { useCanvasStore } from '@/stores/canvas'
import { useEditorStore } from '@/stores/editor'
import { useJobsStore } from '@/stores/jobs'
import ResultActions from '@/features/generate/ResultActions.vue'
import CanvasItemView from './CanvasItemView.vue'
import CanvasMenu from './CanvasMenu.vue'
import { commitBoardRects } from './animate'
import { addAssetsToBoard, addItems, cloneItems, newItemId, removeItems, setTextMarkup, updateItem } from './useCanvasDoc'

const canvas = useCanvasStore()
const assets = useAssetsStore()
const jobs = useJobsStore()
const editor = useEditorStore()

const host = ref<HTMLDivElement>()
const { width, height } = useElementSize(host)
watch([width, height], ([w, h]) => {
  if (w && h) canvas.viewSize = { w, h }
})

const vp = computed(() => canvas.viewport)
const boardId = computed(() => canvas.board.id)

// ------------------------------------------------------------------------------------------------ what to draw

/** Board area on screen, plus a margin so items don't pop in at the edges while panning. */
const visible = computed(() => {
  const r = visibleRect(vp.value, width.value || 1, height.value || 1)
  const m = 200 / vp.value.zoom
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m }
})
const frames = computed(() => canvas.items.filter((i) => i.kind === 'frame'))
/** Hidden from the layers, itself or by a group it is in. */
const isHidden = (i: CanvasItem) => Boolean(i.hidden || (i.groupId && ancestorGroups(canvas.byId, i).some((g) => g.hidden)))
// Groups draw nothing of their own: their members are drawn, and a click on one picks the group.
const childrenByFrame = computed(() => {
  const map = new Map<string, CanvasItem[]>()
  for (const i of canvas.items) if (i.frameId && i.kind !== 'group' && !isHidden(i)) map.set(i.frameId, [...(map.get(i.frameId) ?? []), i])
  return map
})
const visibleFrames = computed(() => frames.value.filter((f) => intersects(canvas.rectOf(f), visible.value)))
const visibleFree = computed(() =>
  paintOrder(canvas.items).filter((i) => i.kind !== 'frame' && i.kind !== 'group' && !i.frameId && !isHidden(i) && intersects(canvas.rectOf(i), visible.value)),
)

function boxStyle(r: Rect, origin?: Rect) {
  return { left: `${r.x - (origin?.x ?? 0)}px`, top: `${r.y - (origin?.y ?? 0)}px`, width: `${r.w}px`, height: `${r.h}px` }
}

const worldStyle = computed(() => ({ transform: `translate(${vp.value.x}px, ${vp.value.y}px) scale(${vp.value.zoom})` }))
const boardStyle = computed(() => {
  // The dot grid thins out when zoomed far out so it never turns into noise.
  let gap = 24 * vp.value.zoom
  while (gap < 12) gap *= 4
  return { '--dot-gap': `${gap}px`, '--dot-x': `${vp.value.x}px`, '--dot-y': `${vp.value.y}px`, '--zoom': vp.value.zoom }
})

// Lineage: a curve from each source image to what was generated from it (both on this board).
const lineage = computed(() => {
  if (!canvas.showLineage) return []
  const byAsset = new Map<string, CanvasItem>()
  for (const i of canvas.items) if (i.kind === 'asset' && i.assetId && !byAsset.has(i.assetId)) byAsset.set(i.assetId, i)
  const lines: { id: string; d: string }[] = []
  for (const child of canvas.items) {
    if (child.kind !== 'asset') continue
    const parents = child.assetId ? (assets.get(child.assetId)?.parentIds ?? []) : pendingParents(child.generationId)
    for (const pid of parents) {
      const parent = byAsset.get(pid)
      if (!parent || parent.id === child.id) continue
      const a = canvas.rectOf(parent)
      const b = canvas.rectOf(child)
      const x1 = a.x + a.w
      const y1 = a.y + a.h / 2
      const x2 = b.x
      const y2 = b.y + b.h / 2
      const bend = Math.max(40, Math.abs(x2 - x1) / 2)
      lines.push({ id: `${parent.id}-${child.id}`, d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}` })
    }
  }
  return lines
})

/** Inputs of a running generation (asset ids in its params), so the lineage shows up before the result does. */
function pendingParents(generationId: string | undefined): string[] {
  const job = generationId ? jobs.byId[generationId] : undefined
  if (!job) return []
  const ids: string[] = []
  for (const v of Object.values(job.params)) {
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && assets.get(x)) ids.push(x)
  }
  return ids
}

// ------------------------------------------------------------------------------------------------ overlay

const selectedRects = computed(() => canvas.selectedItems.map((i) => ({ id: i.id, kind: i.kind, r: toScreen(vp.value, canvas.rectOf(i)), deg: canvas.rotationOf(i) })))
const selectionBox = computed(() => {
  const u = unionRect(canvas.selectedItems.map((i) => canvas.rectOf(i)))
  return u ? toScreen(vp.value, u) : undefined
})
const single = computed(() => (canvas.selectedItems.length === 1 && !canvas.selectedItems[0]!.locked ? canvas.selectedItems[0] : undefined))
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const CURSORS: Record<Handle, string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' }
function handleStyle(h: Handle | 'rotate', r: Rect, deg = 0) {
  const x = h === 'rotate' ? r.x + r.w / 2 : h.includes('w') ? r.x : h.includes('e') ? r.x + r.w : r.x + r.w / 2
  const y = h === 'rotate' ? r.y - 22 : h.includes('n') ? r.y : h.includes('s') ? r.y + r.h : r.y + r.h / 2
  const p = rotateAround({ x, y }, { x: r.x + r.w / 2, y: r.y + r.h / 2 }, deg)
  return { left: `${p.x - 4}px`, top: `${p.y - 4}px`, cursor: h === 'rotate' ? 'grab' : CURSORS[h] }
}
/** Frames don't turn: everything else gets the rotate handle above it. */
const rotatable = computed(() => Boolean(single.value && single.value.kind !== 'frame' && single.value.kind !== 'group'))
const frameLabels = computed(() =>
  visibleFrames.value.map((f) => {
    const r = toScreen(vp.value, canvas.rectOf(f))
    return { id: f.id, name: f.name ?? 'Frame', size: `${Math.round(f.w)} × ${Math.round(f.h)}`, x: r.x, y: r.y - 18, w: r.w }
  }),
)
/** In animation mode, what the clip's camera sees at the playhead (when it isn't the whole frame). */
const cameraBox = computed(() => {
  const v = canvas.animView
  const cam = v?.view.camera
  if (!v || !cam || (cam.zoom === 1 && !cam.x && !cam.y)) return undefined
  const w = v.frame.w / cam.zoom
  const h = v.frame.h / cam.zoom
  const r = toScreen(vp.value, { x: v.frame.x + v.frame.w / 2 + cam.x - w / 2, y: v.frame.y + v.frame.h / 2 + cam.y - h / 2, w, h })
  return boxStyle(r)
})
const guideLines = computed(() =>
  canvas.guides.map((g, i) => {
    const a = toScreen(vp.value, g.axis === 'x' ? { x: g.at, y: g.from, w: 0, h: g.to - g.from } : { x: g.from, y: g.at, w: g.to - g.from, h: 0 })
    return { i, style: { left: `${a.x}px`, top: `${a.y}px`, width: `${Math.max(1, a.w)}px`, height: `${Math.max(1, a.h)}px` } }
  }),
)

// ------------------------------------------------------------------------------------------------ hover actions

/** The result under the pointer: its actions bar (Vary, Animate, Upscale…) sits on its bottom edge. */
const hoveredId = ref<string>()
let unhoverTimer: ReturnType<typeof setTimeout> | undefined
function keepHover() {
  clearTimeout(unhoverTimer)
}
function unhoverSoon() {
  clearTimeout(unhoverTimer)
  // Long enough to move from the item onto its bar.
  unhoverTimer = setTimeout(() => (hoveredId.value = undefined), 220)
}
function onHover(e: PointerEvent) {
  if ((e.target as HTMLElement | null)?.closest?.('[data-result-actions]')) return keepHover()
  const item = hitItem(e.target)
  if (item?.kind === 'asset' && item.assetId) {
    keepHover()
    hoveredId.value = item.id
  } else unhoverSoon()
}
const hovered = computed(() => {
  const item = hoveredId.value && !gesture.value && !canvas.editingId ? canvas.byId.get(hoveredId.value) : undefined
  const asset = item?.kind === 'asset' ? assets.get(item.assetId) : undefined
  if (!item || item.kind !== 'asset' || asset?.status !== 'ready') return undefined
  const r = toScreen(vp.value, canvas.rectOf(item))
  return { item, asset, style: { left: `${r.x + 6}px`, top: `${r.y + r.h - 6}px`, maxWidth: `${Math.max(120, r.w - 12)}px` }, narrow: r.w < 420 }
})

// ------------------------------------------------------------------------------------------------ pointer

type Gesture =
  | { mode: 'pan'; start: { x: number; y: number }; vp: { x: number; y: number; zoom: number } }
  | { mode: 'move'; start: { x: number; y: number }; ids: Set<string>; base: Map<string, Rect>; moved: boolean; hit?: string; additive: boolean }
  | { mode: 'resize'; start: { x: number; y: number }; id: string; handle: Handle; base: Rect; keepAspect: boolean; rotation: number }
  | { mode: 'rotate'; id: string; center: { x: number; y: number }; startAngle: number; base: number }
  | { mode: 'marquee'; start: { x: number; y: number }; current: { x: number; y: number }; base: string[] }
  | { mode: 'draw'; start: { x: number; y: number }; current: { x: number; y: number } }

const gesture = ref<Gesture>()
const spaceHeld = ref(false)

function local(e: { clientX: number; clientY: number }) {
  const b = host.value!.getBoundingClientRect()
  return { x: e.clientX - b.left, y: e.clientY - b.top }
}

/** The element under the pointer as drawn (a group's member). */
function rawHit(target: EventTarget | null): CanvasItem | undefined {
  const el = (target as HTMLElement | null)?.closest?.('[data-item-id]') as HTMLElement | null
  return el ? canvas.byId.get(el.dataset.itemId!) : undefined
}

/** What a click picks: the element, or the group it is in (a member, inside the group double-clicked into). */
function hitItem(target: EventTarget | null): CanvasItem | undefined {
  const raw = rawHit(target)
  const item = raw && pickTarget(canvas.byId, raw, canvas.enteredGroupId)
  return item?.locked ? undefined : item
}

function onPointerDown(e: PointerEvent) {
  // A click outside the text being edited ends the edit (and does nothing else).
  if (canvas.editingId) {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    canvas.editingId = undefined
    return
  }
  host.value?.focus({ preventScroll: true })
  editor.focus = 'canvas'
  const p = local(e)
  const target = e.target as HTMLElement
  // Right click: select what's under the pointer for the context menu, nothing else.
  if (e.button === 2) {
    const label = target.dataset.frameLabel
    const hit = label ? canvas.byId.get(label) : hitItem(target)
    if (hit && !canvas.selection.includes(hit.id)) canvas.select([hit.id])
    if (!hit) canvas.select([])
    return
  }
  if (e.button === 1 || canvas.tool === 'hand' || spaceHeld.value) {
    gesture.value = { mode: 'pan', start: p, vp: { ...vp.value } }
  } else if (target.dataset.handle === 'rotate' && single.value) {
    const item = single.value
    const r = toScreen(vp.value, canvas.rectOf(item))
    const center = { x: r.x + r.w / 2, y: r.y + r.h / 2 }
    gesture.value = { mode: 'rotate', id: item.id, center, startAngle: Math.atan2(p.y - center.y, p.x - center.x), base: canvas.rotationOf(item) }
  } else if (target.dataset.handle && single.value) {
    const item = single.value
    gesture.value = {
      mode: 'resize',
      start: p,
      id: item.id,
      handle: target.dataset.handle as Handle,
      base: { ...item, ...canvas.rectOf(item) },
      keepAspect: item.kind === 'asset' || item.kind === 'note' || item.kind === 'group',
      rotation: canvas.rotationOf(item),
    }
  } else if (canvas.tool !== 'select') {
    gesture.value = { mode: 'draw', start: p, current: p }
  } else {
    const label = target.dataset.frameLabel
    let hit = label ? canvas.byId.get(label) : hitItem(target)
    // A frame with contents is grabbed by its name; clicking its empty area starts a selection rectangle inside.
    if (hit?.kind === 'frame' && !label && childrenByFrame.value.get(hit.id)?.length && !canvas.selection.includes(hit.id)) hit = undefined
    const additive = e.shiftKey || e.metaKey
    if (hit) {
      if (additive) canvas.toggle(hit.id)
      else if (!canvas.selection.includes(hit.id)) canvas.select([hit.id])
      const ids = withFrameContents(canvas.items, canvas.selection.filter((id) => !canvas.byId.get(id)?.locked))
      const base = new Map([...ids].flatMap((id) => {
        const item = canvas.byId.get(id)
        // Where it shows: in animation mode an element starts from its animated place.
        const r = item && canvas.rectOf(item)
        return r ? [[id, { x: r.x, y: r.y, w: r.w, h: r.h }] as const] : []
      }))
      // Locked items select but don't move.
      if (base.size) gesture.value = { mode: 'move', start: p, ids, base, moved: false, hit: hit.id, additive }
    } else {
      gesture.value = { mode: 'marquee', start: p, current: p, base: additive ? [...canvas.selection] : [] }
      if (!additive) canvas.select([])
    }
  }
  host.value?.setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  const g = gesture.value
  if (!g) return
  const p = local(e)
  const zoom = vp.value.zoom
  if (g.mode === 'pan') {
    canvas.viewport = { ...g.vp, x: g.vp.x + p.x - g.start.x, y: g.vp.y + p.y - g.start.y }
  } else if (g.mode === 'move') {
    const dx = (p.x - g.start.x) / zoom
    const dy = (p.y - g.start.y) / zoom
    if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) < 3) return
    g.moved = true
    const moving = unionRect([...g.base.values()])!
    const others = canvas.items.filter((i) => !g.ids.has(i.id) && intersects(i, visible.value))
    const snap = e.altKey ? { dx: 0, dy: 0, guides: [] } : snapRect({ ...moving, x: moving.x + dx, y: moving.y + dy }, others, 6 / zoom)
    const rects = new Map<string, Rect>()
    for (const [id, r] of g.base) rects.set(id, { ...r, x: r.x + dx + snap.dx, y: r.y + dy + snap.dy })
    canvas.setLive(rects, snap.guides)
  } else if (g.mode === 'resize') {
    const dx = (p.x - g.start.x) / zoom
    const dy = (p.y - g.start.y) / zoom
    const keep = e.shiftKey ? !g.keepAspect : g.keepAspect
    canvas.setLive(new Map([[g.id, resizeRotated(g.base, g.handle, dx, dy, keep, 4, g.rotation)]]))
  } else if (g.mode === 'rotate') {
    const deg = g.base + ((Math.atan2(p.y - g.center.y, p.x - g.center.x) - g.startAngle) * 180) / Math.PI
    // Shift snaps to 15°.
    const snapped = e.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg * 10) / 10
    canvas.liveRotation = new Map([[g.id, ((((snapped + 180) % 360) + 360) % 360) - 180]])
  } else if (g.mode === 'marquee') {
    g.current = p
    const r = rectFromPoints(toBoard(vp.value, g.start), toBoard(vp.value, p))
    const picked = itemsInRect(canvas.items.filter((i) => !isHidden(i)), r).map((i) => pickTarget(canvas.byId, i, canvas.enteredGroupId))
    canvas.select([...new Set([...g.base, ...picked.filter((i) => !i.locked).map((i) => i.id)])])
  } else if (g.mode === 'draw') {
    g.current = p
  }
}

function onPointerUp(e: PointerEvent) {
  const g = gesture.value
  gesture.value = undefined
  if (host.value?.hasPointerCapture(e.pointerId)) host.value.releasePointerCapture(e.pointerId)
  if (!g) return
  if (g.mode === 'move') {
    if (g.moved) commitBoardRects(boardId.value, new Map(canvas.live), g.base.size === 1 ? 'Move' : `Move ${g.base.size} items`, { moveOnly: true })
    else if (g.hit && !g.additive && canvas.selection.length > 1) canvas.select([g.hit])
    canvas.clearLive()
  } else if (g.mode === 'resize') {
    const r = canvas.live.get(g.id)
    if (r) commitBoardRects(boardId.value, new Map([[g.id, r]]), 'Resize')
    canvas.clearLive()
  } else if (g.mode === 'rotate') {
    const deg = canvas.liveRotation.get(g.id)
    canvas.liveRotation = new Map()
    if (deg !== undefined && deg !== g.base) updateItem(boardId.value, g.id, { rotation: deg || undefined }, 'Rotate')
  } else if (g.mode === 'draw') {
    createDrawn(rectFromPoints(toBoard(vp.value, g.start), toBoard(vp.value, g.current)), toBoard(vp.value, g.start), toBoard(vp.value, g.current))
  }
}

function onPointerCancel(e: PointerEvent) {
  gesture.value = undefined
  canvas.liveRotation = new Map()
  if (host.value?.hasPointerCapture(e.pointerId)) host.value.releasePointerCapture(e.pointerId)
  canvas.clearLive()
}

/** Creates what the active tool draws; a click (no drag) gets a sensible default size. */
function createDrawn(r: Rect, from?: { x: number; y: number }, to?: { x: number; y: number }) {
  const click = r.w * vp.value.zoom < 4 && r.h * vp.value.zoom < 4
  const base = { id: newItemId(), x: Math.round(r.x), y: Math.round(r.y) }
  let item: CanvasItem
  switch (canvas.tool) {
    case 'frame':
      item = { ...base, kind: 'frame', name: 'Frame', fill: '#ffffff', w: click ? 1080 : Math.round(r.w), h: click ? 1080 : Math.round(r.h) }
      break
    case 'text':
      item = { ...base, kind: 'text', text: 'Text', ...DEFAULT_TEXT, w: click ? 480 : Math.round(r.w), h: Math.round(DEFAULT_TEXT.fontSize * DEFAULT_TEXT.lineHeight) }
      break
    case 'note':
      item = { ...base, kind: 'note', text: '', color: 'yellow', w: click ? 260 : Math.round(r.w), h: click ? 260 : Math.round(r.h) }
      break
    case 'line': {
      // The drag's direction: points are fractions of the box, so the line keeps it when the box is resized.
      const w = click ? 320 : Math.max(1, Math.round(r.w))
      const h = click ? 1 : Math.max(1, Math.round(r.h))
      const a = from && to && !click ? from : { x: r.x, y: r.y }
      const b = from && to && !click ? to : { x: r.x + w, y: r.y }
      const fx = (p: { x: number }) => (w > 1 ? (p.x - r.x) / w : 0.5)
      const fy = (p: { y: number }) => (h > 1 ? (p.y - r.y) / h : 0.5)
      item = {
        ...base,
        kind: 'shape',
        shape: 'line',
        fill: '#ffffff',
        stroke: { color: '#ffffff', width: 6, cap: 'round', join: 'round' },
        points: [
          [fx(a), fy(a)],
          [fx(b), fy(b)],
        ],
        w,
        h,
      }
      break
    }
    default:
      item = { ...base, kind: 'shape', shape: 'rect', fill: '#7c3aed', radius: 0, w: click ? 240 : Math.round(r.w), h: click ? 240 : Math.round(r.h) }
  }
  addItems(boardId.value, [item], `Add ${item.kind === 'shape' ? (item.shape === 'line' ? 'line' : 'rectangle') : item.kind}`)
  canvas.tool = 'select'
  if (item.kind === 'text' || item.kind === 'note') canvas.editingId = item.id
}

/** Pointer capture retargets click and dblclick to the board, so hit-test what is actually under the pointer. */
function onDoubleClick(e: MouseEvent) {
  const under = document.elementFromPoint(e.clientX, e.clientY)
  let hit = hitItem(under)
  // Into a group: its member under the pointer is picked (and a text in it opens for editing on the next one).
  if (hit?.kind === 'group') {
    canvas.enteredGroupId = hit.id
    hit = hitItem(under)
    if (hit) canvas.select([hit.id])
    return
  }
  if (hit && (hit.kind === 'text' || hit.kind === 'note')) {
    canvas.select([hit.id])
    canvas.editingId = hit.id
  }
}

function commitText(item: CanvasItem, text: string) {
  canvas.editingId = undefined
  if (item.kind !== 'text' && item.kind !== 'note') return
  if (item.kind === 'note') return void (text !== item.text && updateItem(boardId.value, item.id, { text }, 'Edit text'))
  // Text is written as markup (bold, italic, highlight, colour): see `richText.ts`.
  if (!parseMarkup(text, item).text.trim()) return removeItems(boardId.value, [item.id])
  setTextMarkup(boardId.value, item.id, text)
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const p = local(e)
  if (e.ctrlKey || e.metaKey || e.altKey) {
    // Trackpad pinch arrives as ctrl+wheel with small deltas; a mouse wheel with ⌥ as ±100 steps.
    const delta = Math.max(-50, Math.min(50, e.deltaY))
    canvas.viewport = zoomAt(vp.value, p, Math.exp(-delta * 0.01))
  } else {
    canvas.viewport = { ...vp.value, x: vp.value.x - e.deltaX, y: vp.value.y - e.deltaY }
  }
}

// ------------------------------------------------------------------------------------------------ zoom requests

function zoomTo(mode: 'fit' | 'selection' | 'actual') {
  const w = width.value
  const h = height.value
  if (!w || !h) return
  if (mode === 'actual') {
    const c = canvas.viewCenter()
    canvas.viewport = { zoom: 1, x: w / 2 - c.x, y: h / 2 - c.y }
    return
  }
  const source = mode === 'selection' && canvas.selectedItems.length ? canvas.selectedItems : canvas.items
  const bounds = unionRect(source.map((i) => canvas.rectOf(i)))
  // Framed above the floating Composer (canvas.dockInset), so nothing ends up under it.
  if (bounds) canvas.viewport = fitRect(bounds, w, Math.max(160, h - canvas.dockInset), 64, mode === 'selection' ? 2 : 1)
}
// Requests made after this view exists always apply; older ones only when fresh (made while switching to the canvas,
// e.g. "Brand board"), so a stale request doesn't re-zoom every time the workspace opens.
const createdAt = Date.now()
let handledNonce: number | undefined
watch(
  () => [canvas.zoomRequest?.nonce, width.value > 0] as const,
  () => {
    const req = canvas.zoomRequest
    if (!req || !width.value || req.nonce === handledNonce) return
    handledNonce = req.nonce
    if (req.at >= createdAt || Date.now() - req.at < 1500) zoomTo(req.mode)
  },
  { immediate: true },
)
// A board seen for the first time opens framed on its contents.
watch(
  () => [canvas.board.id, width.value > 0] as const,
  ([id, sized]) => {
    if (sized && !canvas.viewports[id] && canvas.items.length) zoomTo('fit')
  },
  { immediate: true },
)

// ------------------------------------------------------------------------------------------------ drop / paste

function onDragOver(e: DragEvent) {
  const types = e.dataTransfer?.types ?? []
  if (types.includes('Files') || types.includes(ASSET_DRAG_TYPE)) {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }
}

async function onDrop(e: DragEvent) {
  const at = toBoard(vp.value, local(e))
  const ids = readAssetDrag(e.dataTransfer)
  if (ids) return addAssetsToBoard(ids, at)
  const files = [...(e.dataTransfer?.files ?? [])]
  if (files.length) await importAndPlace(files, at)
}

async function importAndPlace(files: File[], dropAt?: { x: number; y: number }) {
  // Decided before the upload: the user may switch boards or pan while it runs.
  const board = boardId.value
  const at = dropAt ?? canvas.viewCenter()
  // Pictures, clips and sounds (a sound is a player card); fonts go to the Library, not the board.
  const media = files.filter((f) => IMPORTABLE_FILE.test(f.name) && !FONT_FILE.test(f.name))
  if (!media.length) return toast.error('Only images, videos and sounds can go on the board')
  try {
    const imported = await assets.importFiles(media)
    addAssetsToBoard(imported.map((a) => a.id), at, board)
  } catch (err) {
    toast.error('Import failed', { description: errorMessage(err) })
  }
}

/** Where the board was right-clicked: Upload from its menu places the files there. */
const menuAt = ref<{ x: number; y: number }>()
const filePicker = ref<HTMLInputElement>()
function upload() {
  const input = filePicker.value
  if (!input) return
  const at = menuAt.value
  input.value = ''
  input.onchange = () => {
    const files = [...(input.files ?? [])]
    if (files.length) void importAndPlace(files, at)
  }
  input.click()
}

const CLIP_TYPE = 'application/x-studio-canvas'

function active() {
  return editor.workspace === 'canvas' && !canvas.editingId && !isTyping(document.activeElement)
}

/** Text selected on the page (an Inspector prompt, a toast): copy that, not the board items. */
function textSelected() {
  const sel = window.getSelection()
  return Boolean(sel && !sel.isCollapsed && sel.toString().trim())
}

useEventListener(document, 'copy', (e: ClipboardEvent) => {
  if (!active() || textSelected() || !canvas.selection.length || !e.clipboardData) return
  const ids = withFrameContents(canvas.items, canvas.selection)
  e.clipboardData.setData(CLIP_TYPE, JSON.stringify(canvas.items.filter((i) => ids.has(i.id))))
  e.clipboardData.setData('text/plain', canvas.selectedItems.map((i) => (i.kind === 'text' || i.kind === 'note' ? i.text : (i.name ?? ''))).filter(Boolean).join('\n'))
  e.preventDefault()
})
useEventListener(document, 'cut', (e: ClipboardEvent) => {
  if (!active() || textSelected() || !canvas.selection.length || !e.clipboardData) return
  const ids = withFrameContents(canvas.items, canvas.selection)
  e.clipboardData.setData(CLIP_TYPE, JSON.stringify(canvas.items.filter((i) => ids.has(i.id))))
  e.preventDefault()
  removeItems(boardId.value, [...ids])
})
// Images are pasted from the paste event only (never on ⌘V keydown), or they'd arrive twice.
useEventListener(document, 'paste', (e: ClipboardEvent) => {
  if (!active() || !e.clipboardData) return
  const data = e.clipboardData
  const ours = data.getData(CLIP_TYPE)
  if (ours) {
    e.preventDefault()
    try {
      // Repaired like a canvas read from disk: the clipboard can hold anything another page put there.
      const pasted = sanitizeCanvas({ boards: [{ id: 'paste', name: '', items: JSON.parse(ours) as CanvasItem[] }] })?.boards[0]?.items ?? []
      // Copied in another project: its media and generations don't exist here.
      const items = pasted.filter((i) => i.kind !== 'asset' || (i.assetId ? Boolean(assets.get(i.assetId)) : !i.generationId || Boolean(jobs.byId[i.generationId])))
      if (items.length < pasted.length) {
        const skipped = pasted.length - items.length
        toast.warning(`${skipped} image${skipped === 1 ? '' : 's'} from another project left out`, { description: 'Import the media into this project to use it here.' })
      }
      if (items.length) addItems(boardId.value, cloneItems(items, items, { x: 40, y: 40 }), 'Paste')
    } catch {
      toast.error('Could not paste those items')
    }
    return
  }
  const files = [...data.files]
  if (files.length) {
    e.preventDefault()
    void importAndPlace(files)
    return
  }
  const text = data.getData('text/plain').trim()
  if (text) {
    e.preventDefault()
    const c = canvas.viewCenter()
    addItems(boardId.value, [{ kind: 'note', id: newItemId(), text, color: 'yellow', x: Math.round(c.x - 130), y: Math.round(c.y - 130), w: 260, h: 260 }], 'Paste note')
  }
})

useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  if (e.code === 'Space' && active() && !e.repeat) {
    spaceHeld.value = true
    e.preventDefault()
  }
})
useEventListener(window, 'keyup', (e: KeyboardEvent) => {
  if (e.code === 'Space') spaceHeld.value = false
})
// Space released while another window had focus never sends keyup here.
useEventListener(window, 'blur', () => (spaceHeld.value = false))

const cursor = computed(() => {
  const g = gesture.value
  if (g?.mode === 'pan') return 'grabbing'
  if (spaceHeld.value || canvas.tool === 'hand') return 'grab'
  if (canvas.tool !== 'select') return 'crosshair'
  return 'default'
})

const marqueeStyle = computed(() => {
  const g = gesture.value
  if (g?.mode !== 'marquee' && g?.mode !== 'draw') return undefined
  const r = rectFromPoints(g.start, g.current)
  return boxStyle(r)
})

onMounted(() => host.value?.focus({ preventScroll: true }))

defineExpose({ importAndPlace })

const isPendingFailed = (i: CanvasItem) => i.kind === 'asset' && !i.assetId && ['failed', 'canceled', 'needs_attention'].includes(jobs.byId[i.generationId ?? '']?.status ?? '')
/**
 * An element's turn on the board, plus in animation mode its opacity, scale and rotation at the playhead (hidden ones
 * stay faintly visible to grab).
 */
/** Elements used as masks (and members of groups used as masks): shown faintly, since they aren't drawn in exports. */
const mattes = computed(() => {
  const by = new Set(canvas.items.flatMap((i) => (i.clipBy ? [i.clipBy] : [])))
  if (!by.size) return new Set<string>()
  return new Set(canvas.items.filter((i) => by.has(i.id) || ancestorGroups(canvas.byId, i).some((g) => by.has(g.id))).map((i) => i.id))
})

function itemStyle(i: CanvasItem) {
  const a = canvas.animOf(i)
  const rotation = canvas.rotationOf(i) + (a?.rotation ?? 0)
  const sx = (a?.scale ?? 1) * (a?.stretch?.x ?? 1)
  const sy = (a?.scale ?? 1) * (a?.stretch?.y ?? 1)
  const transform = sx !== 1 || sy !== 1 || rotation ? `rotate(${rotation}deg) scale(${sx}, ${sy})` : undefined
  // The element's blend mode, as CSS mixes it with the board under it (the renderers use the canvas equivalent).
  const mixBlendMode = ('blend' in i && i.blend ? (i.blend === 'add' ? 'plus-lighter' : i.blend) : undefined) as CSSProperties['mixBlendMode']
  const matte = mattes.value.has(i.id) ? 0.3 : 1
  return a ? { opacity: Math.max(0.15, a.opacity) * matte, transform, mixBlendMode } : { opacity: matte < 1 ? matte : undefined, transform, mixBlendMode }
}
const hoverable = (i: CanvasItem) => canvas.tool === 'select' && !i.locked && !canvas.selection.includes(i.id)
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child>
      <div
        ref="host"
        tabindex="0"
        class="canvas-board relative size-full touch-none overflow-hidden outline-none"
        :style="{ ...boardStyle, cursor }"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerCancel"
        @dblclick="onDoubleClick"
        @wheel="onWheel"
        @dragover="onDragOver"
        @drop.prevent="onDrop"
        @pointerover="onHover"
        @pointerleave="unhoverSoon"
        @contextmenu="menuAt = toBoard(vp, local($event))"
      >
        <div class="absolute top-0 left-0 origin-top-left" :style="worldStyle">
          <!-- Frames with their (clipped) contents -->
          <div
            v-for="f in visibleFrames"
            :key="f.id"
            :data-item-id="f.id"
            class="canvas-item absolute"
            :style="boxStyle(canvas.rectOf(f))"
          >
            <CanvasItemView :item="f" />
            <div class="absolute inset-0 overflow-hidden">
              <div
                v-for="c in childrenByFrame.get(f.id) ?? []"
                :key="c.id"
                :data-item-id="c.id"
                :class="cn('canvas-item absolute', hoverable(c) && 'hover:outline hover:outline-brand/70')"
                :style="{ ...boxStyle(canvas.rectOf(c), canvas.rectOf(f)), ...itemStyle(c), outlineWidth: `${1.5 / vp.zoom}px` }"
              >
                <CanvasItemView
                  :item="c"
                  :zoom="vp.zoom"
                  :asset="c.kind === 'asset' ? assets.get(c.assetId) : undefined"
                  :job="c.kind === 'asset' && c.generationId ? jobs.byId[c.generationId] : undefined"
                  :editing="canvas.editingId === c.id"
                  :anim="canvas.animOf(c)?.ri"
                  @commit="(t) => commitText(c, t)"
                  @cancel="canvas.editingId = undefined"
                />
              </div>
            </div>
          </div>
          <!-- Free items -->
          <div
            v-for="it in visibleFree"
            :key="it.id"
            :data-item-id="it.id"
            :class="cn('canvas-item absolute', hoverable(it) && 'hover:outline hover:outline-brand/70', isPendingFailed(it) && 'opacity-90')"
            :style="{ ...boxStyle(canvas.rectOf(it)), ...itemStyle(it), outlineWidth: `${1.5 / vp.zoom}px` }"
          >
            <CanvasItemView
              :item="it"
              :zoom="vp.zoom"
              :asset="it.kind === 'asset' ? assets.get(it.assetId) : undefined"
              :job="it.kind === 'asset' && it.generationId ? jobs.byId[it.generationId] : undefined"
              :editing="canvas.editingId === it.id"
              :anim="canvas.animOf(it)?.ri"
              @commit="(t) => commitText(it, t)"
              @cancel="canvas.editingId = undefined"
            />
          </div>
          <svg v-if="lineage.length" class="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1">
            <path
              v-for="l in lineage"
              :key="l.id"
              :d="l.d"
              fill="none"
              stroke="var(--brand)"
              stroke-opacity="0.55"
              stroke-width="1.5"
              stroke-dasharray="6 5"
              vector-effect="non-scaling-stroke"
            />
          </svg>
        </div>

        <!-- Screen-space overlay -->
        <div class="pointer-events-none absolute inset-0">
          <div
            v-for="l in frameLabels"
            :key="l.id"
            :data-frame-label="l.id"
            class="pointer-events-auto absolute flex max-w-full cursor-default items-baseline gap-1.5 truncate text-[11px] leading-4 text-muted-foreground hover:text-foreground"
            :class="canvas.selection.includes(l.id) && 'text-brand'"
            :style="{ left: `${l.x}px`, top: `${l.y}px`, maxWidth: `${Math.max(60, l.w)}px` }"
          >
            <span :data-frame-label="l.id" class="truncate font-medium">{{ l.name }}</span>
            <span :data-frame-label="l.id" class="tabular shrink-0 text-[10px] opacity-70">{{ l.size }}</span>
          </div>
          <div
            v-for="s in selectedRects"
            :key="s.id"
            class="absolute outline-[1.5px] outline-brand outline-solid"
            :style="{ ...boxStyle(s.r), transform: s.deg ? `rotate(${s.deg}deg)` : undefined }"
          />
          <div
            v-if="selectionBox && selectedRects.length > 1"
            class="absolute outline outline-brand/60 outline-dashed"
            :style="boxStyle(selectionBox)"
          />
          <template v-if="single && !gesture">
            <div
              v-for="h in HANDLES"
              :key="h"
              :data-handle="h"
              class="pointer-events-auto absolute size-2 rounded-[2px] border border-brand bg-white"
              :style="handleStyle(h, toScreen(vp, canvas.rectOf(single)), canvas.rotationOf(single))"
            />
            <div
              v-if="rotatable"
              data-handle="rotate"
              title="Rotate (Shift: 15° steps)"
              class="pointer-events-auto absolute size-2 rounded-full border border-brand bg-white"
              :style="handleStyle('rotate', toScreen(vp, canvas.rectOf(single)), canvas.rotationOf(single))"
            />
          </template>
          <div v-for="g in guideLines" :key="g.i" class="absolute bg-pink-500" :style="g.style" />
          <div v-if="cameraBox" class="absolute border-2 border-dashed border-role-motion" :style="cameraBox">
            <span class="absolute -top-5 left-0 rounded bg-role-motion px-1 text-[10px] font-medium text-white">Camera</span>
          </div>
          <div v-if="hovered" class="absolute -translate-y-full" :style="hovered.style" @pointerenter="keepHover" @pointerleave="unhoverSoon">
            <ResultActions :asset="hovered.asset" :item="hovered.item" :narrow="hovered.narrow" />
          </div>
          <div
            v-if="marqueeStyle"
            :class="cn('absolute border', gesture?.mode === 'draw' ? 'border-brand bg-brand/5' : 'border-brand/70 bg-brand/10')"
            :style="marqueeStyle"
          />
        </div>
        <slot />
        <input ref="filePicker" type="file" accept="image/*,video/*,audio/*" multiple class="hidden" data-canvas-upload-input="" />
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent class="w-64">
      <CanvasMenu @upload="upload" />
    </ContextMenuContent>
  </ContextMenu>
</template>
