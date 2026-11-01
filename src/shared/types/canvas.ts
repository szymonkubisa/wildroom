/**
 * Canvas workspace: infinite boards of images, frames (artboards), text, notes and shapes. Lives on the project
 * document like the story (undoable, autosaved, remapped on duplicate). Coordinates are board units (1 unit = 1 px
 * at 100% zoom); frames and their contents are exported at their board size.
 */

export interface CanvasItemBase {
  id: string
  x: number
  y: number
  w: number
  h: number
  /** The frame this item sits in: it moves with the frame and is clipped and exported with it. */
  frameId?: string
  /** The group this item is in: it selects, moves and animates with the group. */
  groupId?: string
  /** Degrees clockwise around the box's centre (frames never turn); motion rotation adds to it. */
  rotation?: number
  locked?: boolean
  /** Not shown anywhere (board, exports, video) until shown again from the layers. */
  hidden?: boolean
  name?: string
  /** A soft shadow under the element (board, PNG and video alike). */
  shadow?: TextShadow
  /** A glow around it: a shadow with no offset, often in a bright colour. */
  glow?: TextShadow
  /** How it mixes with what is under it. */
  blend?: BlendMode
  /**
   * Shown only inside another element of the same frame (a shape, text, picture or group) — or, with `clipInvert`,
   * only outside it. That element becomes a mask: it isn't drawn itself.
   */
  clipBy?: string
  clipInvert?: boolean
}

export const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'soft-light', 'difference', 'add'] as const
export type BlendMode = (typeof BLEND_MODES)[number]

/** An image or video from the media library; pending (a placeholder) until its generation finishes. */
export interface CanvasAssetItem extends CanvasItemBase {
  kind: 'asset'
  assetId?: string
  generationId?: string
  /** Height follows the asset's aspect ratio once its size is known (placeholders guess it). */
  fit?: boolean
  /** A placeholder planned from a brief: what to generate (style included), so it can start later or again. */
  planned?: { deliverable: string; prompt: string }
  /** The picture's shape: a circle or ellipse, or rounded corners (`radius`, board units). */
  mask?: 'ellipse' | 'rounded'
  radius?: number
  /** What part of the picture shows: centred on (x, y) (fractions of it), `zoom` ≥ 1 past a cover crop. */
  crop?: { x: number; y: number; zoom: number }
  /** A border along the mask. */
  stroke?: ShapeStroke
  /** Brightness, contrast and saturation (1 = as it is) and black & white (0..1). */
  adjust?: PictureAdjust
  /** A colour laid over the picture's tones, `amount` 0..1. */
  tint?: { color: string; amount: number }
  /** The picture in two colours: its shadows in `dark`, its highlights in `light`. */
  duotone?: { dark: string; light: string }
}

export interface PictureAdjust {
  brightness?: number
  contrast?: number
  saturate?: number
  bw?: number
}

/** An artboard of an exact pixel size (OG image, Instagram post, favicon…). */
export interface CanvasFrameItem extends CanvasItemBase {
  kind: 'frame'
  presetId?: string
  /** Background colour (CSS hex) or gradient; transparent when unset. */
  fill?: string | GradientFill
}

/** A run of text with its own look; what it leaves out comes from the text element. */
export interface TextSpan {
  text: string
  color?: string
  fontFamily?: string
  fontWeight?: number
  fontStyle?: 'normal' | 'italic'
  /** A marker-pen band behind the words. */
  highlight?: string
}

/** A soft shadow (offset in board units) or, with no offset, a glow. */
export interface TextShadow {
  color: string
  blur: number
  x?: number
  y?: number
}

export interface CanvasTextItem extends CanvasItemBase {
  kind: 'text'
  /** The plain text; with `spans`, always their texts joined. */
  text: string
  /** Rich text: runs with their own colour, font, weight, italic or highlight. */
  spans?: TextSpan[]
  fontFamily: string
  fontSize: number
  fontWeight: number
  fontStyle?: 'normal' | 'italic'
  color: string
  align: 'left' | 'center' | 'right'
  lineHeight: number
  /** Extra space between letters, in board units. */
  letterSpacing?: number
  textTransform?: 'uppercase' | 'lowercase'
  /** A line around the letters, drawn outside them. */
  outline?: { color: string; width: number }
}

export const NOTE_COLORS = ['yellow', 'pink', 'blue', 'green', 'purple'] as const
export type NoteColor = (typeof NOTE_COLORS)[number]

/** A sticky note: context, prompts or comments next to the images. Never exported. */
export interface CanvasNoteItem extends CanvasItemBase {
  kind: 'note'
  text: string
  color: NoteColor
}

/** A gradient: linear at `angle` (degrees, 0 = left to right, 90 = top to bottom) or radial from (`cx`, `cy`) in the box (0..1). */
export interface GradientFill {
  type: 'linear' | 'radial'
  stops: { at: number; color: string }[]
  angle?: number
  cx?: number
  cy?: number
}
/** A repeating pattern in `color` over an optional `background`; `size` is one tile, in board units. */
export interface PatternFill {
  type: 'pattern'
  pattern: 'dots' | 'grid' | 'lines' | 'barcode'
  color: string
  background?: string
  size: number
}
/** A CSS colour (or 'none' on shapes), a gradient or a pattern. */
export type Fill = string | GradientFill | PatternFill
export const PATTERNS: readonly PatternFill['pattern'][] = ['dots', 'grid', 'lines', 'barcode']

/** A fill's main colour: itself, a gradient's first stop, a pattern's ink (for strokes and pickers). */
export function fillColor(fill: Fill | undefined, fallback = '#7c3aed'): string {
  if (!fill || fill === 'none') return fallback
  if (typeof fill === 'string') return fill
  return fill.type === 'pattern' ? fill.color : (fill.stops[0]?.color ?? fallback)
}

const isColor = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length < 80

/** A fill read from disk made valid (gradients need two stops, patterns a size); anything else becomes `fallback`. */
export function sanitizeFill(raw: unknown, fallback: string): Fill {
  if (isColor(raw)) return raw
  const o = raw as { type?: unknown; pattern?: unknown; color?: unknown; background?: unknown; size?: unknown; stops?: unknown; angle?: unknown; cx?: unknown; cy?: unknown } | null
  if (!o || typeof o !== 'object') return fallback
  if (o.type === 'pattern') {
    if (!PATTERNS.includes(o.pattern as PatternFill['pattern']) || !isColor(o.color)) return fallback
    const size = typeof o.size === 'number' && Number.isFinite(o.size) ? Math.min(2000, Math.max(2, o.size)) : 24
    return { type: 'pattern', pattern: o.pattern as PatternFill['pattern'], color: o.color, size, ...(isColor(o.background) ? { background: o.background } : {}) }
  }
  if (o.type !== 'linear' && o.type !== 'radial') return fallback
  const stops = (Array.isArray(o.stops) ? (o.stops as { at?: unknown; color?: unknown }[]) : [])
    .filter((s): s is { at: number; color: string } => Boolean(s) && isColor(s.color) && typeof s.at === 'number' && Number.isFinite(s.at))
    .map((s) => ({ at: Math.min(1, Math.max(0, s.at)), color: s.color }))
    .sort((a, b) => a.at - b.at)
    .slice(0, 8)
  if (stops.length < 2) return stops[0]?.color ?? fallback
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  return o.type === 'linear' ? { type: 'linear', stops, angle: n(o.angle, 90) } : { type: 'radial', stops, cx: n(o.cx, 0.5), cy: n(o.cy, 0.5) }
}

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'polyline' | 'polygon' | 'path' | 'arc'
export const SHAPE_KINDS: readonly ShapeKind[] = ['rect', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'arc']

export interface ShapeStroke {
  color: string
  /** Board units. */
  width: number
  cap?: 'butt' | 'round' | 'square'
  join?: 'miter' | 'round' | 'bevel'
  /** Dash and gap lengths (board units); absent = solid. */
  dash?: number[]
}

export interface CanvasShapeItem extends CanvasItemBase {
  kind: 'shape'
  shape: ShapeKind
  /** CSS colour, 'none' (lines and arcs are never filled), a gradient or a pattern. */
  fill: Fill
  stroke?: ShapeStroke
  /** Corner radius for rectangles (board units). */
  radius?: number
  /** Lines, polylines and polygons: points as fractions of the box (0..1), so resizing scales them. */
  points?: [number, number][]
  /** Paths: SVG path data in `pathBox` units, scaled to the box. */
  d?: string
  pathBox?: { w: number; h: number }
  /** Arcs: degrees clockwise from 3 o'clock, on the ellipse the box holds. */
  arc?: { start: number; end: number }
}

/**
 * Elements kept together: selected, moved, copied and animated as one (a group's animation adds to its members').
 * Its box is always its members' bounds; it draws nothing itself.
 */
export interface CanvasGroupItem extends CanvasItemBase {
  kind: 'group'
}

export type CanvasItem = CanvasAssetItem | CanvasFrameItem | CanvasTextItem | CanvasNoteItem | CanvasShapeItem | CanvasGroupItem
export type CanvasItemKind = CanvasItem['kind']

export interface CanvasBoard {
  id: string
  name: string
  /** Back to front; frames always draw below the other items. */
  items: CanvasItem[]
}

export interface CanvasDoc {
  boards: CanvasBoard[]
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Board shown before the project has any canvas: created on the first edit. */
export const DEFAULT_BOARD_ID = 'board-1'

export function emptyBoard(id = DEFAULT_BOARD_ID, name = 'Board 1'): CanvasBoard {
  return { id, name, items: [] }
}

/** The project's boards, or the one empty default board for a project that never used the canvas. */
export function boardsOf(canvas: CanvasDoc | undefined): CanvasBoard[] {
  return canvas?.boards.length ? canvas.boards : [emptyBoard()]
}

export const DEFAULT_TEXT: Omit<CanvasTextItem, keyof CanvasItemBase | 'kind' | 'text'> = {
  fontFamily: 'Inter',
  fontSize: 48,
  fontWeight: 700,
  color: '#111111',
  align: 'left',
  lineHeight: 1.2,
}

import { fitGroups } from '../canvas/groups'

const KINDS = new Set<CanvasItemKind>(['asset', 'frame', 'text', 'note', 'shape', 'group'])
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

const CAPS = new Set(['butt', 'round', 'square'])
const JOINS = new Set(['miter', 'round', 'bevel'])

/** A shape's geometry and stroke made valid: unknown kinds become rectangles, bad points and strokes are dropped. */
export function sanitizeShape(s: CanvasShapeItem): CanvasShapeItem {
  const out: CanvasShapeItem = { ...s, shape: SHAPE_KINDS.includes(s.shape) ? s.shape : 'rect', fill: sanitizeFill(s.fill, '#7c3aed') }
  const pts = Array.isArray(s.points)
    ? s.points.filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v))).slice(0, 2000)
    : undefined
  if (pts && pts.length > 1) out.points = pts
  else delete out.points
  if (typeof s.d === 'string' && s.d.trim()) out.d = s.d.slice(0, 200_000)
  else delete out.d
  if (s.pathBox && num(s.pathBox.w, 0) > 0 && num(s.pathBox.h, 0) > 0) out.pathBox = { w: s.pathBox.w, h: s.pathBox.h }
  else delete out.pathBox
  if (s.arc && typeof s.arc === 'object') out.arc = { start: num(s.arc.start, -90), end: num(s.arc.end, 90) }
  else delete out.arc
  const st = s.stroke
  if (st && typeof st === 'object' && str(st.color) && num(st.width, 0) > 0) {
    out.stroke = { color: st.color, width: Math.min(2000, st.width) }
    if (CAPS.has(st.cap as string)) out.stroke.cap = st.cap
    if (JOINS.has(st.join as string)) out.stroke.join = st.join
    const dash = Array.isArray(st.dash) ? st.dash.filter((v) => typeof v === 'number' && v >= 0 && Number.isFinite(v)).slice(0, 8) : []
    if (dash.some((v) => v > 0)) out.stroke.dash = dash
  } else delete out.stroke
  return out
}

/** A picture's mask, crop and border made valid in place (bad ones are dropped). */
function sanitizeAssetLook(a: CanvasAssetItem) {
  if (a.mask !== 'ellipse' && a.mask !== 'rounded') delete a.mask
  if (!(num(a.radius, -1) >= 0)) delete a.radius
  const c = a.crop
  if (c && typeof c === 'object') a.crop = { x: Math.min(1, Math.max(0, num(c.x, 0.5))), y: Math.min(1, Math.max(0, num(c.y, 0.5))), zoom: Math.min(20, Math.max(1, num(c.zoom, 1))) }
  else delete a.crop
  const st = a.stroke
  if (st && typeof st === 'object' && str(st.color) && num(st.width, 0) > 0) a.stroke = { color: st.color, width: Math.min(2000, st.width) }
  else delete a.stroke
  const adj: PictureAdjust = {}
  for (const [k, lo, hi, base] of [['brightness', 0, 4, 1], ['contrast', 0, 4, 1], ['saturate', 0, 4, 1], ['bw', 0, 1, 0]] as const) {
    const v = num(a.adjust?.[k], base)
    if (v !== base) adj[k] = Math.min(hi, Math.max(lo, v))
  }
  if (Object.keys(adj).length) a.adjust = adj
  else delete a.adjust
  if (a.tint && str(a.tint.color) && num(a.tint.amount, 0) > 0) a.tint = { color: a.tint.color, amount: Math.min(1, a.tint.amount) }
  else delete a.tint
  if (a.duotone && str(a.duotone.dark) && str(a.duotone.light)) a.duotone = { dark: a.duotone.dark, light: a.duotone.light }
  else delete a.duotone
}

/** Whether a picture is drawn through the shared renderer on the board (a look the plain <img> can't show). */
export const pictureHasLook = (a: CanvasAssetItem) => Boolean(a.mask || a.crop || a.stroke || a.adjust || a.tint || a.duotone || a.shadow || a.glow || a.clipBy)

const shadowOf = (v: unknown, offset: boolean): TextShadow | undefined => {
  const sh = v as TextShadow | undefined
  if (!sh || typeof sh !== 'object' || !str(sh.color)) return undefined
  const out: TextShadow = { color: sh.color, blur: Math.min(500, Math.max(0, num(sh.blur, 0))) }
  if (offset) {
    out.x = num(sh.x, 0)
    out.y = num(sh.y, 0)
  }
  return out.blur > 0 || out.x || out.y ? out : undefined
}

/** An element's shadow, glow and blend made valid in place (frames and notes have none). */
function sanitizeLook(it: CanvasItem) {
  const keep = it.kind !== 'frame' && it.kind !== 'note'
  const shadow = keep ? shadowOf(it.shadow, true) : undefined
  if (shadow) it.shadow = shadow
  else delete it.shadow
  const glow = keep ? shadowOf(it.glow, false) : undefined
  if (glow) it.glow = glow
  else delete it.glow
  if (!keep || !BLEND_MODES.includes(it.blend as BlendMode) || it.blend === 'normal') delete it.blend
}

/** A text element's spans and effects made valid in place; `text` becomes the spans' text. */
export function sanitizeText(t: CanvasTextItem) {
  if (typeof t.text !== 'string') t.text = String(t.text ?? '')
  const spans = Array.isArray(t.spans)
    ? t.spans.flatMap((sp): TextSpan[] => {
        if (!sp || typeof sp.text !== 'string' || !sp.text) return []
        const out: TextSpan = { text: sp.text }
        if (str(sp.color)) out.color = sp.color
        if (str(sp.fontFamily)) out.fontFamily = sp.fontFamily
        if (num(sp.fontWeight, 0) >= 1) out.fontWeight = Math.min(1000, Math.round(sp.fontWeight!))
        if (sp.fontStyle === 'italic' || sp.fontStyle === 'normal') out.fontStyle = sp.fontStyle
        if (str(sp.highlight)) out.highlight = sp.highlight
        return [out]
      })
    : []
  if (spans.length) {
    t.spans = spans
    t.text = spans.map((sp) => sp.text).join('')
  } else delete t.spans
  if (t.fontStyle !== 'italic') delete t.fontStyle
  if (num(t.letterSpacing, 0)) t.letterSpacing = Math.min(1000, Math.max(-200, t.letterSpacing!))
  else delete t.letterSpacing
  if (t.textTransform !== 'uppercase' && t.textTransform !== 'lowercase') delete t.textTransform
  const o = t.outline
  if (o && typeof o === 'object' && str(o.color) && num(o.width, 0) > 0) t.outline = { color: o.color, width: Math.min(200, o.width) }
  else delete t.outline
}

/**
 * Repairs a canvas read from disk (hand-edited or written by another version): drops unknown items, fixes numbers,
 * clears frame links to frames that no longer exist and removes duplicate ids.
 */
export function sanitizeCanvas(raw: unknown): CanvasDoc | undefined {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as CanvasDoc).boards)) return undefined
  const boards: CanvasBoard[] = []
  const boardIds = new Set<string>()
  for (const b of (raw as CanvasDoc).boards) {
    const id = str(b?.id)
    if (!id || boardIds.has(id)) continue
    boardIds.add(id)
    const items: CanvasItem[] = []
    const ids = new Set<string>()
    for (const it of Array.isArray(b.items) ? b.items : []) {
      const itemId = str(it?.id)
      if (!itemId || ids.has(itemId) || !KINDS.has(it.kind)) continue
      ids.add(itemId)
      const w = Math.max(1, num(it.w, 100))
      const h = Math.max(1, num(it.h, 100))
      const item = { ...it, id: itemId, x: num(it.x, 0), y: num(it.y, 0), w, h } as CanvasItem
      if (item.kind === 'frame' || !num(item.rotation, 0)) delete item.rotation
      else item.rotation = num(item.rotation, 0) % 360
      if (item.kind === 'frame' && item.fill !== undefined) {
        const fill = sanitizeFill(item.fill, '')
        if (fill && (typeof fill === 'string' || fill.type !== 'pattern')) item.fill = fill
        else delete item.fill
      }
      if (item.kind === 'asset') sanitizeAssetLook(item)
      if (item.kind === 'text') sanitizeText(item)
      sanitizeLook(item)
      if (item.hidden !== true || item.kind === 'frame') delete item.hidden
      items.push(item.kind === 'shape' ? sanitizeShape(item) : item)
    }
    const frames = new Set(items.filter((i) => i.kind === 'frame').map((i) => i.id))
    for (const it of items) if (it.frameId && (!frames.has(it.frameId) || it.kind === 'frame')) delete it.frameId
    const kept = fitGroups(items)
    // A mask must be another element still on the board, and not a frame or a note.
    const maskable = new Set(kept.filter((i) => i.kind !== 'frame' && i.kind !== 'note').map((i) => i.id))
    for (const it of kept) {
      if (typeof it.clipBy !== 'string' || it.clipBy === it.id || !maskable.has(it.clipBy) || it.kind === 'frame' || it.kind === 'note') delete it.clipBy
      if (!it.clipBy || it.clipInvert !== true) delete it.clipInvert
    }
    boards.push({ id, name: str(b.name) ?? 'Board', items: kept })
  }
  return { boards }
}
