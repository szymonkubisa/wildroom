import { describe, expect, it } from 'vitest'
import { replaceWithGap } from './compound'
import { copyEntries, pasteClips, replaceGap, rippleDeleteRange } from './editing'
import { ease, keyframeObject, keyframeValue, upsertKey } from './keyframes'
import { layoutTimeline } from './layout'
import { aclip, build, gap, invariantViolations, makeDoc, mclip, run, spineOf, title } from './test-utils'

describe('copy / paste', () => {
  it('pastes storyline clips as a block at the playhead and connected clips at their offset', () => {
    const doc = build([mclip('A', 100), mclip('B', 50)], [[title('T', 20), 110]])
    const entries = copyEntries(layoutTimeline(doc), ['B', 'T'])
    expect(entries.map((e) => [e.offset, e.lane])).toEqual([
      [0, 0],
      [10, 1],
    ])
    const out = run(doc, pasteClips(0, entries))
    const lay = layoutTimeline(out)
    expect(lay.spine.map((s) => s.end - s.start)).toEqual([50, 100, 50])
    expect(lay.spine[0]!.id).not.toBe('B')
    const pastedTitle = lay.connected.find((c) => c.item.clip.kind === 'title' && c.id !== 'T')
    expect(pastedTitle?.start).toBe(10)
    expect(invariantViolations(out)).toEqual([])
  })

  it('gives every paste fresh ids (pasting twice never collides)', () => {
    const doc = makeDoc([mclip('A', 100)])
    const entries = copyEntries(layoutTimeline(doc), ['A'])
    const out = run(run(doc, pasteClips(100, entries)), pasteClips(200, entries))
    expect(new Set(out.spine.map((s) => s.id)).size).toBe(3)
    expect(invariantViolations(out)).toEqual([])
  })
})

describe('rippleDeleteRange', () => {
  it('cuts the storyline and closes the hole', () => {
    const out = run(makeDoc([mclip('A', 100), mclip('B', 100)]), rippleDeleteRange(80, 120))
    expect(spineOf(out).map(([, s, e]) => [s, e])).toEqual([
      [0, 80],
      [80, 160],
    ])
    expect(invariantViolations(out)).toEqual([])
  })

  it('removes the in-range part of connected clips starting inside, and cuts listed spanning clips', () => {
    const doc = build([mclip('A', 200)], [
      [aclip('D', 60), 40, -1],
      [aclip('M', 200), 0, -2],
    ])
    const out = run(doc, rippleDeleteRange(50, 70, ['D']))
    const lay = layoutTimeline(out)
    expect(lay.duration).toBe(180)
    const dialogue = lay.connected.filter((c) => c.lane === -1).map((c) => [c.start, c.end])
    expect(dialogue).toEqual([
      [40, 50],
      [50, 80],
    ])
    // Music was not listed: left whole.
    expect(lay.connected.find((c) => c.id === 'M')?.end).toBe(200)
    expect(invariantViolations(out)).toEqual([])
  })

  it('keeps a transition whole: a start inside one moves past it; an end inside one cuts there all the same', () => {
    // A dissolves into B over 80–99; B can't be cut on 81–100 (the piece before couldn't hold the dissolve).
    const a = mclip('A', 100)
    a.transitionOut = { type: 'dissolve', duration: 20 }
    const doc = makeDoc([a, mclip('B', 100), mclip('C', 50)])
    const fromInside = run(doc, rippleDeleteRange(90, 120))
    expect(spineOf(fromInside).map(([, s, e]) => [s, e])).toEqual([
      [0, 100],
      [80, 101],
      [101, 161],
      [161, 211],
    ])
    expect(spineOf(run(doc, rippleDeleteRange(50, 90))).map(([, s, e]) => [s, e])).toEqual([
      [0, 50],
      [50, 140],
      [140, 190],
    ])
    expect(invariantViolations(fromInside)).toEqual([])
  })
})

describe('replaceGap', () => {
  it('swaps a gap for a clip of the gap length', () => {
    const out = run(makeDoc([mclip('A', 50), gap('G', 30), mclip('B', 50)]), replaceGap('G', title('T', 10)))
    expect(spineOf(out).map(([, s, e]) => e - s)).toEqual([50, 30, 50])
    expect(out.spine[1]!.kind).toBe('title')
  })

  it('keeps the gap’s transitions, so nothing after it moves', () => {
    // Replace with gap kept B's dissolve into C; Fill gap dropped it and C slid from 108 to 120.
    const b = mclip('B', 60)
    b.transitionOut = { type: 'dissolve', duration: 12 }
    const gapped = run(makeDoc([mclip('A', 60), b, mclip('C', 60)]), replaceWithGap(['B']))
    const out = run(gapped, replaceGap(gapped.spine[1]!.id, title('T', 5)))
    expect(spineOf(out).map(([, s, e]) => [s, e])).toEqual([
      [0, 60],
      [60, 120],
      [108, 168],
    ])
    expect(out.spine[1]).toMatchObject({ kind: 'title', transitionOut: { type: 'dissolve', duration: 12 } })
  })
})

describe('keyframes', () => {
  it('eases segments by the first key of each segment', () => {
    expect(ease('ease-in', 0.5)).toBeCloseTo(0.125)
    expect(ease('hold', 0.9)).toBe(0)
    const keys = [
      { frame: 0, value: 0, ease: 'hold' as const },
      { frame: 10, value: 10 },
    ]
    expect(keyframeValue(keys, 9, 5)).toBe(0)
    expect(keyframeValue(keys, 10, 5)).toBe(10)
  })

  it('interpolates object keys per field and upserts keeping the easing', () => {
    const keys = upsertKey([{ frame: 0, value: { x: 0, y: 0 }, ease: 'ease-out' as const }], 0, { x: 1, y: 1 })
    expect(keys[0]!.ease).toBe('ease-out')
    const all = upsertKey(keys, 10, { x: 3, y: 1 })
    expect(keyframeObject(all, 10, { x: 9, y: 9 })).toEqual({ x: 3, y: 1 })
  })
})
