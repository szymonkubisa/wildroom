import { aspectValue, fitInside, frameAt, intersects, rowRightOf, withFrameContents } from '@shared/canvas/geometry'
import { ancestorGroups, fitGroups, groupMembers } from '@shared/canvas/groups'
import { parseMarkup } from '@shared/canvas/richText'
import type { CanvasBoard, CanvasDoc, CanvasFrameItem, CanvasItem, CanvasTextItem, Rect } from '@shared/types/canvas'
import { DEFAULT_BOARD_ID, emptyBoard } from '@shared/types/canvas'
import type { GenKind, GenerationDTO } from '@shared/types/jobs'
import { nanoid } from 'nanoid'
import { toast } from 'vue-sonner'
import { useAssetsStore } from '@/stores/assets'
import { DEFAULT_ITEM_WIDTH, useCanvasStore } from '@/stores/canvas'
import type { CanvasTarget } from '@/stores/generate'
import { useProjectStore } from '@/stores/project'
import { changesTextLayout, fitText } from './textFit'

export const newItemId = () => nanoid(10)

/** Generation kinds whose results are pictures. */
export const VISUAL_KINDS: ReadonlySet<GenKind> = new Set<GenKind>(['image', 'video', 'upscale', 'lipsync', 'cutout', 'vectorize'])
/** Generation kinds whose results are sounds: on the board they are a player card. */
export const SOUND_KINDS: ReadonlySet<GenKind> = new Set<GenKind>(['speech', 'dialogue', 'music', 'sfx', 'foley'])
/** Everything a generation can put on the board. */
export const BOARD_KINDS: ReadonlySet<GenKind> = new Set<GenKind>([...VISUAL_KINDS, ...SOUND_KINDS])
/** A sound's card on the board (a sound has no picture size to follow). */
export const AUDIO_ITEM = { w: 440, h: 120 } as const

/**
 * Runs an edit on one board as an undoable project edit. The default board is created on its first edit, so a
 * project that never used the canvas carries no canvas data. Labels say "Canvas:" because the undo stack is
 * shared with the timeline.
 */
export function editBoard(boardId: string, label: string, fn: (board: CanvasBoard, canvas: CanvasDoc) => void): boolean {
  return useProjectStore().apply((draft) => {
    let board = draft.canvas?.boards.find((b) => b.id === boardId)
    // Only the implicit default board is created on demand; an edit for a board that's gone (undone) changes nothing.
    if (!board && !draft.canvas?.boards.length && boardId === DEFAULT_BOARD_ID) {
      draft.canvas ??= { boards: [] }
      board = emptyBoard()
      draft.canvas.boards.push(board)
    }
    if (!board || !draft.canvas) return
    fn(board, draft.canvas)
    // Groups keep their members' bounds whatever the edit did.
    if (board.items.some((i) => i.kind === 'group' || i.groupId)) board.items = fitGroups(board.items)
  }, `Canvas: ${label}`)
}

export function addItems(boardId: string, items: CanvasItem[], label = 'Add', select = true) {
  if (!items.length) return
  editBoard(boardId, label, (b) => {
    // New items join the frame they land in.
    for (const item of items) {
      if (item.kind !== 'frame' && !item.frameId) {
        const frame = frameAt(b.items, item)
        if (frame) item.frameId = frame.id
      }
      fitText(item)
      b.items.push(item)
    }
  })
  if (select) useCanvasStore().select(items.map((i) => i.id))
}

export function updateItem(boardId: string, id: string, patch: Partial<CanvasItem>, label = 'Change') {
  editBoard(boardId, label, (b) => {
    const item = b.items.find((i) => i.id === id)
    if (!item) return
    Object.assign(item, patch)
    if (changesTextLayout(patch)) fitText(item)
  })
}

/** A text element's text from markup (`**bold**`, `*italic*`, … see `richText.ts`): its plain text and spans. */
export function setTextMarkup(boardId: string, id: string, markup: string, extra: Partial<CanvasTextItem> = {}, label = 'Edit text') {
  editBoard(boardId, label, (b) => {
    const item = b.items.find((i) => i.id === id)
    if (item?.kind !== 'text') return
    const { text, spans } = parseMarkup(markup, item)
    item.text = text
    if (spans) item.spans = spans
    else delete item.spans
    Object.assign(item, extra)
    fitText(item)
  })
}

export function updateItems(boardId: string, ids: string[], patch: Partial<CanvasItem>, label = 'Change') {
  const set = new Set(ids)
  editBoard(boardId, label, (b) => {
    const refit = changesTextLayout(patch)
    for (const item of b.items) {
      if (!set.has(item.id)) continue
      Object.assign(item, patch)
      if (refit) fitText(item)
    }
  })
}

/**
 * Commits a drag or resize: the new rectangles, and frame membership for items that moved on their own (an item
 * dropped into a frame joins it, one dragged out leaves it; contents moving with their frame keep their link).
 */
export function commitRects(boardId: string, rects: Map<string, Rect>, label: string, opts: { moveOnly?: boolean } = {}) {
  if (!rects.size) return
  editBoard(boardId, label, (b) => {
    const movingFrames = new Set(b.items.filter((i) => i.kind === 'frame' && rects.has(i.id)).map((i) => i.id))
    // A moved or resized group takes its members (and theirs) along: moved by as much, scaled with its box.
    for (const g of b.items) {
      const r = rects.get(g.id)
      if (g.kind !== 'group' || !r) continue
      const sx = opts.moveOnly ? 1 : r.w / Math.max(1, g.w)
      const sy = opts.moveOnly ? 1 : r.h / Math.max(1, g.h)
      for (const m of groupMembers(b.items, g.id)) {
        if (rects.has(m.id) || m.kind === 'group') continue
        rects.set(m.id, { x: r.x + (m.x - g.x) * sx, y: r.y + (m.y - g.y) * sy, w: m.w * sx, h: m.h * sy })
      }
    }
    for (const item of b.items) {
      const r = rects.get(item.id)
      if (!r) continue
      item.x = Math.round(r.x)
      item.y = Math.round(r.y)
      // A move keeps the size the document has now (a placeholder may have taken its image's shape mid-drag).
      if (opts.moveOnly) continue
      const w = Math.max(1, Math.round(r.w))
      const h = Math.max(1, Math.round(r.h))
      // Resized by hand: the box no longer follows the image's aspect.
      if (item.kind === 'asset' && item.fit && (w !== Math.round(item.w) || h !== Math.round(item.h))) delete item.fit
      item.w = w
      item.h = h
      // A text box takes the height of its text at the new width.
      fitText(item)
    }
    const byId = new Map(b.items.map((i) => [i.id, i]))
    for (const item of b.items) {
      if (item.kind === 'frame' || !rects.has(item.id)) continue
      if (item.frameId && movingFrames.has(item.frameId)) continue
      // A group's members stay in one frame: the one its outermost group lands in.
      const outer = ancestorGroups(byId, item).at(-1)
      const box = outer ? (rects.get(outer.id) ?? outer) : item
      const frame = frameAt(b.items, box, new Set([item.id, ...(outer ? [outer.id] : [])]))
      if (frame) item.frameId = frame.id
      else delete item.frameId
    }
  })
}

export function removeItems(boardId: string, ids: string[]) {
  const board = useCanvasStore().boards.find((b) => b.id === boardId)
  if (!board) return
  const remove = withFrameContents(board.items, ids)
  if (!remove.size) return
  editBoard(boardId, remove.size === 1 ? 'Delete item' : `Delete ${remove.size} items`, (b) => {
    b.items = b.items.filter((i) => !remove.has(i.id))
  })
  const canvas = useCanvasStore()
  canvas.selection = canvas.selection.filter((id) => !remove.has(id))
}

/** Copies items (and the contents of copied frames) offset by `offset`; returns the new ids. */
export function cloneItems(source: CanvasItem[], all: CanvasItem[], offset = { x: 32, y: 32 }): CanvasItem[] {
  const ids = withFrameContents(all, source.map((i) => i.id))
  const originals = all.filter((i) => ids.has(i.id))
  const map = new Map(originals.map((i) => [i.id, newItemId()]))
  return originals.map((i) => {
    const copy = structuredClone({ ...i }) as CanvasItem
    copy.id = map.get(i.id)!
    copy.x = i.x + offset.x
    copy.y = i.y + offset.y
    if (copy.frameId) {
      const mapped = map.get(copy.frameId)
      if (mapped) copy.frameId = mapped
      else delete copy.frameId
    }
    // A copy of a group's member alone leaves the group; a copied group keeps its copied members.
    if (copy.groupId) {
      const mapped = map.get(copy.groupId)
      if (mapped) copy.groupId = mapped
      else delete copy.groupId
    }
    return copy
  })
}

export function duplicateItems(boardId: string, ids: string[]) {
  const canvas = useCanvasStore()
  const board = canvas.boards.find((b) => b.id === boardId)
  if (!board || !ids.length) return
  const wanted = new Set(ids)
  // cloneItems copies in board order: the originals, frame contents included, line up with the copies.
  const originals = board.items.filter((i) => withFrameContents(board.items, ids).has(i.id))
  const copies = cloneItems(originals, board.items)
  editBoard(boardId, 'Duplicate', (b) => {
    for (const copy of copies) {
      // A copy of an item inside a frame stays in that frame (it lands inside it, offset).
      if (copy.kind !== 'frame' && !copy.frameId) {
        const frame = frameAt(b.items, copy)
        if (frame) copy.frameId = frame.id
      }
      b.items.push(copy)
    }
  })
  canvas.select(copies.filter((_, i) => wanted.has(originals[i]!.id)).map((c) => c.id))
}

export function reorder(boardId: string, ids: string[], where: 'front' | 'back') {
  const board = useCanvasStore().boards.find((b) => b.id === boardId)
  // A group moves with its members (in their order).
  const set = board ? withFrameContents(board.items, ids) : new Set(ids)
  editBoard(boardId, where === 'front' ? 'Bring to front' : 'Send to back', (b) => {
    const moving = b.items.filter((i) => set.has(i.id))
    const rest = b.items.filter((i) => !set.has(i.id))
    b.items = where === 'front' ? [...rest, ...moving] : [...moving, ...rest]
  })
}

/**
 * Groups the items (outermost picks: whole groups, or members of one entered group); they must share a frame and a
 * parent group. Returns the new group's id.
 */
export function groupItems(boardId: string, ids: string[]): string | undefined {
  const canvas = useCanvasStore()
  const board = canvas.boards.find((b) => b.id === boardId)
  const picked = board?.items.filter((i) => ids.includes(i.id) && i.kind !== 'frame') ?? []
  if (picked.length < 2) return undefined
  const frameId = picked[0]!.frameId
  const parent = picked[0]!.groupId
  if (picked.some((i) => i.frameId !== frameId || i.groupId !== parent)) {
    toast.warning('Group things that sit in the same frame (and the same group)')
    return undefined
  }
  const id = newItemId()
  editBoard(boardId, 'Group', (b) => {
    const set = new Set(picked.map((i) => i.id))
    const group: CanvasItem = { id, kind: 'group', name: 'Group', x: 0, y: 0, w: 1, h: 1 }
    if (frameId) group.frameId = frameId
    if (parent) group.groupId = parent
    let last = 0
    b.items.forEach((i, at) => {
      if (!set.has(i.id)) return
      i.groupId = id
      last = at
    })
    b.items.splice(last + 1, 0, group)
  })
  canvas.select([id])
  return id
}

/** Takes the groups apart: their members go to the groups' own parents, selected. */
export function ungroupItems(boardId: string, ids: string[]) {
  const canvas = useCanvasStore()
  const board = canvas.boards.find((b) => b.id === boardId)
  const groups = board?.items.filter((i) => i.kind === 'group' && ids.includes(i.id)) ?? []
  if (!groups.length) return
  const members = board!.items.filter((i) => groups.some((g) => g.id === i.groupId)).map((i) => i.id)
  editBoard(boardId, 'Ungroup', (b) => {
    const parents = new Map(groups.map((g) => [g.id, g.groupId]))
    for (const i of b.items) {
      if (!i.groupId || !parents.has(i.groupId)) continue
      const up = parents.get(i.groupId)
      if (up) i.groupId = up
      else delete i.groupId
    }
    b.items = b.items.filter((i) => !parents.has(i.id))
  })
  canvas.select(members)
}

// ------------------------------------------------------------------------------------------------ assets

/** Board size for an asset: its own aspect within `max` px; unknown sizes start square and follow once known. */
function assetSize(assetId: string, max = DEFAULT_ITEM_WIDTH): { w: number; h: number; fit?: boolean } {
  const a = useAssetsStore().get(assetId)
  if (a?.kind === 'audio') return { ...AUDIO_ITEM }
  if (a?.width && a.height) return fitInside(a.width, a.height, max)
  return { w: max, h: max, fit: true }
}

/** Puts library media on the board: a row centred on `at` (default: the middle of the view). */
export function addAssetsToBoard(assetIds: string[], at?: { x: number; y: number }, boardId?: string) {
  const canvas = useCanvasStore()
  const assets = useAssetsStore()
  // Pictures, clips and sounds (a sound is a player card); fonts aren't media to show.
  const visual = assetIds.filter((id) => assets.get(id)?.kind !== 'font')
  if (!visual.length) return
  const center = at ?? canvas.viewCenter()
  const sizes = visual.map((id) => assetSize(id))
  const total = sizes.reduce((s, x) => s + x.w, 0) + 40 * (sizes.length - 1)
  const rects = rowRightOf(undefined, sizes, 40, { x: center.x - total / 2, y: center.y - (sizes[0]?.h ?? 0) / 2 })
  const items: CanvasItem[] = visual.map((assetId, i) => ({
    kind: 'asset',
    id: newItemId(),
    assetId,
    ...rects[i]!,
    ...(sizes[i]!.fit ? { fit: true } : {}),
  }))
  addItems(boardId ?? canvas.board.id, items, visual.length === 1 ? 'Add image' : `Add ${visual.length} items`)
}

/** Aspect (w÷h) a generation's result will most likely have: its aspect param, else its first input image. */
function expectedAspect(job: GenerationDTO): number | undefined {
  const p = job.params
  const declared = aspectValue(p.aspectRatio ?? p.aspect_ratio ?? p.aspect)
  if (declared) return declared
  const assets = useAssetsStore()
  for (const key of ['image', 'firstFrame', 'referenceImages', 'video']) {
    const v = p[key]
    const id = Array.isArray(v) ? v[0] : v
    const a = typeof id === 'string' ? assets.get(id) : undefined
    if (a?.width && a.height) return a.width / a.height
  }
  return undefined
}

/**
 * Placeholders for new generations on a board. Into a frame: the first take fills it and every other take gets a copy
 * of the frame beside it. Otherwise: a row from the anchor. Each placeholder becomes the image once it's ready.
 */
export function placeGenerations(target: CanvasTarget, created: GenerationDTO[]) {
  const jobs = created.filter((j) => BOARD_KINDS.has(j.kind))
  if (!jobs.length) return
  const canvas = useCanvasStore()
  const board = canvas.boards.find((b) => b.id === target.boardId)
  const frame = target.frameId ? (board?.items.find((i) => i.id === target.frameId && i.kind === 'frame') as CanvasFrameItem | undefined) : undefined
  // Pictures fill the frame; sounds (no picture to fill it with) go in a row beside it.
  const framed = frame ? jobs.filter((j) => VISUAL_KINDS.has(j.kind)) : []
  const loose = jobs.filter((j) => !framed.includes(j))
  const items: CanvasItem[] = []
  if (frame) {
    framed.forEach((job, i) => {
      let host: CanvasFrameItem = frame
      if (i > 0) {
        host = { ...frame, id: newItemId(), x: frame.x + i * (frame.w + 80), name: `${frame.name ?? 'Frame'} · take ${i + 1}` }
        items.push(host)
      }
      items.push({ kind: 'asset', id: newItemId(), generationId: job.id, x: host.x, y: host.y, w: host.w, h: host.h, frameId: host.id })
    })
  }
  if (loose.length) {
    const width = target.width ?? DEFAULT_ITEM_WIDTH
    const sizes = loose.map((job) => {
      if (SOUND_KINDS.has(job.kind)) return { ...AUDIO_ITEM }
      const aspect = expectedAspect(job) ?? 1
      return { w: width, h: Math.round(width / aspect) }
    })
    const anchor = { ...(frame ? { x: frame.x, y: frame.y + frame.h + 40 } : (target.anchor ?? canvas.viewCenter())) }
    let rects = rowRightOf(undefined, sizes, 40, anchor)
    // Another batch from the same selection goes below the previous one instead of on top of it.
    const taken = board?.items ?? []
    for (let i = 0; i < 50 && rects.some((r) => taken.some((t) => intersects(t, r))); i++) {
      anchor.y += Math.max(...sizes.map((s) => s.h)) + 40
      rects = rowRightOf(undefined, sizes, 40, anchor)
    }
    // Pictures take their real aspect once they arrive; a sound's card keeps its size.
    loose.forEach((job, i) => items.push({ kind: 'asset', id: newItemId(), generationId: job.id, ...rects[i]!, ...(SOUND_KINDS.has(job.kind) ? {} : { fit: true }) }))
  }
  addItems(target.boardId, items, jobs.length === 1 ? 'Generate' : `Generate ${jobs.length} takes`, false)
  // A fast job can finish before its placeholder exists.
  useProjectStore().resolvePendingTakes()
}

// ------------------------------------------------------------------------------------------------ boards

export function addBoard(name?: string): string {
  const canvas = useCanvasStore()
  const id = `board-${nanoid(8)}`
  const label = name ?? `Board ${canvas.boards.length + 1}`
  useProjectStore().apply((draft) => {
    if (!draft.canvas) draft.canvas = { boards: [] }
    // The implicit default board becomes real first, so it keeps its place in the list.
    if (!draft.canvas.boards.length) draft.canvas.boards.push(emptyBoard())
    draft.canvas.boards.push({ id, name: label, items: [] })
  }, 'Canvas: New board')
  canvas.boardId = id
  return id
}

export function renameBoard(id: string, name: string) {
  editBoard(id, 'Rename board', (b) => (b.name = name.trim() || b.name))
}

export function removeBoard(id: string) {
  const canvas = useCanvasStore()
  if (canvas.boards.length <= 1) return
  useProjectStore().apply((draft) => {
    if (draft.canvas) draft.canvas.boards = draft.canvas.boards.filter((b) => b.id !== id)
  }, 'Canvas: Delete board')
  if (canvas.boardId === id) canvas.boardId = canvas.boards[0]!.id
}
