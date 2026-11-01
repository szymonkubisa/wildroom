import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import type { ProjectDoc } from '../types/project-doc'
import { applyOp, normalizeDoc } from './apply'
import { normalize } from './normalize'
import {
  aclip,
  build,
  connectedOf,
  f2f,
  frameOf,
  gap,
  invariantViolations,
  makeCtx,
  makeDoc,
  mclip,
  spineOf,
  title,
} from './test-utils'

const norm = (doc: ProjectDoc, prevAbs = new Map<string, number>()) =>
  produce(doc, (d: ProjectDoc) => normalize(d, prevAbs, makeCtx().newId))

describe('normalize', () => {
  it('merges adjacent gaps (keeping the first id) and keeps connected items on their frames', () => {
    const doc = build([mclip('A', 10), gap('G1', 5), gap('G2', 7), gap('G3', 3), mclip('B', 10)], [[title('X', 4), 18]])
    const out = norm(doc)
    expect(spineOf(out)).toEqual([
      ['A', 0, 10],
      ['G1', 10, 25],
      ['B', 25, 35],
    ])
    expect(connectedOf(out, 'X')).toMatchObject({ start: 18, anchorId: 'G1' })
    expect(invariantViolations(out)).toEqual([])
  })

  it('merges gaps joined by a transition without moving anything', () => {
    const g1 = gap('G1', 10)
    g1.transitionOut = { type: 'dissolve', duration: 4 }
    const doc = build([mclip('A', 10), g1, gap('G2', 10), mclip('B', 10)], [[title('X', 2), 30]])
    expect(spineOf(doc).at(-1)).toEqual(['B', 26, 36])
    const out = norm(doc)
    expect(spineOf(out)).toEqual([
      ['A', 0, 10],
      ['G1', 10, 26],
      ['B', 26, 36],
    ])
    expect(out.spine[1]!.transitionOut).toBeUndefined()
    expect(frameOf(out, 'X')).toBe(30)
  })

  it('clamps transitions and removes the ones that end up shorter than a frame', () => {
    const a = mclip('A', 10)
    a.transitionIn = { type: 'dip-black', duration: 30 }
    a.transitionOut = { type: 'dissolve', duration: 20 }
    const b = mclip('B', 5)
    b.transitionIn = { type: 'dissolve', duration: 3 } // not first: dropped
    b.transitionOut = { type: 'dissolve', duration: 3 }
    const c = mclip('C', 1)
    c.transitionOut = { type: 'dip-white', duration: 50 } // last: fade-out clamped to the duration
    const out = norm(makeDoc([a, b, c]))
    expect(out.spine[0]!.transitionIn).toEqual({ type: 'dip-black', duration: 10 })
    expect(out.spine[0]!.transitionOut).toEqual({ type: 'dissolve', duration: 4 })
    expect(out.spine[1]!.transitionIn).toBeUndefined()
    // B: 5 frames, 4 incoming → no room left for an outgoing overlap
    expect(out.spine[1]!.transitionOut).toBeUndefined()
    expect(out.spine[2]!.transitionOut).toEqual({ type: 'dip-white', duration: 1 })
    expect(invariantViolations(out)).toEqual([])
  })

  it('limits incoming + outgoing overlap to duration − 1', () => {
    const x = mclip('X', 20)
    x.transitionOut = { type: 'dissolve', duration: 8 }
    const y = mclip('Y', 10)
    y.transitionOut = { type: 'dissolve', duration: 8 }
    const out = norm(makeDoc([x, y, mclip('Z', 20)]))
    expect(out.spine.map((s) => s.transitionOut?.duration)).toEqual([8, 1, undefined])
  })

  it('removes spine items shorter than a frame', () => {
    expect(norm(makeDoc([mclip('A', 10), mclip('Z', 0), mclip('B', 10)])).spine.map((s) => s.id)).toEqual(['A', 'B'])
  })

  it('turns media without takes into a gap (merged with neighbours) and clamps the active take', () => {
    const empty = mclip('M', 10)
    empty.takes = []
    const multi = mclip('K', 10, { takes: [{ asset: 'v10' }, { asset: 'v4' }], active: 5 })
    const doc = build([gap('G', 5), empty, multi], [[title('X', 3), 8]])
    const out = norm(doc)
    expect(spineOf(out)).toEqual([
      ['G', 0, 15],
      ['K', 15, 25],
    ])
    expect((out.spine[1] as typeof multi).active).toBe(1)
    expect(connectedOf(out, 'X')).toMatchObject({ start: 8, anchorId: 'G' })
  })

  it('re-anchors connected items and markers to the owner of their frame', () => {
    const doc = build([mclip('A', 50), mclip('B', 50)])
    // Anchored to A but positioned inside B.
    doc.connected.push({ kind: 'clip', id: 'X', clip: title('X', 5), anchorId: 'A', anchorSourceTime: f2f(70), lane: 1 })
    doc.markers.push({ id: 'M', kind: 'todo', name: '', anchorId: 'A', anchorSourceTime: f2f(55) })
    const out = norm(doc)
    expect(out.connected[0]).toMatchObject({ anchorId: 'B', anchorSourceTime: f2f(20) })
    expect(out.markers[0]).toMatchObject({ anchorId: 'B', anchorSourceTime: f2f(5) })
    expect(frameOf(out, 'X')).toBe(70)
    expect(frameOf(out, 'M')).toBe(55)
  })

  it('places orphans from prevAbs (or 0) and clamps negative frames', () => {
    const doc = build([mclip('A', 50), mclip('B', 50)])
    doc.connected.push({ kind: 'clip', id: 'X', clip: title('X', 5), anchorId: 'gone', anchorSourceTime: 0, lane: 2 })
    doc.connected.push({ kind: 'clip', id: 'Y', clip: title('Y', 5), anchorId: 'gone', anchorSourceTime: 0, lane: 1 })
    doc.connected.push({ kind: 'clip', id: 'Z', clip: title('Z', 5), anchorId: 'A', anchorSourceTime: -f2f(10), lane: 1 })
    const out = norm(doc, new Map([['X', 64]]))
    expect(connectedOf(out, 'X')).toMatchObject({ start: 64, anchorId: 'B' })
    expect(connectedOf(out, 'Y')).toMatchObject({ start: 0, anchorId: 'A' })
    expect(connectedOf(out, 'Z')).toMatchObject({ start: 0, anchorId: 'A' })
  })

  it('anchors items past the end to the last spine item (hanging)', () => {
    const doc = build([mclip('A', 50), mclip('B', 50)])
    doc.connected.push({ kind: 'clip', id: 'X', clip: title('X', 5), anchorId: 'gone', anchorSourceTime: 0, lane: 1 })
    const out = norm(doc, new Map([['X', 130]]))
    expect(connectedOf(out, 'X')).toMatchObject({ start: 130, anchorId: 'B', hanging: true })
    expect(invariantViolations(out)).toEqual([])
  })

  it('gives an empty spine a gap reaching the furthest connected item / marker', () => {
    const doc = makeDoc([])
    doc.connected.push({ kind: 'clip', id: 'X', clip: title('X', 30), anchorId: 'gone', anchorSourceTime: 0, lane: 1 })
    doc.markers.push({ id: 'M', kind: 'chapter', name: '', anchorId: 'gone', anchorSourceTime: 0 })
    const out = norm(doc, new Map([['X', 20], ['M', 70]]))
    expect(out.spine).toEqual([expect.objectContaining({ kind: 'gap', duration: 71 })])
    expect(frameOf(out, 'X')).toBe(20)
    expect(frameOf(out, 'M')).toBe(70)
    expect(invariantViolations(out)).toEqual([])
  })

  it('fixes connected items: lane 0, gaps and empty clips', () => {
    const doc = build([mclip('A', 50)], [[title('T', 5), 0, 0], [aclip('S', 5), 0, 0]])
    const empty = mclip('E', 5)
    empty.takes = []
    doc.connected.push({ kind: 'clip', id: 'E', clip: empty, anchorId: 'A', anchorSourceTime: 0, lane: 1 })
    const out = norm(doc)
    expect(out.connected.map((c) => [c.id, c.lane])).toEqual([
      ['T', 1],
      ['S', -1],
    ])
  })

  it('is idempotent and leaves valid docs untouched', () => {
    const a = mclip('A', 40)
    a.transitionOut = { type: 'dissolve', duration: 6 }
    const doc = build([a, gap('G', 10), mclip('B', 40)], [[title('X', 10), 45], [aclip('S', 30), 12, -1]], [['m', 33]])
    const once = normalizeDoc(doc)
    expect(normalizeDoc(once)).toBe(once)
    const res = applyOp(once, () => {}, makeCtx())
    expect(res.doc).toBe(once)
    expect(res.patches).toEqual([])
  })
})
