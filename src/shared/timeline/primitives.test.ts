import { describe, expect, it } from 'vitest'
import { secondsToFlicks } from '../time/flicks'
import type { MediaClip } from '../types/project-doc'
import { makeMediaClip } from './factories'
import { layoutTimeline } from './layout'
import { audition, blade, connect, insert, move, remove, setProps, setRange, setTransition } from './primitives'
import {
  MEDIA,
  aclip,
  build,
  clipOf,
  connectedOf,
  exec,
  f2f,
  frameOf,
  gap,
  invariantViolations,
  makeCtx,
  makeDoc,
  mclip,
  mediaOf,
  run,
  spineIds,
  spineOf,
  title,
} from './test-utils'

describe('insert', () => {
  it('inserts at an edit point and pushes later items (and their connected clips) right', () => {
    const doc = build([mclip('A', 100), mclip('B', 100)], [[title('X', 10), 150]])
    const out = run(doc, insert(100, [title('T', 20)]))
    expect(spineOf(out)).toEqual([
      ['A', 0, 100],
      ['T', 100, 120],
      ['B', 120, 220],
    ])
    expect(frameOf(out, 'X')).toBe(170)
  })

  it('blades the item under the frame first; clips connected after the cut move with the right piece', () => {
    const doc = build([mclip('A', 100, { sourceIn: 10 })], [[title('X', 10), 30], [title('Y', 10), 70]], [['m', 60]])
    const out = run(doc, insert(50, [title('T', 20)]))
    expect(spineOf(out)).toEqual([
      ['A', 0, 50],
      ['T', 50, 70],
      ['n1', 70, 120],
    ])
    expect(mediaOf(out, 'n1').takes).toEqual([{ id: 'n2', assetId: 'v10', sourceIn: f2f(60) }])
    expect(connectedOf(out, 'X')).toMatchObject({ start: 30, anchorId: 'A' })
    expect(connectedOf(out, 'Y')).toMatchObject({ start: 90, anchorId: 'n1' })
    expect(frameOf(out, 'm')).toBe(80)
    expect(invariantViolations(out)).toEqual([])
  })

  it('appends at or after the spine end, and into an empty spine', () => {
    const doc = makeDoc([mclip('A', 100)])
    expect(spineOf(run(doc, insert(100, [title('T', 5)])))).toEqual([
      ['A', 0, 100],
      ['T', 100, 105],
    ])
    expect(spineOf(run(doc, insert(500, [title('T', 5)])))).toEqual([
      ['A', 0, 100],
      ['T', 100, 105],
    ])
    expect(spineOf(run(makeDoc([]), insert(40, [title('T', 5)])))).toEqual([['T', 0, 5]])
  })

  it('gives colliding ids fresh ones and never freezes the caller’s objects', () => {
    const t = title('A', 5)
    const out = run(makeDoc([mclip('A', 100)]), insert(0, [t]))
    expect(spineIds(out)).toEqual(['n1', 'A'])
    expect(Object.isFrozen(t)).toBe(false)
    expect(t.id).toBe('A')
  })
})

describe('remove', () => {
  const doc = build(
    [mclip('A', 100), mclip('B', 50), mclip('C', 100)],
    [[title('X', 10), 120], [title('Y', 10), 170]],
    [['k', 110], ['m', 160]],
  )

  it('ripple removes spine items with the clips and markers anchored to them; later ones follow', () => {
    const out = run(doc, remove(['B'], 'ripple'))
    expect(spineOf(out)).toEqual([
      ['A', 0, 100],
      ['C', 100, 200],
    ])
    expect(out.connected.map((c) => c.id)).toEqual(['Y'])
    expect(out.markers.map((m) => m.id)).toEqual(['m'])
    expect(frameOf(out, 'Y')).toBe(120)
    expect(frameOf(out, 'm')).toBe(110)
  })

  it("'gap' mode leaves a gap of the same length and keeps connected clips where they were", () => {
    const out = run(doc, remove(['B'], 'gap'))
    expect(spineOf(out)).toEqual([
      ['A', 0, 100],
      ['n1', 100, 150],
      ['C', 150, 250],
    ])
    expect(out.spine[1]!.kind).toBe('gap')
    expect(connectedOf(out, 'X')).toMatchObject({ start: 120, anchorId: 'n1' })
    expect(frameOf(out, 'k')).toBe(110)
    expect(frameOf(out, 'Y')).toBe(170)
  })

  it("'gap' mode keeps transitions so nothing moves", () => {
    const a = mclip('A', 100)
    a.transitionOut = { type: 'dissolve', duration: 10 }
    const b = mclip('B', 50)
    b.transitionOut = { type: 'dissolve', duration: 10 }
    const before = spineOf(makeDoc([a, b, mclip('C', 100)]))
    const out = run(makeDoc([a, b, mclip('C', 100)]), remove(['B'], 'gap'))
    expect(spineOf(out).map(([, s, e]) => [s, e])).toEqual(before.map(([, s, e]) => [s, e]))
  })

  it('deletes connected clips and markers by id', () => {
    const out = run(doc, remove(['X', 'm']))
    expect(out.connected.map((c) => c.id)).toEqual(['Y'])
    expect(out.markers.map((m) => m.id)).toEqual(['k'])
    expect(out.spine).toBe(doc.spine)
  })
})

describe('setRange', () => {
  it('clamps media ranges to the asset length (v4 = 96 frames)', () => {
    const doc = makeDoc([mclip('A', 50, { asset: 'v4' }), mclip('B', 50, { asset: 'v4', sourceIn: 24 })])
    expect(run(doc, setRange('A', { duration: 200 })).spine[0]!.duration).toBe(96)
    expect(run(doc, setRange('B', { duration: 200 })).spine[1]!.duration).toBe(72)
    expect(run(doc, setRange('A', { duration: 0 })).spine[0]!.duration).toBe(1)
  })

  it('slips inside the media and keeps the duration', () => {
    const doc = makeDoc([mclip('A', 100)]) // v10 = 240 frames
    const out = run(doc, setRange('A', { sourceIn: f2f(200) }))
    expect(mediaOf(out, 'A').takes[0]!.sourceIn).toBe(f2f(140))
    expect(out.spine[0]!.duration).toBe(100)
    expect(mediaOf(run(doc, setRange('A', { sourceIn: -5 })), 'A').takes[0]!.sourceIn).toBe(0)
  })

  it('is unlimited for titles, gaps, stills, pending takes and unknown media', () => {
    const doc = makeDoc([
      title('T', 10),
      mclip('I', 10, { asset: 'img' }),
      mclip('P', 10, { takes: [{ generationId: 'g1' }] }),
      mclip('U', 10, { asset: 'unknown' }),
    ])
    const out = run(doc, (d, ctx) => {
      for (const id of ['T', 'I', 'P', 'U']) setRange(id, { duration: 5000 })(d, ctx)
    })
    expect(out.spine.map((s) => s.duration)).toEqual([5000, 5000, 5000, 5000])
    const noMedia = run(makeDoc([mclip('A', 10, { asset: 'v4' })]), setRange('A', { duration: 500 }), { newId: makeCtx().newId })
    expect(noMedia.spine[0]!.duration).toBe(500)
  })

  it('trims connected clips without moving their start', () => {
    const doc = build([mclip('A', 100)], [[aclip('S', 30), 20, -1]])
    const out = run(doc, setRange('S', { duration: 60 }))
    expect(connectedOf(out, 'S')).toMatchObject({ start: 20, end: 80 })
  })
})

describe('blade', () => {
  it('splits a spine clip: connected clips before the cut stay, those after move to the right piece', () => {
    const a = mclip('A', 100, { sourceIn: 12 })
    a.transitionOut = { type: 'dissolve', duration: 10 }
    a.audio!.fadeIn = 6
    a.audio!.fadeOut = 8
    a.video!.opacityKeys = [
      { frame: 10, value: 0 },
      { frame: 60, value: 1 },
    ]
    const doc = build([a, mclip('B', 100)], [[title('X', 10), 20], [title('Y', 10), 60]], [['m', 70]])
    const out = run(doc, blade('A', 50))
    expect(spineOf(out)).toEqual([
      ['A', 0, 50],
      ['n1', 50, 100],
      ['B', 90, 190],
    ])
    const left = mediaOf(out, 'A')
    const right = mediaOf(out, 'n1')
    expect(left.transitionOut).toBeUndefined()
    expect(right.transitionOut).toEqual({ type: 'dissolve', duration: 10 })
    expect(right.takes).toEqual([{ id: 'n2', assetId: 'v10', sourceIn: f2f(62) }])
    expect([left.audio!.fadeIn, left.audio!.fadeOut, right.audio!.fadeIn, right.audio!.fadeOut]).toEqual([6, 0, 0, 8])
    expect(right.video!.opacityKeys).toEqual([
      { frame: -40, value: 0 },
      { frame: 10, value: 1 },
    ])
    expect(connectedOf(out, 'X')).toMatchObject({ start: 20, anchorId: 'A' })
    expect(connectedOf(out, 'Y')).toMatchObject({ start: 60, anchorId: 'n1' })
    expect(out.markers[0]).toMatchObject({ anchorId: 'n1', anchorSourceTime: f2f(12 + 70) })
    expect(invariantViolations(out)).toEqual([])
  })

  it('splits every take of an audition (at the clip speed) and gives them new ids', () => {
    const doc = makeDoc([mclip('A', 100, { speed: 2, takes: [{ asset: 'v10' }, { asset: 'v10', sourceIn: 30 }] })])
    const right = mediaOf(run(doc, blade('A', 20)), 'n1')
    expect(right.takes).toEqual([
      { id: 'n2', assetId: 'v10', sourceIn: f2f(40) },
      { id: 'n3', assetId: 'v10', sourceIn: f2f(70) },
    ])
  })

  it('does nothing unless the frame is strictly inside', () => {
    const doc = makeDoc([mclip('A', 100)])
    expect(run(doc, blade('A', 0))).toBe(doc)
    expect(run(doc, blade('A', 100))).toBe(doc)
    expect(run(doc, blade('nope', 50))).toBe(doc)
  })

  it('never cuts inside a transition: the piece couldn’t hold it, and everything after would slide', () => {
    const a = mclip('A', 100)
    a.transitionOut = { type: 'dissolve', duration: 20 }
    const doc = makeDoc([a, mclip('B', 100), mclip('C', 50)])
    // A's tail under the dissolve (80–99), and B's head under it up to the frame just after (81–100).
    for (const [id, f] of [['A', 80], ['A', 90], ['B', 81], ['B', 90], ['B', 100]] as const) expect(run(doc, blade(id, f))).toBe(doc)
    expect(spineOf(run(doc, blade('A', 79)))).toEqual([
      ['A', 0, 79],
      ['n1', 79, 100],
      ['B', 80, 180],
      ['C', 180, 230],
    ])
    expect(spineOf(run(doc, blade('B', 101)))).toEqual([
      ['A', 0, 100],
      ['B', 80, 101],
      ['n1', 101, 180],
      ['C', 180, 230],
    ])
  })

  it('splits connected clips at an absolute frame', () => {
    const doc = build([mclip('A', 100)], [[aclip('S', 40, { sourceIn: 5 }), 10, -2]])
    const out = run(doc, blade('S', 30))
    expect(connectedOf(out, 'S')).toMatchObject({ start: 10, end: 30, lane: -2 })
    expect(connectedOf(out, 'n1')).toMatchObject({ start: 30, end: 50, lane: -2 })
    expect(mediaOf(out, 'n1').takes[0]!.sourceIn).toBe(f2f(25))
  })
})

describe('connect', () => {
  it('connects at a frame and lane', () => {
    const out = run(makeDoc([mclip('A', 100)]), connect(title('T', 10), 30, 2))
    expect(connectedOf(out, 'T')).toMatchObject({ start: 30, lane: 2, anchorId: 'A' })
  })

  it('appends a gap when connecting past the spine end', () => {
    const out = run(makeDoc([mclip('A', 100)]), connect(title('T', 40), 150, 1))
    expect(spineOf(out)).toEqual([
      ['A', 0, 100],
      ['n1', 100, 190],
    ])
    expect(connectedOf(out, 'T')).toMatchObject({ start: 150, anchorId: 'n1', hanging: false })
    expect(spineOf(run(makeDoc([]), connect(aclip('S', 40), 10)))).toEqual([['n1', 0, 50]])
  })

  it('pads past a fade-out to exactly the clip’s end, however short the pad', () => {
    // The fade-out becomes a dissolve into the gap: a 3-frame pad after a 24-frame fade held only 2 of it, and the
    // spine ended at 49 under a title running to 51.
    const a = mclip('A', 48)
    a.transitionOut = { type: 'dissolve', duration: 24 }
    const out = run(makeDoc([a]), connect(title('T', 3), 48))
    expect(spineOf(out)).toEqual([
      ['A', 0, 48],
      ['n1', 24, 51],
    ])
    expect(connectedOf(out, 'T')).toMatchObject({ start: 48, end: 51, hanging: false })
    expect(invariantViolations(out)).toEqual([])
  })

  it('defaults the lane from the clip and refuses gaps', () => {
    const out = run(makeDoc([mclip('A', 100)]), connect(aclip('S', 10), 0))
    expect(out.connected[0]!.lane).toBe(-1)
    const doc = makeDoc([mclip('A', 100)])
    expect(run(doc, connect(gap('G', 10) as never, 0))).toBe(doc)
  })
})

describe('move', () => {
  it('moves a connected clip to a new frame and lane (re-anchored)', () => {
    const doc = build([mclip('A', 100), mclip('B', 100)], [[title('X', 10), 20]])
    const out = run(doc, move('X', 150, 3))
    expect(connectedOf(out, 'X')).toMatchObject({ start: 150, lane: 3, anchorId: 'B' })
    expect(out.connected[0]!.anchorSourceTime).toBe(f2f(50))
  })

  it('reorders a spine item magnetically; its connected clips travel with it', () => {
    const doc = build([mclip('A', 100), mclip('B', 50), mclip('C', 100)], [[title('X', 10), 110]])
    const toStart = run(doc, move('B', 0))
    expect(spineOf(toStart)).toEqual([
      ['B', 0, 50],
      ['A', 50, 150],
      ['C', 150, 250],
    ])
    expect(connectedOf(toStart, 'X')).toMatchObject({ start: 10, anchorId: 'B' })
    expect(spineIds(run(doc, move('A', 1000)))).toEqual(['B', 'C', 'A'])
    // Frames are measured after lifting the item: 50 falls inside A, which gets bladed.
    expect(spineIds(run(doc, move('C', 50)))).toEqual(['A', 'C', 'n1', 'B'])
  })
})

describe('setProps', () => {
  it('shallow-merges clip props and merges video/audio one level deep', () => {
    const out = run(
      makeDoc([mclip('A', 100)]),
      setProps('A', { name: 'Shot', enabled: false, video: { opacity: 0.5 }, audio: { gainDb: -6 } }),
    )
    const a = mediaOf(out, 'A')
    expect(a).toMatchObject({ name: 'Shot', enabled: false })
    expect(a.video).toMatchObject({ opacity: 0.5, conform: 'fit', transform: { x: 0, y: 0, scale: 1, rotation: 0 } })
    expect(a.audio).toMatchObject({ gainDb: -6, role: 'dialogue', pan: 0 })
  })

  it('merges title style / generator params, removes props set to null and ignores foreign keys', () => {
    const doc = build([mclip('A', 100)], [[title('T', 10), 0]])
    const out = run(doc, (d, ctx) => {
      setProps('T', { text: 'Hi', style: { color: '#f00' }, speed: 3 })(d, ctx)
      setProps('A', { name: null, audio: null, text: 'ignored' })(d, ctx)
    })
    const t = clipOf(out, 'T')
    expect(t).toMatchObject({ text: 'Hi', style: { color: '#f00', fontFamily: 'Helvetica Neue', fontSize: 64 } })
    expect(t).not.toHaveProperty('speed')
    expect(mediaOf(out, 'A').audio).toBeUndefined()
    expect(mediaOf(out, 'A')).not.toHaveProperty('text')
    const g = makeDoc([gap('G', 10), mclip('A', 5)])
    expect(run(g, setProps('G', { text: 'x', speed: 2 }))).toBe(g)
  })
})

describe('setTransition', () => {
  it('adds, clamps and removes transitions; overlaps shift later items', () => {
    const doc = build([mclip('A', 100), mclip('B', 40), mclip('C', 100)], [[title('X', 5), 150]])
    const out = run(doc, setTransition('A', 'out', { type: 'dissolve', duration: 12 }))
    expect(spineOf(out)).toEqual([
      ['A', 0, 100],
      ['B', 88, 128],
      ['C', 128, 228],
    ])
    expect(frameOf(out, 'X')).toBe(138)
    expect(run(doc, setTransition('A', 'out', { type: 'dissolve', duration: 500 })).spine[0]!.transitionOut).toEqual({
      type: 'dissolve',
      duration: 39,
    })
    expect(run(out, setTransition('A', 'out', null)).spine[0]!.transitionOut).toBeUndefined()
    // transitionIn is only honoured on the first item
    expect(run(doc, setTransition('B', 'in', { type: 'dissolve', duration: 5 }))).toEqual(doc)
    expect(run(doc, setTransition('A', 'in', { type: 'dip-black', duration: 5 })).spine[0]!.transitionIn).toEqual({
      type: 'dip-black',
      duration: 5,
    })
  })
})

describe('audition', () => {
  const base = () => build([mclip('A', 100), mclip('B', 100)], [[title('X', 10), 40], [title('Y', 10), 150]], [['m', 60]])

  it('adds takes (optionally selecting them) keeping duration and connected clips', () => {
    const doc = base()
    const added = run(doc, audition('A', { type: 'add', take: { id: 'tk', assetId: 'v4', sourceIn: f2f(100) } }))
    expect(mediaOf(added, 'A').takes.map((t) => t.id)).toEqual(['A.t0', 'tk'])
    expect(mediaOf(added, 'A').active).toBe(0)

    const selected = run(doc, audition('A', { type: 'add', take: { id: 'tk', assetId: 'v4', sourceIn: f2f(100) }, select: true }))
    const a = mediaOf(selected, 'A')
    expect(a.active).toBe(1)
    expect(a.duration).toBe(100)
    expect(connectedOf(selected, 'X')).toMatchObject({ start: 40, anchorId: 'A' })
    expect(selected.connected.find((c) => c.id === 'X')!.anchorSourceTime).toBe(f2f(140))
    expect(frameOf(selected, 'm')).toBe(60)
    expect(frameOf(selected, 'Y')).toBe(150)
  })

  it('selects another take without moving anything', () => {
    const doc = build([mclip('A', 100, { takes: [{ asset: 'v10' }, { asset: 'v10', sourceIn: 80 }] })], [[title('X', 10), 30]])
    const out = run(doc, audition('A', { type: 'select', index: 1 }))
    expect(mediaOf(out, 'A')).toMatchObject({ active: 1, duration: 100 })
    expect(frameOf(out, 'X')).toBe(30)
    expect(run(doc, audition('A', { type: 'select', index: 7 }))).toBe(doc)
  })

  it('finalizes to the active take', () => {
    const doc = makeDoc([mclip('A', 100, { takes: [{ asset: 'v10' }, { asset: 'v4' }, { asset: 'v10' }], active: 1 })])
    const a = mediaOf(run(doc, audition('A', { type: 'finalize' })), 'A')
    expect(a.takes.map((t) => t.id)).toEqual(['A.t1'])
    expect(a.active).toBe(0)
  })

  it('resolves pending takes of a generation wherever they are', () => {
    const doc = build(
      [mclip('A', 100, { takes: [{ generationId: 'g1' }, { generationId: 'g2' }] })],
      [[mclip('C', 20, { takes: [{ generationId: 'g1' }] }), 10]],
    )
    const out = run(doc, audition('ignored', { type: 'resolve', generationId: 'g1', assetId: 'v4' }))
    expect(mediaOf(out, 'A').takes.map((t) => t.assetId)).toEqual(['v4', undefined])
    expect(mediaOf(out, 'C').takes[0]!.assetId).toBe('v4')
  })

  it('removes takes; removing the last one turns the clip into a gap', () => {
    const doc = build([mclip('A', 100, { takes: [{ asset: 'v10' }, { asset: 'v4' }], active: 1 })], [[title('X', 5), 20]])
    const one = run(doc, audition('A', { type: 'remove', index: 1 }))
    expect(mediaOf(one, 'A')).toMatchObject({ active: 0, takes: [expect.objectContaining({ id: 'A.t0' })] })
    const none = run(one, audition('A', { type: 'remove', index: 0 }))
    expect(none.spine).toEqual([{ kind: 'gap', id: 'A', duration: 100, enabled: true }])
    expect(connectedOf(none, 'X')).toMatchObject({ start: 20, anchorId: 'A' })
  })
})

describe('fps auto-lock', () => {
  const clip30 = () => {
    const ids = ['V', 'Vt']
    return makeMediaClip({ assetId: 'v30', media: MEDIA.v30!, fps: 24, newId: () => ids.shift()! }) // 8 s = 192 frames @24
  }

  it('locks to the nearest rate and rescales the doc and the incoming clip before inserting', () => {
    const t = title('T', 48)
    t.transitionIn = { type: 'dip-black', duration: 12 }
    t.video!.opacityKeys = [{ frame: 24, value: 1 }]
    const s = aclip('S', 96)
    s.audio!.fadeIn = 12
    const doc = build([t, mclip('B', 48, { asset: 'img' })], [[s, 24, -1]], [['m', 36]], { fpsAuto: true })
    const out = run(doc, insert(48, [clip30()]))

    expect(out.settings).toMatchObject({ fps: 30, fpsAuto: false })
    const v = mediaOf(out, 'V')
    expect(v.duration).toBe(240) // 8 s @30
    expect(v.takes[0]!.id).toBe('Vt')
    expect(spineOf(out)).toEqual([
      ['T', 0, 60],
      ['V', 60, 300],
      ['B', 300, 360],
    ])
    expect(clipOf(out, 'T').transitionIn).toEqual({ type: 'dip-black', duration: 15 })
    expect(clipOf(out, 'T')).toMatchObject({ video: { opacityKeys: [{ frame: 30, value: 1 }] } })
    expect(mediaOf(out, 'S')).toMatchObject({ duration: 120, audio: { fadeIn: 15 } })
    expect(frameOf(out, 'S')).toBe(30)
    expect(frameOf(out, 'm')).toBe(45)
    expect(invariantViolations(out)).toEqual([])
  })

  it('only unlocks when the asset already matches, and ignores stills, pending clips and locked docs', () => {
    const doc = makeDoc([mclip('A', 10)], { fpsAuto: true })
    const same = run(doc, insert(0, [mclip('B', 10, { asset: 'v10' })]))
    expect(same.settings).toMatchObject({ fps: 24, fpsAuto: false })
    expect(same.spine[0]!.duration).toBe(10)
    for (const c of [mclip('I', 10, { asset: 'img' }), mclip('P', 10, { takes: [{ generationId: 'g' }] })])
      expect(run(doc, insert(0, [c])).settings.fpsAuto).toBe(true)
    expect(run(makeDoc([]), insert(0, [clip30()])).settings).toMatchObject({ fps: 24, fpsAuto: false })
  })

  it('also locks on connect and on resolving a pending generation', () => {
    const c = run(makeDoc([mclip('A', 48, { asset: 'img' })], { fpsAuto: true }), connect(clip30(), 24, 1))
    expect(c.settings.fps).toBe(30)
    expect(connectedOf(c, 'V')).toMatchObject({ start: 30, end: 270 })

    const pending = makeDoc([mclip('P', 120, { takes: [{ generationId: 'g' }] })], { fpsAuto: true })
    const resolved = run(pending, audition('', { type: 'resolve', generationId: 'g', assetId: 'v30' }))
    expect(resolved.settings).toMatchObject({ fps: 30, fpsAuto: false })
    expect(resolved.spine[0]!.duration).toBe(150)
  })

  it('reports patches that undo the whole change', () => {
    const doc = makeDoc([title('T', 48)], { fpsAuto: true })
    const res = exec(doc, insert(48, [clip30()]))
    expect(res.inversePatches.length).toBeGreaterThan(0)
    expect(layoutTimeline(res.doc).duration).toBe(60 + 240)
    const clip = res.doc.spine[1] as MediaClip
    expect(clip.takes[0]!.sourceIn).toBe(0)
    expect(MEDIA.v30!.durationFlicks).toBe(secondsToFlicks(8))
  })
})
