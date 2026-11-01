import { type FramePreset, framePreset } from '@shared/canvas/framePresets'
import { unionRect } from '@shared/canvas/geometry'
import type { CanvasFrameItem } from '@shared/types/canvas'
import { useCanvasStore } from '@/stores/canvas'
import { addItems, editBoard, newItemId } from './useCanvasDoc'

/** Adds a frame of a preset size to the right of everything on the board (or in the middle of an empty one). */
export function addFrame(preset: Pick<FramePreset, 'id' | 'label' | 'w' | 'h'>, at?: { x: number; y: number }): CanvasFrameItem {
  const canvas = useCanvasStore()
  const bounds = unionRect(canvas.items)
  const c = canvas.viewCenter()
  const pos = at ?? (bounds ? { x: bounds.x + bounds.w + 160, y: bounds.y } : { x: c.x - preset.w / 2, y: c.y - preset.h / 2 })
  const frame: CanvasFrameItem = {
    kind: 'frame',
    id: newItemId(),
    name: preset.label,
    presetId: preset.id,
    fill: '#ffffff',
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    w: preset.w,
    h: preset.h,
  }
  addItems(canvas.board.id, [frame], `Add frame (${preset.label})`)
  canvas.requestZoom('selection')
  return frame
}

/**
 * Gives a frame a preset's size around the same centre. Contents stay where they are, so a centred layout stays
 * centred when switching between e.g. square and story formats.
 */
export function applyFramePreset(frame: CanvasFrameItem, preset: FramePreset) {
  const canvas = useCanvasStore()
  const nx = Math.round(frame.x + frame.w / 2 - preset.w / 2)
  const ny = Math.round(frame.y + frame.h / 2 - preset.h / 2)
  editBoard(canvas.board.id, `Frame size: ${preset.label}`, (b) => {
    const item = b.items.find((i) => i.id === frame.id)
    if (item?.kind !== 'frame') return
    // A name the user typed stays; a preset's own label follows the new preset.
    const renamed = !item.name || item.name === 'Frame' || item.name === framePreset(item.presetId)?.label
    Object.assign(item, { x: nx, y: ny, w: preset.w, h: preset.h, presetId: preset.id })
    if (renamed) item.name = preset.label
  })
}
