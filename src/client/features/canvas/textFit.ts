import type { CanvasItem, CanvasTextItem } from '@shared/types/canvas'
import { textBlock } from '@/engine/canvasDraw'

let measureCtx: OffscreenCanvasRenderingContext2D | null | undefined

/**
 * The height a text element's content takes at its width, measured like the board, the viewer and the export draw
 * it: a text box grows and shrinks with its text (at least one line).
 */
export function fittedTextHeight(item: CanvasTextItem): number {
  measureCtx ??= typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1).getContext('2d') : null
  if (!measureCtx) return item.h
  return Math.max(1, Math.ceil(Math.max(item.fontSize * item.lineHeight, textBlock(measureCtx, item).height)))
}

/** What changes how a text element wraps, and so its height. */
const LAYOUT_KEYS = new Set<string>(['text', 'spans', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textTransform', 'w'])
export const changesTextLayout = (patch: object) => Object.keys(patch).some((k) => LAYOUT_KEYS.has(k))

/**
 * Sets a text element's height to its content (in place; other kinds are left alone). A turned box keeps its (turned)
 * top edge where it was: it turns about its centre, which moves by half the change along its own down direction.
 */
export function fitText(item: CanvasItem) {
  if (item.kind !== 'text') return
  const dh = fittedTextHeight(item) - item.h
  item.h += dh
  const a = ((item.rotation ?? 0) * Math.PI) / 180
  if (a && dh) {
    item.x -= (Math.sin(a) * dh) / 2
    item.y += ((Math.cos(a) - 1) * dh) / 2
  }
}
