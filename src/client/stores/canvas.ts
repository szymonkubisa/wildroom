import { type SnapGuide, type Viewport, toBoard, unionRect } from '@shared/canvas/geometry'
import { ancestorGroups, groupMembers } from '@shared/canvas/groups'
import { anchorShifts, anchoredClip, voiceTimings } from '@shared/motion/anchors'
import { type ResolvedItem, evaluateMotion } from '@shared/motion/evaluate'
import type { MotionClip, MotionItemTransform } from '@shared/types/project-doc'
import { type CanvasItem, DEFAULT_BOARD_ID, type Rect, boardsOf } from '@shared/types/canvas'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import type { GenerateTarget } from './generate'
import { useAssetsStore } from './assets'
import { useEditorStore } from './editor'
import { useProjectStore } from './project'

export type CanvasTool = 'select' | 'hand' | 'frame' | 'text' | 'note' | 'rect' | 'line'

/** Width new images get on the board when nothing else decides it. */
export const DEFAULT_ITEM_WIDTH = 512

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

/**
 * Canvas UI state that isn't part of the undoable document: active board, selection, tool, viewport per board and
 * the live geometry of a drag (rendered on top of the document until the pointer is released and one edit commits).
 */
export const useCanvasStore = defineStore('canvas', () => {
  const project = useProjectStore()
  const boardId = ref(DEFAULT_BOARD_ID)
  const selection = ref<string[]>([])
  const tool = ref<CanvasTool>('select')
  const showLineage = ref(readJson('canvas.lineage', true))
  const viewports = ref<Record<string, Viewport>>({})
  /** Item id → rectangle while dragging or resizing. */
  const live = shallowRef<Map<string, Rect>>(new Map())
  /** Item id → rotation (degrees) while the rotate handle is dragged. */
  const liveRotation = shallowRef<Map<string, number>>(new Map())
  const guides = shallowRef<SnapGuide[]>([])
  /** Text or note being edited in place. */
  const editingId = ref<string>()
  /** The group double-clicked into: clicks pick its members instead of the whole group. */
  const enteredGroupId = ref<string>()
  /** Size of the board view in CSS px (for placing things in the middle of what you see). */
  const viewSize = ref({ w: 1200, h: 800 })
  /**
   * How much of the view's bottom the floating Composer and the board's tools cover (CSS px): fitting and "the middle
   * of what you see" leave it out, so nothing lands or is framed under the Composer.
   */
  const dockInset = ref(0)
  /** Canvas dialog open over the workspace. */
  const dialog = ref<'export' | 'asset-set' | 'favicon'>()
  /** A brief from Home for Brief → asset set: it fills the dialog's brief once. */
  const briefDraft = ref<string>()
  /** Motion clip being animated on its frame (Open in Canvas), and whether moves record keyframes. */
  const animClipId = ref<string>()
  const recording = ref(false)
  /** Bumped to ask the view to frame something (fit all, the selection, 100%). */
  const zoomRequest = ref<{ mode: 'fit' | 'selection' | 'actual'; nonce: number; at: number }>()

  const boards = computed(() => boardsOf(project.doc.canvas))
  const board = computed(() => boards.value.find((b) => b.id === boardId.value) ?? boards.value[0]!)
  const items = computed(() => board.value.items)
  const byId = computed(() => new Map(items.value.map((i) => [i.id, i])))
  const selectedItems = computed(() => selection.value.map((id) => byId.value.get(id)).filter((i): i is CanvasItem => Boolean(i)))
  /** Images and videos selected on the board, for "generate from selection". */
  const selectedAssetIds = computed(() =>
    selectedItems.value.flatMap((i) => (i.kind === 'asset' && i.assetId ? [i.assetId] : [])),
  )
  const selectedImageIds = computed(() => {
    const assets = useAssetsStore()
    return selectedAssetIds.value.filter((id) => assets.get(id)?.kind === 'image')
  })
  const viewport = computed<Viewport>({
    get: () => viewports.value[board.value.id] ?? { x: viewSize.value.w / 2, y: viewSize.value.h / 2, zoom: 0.5 },
    set: (v) => (viewports.value = { ...viewports.value, [board.value.id]: v }),
  })

  /**
   * The motion clip open on the board, where it starts on the timeline and the animation frame at the playhead
   * (undefined once the clip is gone, detached, or on another board).
   */
  const anim = computed<{ clip: MotionClip; shifts: Record<string, number>; start: number; local: number; t: number } | undefined>(() => {
    const id = animClipId.value
    if (!id) return undefined
    const spine = project.layout.spine.find((s) => s.id === id)
    const connected = project.layout.connected.find((c) => c.id === id)
    const clip = spine?.item ?? connected?.item.clip
    const start = spine?.start ?? connected?.start
    if (clip?.kind !== 'motion' || clip.detached || start === undefined) return undefined
    const local = Math.max(0, Math.min(clip.duration - 1, useEditorStore().playhead - start))
    // As it plays: keys timed to the voice-over on their words (`shifts` turns edits back into stored keys).
    const assets = useAssetsStore()
    const shifts = anchorShifts(clip, start, voiceTimings(project.layout, (id) => assets.get(id)?.alignment?.words), project.doc.settings.fps)
    return { clip: anchoredClip(clip, shifts), shifts, start, local, t: local + (clip.offset ?? 0) }
  })

  /** The open motion clip's frame as the clip draws it at the playhead: every element resolved, by id. */
  const animView = computed(() => {
    const a = anim.value
    if (!a || board.value.id !== a.clip.boardId) return undefined
    const frame = byId.value.get(a.clip.frameId)
    if (frame?.kind !== 'frame') return undefined
    const view = evaluateMotion(a.clip, frame, items.value.filter((i) => i.frameId === frame.id), a.local)
    return { frame, view, byId: new Map(view.items.map((r) => [r.item.id, r])) }
  })

  /**
   * How the open motion clip shows an element of its frame at the playhead: its offset from its board place, scale,
   * stretch, turn on top of its own, opacity — everything that moves it (keys, its groups, behaviours, a route) — and
   * the full resolved state to draw (undefined for anything else).
   */
  function animOf(item: CanvasItem): (MotionItemTransform & { opacity: number; stretch?: { x: number; y: number }; ri: ResolvedItem }) | undefined {
    const v = animView.value
    const ri = v && item.frameId === v.frame.id ? v.byId.get(item.id) : undefined
    if (!v || !ri) return undefined
    return {
      x: ri.rect.x + v.frame.x - item.x,
      y: ri.rect.y + v.frame.y - item.y,
      scale: ri.scale,
      rotation: ri.rotation - (item.rotation ?? 0),
      opacity: ri.opacity,
      stretch: ri.stretch,
      ri,
    }
  }

  /** An item's rotation on the board right now (live while the rotate handle is dragged). */
  function rotationOf(item: CanvasItem): number {
    return liveRotation.value.get(item.id) ?? item.rotation ?? 0
  }

  /** Where an item is drawn right now: its live drag rectangle, its animated place, or its document position. */
  function rectOf(item: CanvasItem): Rect {
    const dragged = live.value.get(item.id)
    if (dragged) return dragged
    // A member of a group being resized scales with the group's live box.
    if (item.groupId && live.value.size)
      for (const g of ancestorGroups(byId.value, item)) {
        const r = live.value.get(g.id)
        if (!r) continue
        // In animation mode the group's box is round its members where the animation has them: scaled from that.
        if (animView.value && g.frameId === animView.value.frame.id) {
          const shown = (m: CanvasItem): Rect => {
            const a = animOf(m)
            return a ? { x: m.x + a.x, y: m.y + a.y, w: m.w, h: m.h } : m
          }
          const box = unionRect(groupMembers(items.value, g.id).filter((m) => m.kind !== 'group').map(shown))
          if (box) {
            const s = shown(item)
            const kx = r.w / Math.max(1, box.w)
            const ky = r.h / Math.max(1, box.h)
            return { x: r.x + (s.x - box.x) * kx, y: r.y + (s.y - box.y) * ky, w: item.w * kx, h: item.h * ky }
          }
        }
        const sx = r.w / Math.max(1, g.w)
        const sy = r.h / Math.max(1, g.h)
        return { x: r.x + (item.x - g.x) * sx, y: r.y + (item.y - g.y) * sy, w: item.w * sx, h: item.h * sy }
      }
    // In animation mode a group's box is where its members are now.
    if (item.kind === 'group' && animView.value && item.frameId === animView.value.frame.id) {
      const members = groupMembers(items.value, item.id).filter((m) => m.kind !== 'group')
      return unionRect(members.map(rectOf)) ?? item
    }
    const a = animOf(item)
    return a && (a.x || a.y) ? { x: item.x + a.x, y: item.y + a.y, w: item.w, h: item.h } : item
  }

  function select(ids: string[], additive = false) {
    selection.value = additive ? [...new Set([...selection.value, ...ids])] : ids
  }

  function toggle(id: string) {
    selection.value = selection.value.includes(id) ? selection.value.filter((x) => x !== id) : [...selection.value, id]
  }

  function setLive(rects: Map<string, Rect>, snapGuides: SnapGuide[] = []) {
    live.value = rects
    guides.value = snapGuides
  }

  function clearLive() {
    if (live.value.size) live.value = new Map()
    if (guides.value.length) guides.value = []
  }

  function requestZoom(mode: 'fit' | 'selection' | 'actual') {
    zoomRequest.value = { mode, nonce: (zoomRequest.value?.nonce ?? 0) + 1, at: Date.now() }
  }

  /** Board point in the middle of the view. */
  function viewCenter(): { x: number; y: number } {
    return toBoard(viewport.value, { x: viewSize.value.w / 2, y: Math.max(0, viewSize.value.h - dockInset.value) / 2 })
  }

  /**
   * Where a generation goes when the panel has no explicit target: into the one selected frame, next to the
   * selection, or the middle of the view.
   */
  function defaultTarget(): GenerateTarget {
    const sel = selectedItems.value
    if (sel.length === 1 && sel[0]!.kind === 'frame') {
      const f = sel[0]!
      return { canvas: { boardId: board.value.id, frameId: f.id }, label: `Board · fills “${f.name ?? 'Frame'}”` }
    }
    const bounds = unionRect(sel.map(rectOf))
    if (bounds) {
      return {
        canvas: { boardId: board.value.id, anchor: { x: bounds.x + bounds.w + 40, y: bounds.y }, width: DEFAULT_ITEM_WIDTH },
        label: 'Board · next to the selection',
      }
    }
    const c = viewCenter()
    return {
      canvas: { boardId: board.value.id, anchor: { x: c.x - DEFAULT_ITEM_WIDTH / 2, y: c.y - DEFAULT_ITEM_WIDTH / 2 }, width: DEFAULT_ITEM_WIDTH },
      label: 'Board · new item in view',
    }
  }

  // Per project: last board and the view of each board.
  watch(
    () => project.id,
    (pid) => {
      selection.value = []
      editingId.value = undefined
      clearLive()
      if (!pid) return
      viewports.value = readJson(`canvas.view.${pid}`, {})
      boardId.value = readJson(`canvas.board.${pid}`, DEFAULT_BOARD_ID)
    },
    { immediate: true },
  )
  let viewTimer: ReturnType<typeof setTimeout> | undefined
  watch(viewports, (v) => {
    const pid = project.id
    if (!pid) return
    clearTimeout(viewTimer)
    viewTimer = setTimeout(() => {
      try {
        localStorage.setItem(`canvas.view.${pid}`, JSON.stringify(v))
      } catch {
        // Storage full or blocked: the view just won't be remembered.
      }
    }, 400)
  })
  watch(boardId, (id) => {
    if (project.id) localStorage.setItem(`canvas.board.${project.id}`, JSON.stringify(id))
    selection.value = []
    enteredGroupId.value = undefined
  })
  // Selecting anything outside the entered group leaves it.
  watch(selection, (ids) => {
    const g = enteredGroupId.value
    if (!g) return
    if (!byId.value.has(g) || ids.some((id) => { const i = byId.value.get(id); return !i || !ancestorGroups(byId.value, i).some((a) => a.id === g) })) enteredGroupId.value = undefined
  })
  watch(showLineage, (v) => localStorage.setItem('canvas.lineage', JSON.stringify(v)))
  // Items removed by undo or another edit drop out of the selection.
  watch(byId, (map) => {
    if (selection.value.some((id) => !map.has(id))) selection.value = selection.value.filter((id) => map.has(id))
    if (editingId.value && !map.has(editingId.value)) editingId.value = undefined
  })

  return {
    boardId,
    selection,
    tool,
    showLineage,
    viewports,
    live,
    liveRotation,
    rotationOf,
    guides,
    editingId,
    enteredGroupId,
    viewSize,
    dockInset,
    zoomRequest,
    animClipId,
    recording,
    anim,
    animView,
    animOf,
    dialog,
    briefDraft,
    boards,
    board,
    items,
    byId,
    selectedItems,
    selectedAssetIds,
    selectedImageIds,
    viewport,
    rectOf,
    select,
    toggle,
    setLive,
    clearLive,
    requestZoom,
    viewCenter,
    defaultTarget,
  }
})
