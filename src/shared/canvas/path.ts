import type { CanvasShapeItem } from '../types/canvas'

/**
 * Shape geometry as polylines: SVG path data parsed and flattened, every shape kind's outline in its box, lengths and
 * trimming (a stroke that draws itself, a gauge's progress). Pure, so the board, the PNG export and the video share it.
 */

export type Pt = [number, number]
export interface Subpath {
  points: Pt[]
  closed: boolean
}

/** Max distance (board units) between a curve and its flattened polyline. */
const TOLERANCE = 0.35

function cubicPoints(p0: Pt, p1: Pt, p2: Pt, p3: Pt): Pt[] {
  const hull = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1])
  const n = Math.min(256, Math.max(2, Math.ceil(Math.sqrt(hull / TOLERANCE))))
  const out: Pt[] = []
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ])
  }
  return out
}

/** SVG elliptical arc (endpoint form) as points after `from`. */
function arcPoints(from: Pt, rx: number, ry: number, rotation: number, large: boolean, sweep: boolean, to: Pt): Pt[] {
  if (!rx || !ry) return [to]
  const phi = (rotation * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (from[0] - to[0]) / 2
  const dy = (from[1] - to[1]) / 2
  const x1 = cos * dx + sin * dy
  const y1 = -sin * dx + cos * dy
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (lambda > 1) {
    rx *= Math.sqrt(lambda)
    ry *= Math.sqrt(lambda)
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1
  const coef = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den))
  const cx1 = (coef * rx * y1) / ry
  const cy1 = (-coef * ry * x1) / rx
  const cx = cos * cx1 - sin * cy1 + (from[0] + to[0]) / 2
  const cy = sin * cx1 + cos * cy1 + (from[1] + to[1]) / 2
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const t1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
  let dt = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
  if (!sweep && dt > 0) dt -= 2 * Math.PI
  if (sweep && dt < 0) dt += 2 * Math.PI
  const n = Math.min(256, Math.max(4, Math.ceil(Math.abs(dt) * Math.sqrt(Math.max(rx, ry) / TOLERANCE))))
  const out: Pt[] = []
  for (let i = 1; i <= n; i++) {
    const t = t1 + (dt * i) / n
    out.push([cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos])
  }
  out[out.length - 1] = to
  return out
}

/** SVG path data (M L H V C S Q T A Z, absolute and relative) flattened to polylines. Malformed input stops parsing. */
export function parsePath(d: string): Subpath[] {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? []
  const out: Subpath[] = []
  let cur: Subpath | undefined
  let at: Pt = [0, 0]
  let start: Pt = [0, 0]
  let lastCtrl: Pt | undefined
  let lastCmd = ''
  let i = 0
  const num = () => {
    const v = Number(tokens[i++])
    if (!Number.isFinite(v)) throw new Error('bad number')
    return v
  }
  /** An arc flag: one 0 or 1, which minified paths run into the next number ("0110 0" is 0, 1, 10, 0). */
  const flag = () => {
    const t = tokens[i]
    if (t === undefined || !/^[01]/.test(t)) throw new Error('bad flag')
    if (t.length > 1) tokens[i] = t.slice(1)
    else i++
    return t[0] === '1'
  }
  const isNum = () => i < tokens.length && !/[a-z]/i.test(tokens[i]!)
  const moveTo = (p: Pt) => {
    cur = { points: [p], closed: false }
    out.push(cur)
    at = start = p
  }
  const lineTo = (p: Pt) => {
    if (!cur) moveTo(at)
    cur!.points.push(p)
    at = p
  }
  try {
    let cmd = ''
    while (i < tokens.length) {
      if (!isNum()) cmd = tokens[i++]!
      else if (!cmd) break
      const rel = cmd === cmd.toLowerCase()
      const ox = rel ? at[0] : 0
      const oy = rel ? at[1] : 0
      switch (cmd.toUpperCase()) {
        case 'M':
          moveTo([num() + ox, num() + oy])
          cmd = rel ? 'l' : 'L' // further pairs are lines
          break
        case 'L':
          lineTo([num() + ox, num() + oy])
          break
        case 'H':
          lineTo([num() + ox, at[1]])
          break
        case 'V':
          lineTo([at[0], num() + oy])
          break
        case 'C': {
          const c1: Pt = [num() + ox, num() + oy]
          const c2: Pt = [num() + ox, num() + oy]
          const p: Pt = [num() + ox, num() + oy]
          for (const q of cubicPoints(at, c1, c2, p)) lineTo(q)
          lastCtrl = c2
          break
        }
        case 'S': {
          const c1: Pt = lastCtrl && /[CS]/i.test(lastCmd) ? [2 * at[0] - lastCtrl[0], 2 * at[1] - lastCtrl[1]] : at
          const c2: Pt = [num() + ox, num() + oy]
          const p: Pt = [num() + ox, num() + oy]
          for (const q of cubicPoints(at, c1, c2, p)) lineTo(q)
          lastCtrl = c2
          break
        }
        case 'Q':
        case 'T': {
          const q1: Pt =
            cmd.toUpperCase() === 'Q' ? [num() + ox, num() + oy] : lastCtrl && /[QT]/i.test(lastCmd) ? [2 * at[0] - lastCtrl[0], 2 * at[1] - lastCtrl[1]] : at
          const p: Pt = [num() + ox, num() + oy]
          const c1: Pt = [at[0] + (2 / 3) * (q1[0] - at[0]), at[1] + (2 / 3) * (q1[1] - at[1])]
          const c2: Pt = [p[0] + (2 / 3) * (q1[0] - p[0]), p[1] + (2 / 3) * (q1[1] - p[1])]
          for (const q of cubicPoints(at, c1, c2, p)) lineTo(q)
          lastCtrl = q1
          break
        }
        case 'A': {
          const rx = num()
          const ry = num()
          const rot = num()
          const large = flag()
          const sweep = flag()
          const p: Pt = [num() + ox, num() + oy]
          for (const q of arcPoints(at, rx, ry, rot, large, sweep, p)) lineTo(q)
          break
        }
        case 'Z':
          if (cur) cur.closed = true
          at = start
          cur = undefined
          // Numbers after Z have no command to belong to: stop (Z reads none, so they would loop forever).
          if (isNum()) cmd = ''
          break
        default:
          return out
      }
      lastCmd = cmd
      if (!/[CSQT]/i.test(cmd)) lastCtrl = undefined
    }
  } catch {
    // Keep what parsed before the bad token.
  }
  return out.filter((s) => s.points.length > 1)
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number, from: number, to: number): Pt[] {
  const n = Math.min(360, Math.max(8, Math.ceil(Math.abs(to - from) * Math.sqrt(Math.max(rx, ry) / TOLERANCE))))
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = from + ((to - from) * i) / n
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)] as Pt
  })
}

const DEG = Math.PI / 180

/** A shape's outline in its own box (0..w, 0..h): what is filled (closed subpaths) and stroked. */
export function shapeOutline(s: Pick<CanvasShapeItem, 'shape' | 'radius' | 'points' | 'd' | 'pathBox' | 'arc'>, w: number, h: number): Subpath[] {
  switch (s.shape) {
    case 'rect': {
      const r = Math.min(s.radius ?? 0, w / 2, h / 2)
      if (r <= 0)
        return [
          {
            points: [
              [0, 0],
              [w, 0],
              [w, h],
              [0, h],
            ],
            closed: true,
          },
        ]
      const corner = (cx: number, cy: number, a: number) => ellipsePoints(cx, cy, r, r, a, a + Math.PI / 2)
      return [{ points: [...corner(w - r, r, -Math.PI / 2), ...corner(w - r, h - r, 0), ...corner(r, h - r, Math.PI / 2), ...corner(r, r, Math.PI)], closed: true }]
    }
    case 'ellipse':
      return [{ points: ellipsePoints(w / 2, h / 2, w / 2, h / 2, -Math.PI / 2, (3 * Math.PI) / 2).slice(0, -1), closed: true }]
    case 'arc': {
      const a = s.arc ?? { start: -90, end: 90 }
      return [{ points: ellipsePoints(w / 2, h / 2, w / 2, h / 2, a.start * DEG, a.end * DEG), closed: false }]
    }
    case 'line':
    case 'polyline':
    case 'polygon': {
      const pts = (s.points?.length ? s.points : s.shape === 'polygon' ? TRIANGLE : LINE).map(([x, y]) => [x * w, y * h] as Pt)
      return pts.length > 1 ? [{ points: pts, closed: s.shape === 'polygon' }] : []
    }
    case 'path': {
      const box = s.pathBox ?? { w, h }
      const sx = w / Math.max(1e-6, box.w)
      const sy = h / Math.max(1e-6, box.h)
      return parsePath(s.d ?? '').map((sp) => ({ closed: sp.closed, points: sp.points.map(([x, y]) => [x * sx, y * sy] as Pt) }))
    }
  }
}

export const LINE: Pt[] = [
  [0, 0.5],
  [1, 0.5],
]
export const TRIANGLE: Pt[] = [
  [0.5, 0],
  [1, 1],
  [0, 1],
]

/** The ring's points with the closing edge back to the start (closed subpaths are traced and measured round). */
function ring(sp: Subpath): Pt[] {
  return sp.closed ? [...sp.points, sp.points[0]!] : sp.points
}

export function outlineLength(subpaths: readonly Subpath[]): number {
  let n = 0
  for (const sp of subpaths) {
    const pts = ring(sp)
    for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1])
  }
  return n
}

/**
 * The point `at` (0..1 of the whole length, across subpaths in order) along an outline and the direction it runs there
 * (degrees, 0 = to the right, clockwise on screen). An empty outline gives its first point, or the origin.
 */
export function pointAt(subpaths: readonly Subpath[], at: number): { x: number; y: number; angle: number } {
  const total = outlineLength(subpaths)
  let left = Math.min(1, Math.max(0, at)) * total
  let last: { x: number; y: number; angle: number } | undefined
  for (const sp of subpaths) {
    const pts = ring(sp)
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1]!
      const [bx, by] = pts[i]!
      const len = Math.hypot(bx - ax, by - ay)
      if (!len) continue
      const angle = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI
      if (left <= len) return { x: ax + ((bx - ax) * left) / len, y: ay + ((by - ay) * left) / len, angle }
      left -= len
      last = { x: bx, y: by, angle }
    }
  }
  const first = subpaths[0]?.points[0]
  return last ?? { x: first?.[0] ?? 0, y: first?.[1] ?? 0, angle: 0 }
}

/**
 * The part of an outline between `from` and `to` (fractions of its whole length, across all subpaths in order), as
 * open polylines to stroke.
 */
export function trimOutline(subpaths: readonly Subpath[], from: number, to: number): Pt[][] {
  const total = outlineLength(subpaths)
  const a = Math.max(0, Math.min(1, from)) * total
  const b = Math.max(0, Math.min(1, to)) * total
  const out: Pt[][] = []
  if (b <= a) return out
  let walked = 0
  for (const sp of subpaths) {
    const pts = ring(sp)
    let piece: Pt[] | undefined
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1]!
      const q = pts[i]!
      const len = Math.hypot(q[0] - p[0], q[1] - p[1])
      const s0 = walked
      const s1 = walked + len
      walked = s1
      if (s1 <= a || s0 >= b || !len) continue
      const lerp = (s: number): Pt => {
        const t = (s - s0) / len
        return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
      }
      if (!piece) {
        piece = [s0 >= a ? p : lerp(a)]
        out.push(piece)
      }
      piece.push(s1 <= b ? q : lerp(b))
      if (s1 >= b) return out
    }
  }
  return out
}
