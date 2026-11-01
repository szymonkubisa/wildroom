import type { CanvasItem, Rect } from '../types/canvas'
import { groupMembers } from './groups'

/** Board → screen: `screen = board * zoom + offset`. */
export interface Viewport {
  x: number
  y: number
  zoom: number
}

export const MIN_ZOOM = 0.02
export const MAX_ZOOM = 8

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

export function rectOf(item: Pick<Rect, 'x' | 'y' | 'w' | 'h'>): Rect {
  return { x: item.x, y: item.y, w: item.w, h: item.h }
}

/** Smallest rectangle around all of them (undefined for none). */
export function unionRect(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.w)
    y1 = Math.max(y1, r.y + r.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

export function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
}

export function containsPoint(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

/** Rectangle spanned by two corner points (any order). */
export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

/** Items in paint order: frames first (they are backgrounds), then everything else in array order. */
export function paintOrder<T extends CanvasItem>(items: T[]): T[] {
  return [...items.filter((i) => i.kind === 'frame'), ...items.filter((i) => i.kind !== 'frame')]
}

/** The frame a rectangle belongs in: the topmost frame containing its centre (never the item itself). */
export function frameAt(items: CanvasItem[], r: Rect, exclude?: Set<string>): CanvasItem | undefined {
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 }
  const frames = items.filter((i) => i.kind === 'frame' && !exclude?.has(i.id))
  for (let i = frames.length - 1; i >= 0; i--) if (containsPoint(frames[i]!, c)) return frames[i]
  return undefined
}

/** Ids of the items inside these frames and groups (their contents move, copy and delete with them). */
export function withFrameContents(items: CanvasItem[], ids: Iterable<string>): Set<string> {
  const out = new Set(ids)
  const frames = new Set(items.filter((i) => i.kind === 'frame' && out.has(i.id)).map((i) => i.id))
  for (const i of items) if (i.frameId && frames.has(i.frameId)) out.add(i.id)
  for (const g of items) if (g.kind === 'group' && out.has(g.id)) for (const m of groupMembers(items, g.id)) out.add(m.id)
  return out
}

/** Items whose bounds intersect `r` (marquee); frames only when fully enclosed, like design tools do. */
export function itemsInRect(items: CanvasItem[], r: Rect): CanvasItem[] {
  return items.filter((i) => (i.kind === 'frame' ? contains(r, i) : intersects(r, i)) && !i.locked)
}

// ------------------------------------------------------------------------------------------------ viewport

export function toBoard(v: Viewport, p: { x: number; y: number }): { x: number; y: number } {
  return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom }
}

export function toScreen(v: Viewport, r: Rect): Rect {
  return { x: r.x * v.zoom + v.x, y: r.y * v.zoom + v.y, w: r.w * v.zoom, h: r.h * v.zoom }
}

/** Zooms by `factor` keeping the board point under `screen` in place. */
export function zoomAt(v: Viewport, screen: { x: number; y: number }, factor: number): Viewport {
  const zoom = clampZoom(v.zoom * factor)
  const k = zoom / v.zoom
  return { zoom, x: screen.x - (screen.x - v.x) * k, y: screen.y - (screen.y - v.y) * k }
}

/** Viewport showing `r` centred in a `width`×`height` view, with `padding` px around it, never above `maxZoom`. */
export function fitRect(r: Rect, width: number, height: number, padding = 48, maxZoom = 1): Viewport {
  const zoom = clampZoom(Math.min((width - padding * 2) / Math.max(1, r.w), (height - padding * 2) / Math.max(1, r.h), maxZoom))
  return { zoom, x: width / 2 - (r.x + r.w / 2) * zoom, y: height / 2 - (r.y + r.h / 2) * zoom }
}

/** Board-space rectangle visible in a `width`×`height` view. */
export function visibleRect(v: Viewport, width: number, height: number): Rect {
  return { x: -v.x / v.zoom, y: -v.y / v.zoom, w: width / v.zoom, h: height / v.zoom }
}

// ------------------------------------------------------------------------------------------------ snapping

export interface SnapGuide {
  axis: 'x' | 'y'
  /** Board coordinate of the line. */
  at: number
  from: number
  to: number
}

export interface SnapResult {
  dx: number
  dy: number
  guides: SnapGuide[]
}

/**
 * Nudges a moving rectangle so its edges or centre line up with the edges or centres of `others`, when within
 * `threshold` board units. Returns the correction and the guide lines to draw.
 */
export function snapRect(moving: Rect, others: Rect[], threshold: number): SnapResult {
  const xs = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w]
  const ys = (r: Rect) => [r.y, r.y + r.h / 2, r.y + r.h]
  let bestX: { d: number; at: number; o: Rect } | undefined
  let bestY: { d: number; at: number; o: Rect } | undefined
  for (const o of others) {
    for (const a of xs(moving)) {
      for (const b of xs(o)) {
        const d = b - a
        if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: b, o }
      }
    }
    for (const a of ys(moving)) {
      for (const b of ys(o)) {
        const d = b - a
        if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, at: b, o }
      }
    }
  }
  const guides: SnapGuide[] = []
  const dx = bestX?.d ?? 0
  const dy = bestY?.d ?? 0
  if (bestX) {
    const r = { ...moving, x: moving.x + dx, y: moving.y + dy }
    guides.push({ axis: 'x', at: bestX.at, from: Math.min(r.y, bestX.o.y), to: Math.max(r.y + r.h, bestX.o.y + bestX.o.h) })
  }
  if (bestY) {
    const r = { ...moving, x: moving.x + dx, y: moving.y + dy }
    guides.push({ axis: 'y', at: bestY.at, from: Math.min(r.x, bestY.o.x), to: Math.max(r.x + r.w, bestY.o.x + bestY.o.w) })
  }
  return { dx, dy, guides }
}

// ------------------------------------------------------------------------------------------------ resizing

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/**
 * The rectangle after dragging `handle` by (dx, dy) board units. `keepAspect` scales proportionally (corner handles
 * follow the larger change; side handles grow the other axis around the centre). Never smaller than `min`.
 */
export function resizeRect(r: Rect, handle: Handle, dx: number, dy: number, keepAspect: boolean, min = 4): Rect {
  let { x, y, w, h } = r
  if (handle.includes('e')) w = r.w + dx
  if (handle.includes('w')) {
    w = r.w - dx
    x = r.x + dx
  }
  if (handle.includes('s')) h = r.h + dy
  if (handle.includes('n')) {
    h = r.h - dy
    y = r.y + dy
  }
  if (keepAspect && r.w > 0 && r.h > 0) {
    const ratio = r.w / r.h
    const sideX = handle === 'e' || handle === 'w'
    const sideY = handle === 'n' || handle === 's'
    if (sideX) {
      h = w / ratio
      y = r.y + (r.h - h) / 2
    } else if (sideY) {
      w = h * ratio
      x = r.x + (r.w - w) / 2
    } else if (Math.abs(w / r.w) > Math.abs(h / r.h)) {
      const nh = w / ratio
      if (handle.includes('n')) y = r.y + r.h - nh
      h = nh
    } else {
      const nw = h * ratio
      if (handle.includes('w')) x = r.x + r.w - nw
      w = nw
    }
  }
  if (w < min) {
    if (handle.includes('w')) x -= min - w
    w = min
  }
  if (h < min) {
    if (handle.includes('n')) y -= min - h
    h = min
  }
  return { x, y, w, h }
}

// ------------------------------------------------------------------------------------------------ placement

/** Where new items go: a row starting `gap` to the right of `anchor` (top-aligned), or at `fallback`. */
export function rowRightOf(anchor: Rect | undefined, sizes: { w: number; h: number }[], gap = 40, fallback = { x: 0, y: 0 }): Rect[] {
  let x = anchor ? anchor.x + anchor.w + gap : fallback.x
  const y = anchor ? anchor.y : fallback.y
  return sizes.map((s) => {
    const r = { x, y, w: s.w, h: s.h }
    x += s.w + gap
    return r
  })
}

/** Lays out `count` cells of `w`×`h` in a grid of `columns`, starting at `origin`. */
export function grid(count: number, w: number, h: number, columns: number, origin = { x: 0, y: 0 }, gap = 40): Rect[] {
  const cols = Math.max(1, columns)
  return Array.from({ length: count }, (_, i) => ({
    x: origin.x + (i % cols) * (w + gap),
    y: origin.y + Math.floor(i / cols) * (h + gap),
    w,
    h,
  }))
}

/** Fits `w`×`h` inside a `max`×`max` box keeping the aspect ratio (never upscales). */
export function fitInside(w: number, h: number, max: number): { w: number; h: number } {
  if (w <= 0 || h <= 0) return { w: max, h: max }
  const k = Math.min(1, max / Math.max(w, h))
  return { w: Math.round(w * k), h: Math.round(h * k) }
}

/** Parses "16:9" / "9:16" / "1:1" into width÷height (undefined for "auto" and anything else). */
export function aspectValue(aspect: unknown): number | undefined {
  if (typeof aspect !== 'string') return undefined
  const m = /^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/.exec(aspect.trim())
  if (!m) return undefined
  const a = Number(m[1])
  const b = Number(m[2])
  return a > 0 && b > 0 ? a / b : undefined
}

/**
 * Resize of a box rotated by `deg` around its centre: the pointer delta is taken in the box's own axes, and the
 * opposite handle (or side) stays where it was on the board.
 */
export function resizeRotated(r: Rect, handle: Handle, dx: number, dy: number, keepAspect: boolean, min: number, deg: number): Rect {
  if (!deg) return resizeRect(r, handle, dx, dy, keepAspect, min)
  const a = (deg * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const next = resizeRect(r, handle, dx * cos + dy * sin, -dx * sin + dy * cos, keepAspect, min)
  const anchor = (b: Rect) => ({
    x: handle.includes('w') ? b.x + b.w : handle.includes('e') ? b.x : b.x + b.w / 2,
    y: handle.includes('n') ? b.y + b.h : handle.includes('s') ? b.y : b.y + b.h / 2,
  })
  const onBoard = (b: Rect, p: { x: number; y: number }) => {
    const cx = b.x + b.w / 2
    const cy = b.y + b.h / 2
    return { x: cx + (p.x - cx) * cos - (p.y - cy) * sin, y: cy + (p.x - cx) * sin + (p.y - cy) * cos }
  }
  const before = onBoard(r, anchor(r))
  const after = onBoard(next, anchor(next))
  return { ...next, x: next.x + before.x - after.x, y: next.y + before.y - after.y }
}

/** A point turned by `deg` around a centre (screen or board units). */
export function rotateAround(p: { x: number; y: number }, c: { x: number; y: number }, deg: number): { x: number; y: number } {
  const a = (deg * Math.PI) / 180
  const dx = p.x - c.x
  const dy = p.y - c.y
  return { x: c.x + dx * Math.cos(a) - dy * Math.sin(a), y: c.y + dx * Math.sin(a) + dy * Math.cos(a) }
}
