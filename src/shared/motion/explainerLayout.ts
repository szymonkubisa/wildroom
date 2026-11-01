import { shapeOutline } from '../canvas/path'
import { parseMarkup } from '../canvas/richText'
import type { CanvasAssetItem, CanvasFrameItem, CanvasItem, CanvasShapeItem, CanvasTextItem, Rect } from '../types/canvas'
import type { PresetId } from './edit'
import type { ExplainerElement, ExplainerScene } from './explainer'
import type { ExplainerTheme } from './explainerStyles'

/**
 * An explainer scene laid out on a Canvas frame. Six layouts — words beside pictures (`column`), a picture filling one
 * half (`split`), everything centred (`center`), a picture filling the frame under the words (`full-bleed`), up to
 * three cards (`cards`), and points round a ring joined by lines (`diagram`) — each dressed by the style (fonts,
 * pictures cut out or masked, decoration). Elements with a `key` stay from one scene to the next: same place, same
 * picture, already there at the cut. Pure: the board measures text with its renderer when it passes `measure`.
 */

export interface SceneLayout {
  frame: CanvasFrameItem
  /** Back to front: the frame's contents. */
  items: CanvasItem[]
  /** The item made for each scene element (same order). */
  itemIds: string[]
  /** Items kept from an earlier scene (by key): there from the cut, so they don't come in. */
  kept: string[]
  /** Decoration and helpers with their own entrance, after element `after` comes in (-1: as the scene starts). */
  extras: { id: string; preset: PresetId; after: number }[]
  /** The key of each item that has one (a kept picture reuses the first one's picture). */
  keyOf: Record<string, string>
}

/** Where keyed elements were first placed, relative to their frame; filled scene by scene. */
export type SharedElements = Map<string, { kind: ExplainerElement['kind']; rect: Rect; item: CanvasItem }>

type Box = { x: number; y: number; w: number }
type Measure = (text: CanvasTextItem) => number

/** Rough height of wrapped text: about 0.55 em per character on a line. */
function estimateHeight(text: string, width: number, size: number, lineHeight: number): number {
  const perLine = Math.max(1, Math.floor(width / (size * 0.55)))
  return Math.ceil(Math.max(1, text.length) / perLine) * size * lineHeight
}

const isLight = (hex: string) => {
  const m = /^#?([0-9a-f]{6})/i.exec(hex)
  if (!m) return false
  const n = parseInt(m[1]!, 16)
  return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 > 150
}

/** A wave drawn left to right across its box (in a 100 × 40 path box). */
const WAVE = 'M0 20 C 12 0, 25 0, 37 20 S 62 40, 75 20 S 100 0, 100 20'

export function layoutScene(
  scene: ExplainerScene,
  at: { x: number; y: number; w: number; h: number },
  theme: ExplainerTheme,
  newId: () => string,
  measure?: Measure,
  shared: SharedElements = new Map(),
): SceneLayout {
  const { w, h } = at
  const portrait = h > w
  const pad = Math.round(Math.min(w, h) * 0.08)
  const frame: CanvasFrameItem = { id: newId(), kind: 'frame', name: scene.title, x: at.x, y: at.y, w, h, fill: theme.background }
  const out: SceneLayout = { frame, items: [], itemIds: [], kept: [], extras: [], keyOf: {} }
  const bg = typeof theme.background === 'string' ? theme.background : (theme.background.stops[0]?.color ?? '#000000')
  const lightBg = isLight(bg)
  const images = scene.elements.filter((e) => e.kind === 'image').length
  const layout = portrait && scene.layout !== 'center' && scene.layout !== 'full-bleed' ? 'column' : scene.layout
  const add = (item: CanvasItem) => (out.items.push(item), item)
  const R = (x: number, y: number, rw: number, rh: number): Rect => ({ x: Math.round(at.x + x), y: Math.round(at.y + y), w: Math.max(1, Math.round(rw)), h: Math.max(1, Math.round(rh)) })

  // ---- decoration, behind everything
  decorate(theme, frame, R, w, h, pad, newId, add, out)

  // ---- elements
  const textItem = (e: ExplainerElement, box: Box, role: 'title' | 'text' | 'number', align: CanvasTextItem['align'], big = false): CanvasTextItem => {
    // From the short side: a portrait frame's height would make the words too big for its width.
    const size = Math.round(Math.min(w, h) * (role === 'number' ? 0.15 : role === 'title' ? (big ? 0.095 : 0.075) : 0.042))
    const lineHeight = role === 'text' ? 1.35 : 1.1
    const base = {
      fontFamily: role === 'text' ? theme.font : theme.headingFont,
      fontWeight: role === 'text' ? 500 : theme.headingWeight,
      color: role === 'number' ? theme.accent : role === 'title' ? theme.text : theme.muted,
    }
    const rich = parseMarkup(e.text, base)
    const item: CanvasTextItem = {
      id: newId(),
      kind: 'text',
      text: rich.text,
      ...base,
      fontSize: size,
      align,
      lineHeight,
      frameId: frame.id,
      x: Math.round(box.x),
      y: Math.round(box.y),
      w: Math.round(box.w),
      h: Math.round(estimateHeight(rich.text, box.w, size, lineHeight)),
    }
    // A highlighter is bright: the words on it are dark on a dark frame.
    if (rich.spans) item.spans = lightBg ? rich.spans : rich.spans.map((sp) => (sp.highlight && !sp.color ? { ...sp, color: '#111111' } : sp))
    else if (role === 'title' && theme.accentLastWord && /\s/.test(rich.text)) {
      // A serif-italic accent on the last word, in the accent colour.
      const cut = rich.text.lastIndexOf(' ')
      item.spans = [{ text: rich.text.slice(0, cut + 1) }, { text: rich.text.slice(cut + 1), fontFamily: 'Georgia', fontStyle: 'italic', fontWeight: 600, color: theme.accent }]
    }
    if (measure) item.h = Math.round(measure(item))
    return item
  }
  const picture = (e: ExplainerElement, r: Rect, framed: boolean): CanvasAssetItem => {
    const item: CanvasAssetItem = { id: newId(), kind: 'asset', frameId: frame.id, name: 'Picture', ...r, planned: { deliverable: 'explainer', prompt: e.prompt } }
    const p = theme.picture
    if (framed && p.mask) {
      // A circle only where the slot is about square; wide or tall slots get rounded corners.
      item.mask = p.mask === 'ellipse' && Math.abs(r.w / r.h - 1) > 0.25 ? 'rounded' : p.mask
      if (item.mask === 'rounded') item.radius = Math.round(Math.min(r.w, r.h) * 0.08)
    }
    if (p.duotone) item.duotone = { ...p.duotone }
    if (p.mono) item.adjust = { bw: 1, contrast: p.mono }
    if (p.shadow && framed) item.shadow = { color: '#00000099', blur: Math.round(h * 0.04), x: 0, y: Math.round(h * 0.02) }
    return item
  }
  const accent = (e: ExplainerElement, x: number, y: number): CanvasShapeItem =>
    e.shape === 'ellipse'
      ? { id: newId(), kind: 'shape', shape: 'ellipse', fill: theme.accent, frameId: frame.id, x: Math.round(x), y: Math.round(y), w: Math.round(h * 0.06), h: Math.round(h * 0.06) }
      : { id: newId(), kind: 'shape', shape: 'rect', fill: theme.accent, radius: Math.round(h * 0.006), frameId: frame.id, x: Math.round(x), y: Math.round(y), w: Math.round(h * 0.12), h: Math.max(2, Math.round(h * 0.012)) }
  const wave = (box: Box, y: number): CanvasShapeItem => ({
    id: newId(),
    kind: 'shape',
    shape: 'path',
    d: WAVE,
    pathBox: { w: 100, h: 40 },
    fill: 'none',
    stroke: { color: theme.accent, width: Math.max(2, Math.round(h * 0.008)), cap: 'round', join: 'round' },
    frameId: frame.id,
    x: Math.round(box.x),
    y: Math.round(y),
    w: Math.round(Math.min(box.w, h * 0.5)),
    h: Math.round(h * 0.06),
  })

  /** Keys placed in this scene: a key said twice in one scene is laid out again, not stacked on the first. */
  const here = new Set<string>()
  /** A keyed element already placed in an earlier scene: the same thing (same kind), in the same place. */
  const place = (e: ExplainerElement, i: number): boolean => {
    const s = e.key && !here.has(e.key) ? shared.get(e.key) : undefined
    if (!s || s.kind !== e.kind) return false
    here.add(e.key)
    const item = { ...structuredClone(s.item), id: newId(), frameId: frame.id, x: at.x + s.rect.x, y: at.y + s.rect.y }
    add(item)
    out.itemIds[i] = item.id
    out.kept.push(item.id)
    out.keyOf[item.id] = e.key
    return true
  }
  const commit = (e: ExplainerElement, i: number, item: CanvasItem) => {
    add(item)
    out.itemIds[i] = item.id
    if (e.key && !here.has(e.key)) {
      here.add(e.key)
      out.keyOf[item.id] = e.key
      shared.set(e.key, { kind: e.kind, rect: { x: item.x - at.x, y: item.y - at.y, w: item.w, h: item.h }, item: structuredClone(item) })
    }
  }

  /** Words, accents and lines top to bottom in `box`; returns the y below them. */
  const flow = (list: { e: ExplainerElement; i: number }[], box: Box, align: CanvasTextItem['align'], big = false) => {
    let y = box.y
    for (const { e, i } of list) {
      if (place(e, i)) continue
      let item: CanvasItem
      if (e.kind === 'shape') {
        item = accent(e, align === 'center' ? box.x + box.w / 2 - h * 0.06 : box.x, y)
        y += item.h + h * 0.04
      } else if (e.kind === 'line') {
        item = wave(align === 'center' ? { ...box, x: box.x + box.w / 2 - Math.min(box.w, h * 0.5) / 2 } : box, y)
        y += item.h + h * 0.04
      } else {
        const role = e.kind === 'title' ? 'title' : e.kind === 'number' ? 'number' : 'text'
        item = textItem(e, { ...box, y }, role, align, big)
        y += item.h + h * (role === 'title' ? 0.035 : 0.03)
      }
      commit(e, i, item)
    }
    return y
  }

  const els = scene.elements.map((e, i) => ({ e, i }))
  const words = els.filter(({ e }) => e.kind !== 'image')
  const pics = els.filter(({ e }) => e.kind === 'image')
  const putPictures = (slots: Rect[], framed: boolean) =>
    pics.forEach(({ e, i }, k) => {
      if (place(e, i)) return
      commit(e, i, picture(e, slots[Math.min(k, slots.length - 1)]!, framed))
    })

  switch (layout) {
    case 'split': {
      putPictures([R(0, 0, w * 0.5, h), ...[0, 1].map((k) => R(w * 0.56 + k * h * 0.24, h * 0.66, h * 0.2, h * 0.2))], false)
      flow(words, { x: at.x + w * 0.56, y: at.y + h * 0.18, w: w * 0.38 }, 'left')
      break
    }
    case 'center': {
      const bottom = flow(words, { x: at.x + pad * 2, y: at.y + h * (images ? 0.12 : 0.3), w: w - pad * 4 }, 'center', true)
      if (images) {
        // Below the words, but never off the frame: long words leave the pictures smaller, then under them.
        const top = Math.min(Math.max(bottom - at.y + h * 0.03, h * 0.5), h - pad - h * 0.2)
        const sh = h - top - pad
        const sw = Math.min(sh * 1.4, (w - 2 * pad - (images - 1) * pad) / images)
        const x0 = (w - (sw * images + pad * (images - 1))) / 2
        putPictures(
          pics.map((_, k) => R(x0 + k * (sw + pad), top, sw, sh)),
          true,
        )
      }
      break
    }
    case 'full-bleed': {
      putPictures([R(0, 0, w, h), R(w - pad - h * 0.22, pad, h * 0.22, h * 0.22), R(w - pad * 2 - h * 0.44, pad, h * 0.22, h * 0.22)], false)
      // Words over the picture: a fade into the background colour under them.
      const shade: CanvasShapeItem = {
        id: newId(),
        kind: 'shape',
        shape: 'rect',
        fill: { type: 'linear', angle: 90, stops: [{ at: 0, color: `${bg.slice(0, 7)}00` }, { at: 1, color: `${bg.slice(0, 7)}e6` }] },
        frameId: frame.id,
        ...R(0, h * 0.38, w, h * 0.62),
      }
      add(shade)
      out.extras.push({ id: shade.id, preset: 'fade-in', after: -1 })
      flow(words, { x: at.x + pad, y: at.y + h * 0.58, w: portrait ? w - 2 * pad : w * 0.62 }, 'left', true)
      break
    }
    case 'cards': {
      const head = words.filter(({ e }) => e.kind === 'title')
      const rest = words.filter(({ e }) => e.kind !== 'title')
      const captions = rest.filter(({ e }) => e.kind === 'text' || e.kind === 'number')
      flow(head, { x: at.x + pad, y: at.y + h * 0.1, w: w - 2 * pad }, 'left')
      const n = Math.max(1, Math.min(3, Math.max(images, captions.length)))
      const gap = pad * 0.6
      const cw = (w - 2 * pad - (n - 1) * gap) / n
      const cy = h * 0.32
      const ch = h * 0.58
      for (let k = 0; k < n; k++) {
        const card: CanvasShapeItem = {
          id: newId(),
          kind: 'shape',
          shape: 'rect',
          fill: lightBg ? '#0c1a3a0f' : '#ffffff12',
          radius: Math.round(h * 0.025),
          frameId: frame.id,
          ...R(pad + k * (cw + gap), cy, cw, ch),
        }
        add(card)
        out.extras.push({ id: card.id, preset: 'fade-in', after: captions[k]?.i ?? pics[k]?.i ?? -1 })
      }
      putPictures(
        pics.map((_, k) => R(pad + k * (cw + gap) + h * 0.03, cy + h * 0.03, cw - h * 0.06, ch * 0.56)),
        true,
      )
      const inCards = captions.slice(0, n)
      inCards.forEach(({ e, i }, k) => {
        if (place(e, i)) return
        const box = { x: at.x + pad + k * (cw + gap) + h * 0.03, y: at.y + cy + (images ? ch * 0.62 : h * 0.05), w: cw - h * 0.06 }
        commit(e, i, textItem(e, box, e.kind === 'number' ? 'number' : 'text', 'left'))
      })
      // Anything else (accents, lines, more lines than cards) under the title.
      flow(
        rest.filter((r) => !inCards.includes(r)),
        { x: at.x + pad, y: at.y + h * 0.22, w: w - 2 * pad },
        'left',
      )
      break
    }
    case 'diagram': {
      const head = words.filter(({ e }) => e.kind === 'title')
      const nodes = words.filter(({ e }) => e.kind === 'text' || e.kind === 'number').slice(0, 4)
      const others = words.filter((r) => !head.includes(r) && !nodes.includes(r))
      flow(head, { x: at.x + pad, y: at.y + h * 0.08, w: w - 2 * pad }, 'left')
      const cx = w / 2
      const cy = h * 0.6
      const radius = h * 0.27
      const ring = h * 0.24
      const angles = nodes.length === 2 ? [180, 0] : nodes.map((_, k) => -90 + (360 / nodes.length) * k)
      const points = angles.map((a) => ({ x: cx + radius * Math.cos((a * Math.PI) / 180), y: cy + radius * Math.sin((a * Math.PI) / 180) }))
      // Lines from each point to the one before (closing the loop from three points on), drawn as the points come in.
      points.forEach((p, k) => {
        if (k === 0 && points.length < 3) return
        const q = points[k === 0 ? points.length - 1 : k - 1]!
        const x = Math.min(p.x, q.x)
        const y = Math.min(p.y, q.y)
        const lw = Math.max(1, Math.abs(p.x - q.x))
        const lh = Math.max(1, Math.abs(p.y - q.y))
        const line: CanvasShapeItem = {
          id: newId(),
          kind: 'shape',
          shape: 'line',
          fill: 'none',
          stroke: { color: theme.muted, width: Math.max(2, Math.round(h * 0.004)), cap: 'round' },
          points: [
            [lw > 1 ? (q.x - x) / lw : 0.5, lh > 1 ? (q.y - y) / lh : 0.5],
            [lw > 1 ? (p.x - x) / lw : 0.5, lh > 1 ? (p.y - y) / lh : 0.5],
          ],
          frameId: frame.id,
          ...R(x, y, lw, lh),
        }
        add(line)
        out.extras.push({ id: line.id, preset: 'draw', after: nodes[k === 0 ? nodes.length - 1 : k]!.i })
      })
      nodes.forEach(({ e, i }, k) => {
        const p = points[k]!
        const circle: CanvasShapeItem = {
          id: newId(),
          kind: 'shape',
          shape: 'ellipse',
          fill: bg.slice(0, 7),
          stroke: { color: theme.accent, width: Math.max(2, Math.round(h * 0.006)) },
          frameId: frame.id,
          ...R(p.x - ring / 2, p.y - ring / 2, ring, ring),
        }
        if (theme.decor.includes('neon-rings')) circle.glow = { color: theme.accent, blur: Math.round(h * 0.02) }
        add(circle)
        out.extras.push({ id: circle.id, preset: 'draw', after: i })
        if (place(e, i)) return
        const box = { x: at.x + p.x - ring * 0.8, y: at.y + p.y - h * 0.035, w: ring * 1.6 }
        commit(e, i, textItem(e, box, e.kind === 'number' ? 'number' : 'text', 'center'))
      })
      putPictures([R(cx - h * 0.09, cy - h * 0.09, h * 0.18, h * 0.18)], true)
      flow(others, { x: at.x + pad, y: at.y + h * 0.2, w: w - 2 * pad }, 'left')
      break
    }
    default: {
      // column (and every layout in a portrait frame): words above or beside the pictures
      const column = { x: at.x + pad, y: at.y + h * (portrait ? 0.1 : 0.16), w: images && !portrait ? w * 0.44 - pad : w - 2 * pad }
      if (portrait) {
        // The words first; the pictures below them (from half-way down), in what's left of the frame.
        const bottom = flow(words, column, 'left') - at.y
        const top = Math.min(Math.max(h * 0.52, bottom + pad / 2), h - pad - h * 0.2)
        const each = (w - 2 * pad - (images - 1) * (pad / 2)) / Math.max(1, images)
        putPictures(
          pics.map((_, k) => R(pad + k * (each + pad / 2), top, each, Math.min(h * 0.4, h - top - pad))),
          true,
        )
        break
      } else {
        const a = { x: w * 0.5, y: h * 0.14, w: w * 0.42, h: h * 0.72 }
        const slots =
          images <= 1
            ? [R(a.x, a.y, a.w, a.h)]
            : images === 2
              ? [R(a.x, a.y, a.w, a.h * 0.48), R(a.x, a.y + a.h * 0.52, a.w, a.h * 0.48)]
              : [R(a.x, a.y, a.w, a.h * 0.58), R(a.x, a.y + a.h * 0.62, a.w * 0.48, a.h * 0.38), R(a.x + a.w * 0.52, a.y + a.h * 0.62, a.w * 0.48, a.h * 0.38)]
        putPictures(slots, true)
      }
      flow(words, column, 'left')
    }
  }
  clearOfText(out, at, h)
  return out
}

/** About where a text box's words are: as wide as its letters at its size (or the box), placed by its alignment. */
function inked(t: CanvasTextItem): Rect {
  const longest = Math.max(...t.text.split('\n').map((l) => l.length))
  const tw = Math.min(t.w, longest * t.fontSize * 0.55)
  const x = t.align === 'center' ? t.x + (t.w - tw) / 2 : t.align === 'right' ? t.x + t.w - tw : t.x
  return { x, y: t.y, w: tw, h: t.h }
}

/**
 * Outlined decoration (arcs, rings) kept off the words: one that would cross a text tries the other side of the frame,
 * then lower down, then goes.
 */
function clearOfText(out: SceneLayout, at: { x: number; y: number; w: number; h: number }, h: number) {
  const m = h * 0.02
  const texts = out.items.filter((i): i is CanvasTextItem => i.kind === 'text').map(inked)
  const crosses = (d: CanvasShapeItem, x: number, y: number) =>
    shapeOutline(d, d.w, d.h).some((sub) =>
      sub.points.some(([px, py]) => texts.some((t) => x + px > t.x - m && x + px < t.x + t.w + m && y + py > t.y - m && y + py < t.y + t.h + m)),
    )
  const gone = new Set<string>()
  for (const e of out.extras) {
    const d = out.items.find((i) => i.id === e.id)
    if (d?.kind !== 'shape' || d.fill !== 'none' || e.after !== -1) continue
    const mirror = at.x + at.w - (d.x - at.x) - d.w
    const lower = Math.min(at.y + at.h - d.h * 0.45, d.y + h * 0.3)
    const spot = [
      [d.x, d.y],
      [mirror, d.y],
      [d.x, lower],
      [mirror, lower],
    ].find(([x, y]) => !crosses(d, x!, y!))
    if (spot) [d.x, d.y] = [Math.round(spot[0]!), Math.round(spot[1]!)]
    else gone.add(d.id)
  }
  if (!gone.size) return
  out.items = out.items.filter((i) => !gone.has(i.id))
  out.extras = out.extras.filter((e) => !gone.has(e.id))
}

/** The style's decoration on a frame (behind the scene's elements), each with its entrance. */
function decorate(
  theme: ExplainerTheme,
  frame: CanvasFrameItem,
  R: (x: number, y: number, w: number, h: number) => Rect,
  w: number,
  h: number,
  pad: number,
  newId: () => string,
  add: (item: CanvasItem) => CanvasItem,
  out: SceneLayout,
) {
  const shape = (s: Omit<CanvasShapeItem, 'id' | 'kind' | 'frameId'>, preset: PresetId) => {
    const item = add({ id: newId(), kind: 'shape', frameId: frame.id, ...s } as CanvasShapeItem)
    out.extras.push({ id: item.id, preset, after: -1 })
  }
  for (const d of theme.decor) {
    if (d === 'dots') shape({ shape: 'rect', fill: { type: 'pattern', pattern: 'dots', color: `${theme.muted}55`, size: Math.round(h * 0.03) }, ...R(w * 0.74, pad * 0.6, w * 0.2, h * 0.16) }, 'fade-in')
    if (d === 'grid') shape({ shape: 'rect', fill: { type: 'pattern', pattern: 'grid', color: `${theme.muted}33`, size: Math.round(h * 0.05) }, ...R(0, 0, w, h) }, 'fade-in')
    if (d === 'barcode') shape({ shape: 'rect', fill: { type: 'pattern', pattern: 'barcode', color: theme.text, size: Math.round(h * 0.012) }, ...R(pad, h - pad * 0.6 - h * 0.035, w * 0.12, h * 0.035) }, 'wipe-in')
    if (d === 'arc')
      shape({ shape: 'arc', arc: { start: 190, end: 350 }, fill: 'none', stroke: { color: theme.accent, width: Math.max(2, Math.round(h * 0.004)), cap: 'round' }, ...R(w - pad - h * 0.8, h * 0.06, h * 0.8, h * 0.8) }, 'draw')
    if (d === 'sphere')
      shape(
        {
          shape: 'ellipse',
          fill: { type: 'radial', stops: [{ at: 0, color: '#ffffff' }, { at: 0.5, color: '#9a9ca3' }, { at: 1, color: '#2a2b2f' }], cx: 0.35, cy: 0.3 },
          shadow: { color: '#00000099', blur: Math.round(h * 0.04), x: 0, y: Math.round(h * 0.02) },
          ...R(w - pad - h * 0.18, h - pad - h * 0.18, h * 0.18, h * 0.18),
        },
        'pop',
      )
    if (d === 'neon-rings')
      for (const [k, color] of ['#00e5ff', theme.accent].entries())
        shape(
          {
            shape: 'ellipse',
            fill: 'none',
            stroke: { color, width: Math.max(2, Math.round(h * 0.004)) },
            glow: { color, blur: Math.round(h * 0.025) },
            ...R(w - pad - h * 0.46 + k * h * 0.16, pad * 0.6, h * 0.3, h * 0.3),
          },
          'draw',
        )
  }
}
