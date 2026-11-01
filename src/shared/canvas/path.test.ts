import { describe, expect, it } from 'vitest'
import { evaluateMotion } from '../motion/evaluate'
import { fillColor, sanitizeCanvas, sanitizeFill, sanitizeShape, type CanvasFrameItem, type CanvasShapeItem } from '../types/canvas'
import { resizeRect, resizeRotated, rotateAround } from './geometry'
import type { MotionClip } from '../types/project-doc'
import { LINE, outlineLength, parsePath, shapeOutline, trimOutline } from './path'

const shape = (o: Partial<CanvasShapeItem>): CanvasShapeItem => ({ id: 's', kind: 'shape', shape: 'rect', fill: '#f00', x: 0, y: 0, w: 100, h: 50, ...o })

describe('parsePath', () => {
  it('reads absolute and relative lines, H/V and Z', () => {
    const [a] = parsePath('M10 10 L 30 10 h 20 v 10 Z')
    expect(a).toEqual({ closed: true, points: [[10, 10], [30, 10], [50, 10], [50, 20]] })
    const [b] = parsePath('m 0 0 10 0 0 10')
    expect(b!.points).toEqual([[0, 0], [10, 0], [10, 10]])
  })

  it('flattens curves and arcs onto their end points', () => {
    const [c] = parsePath('M0 0 C 0 100 100 100 100 0')
    expect(c!.points.at(-1)).toEqual([100, 0])
    expect(c!.points.length).toBeGreaterThan(8)
    expect(Math.max(...c!.points.map((p) => p[1]))).toBeCloseTo(75, 0)
    const [q] = parsePath('M0 0 Q 50 100 100 0 T 200 0')
    expect(q!.points.at(-1)).toEqual([200, 0])
    // A half circle of radius 50: its length is about π·50.
    const arc = parsePath('M0 50 A 50 50 0 0 1 100 50')
    expect(outlineLength(arc)).toBeCloseTo(Math.PI * 50, 0)
  })

  it('keeps what parsed before a malformed token, and several subpaths', () => {
    expect(parsePath('M0 0 L 10 10 L x')).toHaveLength(1)
    expect(parsePath('M0 0 L 10 0 M 20 0 L 30 0')).toHaveLength(2)
    expect(parsePath('nonsense')).toEqual([])
    // Numbers after Z have no command: parsing stops instead of looping forever.
    expect(parsePath('M0 0 L10 10 Z 5 5')).toEqual([{ closed: true, points: [[0, 0], [10, 10]] }])
  })

  it('reads arc flags run into the next number, as minified paths write them', () => {
    const [a] = parsePath('M0 50 A50 50 0 0110 50')
    const [b] = parsePath('M0 50 A 50 50 0 0 1 10 50')
    expect(a).toEqual(b)
  })
})

describe('shapeOutline', () => {
  it('gives every kind an outline in its box', () => {
    expect(outlineLength(shapeOutline(shape({}), 100, 50))).toBeCloseTo(300, 6)
    expect(outlineLength(shapeOutline(shape({ shape: 'ellipse' }), 100, 100))).toBeCloseTo(Math.PI * 100, 0)
    expect(shapeOutline(shape({ shape: 'line' }), 100, 50)).toEqual([{ points: LINE.map(([x, y]) => [x * 100, y * 50]), closed: false }])
    const tri = shapeOutline(shape({ shape: 'polygon' }), 100, 100)
    expect(tri[0]!.closed).toBe(true)
    expect(tri[0]!.points).toHaveLength(3)
    const arc = shapeOutline(shape({ shape: 'arc', arc: { start: 0, end: 180 } }), 100, 100)
    expect(arc[0]!.closed).toBe(false)
    expect(outlineLength(arc)).toBeCloseTo(Math.PI * 50, 0)
  })

  it('scales a path from its own box to the item’s', () => {
    const [p] = shapeOutline(shape({ shape: 'path', d: 'M0 0 L 10 10', pathBox: { w: 10, h: 10 } }), 200, 100)
    expect(p!.points).toEqual([[0, 0], [200, 100]])
  })
})

describe('trimOutline', () => {
  const square = shapeOutline(shape({ w: 100, h: 100 }), 100, 100) // 400 long, from the top-left corner clockwise

  it('cuts the outline by fractions of its length, across corners', () => {
    expect(trimOutline(square, 0, 0.25)).toEqual([[[0, 0], [100, 0]]])
    expect(trimOutline(square, 0.125, 0.375)).toEqual([[[50, 0], [100, 0], [100, 50]]])
    expect(outlineLength(trimOutline(square, 0, 1).map((points) => ({ points, closed: false })))).toBeCloseTo(400, 6)
    expect(trimOutline(square, 0.5, 0.5)).toEqual([])
  })

  it('splits across subpaths', () => {
    const two = parsePath('M0 0 L 10 0 M 20 0 L 30 0')
    expect(trimOutline(two, 0.25, 0.75)).toEqual([[[5, 0], [10, 0]], [[20, 0], [25, 0]]])
  })
})

describe('sanitizeShape', () => {
  it('keeps valid geometry and strokes, drops broken ones', () => {
    const raw = { ...shape({}), shape: 'blob', points: [[0, 0], [1, 'x'], [1, 1]], stroke: { color: '#fff', width: 3, cap: 'weird', dash: [4, -1, 2] }, arc: 'no' } as unknown as CanvasShapeItem
    const out = sanitizeShape(raw)
    expect(out.shape).toBe('rect')
    expect(out.points).toEqual([[0, 0], [1, 1]])
    expect(out.stroke).toEqual({ color: '#fff', width: 3, dash: [4, 2] })
    expect(out.arc).toBeUndefined()
    expect(sanitizeShape({ ...shape({}), stroke: { color: '#fff', width: 0 } }).stroke).toBeUndefined()
  })
})

describe('trim keys', () => {
  it('resolve per frame for a shape’s track', () => {
    const frame: CanvasFrameItem = { id: 'F', kind: 'frame', x: 0, y: 0, w: 100, h: 100 }
    const line = shape({ id: 'L', shape: 'line', frameId: 'F' })
    const clip: MotionClip = {
      kind: 'motion',
      id: 'c',
      duration: 30,
      enabled: true,
      boardId: 'B',
      frameId: 'F',
      tracks: { L: { trim: [{ frame: 0, value: { start: 0.5, end: 0.5 } }, { frame: 10, value: { start: 0, end: 1 } }] } },
    }
    expect(evaluateMotion(clip, frame, [line], 5).items[0]!.trim).toEqual({ start: 0.25, end: 0.75 })
    expect(evaluateMotion({ ...clip, tracks: {} }, frame, [line], 5).items[0]!.trim).toBeUndefined()
  })
})

describe('rotation', () => {
  it('resizes a turned box along its own axes, keeping the opposite side in place', () => {
    const base = { x: 0, y: 0, w: 100, h: 50 }
    // Turned 90°: the box's east side faces down; dragging the pointer down 20 widens it by 20.
    const r = resizeRotated(base, 'e', 0, 20, false, 4, 90)
    expect(r.w).toBeCloseTo(120, 6)
    expect(r.h).toBeCloseTo(50, 6)
    const west = (b: typeof base) => rotateAround({ x: b.x, y: b.y + b.h / 2 }, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, 90)
    expect(west(r).x).toBeCloseTo(west(base).x, 6)
    expect(west(r).y).toBeCloseTo(west(base).y, 6)
    expect(resizeRotated(base, 'e', 10, 0, false, 4, 0)).toEqual(resizeRect(base, 'e', 10, 0, false, 4))
  })

  it('adds the board rotation to the animation’s, and keeps it out of frames on load', () => {
    const frame: CanvasFrameItem = { id: 'F', kind: 'frame', x: 0, y: 0, w: 100, h: 100 }
    const s = shape({ id: 'R', rotation: 30, frameId: 'F' })
    const clip: MotionClip = { kind: 'motion', id: 'c', duration: 10, enabled: true, boardId: 'B', frameId: 'F', tracks: { R: { transform: [{ frame: 0, value: { x: 0, y: 0, scale: 1, rotation: 15 } }] } } }
    expect(evaluateMotion(clip, frame, [s], 0).items[0]!.rotation).toBe(45)
    const doc = sanitizeCanvas({ boards: [{ id: 'B', name: 'B', items: [{ ...frame, rotation: 10 } as CanvasFrameItem, { ...s, rotation: 390 }, { ...s, id: 'Z', rotation: 0 }] }] })!
    const [f, r, z] = doc.boards[0]!.items
    expect(f!.rotation).toBeUndefined()
    expect(r!.rotation).toBe(30)
    expect('rotation' in z!).toBe(false)
  })
})

describe('fills', () => {
  it('keeps colours, gradients with two stops and patterns; falls back otherwise', () => {
    expect(sanitizeFill('#fff', '#000')).toBe('#fff')
    expect(sanitizeFill({ type: 'linear', stops: [{ at: 1, color: '#000' }, { at: 0, color: '#fff' }] }, '#f00')).toEqual({ type: 'linear', stops: [{ at: 0, color: '#fff' }, { at: 1, color: '#000' }], angle: 90 })
    expect(sanitizeFill({ type: 'radial', stops: [{ at: 0, color: '#fff' }] }, '#f00')).toBe('#fff')
    expect(sanitizeFill({ type: 'pattern', pattern: 'dots', color: '#123', size: 1 }, '#f00')).toEqual({ type: 'pattern', pattern: 'dots', color: '#123', size: 2 })
    expect(sanitizeFill({ type: 'pattern', pattern: 'plaid', color: '#123' }, '#f00')).toBe('#f00')
    expect(sanitizeFill(42, '#f00')).toBe('#f00')
    expect(fillColor({ type: 'pattern', pattern: 'grid', color: '#abc', size: 10 })).toBe('#abc')
    expect(fillColor('none', '#fff')).toBe('#fff')
  })
})
