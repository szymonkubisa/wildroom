import { groupMembers } from '@shared/canvas/groups'
import { unionRect } from '@shared/canvas/geometry'
import { unanchorTracks } from '@shared/motion/anchors'
import { trackValues } from '@shared/motion/edit'
import { isMotionItem } from '@shared/motion/evaluate'
import * as ops from '@shared/timeline'
import type { Rect } from '@shared/types/canvas'
import { nextTick } from 'vue'
import { transport } from '@/features/editor/transport'
import { useCanvasStore } from '@/stores/canvas'
import { useEditorStore } from '@/stores/editor'
import { useProjectStore } from '@/stores/project'
import { commitRects } from './useCanvasDoc'

/**
 * Animation mode on the board: a motion clip's frame shown at the timeline's playhead, its elements where the
 * animation has them. Moving an element while recording keys its offset at the playhead; otherwise it moves its place
 * on the board (the animation moves along with it).
 */

/** Opens the clip's frame on its board in animation mode, with the playhead inside the clip. */
export function openInCanvas(clipId: string) {
  const project = useProjectStore()
  const canvas = useCanvasStore()
  const editor = useEditorStore()
  const spine = project.layout.spine.find((s) => s.id === clipId)
  const connected = project.layout.connected.find((c) => c.id === clipId)
  const clip = spine?.item ?? connected?.item.clip
  const start = spine?.start ?? connected?.start
  if (clip?.kind !== 'motion' || start === undefined) return
  if (editor.playhead < start || editor.playhead >= start + clip.duration) transport.seek(start)
  canvas.boardId = clip.boardId
  canvas.animClipId = clipId
  canvas.recording = false
  editor.workspace = 'canvas'
  // The board switch clears the selection: select the frame and frame it once the board is showing.
  void nextTick(() => {
    canvas.select([clip.frameId])
    canvas.requestZoom('selection')
  })
}

export function closeAnimation() {
  const canvas = useCanvasStore()
  canvas.animClipId = undefined
  canvas.recording = false
}

/**
 * Commits dragged or resized rectangles. Outside animation mode (or for anything not inside the animated frame) they
 * are the items' new places. Inside it they are where the animation shows them: recording keys the offset at the
 * playhead, otherwise the place on the board moves by as much. Moving the frame itself always moves the board layout.
 */
export function commitBoardRects(boardId: string, rects: Map<string, Rect>, label: string, opts: { moveOnly?: boolean } = {}) {
  const canvas = useCanvasStore()
  const project = useProjectStore()
  const a = canvas.anim
  if (!a || boardId !== a.clip.boardId) return commitRects(boardId, rects, label, opts)
  const animated = (id: string) => {
    const item = canvas.byId.get(id)
    return item && item.frameId === a.clip.frameId && isMotionItem(item) ? item : undefined
  }
  const record = canvas.recording && !rects.has(a.clip.frameId)
  // A group in the animated frame is shown round its members where the animation has them: moved or resized, it
  // stands for its members moved or scaled within that shown box — each then handled like an element of its own (its
  // place on the board moved, or keyed when recording), never the playhead's animation written into the layout.
  rects = new Map(rects)
  for (const [id, r] of [...rects]) {
    const g = canvas.byId.get(id)
    if (g?.kind !== 'group' || g.frameId !== a.clip.frameId) continue
    rects.delete(id)
    const members = groupMembers(canvas.items, g.id).filter((m) => m.kind !== 'group' && !rects.has(m.id))
    const shownOf = (m: (typeof members)[number]) => {
      const off = canvas.animOf(m)
      return { x: m.x + (off?.x ?? 0), y: m.y + (off?.y ?? 0), w: m.w, h: m.h }
    }
    const box = unionRect(members.map(shownOf))
    if (!box) continue
    const sx = opts.moveOnly ? 1 : r.w / Math.max(1, box.w)
    const sy = opts.moveOnly ? 1 : r.h / Math.max(1, box.h)
    for (const m of members) {
      const s = shownOf(m)
      rects.set(m.id, { x: r.x + (s.x - box.x) * sx, y: r.y + (s.y - box.y) * sy, w: m.w * sx, h: m.h * sy })
    }
  }
  const base = new Map<string, Rect>()
  const tracks = { ...a.clip.tracks }
  let keyed = false
  for (const [id, r] of rects) {
    const item = animated(id)
    if (!item) {
      base.set(id, r)
      continue
    }
    const now = trackValues(tracks[id], a.t).transform
    // Where it shows now (its keys plus its groups, behaviours or route) against where it was dropped.
    const shown = canvas.animOf(item) ?? { x: now.x, y: now.y }
    if (record) {
      const transform = ops.upsertKey(tracks[id]?.transform, a.t, { ...now, x: Math.round(now.x + r.x - item.x - shown.x), y: Math.round(now.y + r.y - item.y - shown.y) })
      tracks[id] = { ...tracks[id], transform }
      keyed = true
      // A resize while recording changes the element's size on the board (size isn't animated).
      if (!opts.moveOnly && (Math.round(r.w) !== item.w || Math.round(r.h) !== item.h)) base.set(id, { x: item.x, y: item.y, w: r.w, h: r.h })
    } else {
      base.set(id, { ...r, x: r.x - shown.x, y: r.y - shown.y })
    }
  }
  if (base.size) commitRects(boardId, base, label, opts)
  if (keyed) project.apply(ops.setProps(a.clip.id, { tracks: unanchorTracks(tracks, a.shifts) }), rects.size === 1 ? 'Record keyframe' : 'Record keyframes')
}
