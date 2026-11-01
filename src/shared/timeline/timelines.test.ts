import { applyPatches, enablePatches } from 'immer'
import { describe, expect, it } from 'vitest'
import { remapIds } from '../types/remapIds'
import type { ProjectDoc } from '../types/project-doc'
import { aclip, build, exec, invariantViolations, makeDoc, mclip, run, title } from './test-utils'
import {
  DEFAULT_TIMELINE_ID,
  activeTimelineName,
  clipsInAllTimelines,
  createTimeline,
  currentTimelineId,
  deleteTimeline,
  duplicateTimeline,
  nextTimelineName,
  openTimeline,
  renameTimeline,
  timelineExportName,
  timelineSummaries,
  timelinesProblem,
} from './timelines'

enablePatches()

const NOW = '2026-10-09T10:00:00.000Z'
const LATER = '2026-10-09T11:00:00.000Z'

/** A cut with storyline media, a connected title, a marker and a mix — everything a timeline owns. */
function edited(): ProjectDoc {
  const doc = build([mclip('A', 100, { asset: 'v10' }), mclip('B', 50, { asset: 'v4' })], [[title('T', 20), 110]], [['M1', 30]])
  doc.mix = { masterDb: -3, roles: { music: { gainDb: -6, mute: false, solo: false } }, ducking: { enabled: false, amountDb: -12, fadeSeconds: 0.35 }, normalizeDialogue: false }
  return doc
}

const strip = (doc: ProjectDoc) => ({ settings: doc.settings, spine: doc.spine, connected: doc.connected, markers: doc.markers, mix: doc.mix })

describe('old documents (no timelines)', () => {
  it('have one implicit open timeline, "Main", summarised from the top-level fields', () => {
    const doc = edited()
    expect(currentTimelineId(doc)).toBe(DEFAULT_TIMELINE_ID)
    expect(activeTimelineName(doc)).toBe('Main')
    expect(timelineSummaries(doc)).toEqual([
      expect.objectContaining({ id: 'main', name: 'Main', active: true, durationFrames: 150, posterAssetId: 'v10', settings: doc.settings }),
    ])
    expect(timelineExportName('Film', doc)).toBe('Film')
  })

  it('are left untouched by no-op timeline ops', () => {
    const doc = edited()
    for (const recipe of [openTimeline('main'), openTimeline('nope'), deleteTimeline('main'), renameTimeline('nope', 'X'), renameTimeline('main', '  ')]) {
      expect(exec(doc, recipe).patches).toEqual([])
    }
  })

  it('write the implicit "Main" entry on the first timeline op', () => {
    const out = run(edited(), createTimeline({ id: 'tl2', now: NOW }))
    expect(out.activeTimelineId).toBe('main')
    expect(out.timelines!.map((t) => [t.id, t.name])).toEqual([
      ['main', 'Main'],
      ['tl2', 'Timeline 2'],
    ])
    // The open timeline's content stays in the top-level fields only.
    expect(out.timelines![0]).not.toHaveProperty('spine')
    expect(out.spine.map((s) => s.id)).toEqual(['A', 'B'])
  })
})

describe('createTimeline', () => {
  it('adds an empty timeline with the current format by default, without opening it', () => {
    const doc = edited()
    const out = run(doc, createTimeline({ id: 'tl2', name: 'Teaser', now: NOW }))
    const entry = out.timelines!.find((t) => t.id === 'tl2')!
    expect(entry).toMatchObject({ name: 'Teaser', createdAt: NOW, durationFrames: 0, spine: [], connected: [], markers: [], settings: doc.settings })
    expect(currentTimelineId(out)).toBe('main')
    expect(strip(out)).toEqual(strip(doc))
  })

  it('takes its own format (a 9:16 cut beside the 16:9 one) and unique names', () => {
    let doc = run(edited(), createTimeline({ id: 'v', name: 'Vertical', settings: { width: 1080, height: 1920 }, now: NOW }))
    doc = run(doc, createTimeline({ id: 'v2', name: 'vertical', now: NOW }))
    const [, vertical, vertical2] = timelineSummaries(doc)
    expect(vertical!.settings).toMatchObject({ width: 1080, height: 1920, fps: 24 })
    expect(vertical2!.name).toBe('vertical 2')
    expect(nextTimelineName(doc)).toBe('Timeline 4')
  })
})

describe('openTimeline', () => {
  it('stashes the open timeline and loads the target; opening back restores every clip, marker and mix', () => {
    const doc = edited()
    let out = run(doc, createTimeline({ id: 'v', name: 'Vertical', settings: { width: 1080, height: 1920 }, now: NOW }))
    out = run(out, openTimeline('v', LATER))
    expect(currentTimelineId(out)).toBe('v')
    expect(activeTimelineName(out)).toBe('Vertical')
    expect(out.spine).toEqual([])
    expect(out.connected).toEqual([])
    expect(out.markers).toEqual([])
    expect(out.mix).toBeUndefined()
    expect(out.settings).toMatchObject({ width: 1080, height: 1920 })
    const main = out.timelines!.find((t) => t.id === 'main')!
    expect(main).toMatchObject({ durationFrames: 150, posterAssetId: 'v10', updatedAt: LATER })
    expect(main.spine!.map((s) => s.id)).toEqual(['A', 'B'])
    expect(out.timelines!.find((t) => t.id === 'v')).not.toHaveProperty('spine')
    expect(timelineSummaries(out).map((t) => [t.id, t.active, t.durationFrames])).toEqual([
      ['main', false, 150],
      ['v', true, 0],
    ])
    expect(timelineExportName('Film', out)).toBe('Film — Vertical')

    const back = run(out, openTimeline('main', LATER))
    expect(strip(back)).toEqual(strip(doc))
    expect(invariantViolations(back)).toEqual([])
  })

  it('keeps edits made in each timeline apart', () => {
    let doc = run(edited(), createTimeline({ id: 'b', now: NOW }))
    doc = run(doc, openTimeline('b'))
    doc = run(doc, (d) => {
      d.spine.push(aclip('X', 40))
    })
    doc = run(doc, openTimeline('main'))
    expect(doc.spine.map((s) => s.id)).toEqual(['A', 'B'])
    expect(doc.timelines!.find((t) => t.id === 'b')!.spine!.map((s) => s.id)).toEqual(['X'])
    doc = run(doc, openTimeline('b'))
    expect(doc.spine.map((s) => s.id)).toEqual(['X'])
    expect(timelineSummaries(doc).find((t) => t.id === 'main')!.durationFrames).toBe(150)
  })

  it('is one undoable step: the inverse patches return to the previous timeline', () => {
    const doc = run(edited(), createTimeline({ id: 'b', now: NOW }))
    const { doc: opened, inversePatches, patches } = exec(doc, openTimeline('b', LATER))
    expect(applyPatches(opened, inversePatches)).toEqual(doc)
    expect(applyPatches(doc, patches)).toEqual(opened)
  })
})

describe('renameTimeline', () => {
  it('renames, trims and ignores empty names', () => {
    let doc = run(edited(), renameTimeline('main', '  Director’s cut ', NOW))
    expect(activeTimelineName(doc)).toBe('Director’s cut')
    expect(exec(doc, renameTimeline('main', '')).patches).toEqual([])
    doc = run(doc, createTimeline({ id: 'b', now: NOW }))
    doc = run(doc, renameTimeline('b', 'Social'))
    expect(timelineSummaries(doc).map((t) => t.name)).toEqual(['Director’s cut', 'Social'])
  })
})

describe('duplicateTimeline', () => {
  it('copies the open timeline with fresh ids, right after it, without opening it', () => {
    const doc = edited()
    const out = run(doc, duplicateTimeline('main', { id: 'copy', now: NOW }))
    expect(out.timelines!.map((t) => [t.id, t.name])).toEqual([
      ['main', 'Main'],
      ['copy', 'Main copy'],
    ])
    expect(currentTimelineId(out)).toBe('main')
    expect(strip(out)).toEqual(strip(doc))
    const copy = out.timelines![1]!
    expect(copy.spine!.map((s) => s.duration)).toEqual([100, 50])
    const oldIds = new Set([...doc.spine.map((s) => s.id), ...doc.connected.map((c) => c.id), ...doc.markers.map((m) => m.id)])
    const newIds = [...copy.spine!.map((s) => s.id), ...copy.connected!.map((c) => c.id), ...copy.markers!.map((m) => m.id)]
    expect(newIds.some((id) => oldIds.has(id))).toBe(false)
    // Anchors follow the copied storyline; the mix is copied too.
    expect(copy.connected![0]!.anchorId).toBe(copy.spine![1]!.id)
    expect(copy.connected![0]!.clip.id).toBe(copy.connected![0]!.id)
    expect(copy.markers![0]!.anchorId).toBe(copy.spine![0]!.id)
    expect(copy.mix).toEqual(doc.mix)
    expect(copy).toMatchObject({ durationFrames: 150, posterAssetId: 'v10' })
  })

  it('makes an independent copy (editing one leaves the other alone)', () => {
    let doc = run(edited(), duplicateTimeline('main', { id: 'copy', now: NOW }))
    doc = run(doc, openTimeline('copy'))
    expect(invariantViolations(doc)).toEqual([])
    doc = run(doc, (d) => {
      d.spine[0]!.duration = 10
    })
    doc = run(doc, openTimeline('main'))
    expect(doc.spine[0]!.duration).toBe(100)
    expect(doc.timelines!.find((t) => t.id === 'copy')!.spine![0]!.duration).toBe(10)
  })

  it('copies a stashed timeline', () => {
    let doc = run(edited(), createTimeline({ id: 'b', now: NOW }))
    doc = run(doc, openTimeline('b'))
    doc = run(doc, duplicateTimeline('main', { id: 'c', name: 'Alt', now: NOW }))
    expect(doc.timelines!.map((t) => t.id)).toEqual(['main', 'c', 'b'])
    expect(doc.timelines![1]!.spine!.length).toBe(2)
    expect(doc.timelines![1]!.name).toBe('Alt')
  })
})

describe('deleteTimeline', () => {
  it('never deletes the last timeline', () => {
    const doc = run(edited(), renameTimeline('main', 'Only', NOW))
    expect(exec(doc, deleteTimeline('main')).patches).toEqual([])
  })

  it('deletes a stashed timeline', () => {
    let doc = run(edited(), createTimeline({ id: 'b', now: NOW }))
    doc = run(doc, deleteTimeline('b'))
    expect(doc.timelines!.map((t) => t.id)).toEqual(['main'])
    expect(doc.spine.map((s) => s.id)).toEqual(['A', 'B'])
  })

  it('opens a neighbour first when deleting the open timeline', () => {
    let doc = run(edited(), createTimeline({ id: 'b', now: NOW }))
    doc = run(doc, openTimeline('b'))
    doc = run(doc, deleteTimeline('b'))
    expect(currentTimelineId(doc)).toBe('main')
    expect(doc.timelines!.map((t) => t.id)).toEqual(['main'])
    expect(strip(doc)).toEqual(strip(edited()))
  })
})

describe('helpers', () => {
  it('lists clips of every timeline (for "is this asset still used")', () => {
    let doc = run(edited(), createTimeline({ id: 'b', now: NOW }))
    doc = run(doc, openTimeline('b'))
    doc = run(doc, (d) => {
      d.spine.push(aclip('X', 40))
    })
    expect(clipsInAllTimelines(doc).map((c) => c.id).sort()).toEqual(['A', 'B', 'T', 'X'])
  })

  it('project copies remap asset ids inside stashed timelines too', () => {
    let doc = run(edited(), createTimeline({ id: 'b', now: NOW }))
    doc = run(doc, openTimeline('b'))
    const copied = remapIds(doc, { v10: 'NEW' })
    const main = copied.timelines!.find((t) => t.id === 'main')!
    expect(main.spine![0]!.kind === 'media' && main.spine![0]!.takes[0]!.assetId).toBe('NEW')
    expect(main.posterAssetId).toBe('NEW')
  })

  it('validates saved timeline lists', () => {
    const doc = run(makeDoc([mclip('A', 10)]), createTimeline({ id: 'b', now: NOW }))
    expect(timelinesProblem(doc)).toBeUndefined()
    expect(timelinesProblem(edited())).toBeUndefined()
    expect(timelinesProblem({ ...doc, timelines: {} as never })).toBe('Invalid timelines')
    expect(timelinesProblem({ ...doc, timelines: [doc.timelines![0]!, doc.timelines![0]!] })).toBe('Duplicate timeline id')
    expect(timelinesProblem({ ...doc, timelines: [{ ...doc.timelines![1]!, settings: { ...doc.settings, fps: 23 } }] })).toBe('Unsupported timeline frame rate')
    expect(timelinesProblem({ ...doc, timelines: [{ ...doc.timelines![1]!, spine: 'x' as never }] })).toBe('Invalid timeline')
    expect(timelinesProblem({ ...doc, activeTimelineId: 5 as never })).toBe('Invalid active timeline')
  })
})
