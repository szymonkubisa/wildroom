import { describe, expect, it } from 'vitest'
import { clampedOverlaps, clipsAt, layoutTimeline, localFrameAt, ownerAt, sourceTimeAt } from './layout'
import { FPS, aclip, build, f2f, gap, makeDoc, mclip, title } from './test-utils'

describe('spine layout', () => {
  it('lays out items with overlap-mode transitions, fades and ownership', () => {
    const a = mclip('A', 100)
    a.transitionIn = { type: 'dip-black', duration: 12 }
    a.transitionOut = { type: 'dissolve', duration: 10 }
    const d = mclip('D', 30)
    d.transitionOut = { type: 'dip-black', duration: 15 }
    const layout = layoutTimeline(makeDoc([a, mclip('B', 50), mclip('C', 80), gap('G', 20), d]))

    expect(layout.spine.map((s) => [s.id, s.start, s.end, s.ownEnd, s.overlapIn, s.overlapOut])).toEqual([
      ['A', 0, 100, 90, 0, 10],
      ['B', 90, 140, 140, 10, 0],
      ['C', 140, 220, 220, 0, 0],
      ['G', 220, 240, 240, 0, 0],
      ['D', 240, 270, 270, 0, 0], // fade-out on the last item: no overlap
    ])
    expect(layout.duration).toBe(270)
    expect(layout.extent).toBe(270)
    expect(layout.fps).toBe(FPS)
  })

  it('clamps overlaps: ≤ min(left, right) − 1 and incoming + outgoing ≤ duration − 1', () => {
    const a = mclip('A', 10)
    a.transitionOut = { type: 'dissolve', duration: 20 }
    expect(clampedOverlaps([a, mclip('B', 5)])).toEqual([4, 0])

    const x = mclip('X', 20)
    x.transitionOut = { type: 'dissolve', duration: 8 }
    const y = mclip('Y', 10)
    y.transitionOut = { type: 'dissolve', duration: 8 }
    expect(clampedOverlaps([x, y, mclip('Z', 20)])).toEqual([8, 1, 0])

    const p = mclip('P', 5)
    p.transitionOut = { type: 'dissolve', duration: 3 }
    expect(clampedOverlaps([p, mclip('Q', 1)])).toEqual([0, 0])
  })
})

describe('source mapping', () => {
  it('maps local frames to source flicks through sourceIn and speed', () => {
    const c = mclip('C', 100, { sourceIn: 48, speed: 2 })
    expect(sourceTimeAt(c, 10, FPS)).toBe(f2f(48) + f2f(20))
    expect(localFrameAt(c, f2f(48) + f2f(20), FPS)).toBe(10)
    expect(localFrameAt(c, f2f(48) + f2f(21), FPS)).toBe(11) // 10.5 rounds up
    for (let f = 0; f < 200; f += 7) expect(localFrameAt(c, sourceTimeAt(c, f, FPS), FPS)).toBe(f)
  })

  it('treats gaps and titles as media with sourceIn 0 and speed 1', () => {
    expect(sourceTimeAt(gap('G', 10), 5, FPS)).toBe(f2f(5))
    expect(localFrameAt(title('T', 10), f2f(7), FPS)).toBe(7)
  })

  it('round-trips at fractional speeds', () => {
    for (const speed of [0.25, 0.3, 0.7, 1.5, 3, 7.3]) {
      const c = mclip('C', 1000, { sourceIn: 13, speed })
      for (let f = 0; f < 5000; f += 97) expect(localFrameAt(c, sourceTimeAt(c, f, FPS), FPS)).toBe(f)
    }
  })
})

describe('connected layout', () => {
  it('positions connected items through their anchor source time', () => {
    const doc = build([mclip('A', 100, { sourceIn: 24 }), mclip('B', 100, { sourceIn: 10, speed: 2 })])
    doc.connected.push({ kind: 'clip', id: 'X', clip: title('X', 10), anchorId: 'B', anchorSourceTime: f2f(10 + 2 * 15), lane: 1 })
    const x = layoutTimeline(doc).byId.get('X')
    expect(x).toMatchObject({ type: 'connected', start: 115, end: 125, lane: 1, anchorId: 'B', hanging: false })
  })

  it('resolves lane collisions deterministically, by (start, id)', () => {
    const doc = build(
      [mclip('A', 100), mclip('B', 100)],
      [
        [title('X', 40), 20, 1],
        [title('Y', 40), 30, 1],
        [title('U', 5), 35, 2],
        [title('Z', 10), 60, 1],
        [aclip('W', 50), 10, -1],
        [aclip('V', 20), 40, -1],
      ],
    )
    const layout = layoutTimeline(doc)
    expect(layout.connected.map((c) => [c.id, c.start, c.lane])).toEqual([
      ['W', 10, -1],
      ['X', 20, 1],
      ['Y', 30, 2],
      ['U', 35, 3],
      ['V', 40, -2],
      ['Z', 60, 1], // X ends at 60: half-open ranges do not collide
    ])
    expect(layout.lanes).toEqual({ min: -2, max: 3 })
    // Same result regardless of the stored order.
    doc.connected.reverse()
    expect(layoutTimeline(doc).connected.map((c) => [c.id, c.lane])).toEqual(layout.connected.map((c) => [c.id, c.lane]))
  })

  it('treats lane 0 as the default lane for the clip', () => {
    const doc = build([mclip('A', 100)], [[title('T', 10), 0, 0], [aclip('M', 10), 0, 0]])
    const layout = layoutTimeline(doc)
    expect(layout.byId.get('T')).toMatchObject({ lane: 1, preferredLane: 1 })
    expect(layout.byId.get('M')).toMatchObject({ lane: -1, preferredLane: -1 })
  })

  it('flags items anchored past the spine end as hanging', () => {
    const doc = build([mclip('A', 50)])
    doc.connected.push({ kind: 'clip', id: 'X', clip: title('X', 10), anchorId: 'A', anchorSourceTime: f2f(70), lane: 1 })
    doc.markers.push({ id: 'M', kind: 'standard', name: '', anchorId: 'A', anchorSourceTime: f2f(60) })
    const layout = layoutTimeline(doc)
    expect(layout.byId.get('X')).toMatchObject({ start: 70, hanging: true })
    expect(layout.byId.get('M')).toMatchObject({ frame: 60, hanging: true })
    expect(layout.extent).toBe(80)
  })
})

describe('ownerAt / clipsAt', () => {
  const a = mclip('A', 100)
  a.transitionOut = { type: 'dissolve', duration: 10 }
  const doc = build([a, mclip('B', 100)], [[title('T', 20), 92, 1], [aclip('M', 30), 80, -1]], [['mk', 5]])
  const layout = layoutTimeline(doc)

  it('returns the owning spine item (the incoming one inside a transition)', () => {
    expect(ownerAt(layout, 0)?.id).toBe('A')
    expect(ownerAt(layout, 89)?.id).toBe('A')
    expect(ownerAt(layout, 90)?.id).toBe('B')
    expect(ownerAt(layout, 99)?.id).toBe('B')
    expect(ownerAt(layout, 189)?.id).toBe('B')
    expect(ownerAt(layout, 190)).toBeUndefined()
    expect(ownerAt(layout, -1)).toBeUndefined()
  })

  it('returns both sides of a transition in compositing order', () => {
    expect(clipsAt(layout, 95).map((c) => c.id)).toEqual(['M', 'A', 'B', 'T'])
    expect(clipsAt(layout, 50).map((c) => c.id)).toEqual(['A'])
    expect(clipsAt(layout, 150).map((c) => c.id)).toEqual(['B'])
    expect(clipsAt(layout, 500)).toEqual([])
  })

  it('exposes markers and every id in byId', () => {
    expect(layout.markers).toEqual([
      expect.objectContaining({ type: 'marker', id: 'mk', frame: 5, kind: 'standard', done: false, hanging: false }),
    ])
    expect([...layout.byId.keys()].sort()).toEqual(['A', 'B', 'M', 'T', 'mk'])
  })
})
