import { useEventListener } from '@vueuse/core'
import { withFrameContents } from '@shared/canvas/geometry'
import type { Rect } from '@shared/types/canvas'
import { isTyping } from '@/lib/shortcuts'
import { type CanvasTool, useCanvasStore } from '@/stores/canvas'
import { useEditorStore } from '@/stores/editor'
import { commitRects, duplicateItems, groupItems, removeItems, reorder, ungroupItems } from './useCanvasDoc'

const TOOL_KEYS: Record<string, CanvasTool> = { v: 'select', h: 'hand', f: 'frame', t: 'text', n: 'note', r: 'rect', l: 'line' }

/**
 * Canvas shortcuts (only while the canvas workspace is on screen and nothing is being typed). ⌘0 / ⌘± belong to the
 * Electron View menu, so zooming uses ⇧1 / ⇧2 / ⇧0 like Figma; copy/cut/paste go through the clipboard events.
 */
export function useCanvasHotkeys() {
  const canvas = useCanvasStore()
  const editor = useEditorStore()

  // Arrow nudges show live and commit as one undo step when the key is released (holding an arrow repeats).
  let nudgeTimer: ReturnType<typeof setTimeout> | undefined
  function flushNudge() {
    clearTimeout(nudgeTimer)
    nudgeTimer = undefined
    if (!canvas.live.size) return
    commitRects(canvas.board.id, new Map(canvas.live), 'Nudge', { moveOnly: true })
    canvas.clearLive()
  }
  useEventListener(window, 'keyup', (e: KeyboardEvent) => {
    if (nudgeTimer && e.key.startsWith('Arrow')) flushNudge()
  })
  useEventListener(window, 'blur', () => nudgeTimer && flushNudge())

  useEventListener(window, 'keydown', (e: KeyboardEvent) => {
    if (editor.workspace !== 'canvas' || canvas.editingId || e.defaultPrevented || isTyping(e.target)) return
    // A focused slider, tab or toggle owns the arrow keys.
    if ((e.target as HTMLElement | null)?.closest?.('[role="slider"], [role="tab"], [role="radio"], [role="tablist"]')) return
    const cmd = e.metaKey || e.ctrlKey
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    const board = canvas.board.id
    const run = (fn: () => void) => {
      e.preventDefault()
      fn()
    }

    if (cmd) {
      if (key === 'd') return run(() => duplicateItems(board, canvas.selection))
      if (key === 'g' && e.shiftKey) return run(() => ungroupItems(board, canvas.selection))
      if (key === 'g') return run(() => groupItems(board, canvas.selection))
      if (key === 'a') return run(() => canvas.select(canvas.items.filter((i) => !i.locked && !i.frameId && !i.groupId).map((i) => i.id)))
      return
    }
    if (e.shiftKey && (e.code === 'Digit1' || key === '!')) return run(() => canvas.requestZoom('fit'))
    if (e.shiftKey && (e.code === 'Digit2' || key === '@')) return run(() => canvas.requestZoom('selection'))
    if (e.shiftKey && (e.code === 'Digit0' || key === ')')) return run(() => canvas.requestZoom('actual'))
    if (!e.altKey && !e.shiftKey && TOOL_KEYS[key]) return run(() => (canvas.tool = TOOL_KEYS[key]!))

    switch (key) {
      case 'Escape':
        return run(() => {
          if (canvas.tool !== 'select') canvas.tool = 'select'
          else if (canvas.enteredGroupId) {
            // Out of the group: the group itself is picked again.
            const g = canvas.enteredGroupId
            canvas.enteredGroupId = undefined
            canvas.select([g])
          } else canvas.select([])
        })
      case 'Backspace':
      case 'Delete':
        if (canvas.selection.length) run(() => removeItems(board, canvas.selection))
        return
      case 'Enter':
        if (canvas.selectedItems.length === 1 && ['text', 'note'].includes(canvas.selectedItems[0]!.kind)) {
          run(() => (canvas.editingId = canvas.selection[0]))
        }
        return
      case ']':
        return run(() => reorder(board, canvas.selection, 'front'))
      case '[':
        return run(() => reorder(board, canvas.selection, 'back'))
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        const items = canvas.selectedItems.filter((i) => !i.locked)
        if (!items.length) return
        const step = e.shiftKey ? 10 : 1
        const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0
        const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0
        return run(() => {
          const rects = new Map<string, Rect>(canvas.live)
          // Frame and group contents travel with them.
          const ids = withFrameContents(canvas.items, items.map((i) => i.id))
          for (const i of canvas.items) {
            if (!ids.has(i.id)) continue
            const r = rects.get(i.id) ?? i
            rects.set(i.id, { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h })
          }
          canvas.setLive(rects)
          clearTimeout(nudgeTimer)
          nudgeTimer = setTimeout(flushNudge, 600)
        })
      }
    }
  })
}
