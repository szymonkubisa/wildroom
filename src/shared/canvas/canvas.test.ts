import { describe, expect, it } from 'vitest'
import { getModel } from '../models/registry'
import { nearestAspect } from '../models/fit'
import { type CanvasAssetItem, type CanvasDoc, type CanvasItem, boardsOf, pictureHasLook, sanitizeCanvas } from '../types/canvas'
import {
  aspectValue,
  fitInside,
  fitRect,
  frameAt,
  grid,
  itemsInRect,
  paintOrder,
  resizeRect,
  rowRightOf,
  snapRect,
  toBoard,
  toScreen,
  unionRect,
  withFrameContents,
  zoomAt,
} from './geometry'
import { applyCanvasResolutions, canvasResolutions } from './resolve'

const frame = (id: string, x: number, y: number, w: number, h: number): CanvasItem => ({ kind: 'frame', id, x, y, w, h })
const image = (id: string, x: number, y: number, w = 100, h = 100, extra: Partial<CanvasItem> = {}): CanvasItem =>
  ({ kind: 'asset', id, x, y, w, h, assetId: `a-${id}`, ...extra }) as CanvasItem

describe('canvas geometry', () => {
  it('unions rectangles and finds items inside a marquee', () => {
    expect(unionRect([])).toBeUndefined()
    expect(unionRect([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: -5, w: 5, h: 5 }])).toEqual({ x: 0, y: -5, w: 25, h: 15 })
    const items = [image('a', 0, 0), image('b', 500, 500), frame('f', 0, 0, 1000, 1000), { ...image('c', 50, 50), locked: true }]
    // Touching selects images; frames only when fully enclosed; locked items never.
    expect(itemsInRect(items, { x: 90, y: 90, w: 20, h: 20 }).map((i) => i.id)).toEqual(['a'])
    expect(itemsInRect(items, { x: -1, y: -1, w: 1002, h: 1002 }).map((i) => i.id)).toEqual(['a', 'b', 'f'])
  })

  it('paints frames first and finds the frame an item lands in', () => {
    const items = [image('a', 0, 0), frame('f1', 0, 0, 500, 500), frame('f2', 400, 0, 500, 500)]
    expect(paintOrder(items).map((i) => i.id)).toEqual(['f1', 'f2', 'a'])
    // Centre decides; the topmost (last) frame wins where frames overlap.
    expect(frameAt(items, { x: 420, y: 10, w: 40, h: 40 })?.id).toBe('f2')
    expect(frameAt(items, { x: 420, y: 10, w: 40, h: 40 }, new Set(['f2']))?.id).toBe('f1')
    expect(frameAt(items, { x: 2000, y: 0, w: 10, h: 10 })).toBeUndefined()
  })

  it('includes frame contents with their frame', () => {
    const items = [frame('f', 0, 0, 500, 500), image('in', 10, 10, 100, 100, { frameId: 'f' }), image('out', 900, 0)]
    expect([...withFrameContents(items, ['f'])].sort()).toEqual(['f', 'in'])
    expect([...withFrameContents(items, ['out'])]).toEqual(['out'])
  })

  it('converts between board and screen and zooms around a point', () => {
    const v = { x: 100, y: 50, zoom: 2 }
    expect(toScreen(v, { x: 10, y: 10, w: 5, h: 5 })).toEqual({ x: 120, y: 70, w: 10, h: 10 })
    expect(toBoard(v, { x: 120, y: 70 })).toEqual({ x: 10, y: 10 })
    const z = zoomAt(v, { x: 120, y: 70 }, 2)
    expect(z.zoom).toBe(4)
    // The board point under the cursor stays under the cursor.
    expect(toBoard(z, { x: 120, y: 70 })).toEqual({ x: 10, y: 10 })
  })

  it('fits a rectangle into the view without zooming past the cap', () => {
    const v = fitRect({ x: 0, y: 0, w: 1000, h: 500 }, 1100, 600, 50)
    expect(v.zoom).toBe(1)
    expect(toScreen(v, { x: 0, y: 0, w: 1000, h: 500 })).toEqual({ x: 50, y: 50, w: 1000, h: 500 })
    expect(fitRect({ x: 0, y: 0, w: 4000, h: 1000 }, 1100, 600, 50).zoom).toBe(0.25)
  })

  it('snaps edges and centres within the threshold', () => {
    const other = { x: 200, y: 0, w: 100, h: 100 }
    const snapped = snapRect({ x: 97, y: 300, w: 100, h: 50 }, [other], 6)
    // Right edge 197 → 200.
    expect(snapped.dx).toBe(3)
    expect(snapped.dy).toBe(0)
    expect(snapped.guides).toEqual([{ axis: 'x', at: 200, from: 0, to: 350 }])
    expect(snapRect({ x: 0, y: 300, w: 100, h: 50 }, [other], 6)).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  it('resizes from any handle, keeping the aspect ratio when asked', () => {
    const r = { x: 0, y: 0, w: 200, h: 100 }
    expect(resizeRect(r, 'se', 20, 10, false)).toEqual({ x: 0, y: 0, w: 220, h: 110 })
    expect(resizeRect(r, 'nw', 20, 10, false)).toEqual({ x: 20, y: 10, w: 180, h: 90 })
    expect(resizeRect(r, 'se', 100, 0, true)).toEqual({ x: 0, y: 0, w: 300, h: 150 })
    // Top-left corner keeps the bottom-right anchored.
    expect(resizeRect(r, 'nw', -100, 0, true)).toEqual({ x: -100, y: -50, w: 300, h: 150 })
    // Side handle grows the other axis around the centre.
    expect(resizeRect(r, 'e', 200, 0, true)).toEqual({ x: 0, y: -50, w: 400, h: 200 })
    expect(resizeRect(r, 'w', 500, 0, false).w).toBe(4)
  })

  it('places rows and grids and fits sizes inside a box', () => {
    expect(rowRightOf({ x: 0, y: 10, w: 100, h: 100 }, [{ w: 50, h: 50 }, { w: 60, h: 30 }], 40)).toEqual([
      { x: 140, y: 10, w: 50, h: 50 },
      { x: 230, y: 10, w: 60, h: 30 },
    ])
    expect(grid(3, 10, 10, 2, { x: 0, y: 0 }, 5)).toEqual([
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 15, y: 0, w: 10, h: 10 },
      { x: 0, y: 15, w: 10, h: 10 },
    ])
    expect(fitInside(4000, 2000, 512)).toEqual({ w: 512, h: 256 })
    expect(fitInside(100, 50, 512)).toEqual({ w: 100, h: 50 })
  })

  it('parses aspect ratios', () => {
    expect(aspectValue('16:9')).toBeCloseTo(16 / 9)
    expect(aspectValue('2.35:1')).toBeCloseTo(2.35)
    expect(aspectValue('auto')).toBeUndefined()
    expect(aspectValue(undefined)).toBeUndefined()
  })
})

describe('nearestAspect', () => {
  it('picks the model option closest to a frame', () => {
    const nano = getModel('fal-nano-banana-pro')!
    expect(nearestAspect(nano, 1200, 630)).toBe('16:9')
    expect(nearestAspect(nano, 1080, 1350)).toBe('4:5')
    expect(nearestAspect(nano, 1080, 1920)).toBe('9:16')
    expect(nearestAspect(nano, 1584, 396)).toBe('21:9')
    const flux = getModel('local-flux-2')!
    expect(nearestAspect(flux, 1080, 1350)).toBe('3:4')
    // A model without an aspect choice.
    expect(nearestAspect(getModel('fal-topaz-upscale-image')!, 100, 100)).toBeUndefined()
  })
})

describe('canvas resolution', () => {
  const doc: CanvasDoc = {
    boards: [
      {
        id: 'b',
        name: 'Board',
        items: [
          { kind: 'asset', id: 'p1', x: 0, y: 0, w: 500, h: 500, generationId: 'g1', fit: true },
          { kind: 'asset', id: 'p2', x: 0, y: 0, w: 500, h: 500, generationId: 'g2', fit: true },
          { kind: 'asset', id: 'p3', x: 0, y: 0, w: 400, h: 400, generationId: 'g3' },
          { kind: 'asset', id: 'img', x: 0, y: 0, w: 512, h: 512, assetId: 'imported', fit: true },
        ],
      },
    ],
  }
  const jobs: Record<string, { status: string; outputAssetIds: string[] }> = {
    g1: { status: 'succeeded', outputAssetIds: ['out1'] },
    g2: { status: 'running', outputAssetIds: [] },
    g3: { status: 'succeeded', outputAssetIds: ['out3'] },
  }
  const sizes: Record<string, { width: number; height: number }> = {
    out1: { width: 1600, height: 900 },
    out3: { width: 100, height: 300 },
    imported: { width: 1000, height: 250 },
  }

  it('fills finished placeholders and follows the real aspect of fit items only', () => {
    const list = canvasResolutions(doc, (id) => jobs[id], (id) => sizes[id])
    expect(list).toEqual([
      { boardId: 'b', itemId: 'p1', assetId: 'out1', h: 281 },
      // Not fit: a frame placeholder keeps the frame's shape.
      { boardId: 'b', itemId: 'p3', assetId: 'out3' },
      { boardId: 'b', itemId: 'img', h: 128 },
    ])
    const copy = structuredClone(doc)
    applyCanvasResolutions(copy, list)
    expect(copy.boards[0]!.items[0]).toEqual({ kind: 'asset', id: 'p1', x: 0, y: 0, w: 500, h: 281, generationId: 'g1', assetId: 'out1' })
    expect(copy.boards[0]!.items[2]).toMatchObject({ assetId: 'out3', h: 400 })
    // Once applied, nothing is left to do.
    expect(canvasResolutions(copy, (id) => jobs[id], (id) => sizes[id])).toEqual([])
  })

  it('waits for the size before settling a fit item', () => {
    expect(canvasResolutions(doc, (id) => jobs[id], () => undefined)).toEqual([
      { boardId: 'b', itemId: 'p1', assetId: 'out1' },
      { boardId: 'b', itemId: 'p3', assetId: 'out3' },
    ])
  })
})

describe('sanitizeCanvas', () => {
  it('drops broken data and repairs what it can', () => {
    const raw = {
      boards: [
        {
          id: 'b1',
          name: 'One',
          items: [
            { kind: 'frame', id: 'f', x: 0, y: 0, w: 100, h: 100 },
            { kind: 'asset', id: 'a', x: 'oops', y: 5, w: -3, h: 10, frameId: 'f' },
            { kind: 'asset', id: 'a', x: 1, y: 1, w: 1, h: 1 },
            { kind: 'video-game', id: 'z', x: 0, y: 0, w: 1, h: 1 },
            { kind: 'note', id: 'n', x: 0, y: 0, w: 10, h: 10, text: 'hi', color: 'yellow', frameId: 'gone' },
            null,
          ],
        },
        { id: 'b1', name: 'Duplicate', items: [] },
        { name: 'No id', items: [] },
      ],
    }
    const out = sanitizeCanvas(raw)!
    expect(out.boards.map((b) => b.id)).toEqual(['b1'])
    expect(out.boards[0]!.items.map((i) => i.id)).toEqual(['f', 'a', 'n'])
    expect(out.boards[0]!.items[1]).toMatchObject({ x: 0, y: 5, w: 1, frameId: 'f' })
    expect(out.boards[0]!.items[2]!.frameId).toBeUndefined()
    expect(sanitizeCanvas({ boards: 'nope' })).toBeUndefined()
    expect(sanitizeCanvas(undefined)).toBeUndefined()
  })

  it('shows one default board for a project without a canvas', () => {
    expect(boardsOf(undefined)).toEqual([{ id: 'board-1', name: 'Board 1', items: [] }])
    expect(boardsOf({ boards: [{ id: 'x', name: 'X', items: [] }] }).map((b) => b.id)).toEqual(['x'])
  })
})

describe('picture looks', () => {
  it('keeps adjustments that change something, a tint with an amount and a full duotone', () => {
    const doc = sanitizeCanvas({
      boards: [
        {
          id: 'B',
          name: 'B',
          items: [
            { id: 'a', kind: 'asset', assetId: 'x', x: 0, y: 0, w: 10, h: 10, adjust: { brightness: 1, contrast: 9, bw: 0.5 }, tint: { color: '#f00', amount: 3 }, duotone: { dark: '#000' } },
            { id: 'b', kind: 'asset', assetId: 'x', x: 0, y: 0, w: 10, h: 10, adjust: { brightness: 1 }, tint: { color: '#f00', amount: 0 } },
          ],
        },
      ],
    } as never)!
    const [a, b] = doc.boards[0]!.items as CanvasAssetItem[]
    expect(a!.adjust).toEqual({ contrast: 4, bw: 0.5 })
    expect(a!.tint).toEqual({ color: '#f00', amount: 1 })
    expect(a!.duotone).toBeUndefined()
    expect(b).not.toHaveProperty('adjust')
    expect(b).not.toHaveProperty('tint')
    expect(pictureHasLook(a!)).toBe(true)
    expect(pictureHasLook(b!)).toBe(false)
  })
})
