import { describe, expect, it } from 'vitest'
import {
  addMarker,
  appendToSpine,
  bladeAt,
  connectAt,
  detachAudio,
  duplicate,
  insertAt,
  liftFromStoryline,
  moveAcross,
  moveMarker,
  overwriteAt,
  overwriteToPrimary,
  removeMarker,
  replaceWithGap,
  resolveGeneration,
  rippleDelete,
  roll,
  setSpeed,
  slide,
  slip,
  trimEdge,
  updateMarker,
} from './compound'
import {
  aclip,
  build,
  connectedOf,
  f2f,
  frameOf,
  gap,
  invariantViolations,
  makeDoc,
  mclip,
  mediaOf,
  run,
  spineIds,
  spineOf,
  title,
} from './test-utils'

describe('edits: append / insert / connect', () => {
  it('E appends to the storyline', () => {
    const out = run(makeDoc([mclip('A', 100)]), appendToSpine([title('T', 20), gap('G', 10)]))
    expect(spineOf(out)).toEqual([
      ['A', 0, 100],
      ['T', 100, 120],
      ['G', 120, 130],
    ])
  })

  it('W inserts and ripples connected clips', () => {
    const doc = build([mclip('A', 100)], [[title('X', 10), 30]])
    const out = run(doc, insertAt(0, [title('T', 25)]))
    expect(spineIds(out)).toEqual(['T', 'A'])
    expect(frameOf(out, 'X')).toBe(55)
  })

  it('Q connects clips one after another; audio-only clips default below the spine', () => {
    const out = run(makeDoc([mclip('A', 100)]), connectAt(10, [title('T1', 20), title('T2', 30)], 2))
    expect(connectedOf(out, 'T1')).toMatchObject({ start: 10, end: 30, lane: 2 })
    expect(connectedOf(out, 'T2')).toMatchObject({ start: 30, end: 60, lane: 2 })
    const audio = run(makeDoc([mclip('A', 100)]), connectAt(0, [aclip('S', 20), title('T', 5)]))
    expect(connectedOf(audio, 'S').lane).toBe(-1)
    expect(connectedOf(audio, 'T').lane).toBe(1)
  })
})

describe('D overwrite', () => {
  it('replaces the range, blading both edges, and re-anchors (never deletes) connected clips', () => {
    const doc = build(
      [mclip('A', 100), mclip('B', 100), mclip('C', 100)],
      [[title('Y', 5), 20], [title('W', 5), 70], [title('X', 5), 150], [title('Z', 5), 250]],
      [['m', 120]],
    )
    const out = run(doc, overwriteAt(50, [title('T', 100)]))
    expect(spineOf(out)).toEqual([
      ['A', 0, 50],
      ['T', 50, 150],
      ['n3', 150, 200],
      ['C', 200, 300],
    ])
    expect(mediaOf(out, 'n3').takes[0]!.sourceIn).toBe(f2f(50))
    expect(out.connected.map((c) => [c.id, frameOf(out, c.id), c.anchorId])).toEqual([
      ['Y', 20, 'A'],
      ['W', 70, 'T'],
      ['X', 150, 'n3'],
      ['Z', 250, 'C'],
    ])
    expect(out.markers[0]).toMatchObject({ anchorId: 'T' })
    expect(frameOf(out, 'm')).toBe(120)
    expect(invariantViolations(out)).toEqual([])
  })

  it('extends the storyline when overwriting past its end', () => {
    expect(spineOf(run(makeDoc([mclip('A', 100)]), overwriteAt(150, [title('T', 20)])))).toEqual([
      ['A', 0, 100],
      ['n1', 100, 150],
      ['T', 150, 170],
    ])
    expect(spineOf(run(makeDoc([mclip('A', 100)]), overwriteAt(80, [title('T', 50)])))).toEqual([
      ['A', 0, 80],
      ['T', 80, 130],
    ])
    // Past a fade-out too (the pad holds the dissolve the fade becomes, and still ends on the frame).
    const a = mclip('A', 48)
    a.transitionOut = { type: 'dissolve', duration: 24 }
    expect(spineOf(run(makeDoc([a]), overwriteAt(51, [title('T', 3)]))).at(-1)).toEqual(['T', 51, 54])
  })
})

describe('inside a transition', () => {
  // A dissolves into B over frames 80–99. A cut there leaves a piece too short to hold the dissolve: normalize
  // clamped it shorter and everything after slid (Blade All at 90 made the film 11 frames longer).
  const dissolving = () => {
    const a = mclip('A', 100)
    a.transitionOut = { type: 'dissolve', duration: 20 }
    return build([a, mclip('B', 100), mclip('C', 50)], [[title('X', 10), 150]])
  }

  it('Blade All cuts nothing from its first frame to the one after its last', () => {
    const doc = dissolving()
    for (const f of [81, 90, 100]) expect(spineOf(run(doc, bladeAt(f)))).toEqual(spineOf(doc))
    expect(spineOf(run(doc, bladeAt(90, ['A'])))).toEqual(spineOf(doc))
    expect(spineOf(run(doc, bladeAt(101)))).toEqual([
      ['A', 0, 100],
      ['B', 80, 101],
      ['n1', 101, 180],
      ['C', 180, 230],
    ])
  })

  it('W inserts at the edit point under it', () => {
    const out = run(dissolving(), insertAt(90, [title('T', 30)]))
    expect(spineOf(out)).toEqual([
      ['A', 0, 100],
      ['T', 80, 110],
      ['B', 110, 210],
      ['C', 210, 260],
    ])
    expect(frameOf(out, 'X')).toBe(180)
    expect(invariantViolations(out)).toEqual([])
  })

  it('D overwrites from the edit point under it; a range ending inside it is cut there all the same', () => {
    const fromInside = run(dissolving(), overwriteAt(90, [title('T', 40)]))
    expect(spineOf(fromInside)).toEqual([
      ['A', 0, 100],
      ['T', 80, 120],
      ['n1', 120, 180],
      ['C', 180, 230],
    ])
    expect(frameOf(fromInside, 'X')).toBe(150)
    // The piece of B before 90 can't hold the dissolve, but it is overwritten with the rest of the range.
    const intoIt = run(dissolving(), overwriteAt(50, [title('T', 40)]))
    expect(spineOf(intoIt)).toEqual([
      ['A', 0, 50],
      ['T', 50, 90],
      ['n3', 90, 180],
      ['C', 180, 230],
    ])
    expect(frameOf(intoIt, 'X')).toBe(150)
    expect(invariantViolations(intoIt)).toEqual([])
  })
})

describe('blade', () => {
  const doc = build(
    [mclip('A', 100)],
    [[title('X', 60), 20, 1], [aclip('S', 50), 40, -1], [title('Y', 10), 90, 1]],
  )

  it('Blade All cuts the spine owner and every connected clip under the frame', () => {
    const out = run(doc, bladeAt(50))
    expect(spineOf(out)).toEqual([
      ['A', 0, 50],
      ['n1', 50, 100],
    ])
    expect(out.connected.map((c) => [c.id, connectedOf(out, c.id).start, connectedOf(out, c.id).end])).toEqual([
      ['X', 20, 50],
      ['n3', 50, 80],
      ['S', 40, 50],
      ['n4', 50, 90],
      ['Y', 90, 100],
    ])
    expect(invariantViolations(out)).toEqual([])
  })

  it('cuts only the given clips when ids are passed', () => {
    const out = run(doc, bladeAt(50, ['X']))
    expect(spineIds(out)).toEqual(['A'])
    expect(out.connected.map((c) => c.id)).toEqual(['X', 'n1', 'S', 'Y'])
  })
})

describe('delete', () => {
  const doc = build(
    [mclip('A', 100), mclip('B', 50), mclip('C', 100)],
    [[title('X', 10), 110], [title('Y', 10), 160]],
    [['onB', 120], ['onC', 180]],
  )

  it('ripple delete removes the clips anchored to deleted items; markers after it follow', () => {
    const out = run(doc, rippleDelete(['B']))
    expect(spineOf(out)).toEqual([
      ['A', 0, 100],
      ['C', 100, 200],
    ])
    expect(out.connected.map((c) => c.id)).toEqual(['Y'])
    expect(frameOf(out, 'Y')).toBe(110)
    expect(out.markers.map((m) => [m.id, frameOf(out, m.id)])).toEqual([['onC', 130]])
  })

  it('replace with gap keeps them in place', () => {
    const out = run(doc, replaceWithGap(['B']))
    expect(spineOf(out).map(([, s, e]) => [s, e])).toEqual([
      [0, 100],
      [100, 150],
      [150, 250],
    ])
    expect(out.connected.map((c) => [c.id, frameOf(out, c.id)])).toEqual([
      ['X', 110],
      ['Y', 160],
    ])
    expect(frameOf(out, 'onB')).toBe(120)
  })

  it('merges the gaps left next to each other', () => {
    const out = run(makeDoc([mclip('A', 10), gap('G', 5), mclip('B', 10), mclip('C', 10)]), replaceWithGap(['B']))
    expect(spineOf(out)).toEqual([
      ['A', 0, 10],
      ['G', 10, 25],
      ['C', 25, 35],
    ])
  })
})

describe('trimEdge', () => {
  const doc = () =>
    build([mclip('A', 100), mclip('B', 100)], [[title('X', 10), 40], [title('Y', 10), 150]], [['m', 30]])

  it('head trim of an anchor keeps connected clips locked to the picture (they move left with it)', () => {
    const out = run(doc(), trimEdge('A', 'start', 20))
    expect(spineOf(out)).toEqual([
      ['A', 0, 80],
      ['B', 80, 180],
    ])
    expect(mediaOf(out, 'A').takes[0]!.sourceIn).toBe(f2f(20))
    expect(frameOf(out, 'X')).toBe(20)
    expect(frameOf(out, 'm')).toBe(10)
    expect(frameOf(out, 'Y')).toBe(130)
  })

  it('clamps head extension to the available source and end trims to the media / one frame', () => {
    const a = mclip('A', 100, { sourceIn: 10 })
    a.video!.opacityKeys = [{ frame: 30, value: 1 }]
    const out = run(makeDoc([a]), trimEdge('A', 'start', -30))
    expect(mediaOf(out, 'A')).toMatchObject({ duration: 110, video: { opacityKeys: [{ frame: 40, value: 1 }] } })
    expect(mediaOf(out, 'A').takes[0]!.sourceIn).toBe(0)
    expect(run(makeDoc([mclip('A', 80, { asset: 'v4' })]), trimEdge('A', 'end', 50)).spine[0]!.duration).toBe(96)
    expect(run(makeDoc([mclip('A', 80)]), trimEdge('A', 'end', -500)).spine[0]!.duration).toBe(1)
    expect(run(makeDoc([mclip('A', 80)]), trimEdge('A', 'start', 500)).spine[0]!.duration).toBe(1)
  })

  it('ripple trims the end: later items and their clips move', () => {
    const out = run(doc(), trimEdge('A', 'end', -30))
    expect(spineOf(out)[1]).toEqual(['B', 70, 170])
    expect(frameOf(out, 'Y')).toBe(120)
    expect(frameOf(out, 'X')).toBe(40)
  })

  it('trims connected clips in place; a start trim keeps the end fixed', () => {
    const d = build([mclip('A', 100)], [[aclip('S', 50, { sourceIn: 5 }), 20, -1], [title('T', 10), 5]])
    const s = run(d, trimEdge('S', 'start', 10))
    expect(connectedOf(s, 'S')).toMatchObject({ start: 30, end: 70 })
    expect(mediaOf(s, 'S').takes[0]!.sourceIn).toBe(f2f(15))
    expect(connectedOf(run(d, trimEdge('S', 'start', -20)), 'S')).toMatchObject({ start: 15, end: 70 })
    expect(connectedOf(run(d, trimEdge('T', 'start', -20)), 'T')).toMatchObject({ start: 0, end: 15 })
    const e = run(d, trimEdge('S', 'end', 10))
    expect(connectedOf(e, 'S')).toMatchObject({ start: 20, end: 80 })
    expect(spineOf(e)).toEqual([['A', 0, 100]])
  })
})

describe('roll / slip / slide', () => {
  it('roll moves the edit point only', () => {
    const doc = build([mclip('A', 100), mclip('B', 100, { sourceIn: 48 })], [[title('W', 5), 90], [title('X', 5), 150]])
    const r = run(doc, roll('A', 20))
    expect(spineOf(r)).toEqual([
      ['A', 0, 120],
      ['B', 120, 200],
    ])
    expect(mediaOf(r, 'B').takes[0]!.sourceIn).toBe(f2f(68))
    expect([frameOf(r, 'W'), frameOf(r, 'X')]).toEqual([90, 150])

    const back = run(doc, roll('A', -30))
    expect(spineOf(back)).toEqual([
      ['A', 0, 70],
      ['B', 70, 200],
    ])
    expect(connectedOf(back, 'W')).toMatchObject({ start: 90, anchorId: 'B' })
    // B can only reveal 48 frames of head; A can only give up 99.
    expect(spineOf(run(doc, roll('A', -100)))[1]).toEqual(['B', 52, 200])
    expect(spineOf(run(doc, roll('A', 200)))[1]).toEqual(['B', 199, 200])
    expect(run(doc, roll('B', 5))).toBe(doc)
  })

  it('roll keeps the total even when a clip already runs past its media', () => {
    // v4 has 96 frames: at 2x from frame 2 only 47 timeline frames exist, but the clip is 49 long.
    const doc = makeDoc([mclip('A', 49, { asset: 'v4', sourceIn: 2, speed: 2 }), mclip('B', 10, { sourceIn: 5 })])
    const out = run(doc, roll('A', -1))
    expect(spineOf(out)).toEqual([
      ['A', 0, 48],
      ['B', 48, 59],
    ])
    expect(run(doc, roll('A', 1))).toBe(doc) // cannot extend past the media
  })

  it('clips attached to titles and gaps move with their start (no source offset to lock to)', () => {
    const doc = build([mclip('A', 100), title('T', 100)], [[title('X', 5), 110]])
    const out = run(doc, roll('A', 20))
    expect(frameOf(out, 'X')).toBe(130)
  })

  it('slip changes the source window; the clip and its connected clips stay put', () => {
    const doc = build([mclip('A', 100, { sourceIn: 24 })], [[title('X', 5), 40]])
    const out = run(doc, slip('A', f2f(48)))
    expect(mediaOf(out, 'A')).toMatchObject({ duration: 100, takes: [expect.objectContaining({ sourceIn: f2f(72) })] })
    expect(frameOf(out, 'X')).toBe(40)
    expect(mediaOf(run(doc, slip('A', f2f(1000))), 'A').takes[0]!.sourceIn).toBe(f2f(140))
    expect(mediaOf(run(doc, slip('A', -f2f(1000))), 'A').takes[0]!.sourceIn).toBe(0)
    const t = makeDoc([title('T', 10)])
    expect(run(t, slip('T', f2f(5)))).toBe(t)
  })

  it('slide moves an item between its neighbours', () => {
    const doc = build(
      [mclip('A', 100), mclip('B', 50), mclip('C', 100, { sourceIn: 30 })],
      [[title('X', 5), 110], [title('Y', 5), 200]],
    )
    const out = run(doc, slide('B', 20))
    expect(spineOf(out)).toEqual([
      ['A', 0, 120],
      ['B', 120, 170],
      ['C', 170, 250],
    ])
    expect(mediaOf(out, 'C').takes[0]!.sourceIn).toBe(f2f(50))
    expect([frameOf(out, 'X'), frameOf(out, 'Y')]).toEqual([130, 200])
    expect(spineOf(run(doc, slide('B', -50)))).toEqual([
      ['A', 0, 70],
      ['B', 70, 120],
      ['C', 120, 250],
    ])
    expect(run(doc, slide('A', 10))).toBe(doc)
  })
})

describe('storyline ⇄ connected', () => {
  it('lifts a spine item into a connected clip, leaving a gap; its clips stay in place', () => {
    const doc = build([mclip('A', 100), mclip('B', 50), mclip('C', 100)], [[title('X', 5), 110]])
    const out = run(doc, liftFromStoryline('B'))
    expect(spineOf(out)).toEqual([
      ['A', 0, 100],
      ['n1', 100, 150],
      ['C', 150, 250],
    ])
    expect(connectedOf(out, 'B')).toMatchObject({ start: 100, end: 150, lane: 1, anchorId: 'n1' })
    expect(connectedOf(out, 'X')).toMatchObject({ start: 110, anchorId: 'n1' })
    expect(connectedOf(run(makeDoc([aclip('S', 10), mclip('A', 10)]), liftFromStoryline('S')), 'S').lane).toBe(-1)
    const g = makeDoc([gap('G', 10), mclip('A', 10)])
    expect(run(g, liftFromStoryline('G'))).toBe(g)
  })

  it('overwrites a connected clip into the storyline at its position', () => {
    const doc = build([mclip('A', 100), mclip('B', 100)], [[title('T', 30), 50], [title('X', 5), 60]])
    const out = run(doc, overwriteToPrimary('T'))
    expect(spineOf(out)).toEqual([
      ['A', 0, 50],
      ['T', 50, 80],
      ['n3', 80, 100],
      ['B', 100, 200],
    ])
    expect(out.connected.map((c) => c.id)).toEqual(['X'])
    expect(connectedOf(out, 'X')).toMatchObject({ start: 60, anchorId: 'T' })
    expect(invariantViolations(out)).toEqual([])
  })
})

describe('dragging between the storyline and the lanes', () => {
  it('a storyline clip dragged to a lane plays over another; the storyline closes up and its clips go with it', () => {
    const doc = build([mclip('A', 100), mclip('B', 50), mclip('C', 100)], [[title('X', 5), 110]])
    const out = run(doc, moveAcross('B', 20, 1))
    expect(spineOf(out)).toEqual([
      ['A', 0, 100],
      ['C', 100, 200],
    ])
    expect(connectedOf(out, 'B')).toMatchObject({ start: 20, end: 70, lane: 1, anchorId: 'A' })
    // X sat 10 frames into B: it still does.
    expect(connectedOf(out, 'X')).toMatchObject({ start: 30 })
    expect(invariantViolations(out)).toEqual([])
    // Audio goes below; a gap can't be lifted.
    expect(connectedOf(run(makeDoc([mclip('A', 10), aclip('S', 10)]), moveAcross('S', 0, -2)), 'S').lane).toBe(-2)
    const g = makeDoc([gap('G', 10), mclip('A', 10)])
    expect(run(g, moveAcross('G', 0, 1))).toBe(g)
  })

  it('a connected clip dragged onto the storyline is inserted at the boundary', () => {
    const doc = build([mclip('A', 100), mclip('B', 100)], [[title('T', 30), 50], [title('X', 5), 150]])
    const out = run(doc, moveAcross('T', 100, 0))
    expect(spineOf(out)).toEqual([
      ['A', 0, 100],
      ['T', 100, 130],
      ['B', 130, 230],
    ])
    expect(out.connected.map((c) => c.id)).toEqual(['X'])
    // X rides on B, which moved.
    expect(connectedOf(out, 'X')).toMatchObject({ start: 180 })
    expect(invariantViolations(out)).toEqual([])
  })

  it('anything else is a plain move', () => {
    const doc = build([mclip('A', 100), mclip('B', 100)], [[title('T', 30), 50]])
    expect(connectedOf(run(doc, moveAcross('T', 70, 2)), 'T')).toMatchObject({ start: 70, lane: 2 })
    expect(spineOf(run(doc, moveAcross('A', 200, 0)))).toEqual([
      ['B', 0, 100],
      ['A', 100, 200],
    ])
  })
})

describe('retime / audio', () => {
  it('setSpeed rescales the duration; connected clips follow the picture', () => {
    const a = mclip('A', 100)
    a.video!.opacityKeys = [{ frame: 40, value: 1 }]
    const doc = build([a, mclip('B', 100)], [[title('W', 5), 40], [title('X', 5), 150]])
    const fast = run(doc, setSpeed('A', 2))
    expect(mediaOf(fast, 'A')).toMatchObject({ speed: 2, duration: 50, video: { opacityKeys: [{ frame: 20, value: 1 }] } })
    expect([frameOf(fast, 'W'), frameOf(fast, 'X')]).toEqual([20, 100])
    expect(mediaOf(run(doc, setSpeed('A', 0.5)), 'A').duration).toBe(200)
    // Clamped to the media: v4 has 96 frames = 48 frames at 2x.
    expect(mediaOf(run(makeDoc([mclip('A', 200, { asset: 'v4' })]), setSpeed('A', 2)), 'A').duration).toBe(48)
    for (const bad of [0, -1, Number.NaN]) expect(run(doc, setSpeed('A', bad))).toBe(doc)
  })

  it('detachAudio mutes the clip and connects an audio-only copy below it', () => {
    const a = mclip('A', 100, { sourceIn: 12 })
    a.audio!.role = 'music'
    const doc = build([mclip('Z', 40), a], [[mclip('V', 30), 10, 1]])
    const out = run(doc, detachAudio('A'))
    expect(mediaOf(out, 'A').audio!.enabled).toBe(false)
    const copy = mediaOf(out, 'n1')
    expect(copy.video).toBeUndefined()
    expect(copy).toMatchObject({ duration: 100, speed: 1, audio: { enabled: true, role: 'music' } })
    expect(copy.takes).toEqual([{ id: 'n2', assetId: 'v10', sourceIn: f2f(12) }])
    expect(connectedOf(out, 'n1')).toMatchObject({ start: 40, lane: -1, anchorId: 'A' })

    const fromConnected = run(doc, detachAudio('V'))
    expect(connectedOf(fromConnected, 'n1')).toMatchObject({ start: 10, lane: -1 })
    const detached = run(doc, detachAudio('A'))
    expect(run(detached, detachAudio('A'))).toBe(detached)
    const audioOnly = makeDoc([aclip('S', 10)])
    expect(run(audioOnly, detachAudio('S'))).toBe(audioOnly)
  })
})

describe('markers', () => {
  const doc = build([mclip('A', 100), mclip('B', 100)], [], [['m', 150]])

  it('adds, moves, updates and removes markers', () => {
    const added = run(doc, addMarker(30, 'todo', 'Fix colour'))
    expect(added.markers[1]).toMatchObject({ id: 'n1', kind: 'todo', name: 'Fix colour', anchorId: 'A' })
    expect(frameOf(added, 'n1')).toBe(30)
    expect(frameOf(run(doc, moveMarker('m', 20)), 'm')).toBe(20)
    expect(run(doc, updateMarker('m', { done: true, name: 'ok' })).markers[0]).toMatchObject({ done: true, name: 'ok' })
    expect(run(doc, removeMarker('m')).markers).toEqual([])
  })

  it('follows ripple edits', () => {
    expect(frameOf(run(doc, trimEdge('A', 'end', -40)), 'm')).toBe(110)
    expect(frameOf(run(doc, insertAt(0, [title('T', 10)])), 'm')).toBe(160)
    expect(frameOf(run(doc, rippleDelete(['A'])), 'm')).toBe(50)
  })

  it('gives an empty timeline a gap to hang the marker on', () => {
    const out = run(makeDoc([]), addMarker(24))
    expect(out.spine).toEqual([expect.objectContaining({ kind: 'gap', duration: 25 })])
    expect(frameOf(out, 'n1')).toBe(24)
  })
})

describe('duplicate / resolveGeneration', () => {
  it('duplicates connected clips at a frame keeping offsets and lanes', () => {
    const doc = build([mclip('A', 200)], [[title('X', 30), 20, 2], [aclip('S', 50), 40, -1]])
    const out = run(doc, duplicate(['X', 'S'], 100))
    expect(connectedOf(out, 'n1')).toMatchObject({ start: 100, preferredLane: 2 })
    expect(connectedOf(out, 'n2')).toMatchObject({ start: 120, preferredLane: -1 })
    expect(mediaOf(out, 'n2').takes[0]!.id).toBe('n3')
    const past = run(doc, duplicate(['X'], 300))
    expect(connectedOf(past, 'n1')).toMatchObject({ start: 300, hanging: false })
    expect(spineOf(past).at(-1)).toEqual(['n2', 200, 330])
  })

  it('resolves pending takes by generation id', () => {
    const doc = makeDoc([mclip('P', 50, { takes: [{ generationId: 'g' }] })])
    expect(mediaOf(run(doc, resolveGeneration('g', 'v4')), 'P').takes[0]!.assetId).toBe('v4')
  })
})
