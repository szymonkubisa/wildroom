import type { MotionView, ResolvedItem } from '@shared/motion/evaluate'
import type { AssetDTO } from '@shared/types/assets'
import { type Pt, shapeOutline, trimOutline } from '@shared/canvas/path'
import {
  type CanvasAssetItem,
  type CanvasShapeItem,
  type CanvasTextItem,
  type Fill,
  type PatternFill,
  type Rect,
  type ShapeStroke,
  type TextShadow,
  type TextSpan,
  fillColor,
} from '@shared/types/canvas'
import type { MotionTrim, RevealMode } from '@shared/types/project-doc'
import { DEFAULT_HIGHLIGHT } from '@shared/canvas/richText'
import { type Piece, cutPieces, lineText, shownChars, wrapRuns } from './textLayout'

/**
 * Draws Canvas board elements with plain Canvas2D — no DOM, so the same code runs in the viewer, the export worker
 * and the board's PNG export. Coordinates are frame units: the caller sets the transform.
 */

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** A decoded picture for an asset element (image, poster or the current video frame). */
export interface ItemSource {
  image: CanvasImageSource
  /** Intrinsic pixel size of `image`. */
  width: number
  height: number
}

/** Part of a `srcW`×`srcH` image that fills `dst` like CSS `object-fit: cover` (centred crop). */
export function coverCrop(srcW: number, srcH: number, dst: { w: number; h: number }): Rect {
  const scale = Math.max(dst.w / srcW, dst.h / srcH)
  const w = dst.w / scale
  const h = dst.h / scale
  return { x: (srcW - w) / 2, y: (srcH - h) / 2, w, h }
}

/** Lines of plain `text` as the board shows them (see `wrapRuns`). */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  return wrapRuns([{ text, style: 0 }], maxWidth, (t) => measure(t)).map(lineText)
}

/** The part of wrapped `lines` shown at `reveal` (0..1): letters or whole words in reading order. */
export function revealLines(lines: readonly string[], reveal: number, mode: 'typewriter' | 'words'): string[] {
  const counts = shownChars(lines, reveal, mode)
  return lines.map((l, i) => [...l].slice(0, counts[i]).join(''))
}

/** Copies of an asset to try for a still picture, best first: the original, the display copy, the poster (videos: poster). */
export function stillUrls(asset: Pick<AssetDTO, 'id' | 'kind' | 'variants'>): string[] {
  // A sound on a board has no picture: renders and motion clips leave it out.
  if (asset.kind === 'audio' || asset.kind === 'font') return []
  if (asset.kind === 'video') return [`/media/${asset.id}/poster`]
  return [`/media/${asset.id}/original`, asset.variants.display && `/media/${asset.id}/display`, asset.variants.poster && `/media/${asset.id}/poster`].filter(
    (u): u is string => Boolean(u),
  )
}

/** The CSS font of a text element, or of one of its spans. */
export function textFont(item: CanvasTextItem, size = item.fontSize, span?: TextSpan): string {
  const italic = (span?.fontStyle ?? item.fontStyle) === 'italic' ? 'italic ' : ''
  return `${italic}${span?.fontWeight ?? item.fontWeight} ${size}px "${span?.fontFamily ?? item.fontFamily}", Inter, system-ui, sans-serif`
}

/** Every font a text element draws with (to load before drawing). */
export const textFonts = (item: CanvasTextItem): string[] => [...new Set([textFont(item), ...(item.spans ?? []).map((sp) => textFont(item, item.fontSize, sp))])]

interface TextLook {
  font: string
  color: string
  highlight?: string
}

const caseOf = (item: CanvasTextItem, text: string) =>
  item.textTransform === 'uppercase' ? text.toUpperCase() : item.textTransform === 'lowercase' ? text.toLowerCase() : text

/** The element's text as pieces (case applied), and the look each piece's `style` points at. */
function textRuns(item: CanvasTextItem): { runs: Piece[]; looks: TextLook[] } {
  const looks: TextLook[] = []
  const keys = new Map<string, number>()
  const runs = (item.spans?.length ? item.spans : [{ text: item.text }]).map((sp: TextSpan) => {
    const look: TextLook = { font: textFont(item, item.fontSize, sp), color: sp.color ?? item.color, highlight: sp.highlight }
    const key = `${look.font}|${look.color}|${look.highlight ?? ''}`
    let style = keys.get(key)
    if (style === undefined) {
      style = looks.push(look) - 1
      keys.set(key, style)
    }
    return { text: caseOf(item, sp.text), style }
  })
  return { runs, looks }
}

function setLetterSpacing(ctx: Ctx2D, item: CanvasTextItem) {
  const c = ctx as Ctx2D & { letterSpacing?: string }
  if (item.letterSpacing || (c.letterSpacing && c.letterSpacing !== '0px')) c.letterSpacing = `${item.letterSpacing ?? 0}px`
}

/** Outline length of a shape (ellipses by Ramanujan's approximation). */
export function shapePerimeter(shape: CanvasShapeItem['shape'], w: number, h: number, radius = 0): number {
  if (shape === 'ellipse') {
    const a = w / 2
    const b = h / 2
    return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)))
  }
  const r = Math.min(radius, w / 2, h / 2)
  return 2 * (w + h) - (8 - 2 * Math.PI) * r
}

// ------------------------------------------------------------------------------------------------ fills

const tiles = new Map<string, OffscreenCanvas>()

/** Deterministic bar widths for the barcode pattern (in tenths of a tile). */
const BARS = [2, 1, 3, 1, 1, 2, 1, 4, 2, 1, 1, 3, 2, 2, 1, 1, 3, 1, 2, 1]

/** One tile of a pattern at `scale` pixels per board unit (tiles are cached; at most 1024 px a side). */
function patternTile(fill: PatternFill, scale: number): OffscreenCanvas {
  const key = `${fill.pattern}|${fill.color}|${fill.size}|${scale}`
  const hit = tiles.get(key)
  if (hit) return hit
  const unit = fill.size * scale
  const w = Math.max(2, Math.min(1024, Math.round(fill.pattern === 'barcode' ? unit * 8 : unit)))
  const h = Math.max(2, Math.min(1024, Math.round(unit)))
  const tile = new OffscreenCanvas(w, h)
  const t = tile.getContext('2d')!
  t.fillStyle = fill.color
  t.strokeStyle = fill.color
  if (fill.pattern === 'dots') {
    t.beginPath()
    t.arc(w / 2, h / 2, Math.max(0.5, w * 0.18), 0, Math.PI * 2)
    t.fill()
  } else if (fill.pattern === 'grid') {
    const lw = Math.max(1, w * 0.04)
    t.fillRect(0, 0, w, lw)
    t.fillRect(0, 0, lw, h)
  } else if (fill.pattern === 'lines') {
    t.lineWidth = Math.max(1, w * 0.22)
    for (const o of [-w, 0, w]) {
      t.beginPath()
      t.moveTo(o, h)
      t.lineTo(o + w, 0)
      t.stroke()
    }
  } else {
    const total = BARS.reduce((a, b) => a + b, 0)
    let x = 0
    BARS.forEach((b, i) => {
      const bw = (b / total) * w
      if (i % 2 === 0) t.fillRect(x, 0, bw, h)
      x += bw
    })
  }
  if (tiles.size > 64) tiles.delete(tiles.keys().next().value!)
  tiles.set(key, tile)
  return tile
}

/** What to fill `r` with: a colour, a gradient laid across the box, or a pattern anchored at its corner. */
export function paintOf(ctx: Ctx2D, fill: Fill, r: Rect): string | CanvasGradient | CanvasPattern {
  if (typeof fill === 'string') return fill
  if (fill.type === 'linear') {
    const a = ((fill.angle ?? 90) * Math.PI) / 180
    const cx = r.x + r.w / 2
    const cy = r.y + r.h / 2
    const half = Math.abs((r.w / 2) * Math.cos(a)) + Math.abs((r.h / 2) * Math.sin(a))
    const g = ctx.createLinearGradient(cx - Math.cos(a) * half, cy - Math.sin(a) * half, cx + Math.cos(a) * half, cy + Math.sin(a) * half)
    for (const s of fill.stops) g.addColorStop(s.at, s.color)
    return g
  }
  if (fill.type === 'radial') {
    const cx = r.x + (fill.cx ?? 0.5) * r.w
    const cy = r.y + (fill.cy ?? 0.5) * r.h
    const far = Math.max(Math.hypot(cx - r.x, cy - r.y), Math.hypot(cx - r.x - r.w, cy - r.y), Math.hypot(cx - r.x, cy - r.y - r.h), Math.hypot(cx - r.x - r.w, cy - r.y - r.h))
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, far))
    for (const s of fill.stops) g.addColorStop(s.at, s.color)
    return g
  }
  if (fill.type !== 'pattern') return fillColor(fill)
  // Tiles drawn at the pixel density the context draws at, so patterns stay crisp when zoomed.
  const m = ctx.getTransform()
  const scale = Math.min(8, Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(1e-3, Math.hypot(m.a, m.b))))))
  const tile = patternTile(fill, scale)
  const pattern = ctx.createPattern(tile, 'repeat')
  if (!pattern) return fill.color
  // Back to board units from the tile's real size (capped at 1024 px, so not always size × scale).
  const unit = fill.size * (fill.pattern === 'barcode' ? 8 : 1)
  pattern.setTransform(new DOMMatrix().translate(r.x, r.y).scale(unit / tile.width, fill.size / tile.height))
  return pattern
}

/** Fills the current path: a pattern's background first, then the fill. */
function fillPath(ctx: Ctx2D, fill: Fill, r: Rect) {
  if (typeof fill !== 'string' && fill.type === 'pattern' && fill.background) {
    ctx.fillStyle = fill.background
    ctx.fill()
  }
  ctx.fillStyle = paintOf(ctx, fill, r)
  ctx.fill()
}

/** A frame's background over `r` (colour or gradient). */
export function fillRectWith(ctx: Ctx2D, fill: Fill, r: Rect) {
  ctx.fillStyle = paintOf(ctx, fill, r)
  ctx.fillRect(r.x, r.y, r.w, r.h)
}

const OPEN_SHAPES = new Set<CanvasShapeItem['shape']>(['line', 'polyline', 'arc'])
/** The shape has an inside to fill: never lines and arcs, and not when its fill is 'none'. */
const fillable = (item: CanvasShapeItem) => !OPEN_SHAPES.has(item.shape) && item.fill !== 'none'

function tracePolys(ctx: Ctx2D, polys: readonly { points: readonly Pt[]; closed?: boolean }[], r: Rect) {
  for (const p of polys) {
    p.points.forEach(([x, y], i) => (i ? ctx.lineTo(r.x + x, r.y + y) : ctx.moveTo(r.x + x, r.y + y)))
    if (p.closed) ctx.closePath()
  }
}

function shapePath(ctx: Ctx2D, item: CanvasShapeItem, r: Rect) {
  ctx.beginPath()
  if (item.shape === 'ellipse') ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2)
  else if (item.shape === 'rect') ctx.roundRect(r.x, r.y, r.w, r.h, Math.min(item.radius ?? 0, r.w / 2, r.h / 2))
  else tracePolys(ctx, shapeOutline(item, r.w, r.h), r)
}

/** The stroke a shape is drawn with: its own; lines without one (and outlines being drawn) take the fill colour. */
function strokeOf(item: CanvasShapeItem, r: Rect): ShapeStroke | undefined {
  if (item.stroke) return item.stroke
  return { color: fillColor(item.fill, '#ffffff'), width: Math.max(2, Math.min(r.w, r.h) * 0.03) }
}

function setStroke(ctx: Ctx2D, st: ShapeStroke) {
  ctx.strokeStyle = st.color
  ctx.lineWidth = st.width
  ctx.lineCap = st.cap ?? 'butt'
  ctx.lineJoin = st.join ?? 'miter'
  ctx.setLineDash(st.dash ?? [])
}

/** Share of `draw` spent on the outline; the fill comes in over the rest. */
const OUTLINE_SHARE = 0.8

function drawShape(ctx: Ctx2D, item: CanvasShapeItem, r: Rect, reveal: number, mode: RevealMode | undefined, trim: MotionTrim | undefined) {
  const drawing = mode === 'draw' && reveal < 1
  const trimmed = Boolean(trim && (trim.start > 0 || trim.end < 1))
  if (!drawing && !trimmed) {
    if (fillable(item)) {
      shapePath(ctx, item, r)
      fillPath(ctx, item.fill, r)
    }
    if (item.stroke || OPEN_SHAPES.has(item.shape)) {
      shapePath(ctx, item, r)
      setStroke(ctx, strokeOf(item, r)!)
      ctx.stroke()
      ctx.setLineDash([])
    }
    return
  }
  // Part of the outline: it draws itself along its length (and a filled shape fills in at the end), or a trim.
  const from = trim?.start ?? 0
  const to = trim?.end ?? 1
  const share = fillable(item) ? OUTLINE_SHARE : 1
  const end = drawing ? from + (to - from) * Math.min(1, reveal / share) : to
  ctx.beginPath()
  tracePolys(
    ctx,
    trimOutline(shapeOutline(item, r.w, r.h), from, end).map((points) => ({ points })),
    r,
  )
  setStroke(ctx, strokeOf(item, r)!)
  ctx.stroke()
  ctx.setLineDash([])
  const fill = drawing && !trimmed && fillable(item) ? (reveal - OUTLINE_SHARE) / (1 - OUTLINE_SHARE) : 0
  if (fill > 0) {
    ctx.globalAlpha *= fill
    shapePath(ctx, item, r)
    fillPath(ctx, item.fill, r)
  }
}

interface TextLayout {
  lines: Piece[][]
  looks: TextLook[]
  height: number
  /** Width of a piece, as drawn. */
  width: (p: Piece) => number
}

function layoutText(ctx: Ctx2D, item: CanvasTextItem, width: number): TextLayout {
  const { runs, looks } = textRuns(item)
  setLetterSpacing(ctx, item)
  const widths = new Map<string, number>()
  const measure = (text: string, style: number) => {
    const key = `${style}|${text}`
    let w = widths.get(key)
    if (w === undefined) {
      ctx.font = looks[style]!.font
      w = ctx.measureText(text).width
      widths.set(key, w)
    }
    return w
  }
  const lines = wrapRuns(runs, width, measure)
  return { lines, looks, height: lines.length * item.fontSize * item.lineHeight, width: (p) => measure(p.text, p.style) }
}

/**
 * A text element's wrapped lines at `width` and the height they take. The box can be shorter: the text runs past it,
 * as on the board.
 */
export function textBlock(ctx: Ctx2D, item: CanvasTextItem, width = item.w): { lines: string[]; height: number } {
  const { lines, height } = layoutText(ctx, item, width)
  return { lines: lines.map(lineText), height }
}

/** How far an element's shadow, glow and (text) outline reach past it (board units). */
export function itemOverhang(item: CanvasAssetItem | CanvasShapeItem | CanvasTextItem): number {
  const sh = item.shadow
  return Math.ceil(
    Math.max(
      item.kind === 'text' ? (item.outline?.width ?? 0) : 0,
      (item.glow?.blur ?? 0) * 1.5,
      sh ? sh.blur * 1.5 + Math.max(Math.abs(sh.x ?? 0), Math.abs(sh.y ?? 0)) : 0,
    ),
  )
}

/** A shadow's offset turned and scaled by the transform (Canvas shadows and filters ignore it), so it turns with a rotated element as on the board. */
function shadowOffset(ctx: Ctx2D, x: number, y: number, scale: number): [number, number] {
  const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : undefined
  return m ? [x * m.a + y * m.c, x * m.b + y * m.d] : [x * scale, y * scale]
}

/** Canvas shadows ignore the transform: blur and offset are in device pixels. */
function setShadow(ctx: Ctx2D, sh: TextShadow | undefined, scale: number) {
  const [ox, oy] = sh ? shadowOffset(ctx, sh.x ?? 0, sh.y ?? 0, scale) : [0, 0]
  ctx.shadowColor = sh ? sh.color : 'transparent'
  ctx.shadowBlur = sh ? sh.blur * scale : 0
  ctx.shadowOffsetX = ox
  ctx.shadowOffsetY = oy
}

/** A run of text placed on the frame. */
interface Seg {
  text: string
  style: number
  x: number
  y: number
}

/** The letters of `segs`: glow, then the outline (carrying the shadow), then the fill. */
function drawGlyphs(ctx: Ctx2D, item: CanvasTextItem, looks: TextLook[], segs: readonly Seg[], scale: number) {
  if (item.glow) {
    setShadow(ctx, item.glow, scale)
    for (const s of segs) {
      ctx.font = looks[s.style]!.font
      ctx.fillStyle = looks[s.style]!.color
      ctx.fillText(s.text, s.x, s.y)
    }
  }
  if (item.outline) {
    setShadow(ctx, item.shadow, scale)
    ctx.lineWidth = item.outline.width * 2
    ctx.lineJoin = 'round'
    ctx.strokeStyle = item.outline.color
    for (const s of segs) {
      ctx.font = looks[s.style]!.font
      ctx.strokeText(s.text, s.x, s.y)
    }
  }
  setShadow(ctx, item.outline ? undefined : item.shadow, scale)
  for (const s of segs) {
    ctx.font = looks[s.style]!.font
    ctx.fillStyle = looks[s.style]!.color
    ctx.fillText(s.text, s.x, s.y)
  }
  setShadow(ctx, undefined, scale)
}

/** A marker band behind a run, `part` (0..1) of its width from the left. */
function highlightBand(ctx: Ctx2D, color: string, x: number, y: number, w: number, size: number, part = 1) {
  if (part <= 0) return
  ctx.fillStyle = color
  ctx.fillRect(x - size * 0.04, y + size * 0.04, (w + size * 0.08) * Math.min(1, part), size * 0.96)
}

/** Reveal modes that animate each word or letter on its own. */
const KINETIC: Partial<Record<RevealMode, 'word' | 'letter'>> = {
  'words-rise': 'word',
  'words-pop': 'word',
  'words-blur': 'word',
  'letters-rise': 'letter',
  'letters-fade': 'letter',
}
/** Modes where the text is there from the start (the highlight sweeps in, the numbers count). */
export const SHOWN_AT_ZERO = new Set<RevealMode>(['highlight-sweep', 'roll'])

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3
const easeOutBack = (t: number) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2

/** Progress (0..1) of unit `i` of `n` at `reveal`: they start one after another, each taking a few units' time. */
export function unitProgress(i: number, n: number, reveal: number): number {
  if (reveal >= 1) return 1
  const span = Math.min(1, 3 / (n + 2))
  const start = n > 1 ? (i / (n - 1)) * (1 - span) : 0
  return Math.min(1, Math.max(0, (reveal - start) / span))
}

const withFilter = (base: string, add: string) => (base && base !== 'none' ? `${base} ${add}` : add)

function drawText(ctx: Ctx2D, item: CanvasTextItem, r: Rect, reveal: number, mode: RevealMode | undefined, rollFrom = 0) {
  const size = item.fontSize
  const layout = layoutText(ctx, item, r.w)
  const { lines, looks } = layout
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  const lineHeight = size * item.lineHeight
  // CSS centres the glyphs in each line box: shift by half the leading.
  const leading = (lineHeight - size) / 2
  const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : undefined
  const scale = m ? Math.hypot(m.a, m.b) : 1
  const width = (text: string, style: number) => layout.width({ text, style })
  // Every line placed by its whole width, so a line typing itself doesn't slide.
  const placed: Seg[][] = lines.map((line, i) => {
    const full = line.reduce((w, p) => w + layout.width(p), 0)
    let x = item.align === 'center' ? r.x + (r.w - full) / 2 : item.align === 'right' ? r.x + r.w - full : r.x
    const y = r.y + i * lineHeight + leading
    return line.map((p) => {
      const seg = { ...p, x, y }
      x += layout.width(p)
      return seg
    })
  })
  const highlights = (segs: readonly Seg[], part = 1) => {
    for (const s of segs) {
      const hl = looks[s.style]!.highlight
      if (hl) highlightBand(ctx, hl, s.x, s.y, width(s.text, s.style), size, part)
    }
  }

  if (mode === 'typewriter' || mode === 'words') {
    const counts = shownChars(lines.map(lineText), reveal, mode)
    placed.forEach((segs, i) => {
      const shown = cutPieces(segs, counts[i]!).map((p, j) => ({ ...p, x: segs[j]!.x, y: segs[j]!.y }))
      highlights(shown)
      drawGlyphs(ctx, item, looks, shown, scale)
    })
    return
  }

  if (mode === 'highlight-sweep') {
    // The marker runs under the highlighted words in reading order (under all of the text when none is).
    const marked = looks.some((l) => l.highlight)
    const runs = placed.flat().filter((s) => s.text.trim() && (!marked || looks[s.style]!.highlight))
    const total = runs.reduce((w, s) => w + width(s.text, s.style), 0)
    let left = reveal * total
    for (const s of runs) {
      const w = width(s.text, s.style)
      highlightBand(ctx, looks[s.style]!.highlight ?? DEFAULT_HIGHLIGHT, s.x, s.y, w, size, w > 0 ? left / w : 0)
      left -= w
    }
    for (const segs of placed) drawGlyphs(ctx, item, looks, segs, scale)
    return
  }

  if (mode === 'roll') {
    drawRoll(ctx, item, looks, placed, width, lineHeight, leading, reveal, rollFrom, scale)
    return
  }

  const unitKind = mode && KINETIC[mode]
  if (!unitKind) {
    for (const segs of placed) {
      highlights(segs)
      drawGlyphs(ctx, item, looks, segs, scale)
    }
    return
  }

  // Words (or letters) in reading order, each with its parts in their own looks.
  const units: Seg[][] = []
  for (const segs of placed) {
    let open = false
    for (const s of segs)
      for (const tok of s.text.matchAll(unitKind === 'word' ? /\S+|\s+/gu : /\S|\s+/gu)) {
        if (!tok[0].trim()) {
          open = false
          continue
        }
        const part = { text: tok[0], style: s.style, x: s.x + width(s.text.slice(0, tok.index), s.style), y: s.y }
        if (open && unitKind === 'word') units.at(-1)!.push(part)
        else units.push([part])
        open = true
      }
  }
  const baseFilter = String(ctx.filter ?? 'none')
  units.forEach((unit, i) => {
    const p = unitProgress(i, units.length, reveal)
    if (p <= 0) return
    const e = easeOutCubic(p)
    ctx.save()
    if (mode === 'words-pop') {
      const x0 = unit[0]!.x
      const last = unit.at(-1)!
      const cx = (x0 + last.x + width(last.text, last.style)) / 2
      const cy = unit[0]!.y + size / 2
      const k = 0.4 + 0.6 * easeOutBack(p)
      ctx.globalAlpha *= Math.min(1, p * 2)
      ctx.translate(cx, cy)
      ctx.scale(k, k)
      ctx.translate(-cx, -cy)
    } else {
      ctx.globalAlpha *= e
      if (mode === 'words-rise' || mode === 'letters-rise') ctx.translate(0, (1 - e) * size * (mode === 'words-rise' ? 0.6 : 0.4))
      if (mode === 'words-blur' && e < 1) ctx.filter = withFilter(baseFilter, `blur(${((1 - e) * size * 0.25 * scale).toFixed(2)}px)`)
    }
    highlights(unit)
    drawGlyphs(ctx, item, looks, unit, scale)
    ctx.restore()
  })
}

/**
 * Numbers count up like an odometer: each digit rolls under the line (a column turns over in the last tenth of the
 * one below it), from `from` to the number written. Nothing reflows: every digit stays in its final place.
 */
function drawRoll(
  ctx: Ctx2D,
  item: CanvasTextItem,
  looks: TextLook[],
  placed: Seg[][],
  width: (text: string, style: number) => number,
  lineHeight: number,
  leading: number,
  reveal: number,
  from: number,
  scale: number,
) {
  for (const segs of placed)
    for (const s of segs) {
      let last = 0
      for (const m of s.text.matchAll(/\d+/g)) {
        const before = s.text.slice(last, m.index)
        if (before) drawGlyphs(ctx, item, looks, [{ ...s, text: before, x: s.x + width(s.text.slice(0, last), s.style) }], scale)
        last = m.index + m[0].length
        const target = Number(m[0])
        const v = from + (target - from) * Math.min(1, Math.max(0, reveal))
        const digits = m[0].length
        const top = s.y - leading
        ctx.save()
        ctx.beginPath()
        ctx.rect(s.x + width(s.text.slice(0, m.index), s.style) - lineHeight, top, width(m[0], s.style) + 2 * lineHeight, lineHeight)
        ctx.clip()
        // How far each column has turned towards its next digit: the units turn smoothly, a column above only while
        // the one below turns over from 9.
        const turn: number[] = []
        for (let k = 0; k < digits; k++) {
          const below = Math.floor(Math.abs(v) / 10 ** (k - 1)) % 10
          turn[k] = reveal >= 1 ? 0 : k === 0 ? Math.abs(v) % 1 : below === 9 ? turn[k - 1]! : 0
        }
        for (let j = 0; j < digits; j++) {
          const k = digits - 1 - j
          const col = Math.abs(v) / 10 ** k
          const d = Math.floor(col) % 10
          const f = turn[k]!
          const cellX = s.x + width(s.text.slice(0, m.index + j), s.style)
          const cellW = width(m[0][j]!, s.style)
          const at = (digit: number, dy: number) => {
            const t = String(digit)
            drawGlyphs(ctx, item, looks, [{ text: t, style: s.style, x: cellX + (cellW - width(t, s.style)) / 2, y: s.y + dy }], scale)
          }
          // Leading zeros stay hidden until their digit rolls in.
          if (k === 0 || Math.floor(col) > 0) at(d, -f * lineHeight)
          if (f > 0) at((d + 1) % 10, (1 - f) * lineHeight)
        }
        ctx.restore()
      }
      const rest = s.text.slice(last)
      if (rest) drawGlyphs(ctx, item, looks, [{ ...s, text: rest, x: s.x + width(s.text.slice(0, last), s.style) }], scale)
    }
}

/** The part of a `srcW`×`srcH` picture to show in `dst`: a cover crop `zoom` times closer, centred on (x, y), kept inside. */
export function focalCrop(srcW: number, srcH: number, dst: { w: number; h: number }, crop: { x: number; y: number; zoom: number }): Rect {
  const scale = Math.max(dst.w / srcW, dst.h / srcH) * Math.max(1, crop.zoom)
  const w = dst.w / scale
  const h = dst.h / scale
  return { x: Math.min(srcW - w, Math.max(0, crop.x * srcW - w / 2)), y: Math.min(srcH - h, Math.max(0, crop.y * srcH - h / 2)), w, h }
}

function maskPath(ctx: Ctx2D, item: CanvasAssetItem, r: Rect) {
  ctx.beginPath()
  if (item.mask === 'ellipse') ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2)
  else ctx.roundRect(r.x, r.y, r.w, r.h, item.mask === 'rounded' ? Math.min(item.radius ?? Math.min(r.w, r.h) * 0.08, r.w / 2, r.h / 2) : 0)
}

const lookCache = new WeakMap<object, Map<string, OffscreenCanvas>>()
const scratch: OffscreenCanvas[] = []
function scratchCanvas(i: number, w: number, h: number): OffscreenCanvasRenderingContext2D {
  let c = scratch[i]
  if (!c || c.width !== w || c.height !== h) c = scratch[i] = new OffscreenCanvas(w, h)
  const ctx = c.getContext('2d')!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.filter = 'none'
  ctx.clearRect(0, 0, w, h)
  return ctx
}

/**
 * The crop of a picture with its adjustments, duotone and tint, at the crop's own pixels (capped at 2048 a side).
 * Duotone mixes the two colours by brightness exactly: light × L plus dark × (1 − L), each masked by the picture's
 * alpha. Still pictures are cached (see below).
 */
/** One canvas per element for pictures that change every frame (video), reused instead of a new one each frame. */
const liveLooks = new Map<string, OffscreenCanvas>()
function liveLook(id: string, w: number, h: number): OffscreenCanvas {
  let c = liveLooks.get(id)
  if (!c) {
    if (liveLooks.size >= 32) liveLooks.delete(liveLooks.keys().next().value!)
    liveLooks.set(id, (c = new OffscreenCanvas(w, h)))
  } else if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  } else c.getContext('2d')!.clearRect(0, 0, w, h)
  return c
}

function lookedPicture(src: ItemSource, crop: Rect, item: CanvasAssetItem): OffscreenCanvas {
  const key = JSON.stringify([crop, item.adjust, item.tint, item.duotone])
  const cached = lookCache.get(src.image as object)?.get(key)
  if (cached) return cached
  // Only pictures that never change are cached: a <video> element or a frame canvas is a new picture every frame
  // (drawn into the element's own canvas, used straight away).
  const still = (typeof ImageBitmap !== 'undefined' && src.image instanceof ImageBitmap) || (typeof HTMLImageElement !== 'undefined' && src.image instanceof HTMLImageElement)
  const k = Math.min(1, 2048 / Math.max(crop.w, crop.h))
  const w = Math.max(1, Math.round(crop.w * k))
  const h = Math.max(1, Math.round(crop.h * k))
  const out = still ? new OffscreenCanvas(w, h) : liveLook(item.id, w, h)
  const o = out.getContext('2d')!
  const a = item.adjust
  const parts = [
    a?.brightness !== undefined && `brightness(${a.brightness})`,
    a?.contrast !== undefined && `contrast(${a.contrast})`,
    a?.saturate !== undefined && `saturate(${a.saturate})`,
    a?.bw && `grayscale(${a.bw})`,
  ].filter(Boolean)
  o.filter = parts.length ? parts.join(' ') : 'none'
  o.drawImage(src.image, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h)
  o.filter = 'none'
  if (item.duotone) {
    const tone = (i: number, filter: string, color: string) => {
      const t = scratchCanvas(i, w, h)
      t.filter = filter
      t.drawImage(out, 0, 0)
      t.filter = 'none'
      t.globalCompositeOperation = 'multiply'
      t.fillStyle = color
      t.fillRect(0, 0, w, h)
      t.globalCompositeOperation = 'destination-in'
      t.drawImage(out, 0, 0)
      return t.canvas
    }
    const light = tone(0, 'grayscale(1)', item.duotone.light)
    const dark = tone(1, 'grayscale(1) invert(1)', item.duotone.dark)
    o.clearRect(0, 0, w, h)
    o.drawImage(light, 0, 0)
    o.globalCompositeOperation = 'lighter'
    o.drawImage(dark, 0, 0)
    o.globalCompositeOperation = 'source-over'
  }
  if (item.tint) {
    const t = scratchCanvas(2, w, h)
    t.drawImage(out, 0, 0)
    t.globalCompositeOperation = 'color'
    t.fillStyle = item.tint.color
    t.fillRect(0, 0, w, h)
    t.globalCompositeOperation = 'destination-in'
    t.drawImage(out, 0, 0)
    o.globalAlpha = item.tint.amount
    o.drawImage(t.canvas, 0, 0)
    o.globalAlpha = 1
  }
  if (still) {
    let byKey = lookCache.get(src.image as object)
    if (!byKey) lookCache.set(src.image as object, (byKey = new Map()))
    if (byKey.size > 8) byKey.clear()
    byKey.set(key, out)
  }
  return out
}

function drawAsset(ctx: Ctx2D, item: CanvasAssetItem, r: Rect, src: ItemSource | undefined) {
  if (src && src.width && src.height) {
    const crop = item.crop ? focalCrop(src.width, src.height, r, item.crop) : coverCrop(src.width, src.height, r)
    ctx.save()
    if (item.mask) {
      maskPath(ctx, item, r)
      ctx.clip()
    }
    if ((item.adjust || item.tint || item.duotone) && typeof OffscreenCanvas !== 'undefined') ctx.drawImage(lookedPicture(src, crop, item), r.x, r.y, r.w, r.h)
    else ctx.drawImage(src.image, crop.x, crop.y, crop.w, crop.h, r.x, r.y, r.w, r.h)
    ctx.restore()
  }
  if (item.stroke) {
    maskPath(ctx, item, r)
    setStroke(ctx, item.stroke)
    ctx.stroke()
  }
}

/** One resolved element: its opacity, scale and rotation around its centre, its reveal. */
export function drawItem(ctx: Ctx2D, ri: ResolvedItem, source: (item: CanvasAssetItem) => ItemSource | undefined): void {
  if (ri.trail?.length && typeof OffscreenCanvas !== 'undefined') return drawTrail(ctx, ri, source)
  const { item, rect: r, reveal, revealMode: mode } = ri
  if (ri.opacity <= 0.001 || ri.scale <= 0) return
  if (mode && reveal <= 0 && !SHOWN_AT_ZERO.has(mode)) return
  ctx.save()
  ctx.globalAlpha *= ri.opacity
  const sx = ri.scale * (ri.stretch?.x ?? 1)
  const sy = ri.scale * (ri.stretch?.y ?? 1)
  if (sx === 0 || sy === 0) return ctx.restore()
  if (sx !== 1 || sy !== 1 || ri.rotation) {
    const cx = r.x + r.w / 2
    const cy = r.y + r.h / 2
    ctx.translate(cx, cy)
    if (ri.rotation) ctx.rotate((ri.rotation * Math.PI) / 180)
    if (sx !== 1 || sy !== 1) ctx.scale(sx, sy)
    ctx.translate(-cx, -cy)
  }
  if (item.blend) ctx.globalCompositeOperation = item.blend === 'add' ? 'lighter' : item.blend === 'normal' ? 'source-over' : item.blend
  // Filters, like shadows, are in canvas pixels: scale by the transform.
  const m = ri.blur || item.shadow || item.glow ? (typeof ctx.getTransform === 'function' ? ctx.getTransform() : undefined) : undefined
  const px = m ? Math.hypot(m.a, m.b) : 1
  let filter = String(ctx.filter ?? 'none')
  if (ri.blur) filter = withFilter(filter, `blur(${(ri.blur * px).toFixed(2)}px)`)
  // Text draws its own glow and shadow letter by letter (under its outline); the rest take them as filters.
  if (item.kind !== 'text') {
    if (item.glow) filter = withFilter(filter, `drop-shadow(0 0 ${(item.glow.blur * px).toFixed(2)}px ${item.glow.color})`)
    const sh = item.shadow
    const [ox, oy] = sh ? shadowOffset(ctx, sh.x ?? 0, sh.y ?? 0, px) : [0, 0]
    if (sh) filter = withFilter(filter, `drop-shadow(${ox.toFixed(2)}px ${oy.toFixed(2)}px ${(sh.blur * px).toFixed(2)}px ${sh.color})`)
  }
  if (filter !== String(ctx.filter ?? 'none')) ctx.filter = filter
  if ((mode === 'wipe-left' || mode === 'wipe-up') && reveal < 1) {
    ctx.beginPath()
    if (mode === 'wipe-left') ctx.rect(r.x, r.y, r.w * reveal, r.h)
    else ctx.rect(r.x, r.y + r.h * (1 - reveal), r.w, r.h * reveal)
    ctx.clip()
  }
  if (item.kind === 'asset') drawAsset(ctx, item, r, source(item))
  else if (item.kind === 'shape') drawShape(ctx, item, r, reveal, mode, ri.trim)
  else drawText(ctx, item, r, reveal, mode, ri.rollFrom)
  ctx.restore()
}

let trailCanvases: [OffscreenCanvas, OffscreenCanvas] | undefined
function trailCanvas(w: number, h: number): [OffscreenCanvas, OffscreenCanvas] {
  if (!trailCanvases || trailCanvases[0].width !== w || trailCanvases[0].height !== h) trailCanvases = [new OffscreenCanvas(w, h), new OffscreenCanvas(w, h)]
  return trailCanvases
}

/**
 * Motion blur: each sample drawn alone, added at 1 / n (premultiplied, so the sum is the exact average), then the
 * average drawn like the element would be (the frame's clip, the layer's alpha and effects still apply).
 */
function drawTrail(ctx: Ctx2D, ri: ResolvedItem, source: (item: CanvasAssetItem) => ItemSource | undefined): void {
  const samples = ri.trail!
  const { width, height } = ctx.canvas
  const [one, sum] = trailCanvas(width, height)
  const a = one.getContext('2d')
  const b = sum.getContext('2d')
  if (!a || !b) return drawItem(ctx, { ...ri, trail: undefined }, source)
  const m = ctx.getTransform()
  b.setTransform(1, 0, 0, 1, 0, 0)
  b.clearRect(0, 0, width, height)
  b.globalCompositeOperation = 'lighter'
  b.globalAlpha = 1 / samples.length
  for (const s of samples) {
    a.setTransform(1, 0, 0, 1, 0, 0)
    a.clearRect(0, 0, width, height)
    a.setTransform(m)
    a.imageSmoothingQuality = 'high'
    drawItem(a, { ...s, trail: undefined }, source)
    b.drawImage(one, 0, 0)
  }
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  if (ri.item.blend) ctx.globalCompositeOperation = ri.item.blend === 'add' ? 'lighter' : ri.item.blend === 'normal' ? 'source-over' : ri.item.blend
  ctx.drawImage(sum, 0, 0)
  ctx.restore()
}

const clipCanvases: OffscreenCanvas[] = []
function clipCanvas(i: number, w: number, h: number, m: DOMMatrix): OffscreenCanvasRenderingContext2D {
  let c = clipCanvases[i]
  if (!c || c.width !== w || c.height !== h) c = clipCanvases[i] = new OffscreenCanvas(w, h)
  const ctx = c.getContext('2d')!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.filter = 'none'
  ctx.clearRect(0, 0, w, h)
  ctx.setTransform(m)
  ctx.imageSmoothingQuality = 'high'
  return ctx
}

/**
 * Keeps what is drawn on `ctx` only where the masks are (or, inverted, only where they aren't): the masks are drawn
 * together, with their own alpha, then cut what is there.
 */
export function applyMask(ctx: Ctx2D, masks: readonly ResolvedItem[], invert: boolean, source: (item: CanvasAssetItem) => ItemSource | undefined) {
  if (typeof OffscreenCanvas === 'undefined') return
  const { width, height } = ctx.canvas
  const m = clipCanvas(1, width, height, ctx.getTransform())
  for (const mk of masks) drawItem(m, mk, source)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.filter = 'none'
  ctx.globalCompositeOperation = invert ? 'destination-out' : 'destination-in'
  ctx.drawImage(m.canvas, 0, 0)
  ctx.restore()
}

/**
 * Every element of a view, back to front, in frame units (background and camera are the caller's). Masks aren't
 * drawn on their own; a clipped element is drawn alone, cut by its mask, then laid down.
 */
export function drawItems(ctx: Ctx2D, view: MotionView, source: (item: CanvasAssetItem) => ItemSource | undefined) {
  for (const ri of view.items) {
    if (ri.matte) continue
    const clip = ri.clip
    const masks = clip ? view.items.filter((m) => m.item.id === clip.by || m.groupIds?.includes(clip.by)) : []
    if (!clip || !masks.length || typeof OffscreenCanvas === 'undefined') {
      drawItem(ctx, ri, source)
      continue
    }
    const { width, height } = ctx.canvas
    const layer = clipCanvas(0, width, height, ctx.getTransform())
    drawItem(layer, { ...ri, item: { ...ri.item, blend: undefined } }, source)
    applyMask(layer, masks, clip.invert, source)
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (ri.item.blend) ctx.globalCompositeOperation = ri.item.blend === 'add' ? 'lighter' : ri.item.blend === 'normal' ? 'source-over' : ri.item.blend
    ctx.drawImage(layer.canvas, 0, 0)
    ctx.restore()
  }
}
