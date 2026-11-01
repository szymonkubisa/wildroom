import fc from 'fast-check'
import { applyPatches } from 'immer'
import { describe, expect, it } from 'vitest'
import { keyframeValue } from './keyframes'
import {
  type MarkerKind,
  type MediaClip,
  type ProjectDoc,
  type SpineItem,
  type Take,
  createEmptyDoc,
  defaultAudioProps,
  defaultVideoProps,
} from '../types/project-doc'
import {
  type ClipPropsPatch,
  type ConnectableClip,
  type OpContext,
  type TimelineRecipe,
  absolutePositions,
  anchorAt,
  anchoredFrame,
  applyOp,
  indexSpine,
  layoutTimeline,
  makeGap,
  makeGenerator,
  makeMotion,
  makeTitle,
  normalizeDoc,
  ops,
  ownerAt,
  rippleDeleteRange,
} from './index'
import { f2f, idGen, invariantViolations, media } from './test-utils'

// ---------------------------------------------------------------------------------------------------------------
// Random documents

const CLIP_KINDS = ['media', 'media', 'media', 'audio', 'pending', 'title', 'gap', 'gap', 'generator', 'motion'] as const

interface ClipSpec {
  kind: (typeof CLIP_KINDS)[number]
  asset: string
  duration: number
  sourceIn: number
  speed: number
  extraTakes: number
  tOut: number | undefined
}

const clipSpecArb: fc.Arbitrary<ClipSpec> = fc.record({
  kind: fc.constantFrom(...CLIP_KINDS),
  asset: fc.constantFrom('v10', 'v4', 'v30', 'img'),
  duration: fc.integer({ min: 1, max: 60 }),
  sourceIn: fc.integer({ min: 0, max: 60 }),
  speed: fc.constantFrom(1, 1, 1, 0.5, 2, 1.5, 0.3),
  extraTakes: fc.integer({ min: 0, max: 2 }),
  tOut: fc.option(fc.integer({ min: 1, max: 30 }), { nil: undefined }),
})

interface DocSpec {
  fps: number
  fpsAuto: boolean
  spine: ClipSpec[]
  tIn: number | undefined
  connected: Array<{ at: number; lane: number; clip: ClipSpec }>
  markers: number[]
}

const docSpecArb: fc.Arbitrary<DocSpec> = fc.record({
  fps: fc.constantFrom(24, 30),
  fpsAuto: fc.boolean(),
  spine: fc.array(clipSpecArb, { maxLength: 7 }),
  tIn: fc.option(fc.integer({ min: 1, max: 20 }), { nil: undefined }),
  connected: fc.array(
    fc.record({ at: fc.nat({ max: 400 }), lane: fc.constantFrom(1, 1, 2, 3, -1, -1, -2), clip: clipSpecArb }),
    { maxLength: 6 },
  ),
  markers: fc.array(fc.nat({ max: 400 }), { maxLength: 4 }),
})

const withoutTransitions = (spec: DocSpec): DocSpec => ({
  ...spec,
  tIn: undefined,
  spine: spec.spine.map((s) => ({ ...s, tOut: undefined })),
})

function clipFromSpec(s: ClipSpec, newId: () => string): SpineItem {
  let clip: SpineItem
  if (s.kind === 'gap') clip = makeGap(s.duration, newId)
  else if (s.kind === 'title') clip = makeTitle({ duration: s.duration, newId })
  else if (s.kind === 'generator') clip = makeGenerator({ duration: s.duration, newId })
  else if (s.kind === 'motion') clip = makeMotion({ duration: s.duration, newId, boardId: 'b', frameId: 'f', tracks: { t: { opacity: [{ frame: 0, value: 0 }, { frame: 12, value: 1 }] } } })
  else {
    const id = newId()
    const takes: Take[] = []
    for (let i = 0; i <= s.extraTakes; i++) {
      const take: Take = { id: newId(), sourceIn: f2f(s.sourceIn + 7 * i) }
      if (s.kind === 'pending') take.generationId = `g${(s.sourceIn + i) % 3}`
      else take.assetId = s.kind === 'audio' ? 'a20' : i % 2 ? 'v4' : s.asset
      takes.push(take)
    }
    const m: MediaClip = { kind: 'media', id, duration: s.duration, enabled: true, takes, active: s.extraTakes, speed: s.speed }
    if (s.kind !== 'audio') m.video = defaultVideoProps()
    if (s.kind !== 'pending') m.audio = defaultAudioProps(s.kind === 'audio' ? 'music' : 'dialogue')
    clip = m
  }
  if (s.tOut !== undefined) clip.transitionOut = { type: 'dissolve', duration: s.tOut }
  return clip
}

function connectable(clip: SpineItem, newId: () => string): ConnectableClip {
  return clip.kind === 'gap' ? makeTitle({ duration: clip.duration, newId }) : clip
}

const MARKER_KINDS: MarkerKind[] = ['standard', 'todo', 'chapter']

function buildDoc(spec: DocSpec): ProjectDoc {
  const newId = idGen('c')
  const doc = createEmptyDoc({ fps: spec.fps, fpsAuto: spec.fpsAuto })
  doc.spine = spec.spine.map((s) => clipFromSpec(s, newId))
  if (spec.tIn !== undefined && doc.spine[0]) doc.spine[0].transitionIn = { type: 'dip-black', duration: spec.tIn }
  const index = indexSpine(doc.spine)
  const anchor = (at: number) =>
    anchorAt(doc.spine, index, at % (index.end + 20), doc.settings.fps) ?? { anchorId: 'missing', anchorSourceTime: 0 }
  doc.connected = spec.connected.map((c) => {
    const clip = connectable(clipFromSpec(c.clip, newId), newId)
    return { kind: 'clip', id: clip.id, clip, ...anchor(c.at), lane: c.lane }
  })
  doc.markers = spec.markers.map((at, i) => ({ id: newId(), kind: MARKER_KINDS[i % 3]!, name: `m${i}`, ...anchor(at) }))
  return normalizeDoc(doc, idGen('z'))
}

// ---------------------------------------------------------------------------------------------------------------
// Random ops

const OP_KINDS = [
  'insert',
  'insertAt',
  'appendToSpine',
  'connect',
  'connectAt',
  'overwriteAt',
  'bladeAll',
  'bladeIds',
  'blade',
  'rippleDelete',
  'replaceWithGap',
  'trimStart',
  'trimEnd',
  'setRange',
  'roll',
  'slip',
  'slide',
  'move',
  'liftFromStoryline',
  'overwriteToPrimary',
  'setSpeed',
  'setProps',
  'detachAudio',
  'setTransition',
  'auditionAdd',
  'auditionSelect',
  'auditionFinalize',
  'auditionRemove',
  'resolveGeneration',
  'addMarker',
  'moveMarker',
  'updateMarker',
  'removeMarker',
  'duplicate',
  'rippleDeleteRange',
] as const

interface OpSpec {
  kind: number
  a: number
  b: number
  c: number
  clip: ClipSpec
}

const opSpecArb: fc.Arbitrary<OpSpec> = fc.record({
  kind: fc.nat({ max: OP_KINDS.length - 1 }),
  a: fc.nat({ max: 10_000 }),
  b: fc.nat({ max: 10_000 }),
  c: fc.integer({ min: -80, max: 80 }),
  clip: clipSpecArb,
})

const PROPS_PATCHES: ClipPropsPatch[] = [
  { name: 'renamed' },
  { enabled: false },
  { video: { opacity: 0.5 } },
  { audio: { gainDb: -3 } },
  { speed: 2 },
  { text: 'changed', style: { color: '#f00' } },
  { name: null, audio: null },
]

function opFor(spec: OpSpec, doc: ProjectDoc, newId: () => string): { name: string; recipe: TimelineRecipe } {
  const layout = layoutTimeline(doc)
  const spineIds = doc.spine.map((s) => s.id)
  const connIds = doc.connected.map((c) => c.id)
  const clipIds = [...spineIds, ...connIds]
  const markerIds = doc.markers.map((m) => m.id)
  const pick = (ids: string[]) => (ids.length ? ids[spec.b % ids.length]! : 'missing')
  const frame = spec.a % (layout.extent + 30)
  const lane = [1, 2, -1, -2, 3, 0][spec.b % 6]!
  const fresh = () => clipFromSpec(spec.clip, newId)
  const kind = OP_KINDS[spec.kind % OP_KINDS.length]!
  const recipe = ((): TimelineRecipe => {
    switch (kind) {
      case 'insert':
        return ops.insert(frame, [fresh()])
      case 'insertAt':
        return ops.insertAt(frame, [fresh(), fresh()])
      case 'appendToSpine':
        return ops.appendToSpine([fresh()])
      case 'connect':
        return ops.connect(connectable(fresh(), newId), frame, lane)
      case 'connectAt':
        return ops.connectAt(frame, [connectable(fresh(), newId), connectable(fresh(), newId)], lane)
      case 'overwriteAt':
        return ops.overwriteAt(frame, [fresh()])
      case 'bladeAll':
        return ops.bladeAt(frame)
      case 'bladeIds':
        return ops.bladeAt(frame, [pick(clipIds)])
      case 'blade':
        return ops.blade(pick(clipIds), frame)
      case 'rippleDelete':
        return ops.rippleDelete([pick([...clipIds, ...markerIds])])
      case 'replaceWithGap':
        return ops.replaceWithGap([pick(clipIds)])
      case 'trimStart':
        return ops.trimEdge(pick(clipIds), 'start', spec.c)
      case 'trimEnd':
        return ops.trimEdge(pick(clipIds), 'end', spec.c)
      case 'setRange':
        return ops.setRange(
          pick(clipIds),
          spec.a % 3 === 0
            ? { sourceIn: f2f(spec.c) }
            : spec.a % 3 === 1
              ? { duration: spec.c }
              : { sourceIn: f2f(spec.a % 100), duration: Math.abs(spec.c) },
        )
      case 'roll':
        return ops.roll(pick(spineIds), spec.c)
      case 'slip':
        return ops.slip(pick(clipIds), f2f(spec.c * 3))
      case 'slide':
        return ops.slide(pick(spineIds), spec.c)
      case 'move':
        return ops.move(pick(clipIds), frame, spec.c % 3 === 0 ? undefined : lane)
      case 'liftFromStoryline':
        return ops.liftFromStoryline(pick(spineIds))
      case 'overwriteToPrimary':
        return ops.overwriteToPrimary(pick(connIds))
      case 'setSpeed':
        return ops.setSpeed(pick(clipIds), [0.5, 2, 1, 0.25, 3, 1.5, 0.3][spec.a % 7]!)
      case 'setProps':
        return ops.setProps(pick(clipIds), PROPS_PATCHES[spec.a % PROPS_PATCHES.length]!)
      case 'detachAudio':
        return ops.detachAudio(pick(clipIds))
      case 'setTransition':
        return ops.setTransition(
          pick(spineIds),
          spec.a % 3 === 0 ? 'in' : 'out',
          spec.a % 5 === 0 ? null : { type: 'dissolve', duration: Math.abs(spec.c) },
        )
      case 'auditionAdd': {
        const take: Take =
          spec.a % 5 === 0
            ? { id: newId(), generationId: `g${spec.a % 3}`, sourceIn: 0 }
            : { id: newId(), assetId: ['v10', 'v4', 'v30', 'a20'][spec.a % 4]!, sourceIn: f2f(spec.a % 50) }
        return ops.audition(pick(clipIds), { type: 'add', take, select: spec.c % 2 === 0 })
      }
      case 'auditionSelect':
        return ops.audition(pick(clipIds), { type: 'select', index: spec.a % 3 })
      case 'auditionFinalize':
        return ops.audition(pick(clipIds), { type: 'finalize' })
      case 'auditionRemove':
        return ops.audition(pick(clipIds), { type: 'remove', index: spec.a % 3 })
      case 'resolveGeneration':
        return ops.resolveGeneration(`g${spec.a % 3}`, ['v10', 'v4', 'v30', 'a20'][spec.b % 4]!)
      case 'addMarker':
        return ops.addMarker(frame, MARKER_KINDS[spec.b % 3], 'added')
      case 'moveMarker':
        return ops.moveMarker(pick(markerIds), frame)
      case 'updateMarker':
        return ops.updateMarker(pick(markerIds), { done: spec.b % 2 === 0, name: 'updated' })
      case 'removeMarker':
        return ops.removeMarker(pick(markerIds))
      case 'duplicate':
        return ops.duplicate([pick(connIds)], frame)
      case 'rippleDeleteRange':
        return rippleDeleteRange(frame, frame + Math.abs(spec.c), [pick(connIds)])
    }
  })()
  return { name: `${kind}(a=${spec.a}, b=${spec.b}, c=${spec.c})`, recipe }
}

// ---------------------------------------------------------------------------------------------------------------
// Checks

function expectValid(doc: ProjectDoc, label: string): void {
  const violations = invariantViolations(doc)
  if (violations.length) throw new Error(`${label}:\n  ${violations.join('\n  ')}`)
}

const ctx = (): OpContext => ({ media, newId: idGen('n') })
const spineEnd = (doc: ProjectDoc) => layoutTimeline(doc).duration
const RUNS = { numRuns: 300 }

/** Where an edit at `frame` lands: on a frame a transition keeps from being cut, the edit point under it. */
function editPointAt(doc: ProjectDoc, frame: number): number {
  const owner = ownerAt(layoutTimeline(doc), frame)
  return owner && frame > owner.start && frame <= owner.start + owner.overlapIn ? owner.start : frame
}

/** [id, anchorId, absolute frame] of every connected item and marker. */
function anchoredItems(doc: ProjectDoc): Array<readonly [string, string, number]> {
  const layout = layoutTimeline(doc)
  return [
    ...layout.connected.map((c) => [c.id, c.anchorId, c.start] as const),
    ...layout.markers.map((m) => [m.id, m.anchorId, m.frame] as const),
  ]
}

describe('timeline properties', () => {
  it('random documents normalize to valid documents', () => {
    fc.assert(
      fc.property(docSpecArb, (spec) => {
        const doc = buildDoc(spec)
        expectValid(doc, 'built doc')
        expect(normalizeDoc(doc)).toBe(doc)
      }),
      RUNS,
    )
  })

  it('random op sequences keep every invariant, undo exactly, and lay out deterministically', () => {
    fc.assert(
      fc.property(docSpecArb, fc.array(opSpecArb, { minLength: 1, maxLength: 12 }), (spec, opSpecs) => {
        let doc = buildDoc(spec)
        const opCtx = ctx()
        const clipIds = idGen('x')
        const trail: string[] = []
        for (const opSpec of opSpecs) {
          const { name, recipe } = opFor(opSpec, doc, clipIds)
          trail.push(name)
          const res = applyOp(doc, recipe, opCtx)
          expectValid(res.doc, trail.join(' → '))
          // undo / redo through patches is exact
          expect(applyPatches(res.doc, res.inversePatches)).toStrictEqual(doc)
          expect(applyPatches(doc, res.patches)).toStrictEqual(res.doc)
          // normalized docs are fixed points, plain JSON, and lay out deterministically
          expect(normalizeDoc(res.doc)).toBe(res.doc)
          expect(JSON.parse(JSON.stringify(res.doc))).toStrictEqual(res.doc)
          expect(layoutTimeline(structuredClone(res.doc))).toStrictEqual(layoutTimeline(res.doc))
          doc = res.doc
        }
      }),
      RUNS,
    )
  })

  it('Blade All moves nothing, transitions or not (it never cuts inside one)', () => {
    fc.assert(
      fc.property(docSpecArb, fc.nat({ max: 1000 }), (spec, a) => {
        const doc = buildDoc(spec)
        const f = a % (layoutTimeline(doc).extent + 10)
        const out = applyOp(doc, ops.bladeAt(f), ctx()).doc
        const after = absolutePositions(out)
        const before = absolutePositions(doc)
        for (const [id, pos] of before) expect([id, after.get(id)]).toEqual([id, pos])
        // New ids are the right-hand pieces of connected clips, starting at the cut.
        for (const [id, pos] of after) if (!before.has(id)) expect(pos).toBe(f)
        expect(spineEnd(out)).toBe(spineEnd(doc))
      }),
      RUNS,
    )
  })

  it('replace with gap moves nothing, even with transitions', () => {
    fc.assert(
      fc.property(docSpecArb, fc.nat({ max: 1000 }), (spec, b) => {
        const doc = buildDoc(spec)
        if (!doc.spine.length) return
        const out = applyOp(doc, ops.replaceWithGap([doc.spine[b % doc.spine.length]!.id]), ctx()).doc
        expect(absolutePositions(out)).toEqual(absolutePositions(doc))
        expect(spineEnd(out)).toBe(spineEnd(doc))
      }),
      RUNS,
    )
  })

  it('insert shifts exactly what lies at or after the insertion frame', () => {
    fc.assert(
      fc.property(docSpecArb.map(withoutTransitions), fc.nat({ max: 1000 }), fc.integer({ min: 1, max: 50 }), (spec, a, dur) => {
        const doc = buildDoc(spec)
        const end = spineEnd(doc)
        if (!end) return
        const f = a % end
        const out = applyOp(doc, ops.insertAt(f, [makeTitle({ duration: dur, newId: () => 'ins' })]), ctx()).doc
        const after = absolutePositions(out)
        for (const [id, pos] of absolutePositions(doc)) expect([id, after.get(id)]).toEqual([id, pos >= f ? pos + dur : pos])
        expect(spineEnd(out)).toBe(end + dur)
      }),
      RUNS,
    )
  })

  // A frame inside a transition, from its first frame to the one after its last, can't be cut (the piece before it
  // couldn't hold the transition, and everything after slid): an insert or overwrite there starts at the edit point
  // under it. The clips are longer than any transition here (≤ 30 frames), so they hold the one they land next to.
  it('with transitions, insert shifts exactly what lies at or after its edit point', () => {
    fc.assert(
      fc.property(docSpecArb, fc.nat({ max: 1000 }), fc.integer({ min: 31, max: 80 }), (spec, a, dur) => {
        const doc = buildDoc(spec)
        const end = spineEnd(doc)
        if (!end) return
        const f = editPointAt(doc, a % end)
        const out = applyOp(doc, ops.insertAt(a % end, [makeTitle({ duration: dur, newId: () => 'ins' })]), ctx()).doc
        const after = absolutePositions(out)
        for (const [id, pos] of absolutePositions(doc)) expect([id, after.get(id)]).toEqual([id, pos >= f ? pos + dur : pos])
        expect(spineEnd(out)).toBe(end + dur)
      }),
      RUNS,
    )
  })

  it('with transitions, overwrite moves nothing either, from its edit point', () => {
    fc.assert(
      fc.property(docSpecArb, fc.nat({ max: 1000 }), fc.integer({ min: 31, max: 80 }), (spec, a, dur) => {
        const doc = buildDoc(spec)
        const end = spineEnd(doc)
        if (!end) return
        const f = editPointAt(doc, a % end)
        const out = applyOp(doc, ops.overwriteAt(a % end, [makeTitle({ duration: dur, newId: () => 'ow' })]), ctx()).doc
        expect(absolutePositions(out)).toEqual(absolutePositions(doc))
        expect(spineEnd(out)).toBe(Math.max(end, f + dur))
      }),
      RUNS,
    )
  })

  it('ripple delete range keeps what lies before it and pulls what follows in together, by at most its length', () => {
    fc.assert(
      fc.property(docSpecArb, fc.nat({ max: 1000 }), fc.nat({ max: 80 }), (spec, a, len) => {
        const doc = buildDoc(spec)
        const end = spineEnd(doc)
        if (!end) return
        const s = a % end
        const out = applyOp(doc, rippleDeleteRange(s, s + len), ctx()).doc
        const removed = end - spineEnd(out)
        expect(removed).toBeGreaterThanOrEqual(0)
        expect(removed).toBeLessThanOrEqual(len)
        const after = absolutePositions(out)
        // From an edit point under a transition, what follows the range takes the transition on and may be too short
        // to hold it beside its own, which then moves what follows it (as a ripple delete of the clip would).
        const layout = layoutTimeline(doc)
        const from = ownerAt(layout, s)
        const start = from && s > from.start && s <= from.start + from.overlapIn ? from.start + from.overlapIn + 1 : s
        const at = ownerAt(layout, start)
        const rigid = !(at && at.start === start && at.overlapIn > 0)
        for (const [id, pos] of absolutePositions(doc)) {
          if (pos < s) expect([id, after.get(id)]).toEqual([id, pos])
          else if (rigid && pos >= s + len && after.has(id)) expect([id, after.get(id)]).toEqual([id, pos - removed])
        }
      }),
      RUNS,
    )
  })

  it('overwrite never deletes or moves connected clips and markers', () => {
    fc.assert(
      fc.property(docSpecArb.map(withoutTransitions), fc.nat({ max: 1000 }), fc.integer({ min: 1, max: 80 }), (spec, a, dur) => {
        const doc = buildDoc(spec)
        const f = a % (layoutTimeline(doc).extent + 20)
        const out = applyOp(doc, ops.overwriteAt(f, [makeTitle({ duration: dur, newId: () => 'ow' })]), ctx()).doc
        const after = absolutePositions(out)
        for (const [id, pos] of absolutePositions(doc)) expect([id, after.get(id)]).toEqual([id, pos])
        expect(spineEnd(out)).toBe(Math.max(spineEnd(doc), f + dur))
      }),
      RUNS,
    )
  })

  it('slip moves nothing', () => {
    fc.assert(
      fc.property(docSpecArb, fc.nat({ max: 1000 }), fc.integer({ min: -80, max: 80 }), (spec, b, c) => {
        const doc = buildDoc(spec)
        const ids = [...doc.spine.map((s) => s.id), ...doc.connected.map((x) => x.id)]
        if (!ids.length) return
        const out = applyOp(doc, ops.slip(ids[b % ids.length]!, f2f(c)), ctx()).doc
        expect(absolutePositions(out)).toEqual(absolutePositions(doc))
        expect(spineEnd(out)).toBe(spineEnd(doc))
      }),
      RUNS,
    )
  })

  it('roll and slide keep the storyline length; ripple trims change it by exactly the trim', () => {
    fc.assert(
      fc.property(docSpecArb.map(withoutTransitions), fc.nat({ max: 1000 }), fc.integer({ min: -80, max: 80 }), (spec, b, c) => {
        const doc = buildDoc(spec)
        if (!doc.spine.length) return
        const i = b % doc.spine.length
        const id = doc.spine[i]!.id
        for (const recipe of [ops.roll(id, c), ops.slide(id, c)]) expect(spineEnd(applyOp(doc, recipe, ctx()).doc)).toBe(spineEnd(doc))
        for (const edge of ['start', 'end'] as const) {
          const out = applyOp(doc, ops.trimEdge(id, edge, c), ctx()).doc
          expect(spineEnd(out) - spineEnd(doc)).toBe(out.spine[i]!.duration - doc.spine[i]!.duration)
          if (c < 0 && edge === 'start') expect(out.spine[i]!.duration).toBeGreaterThanOrEqual(doc.spine[i]!.duration)
        }
      }),
      RUNS,
    )
  })

  // The magnetic contract: an item stays on the picture of its anchor. For edits that keep the anchor on the
  // spine, the item must end up where its original anchor point (anchor id + source time) lands in the new
  // layout. Media clips are source-locked; gaps, titles and generators have no source offset, so their
  // attachments move with their start.
  it('connected clips and markers stay on their anchor’s picture', () => {
    const lawful = ['roll', 'slide', 'trimStart', 'trimEnd', 'setSpeed', 'setTransition', 'setRange', 'speedProp'] as const
    fc.assert(
      fc.property(docSpecArb, fc.constantFrom(...lawful), fc.nat({ max: 1000 }), fc.integer({ min: -80, max: 80 }), (spec, kind, b, c) => {
        const doc = buildDoc(spec)
        if (!doc.spine.length) return
        const id = doc.spine[b % doc.spine.length]!.id
        const recipe = {
          roll: () => ops.roll(id, c),
          slide: () => ops.slide(id, c),
          trimStart: () => ops.trimEdge(id, 'start', c),
          trimEnd: () => ops.trimEdge(id, 'end', c),
          setSpeed: () => ops.setSpeed(id, [0.5, 2, 0.3, 1.5][b % 4]!),
          setTransition: () => ops.setTransition(id, 'out', c > 0 ? { type: 'dissolve', duration: c } : null),
          setRange: () => ops.setRange(id, { duration: Math.abs(c) }),
          speedProp: () => ops.setProps(id, { speed: [0.5, 2][b % 2]! }),
        }[kind]()
        const out = applyOp(doc, recipe, ctx()).doc
        const index = indexSpine(out.spine)
        const after = absolutePositions(out)
        for (const t of [...doc.connected, ...doc.markers]) {
          const expected = anchoredFrame(out.spine, index, t, out.settings.fps)
          if (expected !== undefined) expect([t.id, after.get(t.id)]).toEqual([t.id, Math.max(0, expected)])
        }
      }),
      RUNS,
    )
  })

  it('ripple delete removes what hangs off the item and pulls later items in', () => {
    fc.assert(
      fc.property(docSpecArb.map(withoutTransitions), fc.nat({ max: 1000 }), (spec, b) => {
        const doc = buildDoc(spec)
        const layout = layoutTimeline(doc)
        if (!layout.spine.length) return
        const victim = layout.spine[b % layout.spine.length]!
        const out = applyOp(doc, ops.rippleDelete([victim.id]), ctx()).doc
        const after = absolutePositions(out)
        for (const [id, anchorId, pos] of anchoredItems(doc)) {
          if (anchorId === victim.id) expect(after.has(id)).toBe(false)
          else expect([id, after.get(id)]).toEqual([id, pos >= victim.end ? pos - victim.item.duration : pos])
        }
      }),
      RUNS,
    )
  })
})

describe('keyframeValue on an interior key after a hold', () => {
  it('returns the key’s own value, not the held one', () => {
    expect(keyframeValue([{ frame: 0, value: 0, ease: 'hold' }, { frame: 10, value: 1 }, { frame: 20, value: 2 }] as never, 10, 0)).toBe(1)
  })
})
