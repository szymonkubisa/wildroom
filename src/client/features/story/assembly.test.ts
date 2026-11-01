import { applyOp, layoutTimeline, type MediaInfo, appendToSpine, makeTitle } from '@shared/timeline'
import { applyPatches } from 'immer'
import { currentTimelineId, openTimeline, timelineSummaries } from '@shared/timeline/timelines'
import { secondsToFlicks } from '@shared/time/flicks'
import { type Clip, type MediaClip, activeTake, createEmptyDoc } from '@shared/types/project-doc'
import type { StoryDoc, StoryShot } from '@shared/types/story'
import { describe, expect, it } from 'vitest'
import { type AssemblySources, STORY_CUT_NAME, applyAssembly, cutContent, cutEdited, cutSignature, layOutStoryCut, planAssembly, takePieces } from './assembly'

const shot = (id: string, sceneId: string, over: Partial<StoryShot> = {}): StoryShot => ({
  id,
  sceneId,
  description: `${id} described`,
  prompt: '',
  duration: 4,
  characterIds: [],
  dialogue: [],
  videoGenerationIds: [],
  ...over,
})

/**
 * Scene 1: a shot with its own 4 s take, then two shots made as one 8 s multi-shot take that cuts at 3.5 s. Scene 2:
 * a shot with nothing made yet, one with only its keyframe, one whose take the timeline doesn't know.
 */
function story(): StoryDoc {
  return {
    script: '',
    style: '',
    characters: [],
    scenes: [
      { id: 'a', title: 'Platform' },
      { id: 'b', title: 'Train' },
    ],
    shots: [shot('s1', 'a'), shot('s2', 'a'), shot('s3', 'a'), shot('s4', 'b'), shot('s5', 'b', { duration: 2 }), shot('s6', 'b')],
    multishots: [{ id: 'g', shotIds: ['s2', 's3'], videoGenerationIds: ['gen-g'], takes: { 'gen-g': { planned: [4], total: 8, detected: [3.5] } } }],
  }
}

const video = (seconds: number): MediaInfo => ({ kind: 'video', durationFlicks: secondsToFlicks(seconds), hasVideo: true, hasAudio: true, fps: 24 })
const MEDIA: Record<string, MediaInfo> = {
  'take-1': video(4),
  'take-g': video(8),
  'kf-5': { kind: 'image', hasVideo: false, hasAudio: false },
  'line-1': { kind: 'audio', durationFlicks: secondsToFlicks(1.5), hasVideo: false, hasAudio: true },
  'line-2': { kind: 'audio', durationFlicks: secondsToFlicks(1), hasVideo: false, hasAudio: true },
}
const SHOT_MEDIA: Record<string, string> = { s1: 'take-1', s5: 'kf-5', s6: 'not-imported' }

function sources(): AssemblySources {
  let n = 0
  return {
    fps: 24,
    media: (id) => MEDIA[id],
    newId: () => `id-${++n}`,
    groupTake: (g) => (g.id === 'g' ? { asset: { id: 'take-g', durationFlicks: secondsToFlicks(8) }, generationId: 'gen-g' } : undefined),
    shotMedia: (x) => (SHOT_MEDIA[x.id] ? { id: SHOT_MEDIA[x.id]! } : undefined),
  }
}

const LINES = { lines: (x: StoryShot) => (x.id === 's1' ? [{ id: 'line-1', name: 'Maja: Hi' }, { id: 'line-2', name: 'Tymon: Hey' }, { id: 'gone', name: 'Deleted' }] : []) }
const media = (clip: Clip | undefined) => (clip?.kind === 'media' ? { assetId: activeTake(clip)?.assetId, sourceIn: activeTake(clip)?.sourceIn, duration: clip.duration } : undefined)

describe('planAssembly', () => {
  it('puts each shot in as its chosen take, else its keyframe still, at its own length', () => {
    const { spineClips } = planAssembly(story(), sources(), LINES)
    expect(spineClips).toHaveLength(6)
    expect(spineClips[0]).toMatchObject({ kind: 'media', name: 'Shot 1.1', duration: 96 })
    expect(media(spineClips[0])).toEqual({ assetId: 'take-1', sourceIn: 0, duration: 96 })
    expect(spineClips[4]).toMatchObject({ kind: 'media', name: 'Shot 2.2', duration: 48 })
    expect(media(spineClips[4])?.assetId).toBe('kf-5')
    // A take's sound plays under the cut as an effect; the lines go under it on their own.
    expect((spineClips[0] as MediaClip).audio?.role).toBe('effects')
  })

  it('cuts a group’s take back into its shots where the picture cuts', () => {
    const { spineClips } = planAssembly(story(), sources(), LINES)
    expect(media(spineClips[1])).toEqual({ assetId: 'take-g', sourceIn: 0, duration: 84 })
    expect(media(spineClips[2])).toEqual({ assetId: 'take-g', sourceIn: secondsToFlicks(3.5), duration: 108 })
    expect(spineClips.slice(1, 3).map((c) => c.name)).toEqual(['Shot 1.2', 'Shot 1.3'])
  })

  it('a group rendered shot by shot now: a shot animated on its own since is assembled from its own take', () => {
    // An LTX project from before its shots rendered separately: the old group take still covers shot 1.2.
    const own: Record<string, string> = { s3: 'take-3' }
    const src: AssemblySources = {
      ...sources(),
      media: (id) => (id === 'take-3' ? video(4) : MEDIA[id]),
      shotMedia: (x) => (own[x.id] ? { id: own[x.id]! } : SHOT_MEDIA[x.id] ? { id: SHOT_MEDIA[x.id]! } : undefined),
      separate: (g) => g.id === 'g',
      shotTake: (x) => (own[x.id] ? { id: own[x.id]! } : undefined),
    }
    const { spineClips } = planAssembly(story(), src, LINES)
    expect(media(spineClips[1])).toEqual({ assetId: 'take-g', sourceIn: 0, duration: 84 })
    expect(media(spineClips[2])).toEqual({ assetId: 'take-3', sourceIn: 0, duration: 96 })
    // One clip: the group's take wins, as before.
    expect(media(planAssembly(story(), { ...src, separate: () => false }, LINES).spineClips[2])?.assetId).toBe('take-g')
  })

  it('a shot with nothing made yet, or media the timeline doesn’t know, goes in as a title card', () => {
    const plan = planAssembly(story(), sources(), LINES)
    expect(plan.missing).toBe(2)
    expect(plan.spineClips[3]).toMatchObject({ kind: 'title', template: 'centered', text: 'Shot 2.1', subtitle: 's4 described', name: 'Shot 2.1 (placeholder)', duration: 96 })
    expect(plan.spineClips[5]).toMatchObject({ kind: 'title', text: 'Shot 2.3' })
    // A group without a take: its shots stand alone (here as title cards).
    const bare = planAssembly(story(), { ...sources(), groupTake: () => undefined }, LINES)
    expect(bare.spineClips.slice(1, 3).map((c) => c.kind)).toEqual(['title', 'title'])
    expect(bare.missing).toBe(4)
  })

  it('with fixed lengths, footage that runs out early is followed by a gap, and a piece never runs into the next shot', () => {
    const { spineClips } = planAssembly(story(), sources(), { ...LINES, seconds: () => 6 })
    expect(spineClips.map((c) => `${c.kind}:${c.duration}`)).toEqual([
      'media:96',
      'gap:48',
      'media:84',
      'gap:60',
      'media:108',
      'gap:36',
      'title:144',
      'media:144',
      'title:144',
    ])
  })

  it('places the lines under their shot, a lead-in before the first and a gap between them', () => {
    const plan = planAssembly(story(), sources(), LINES)
    expect(plan.lines[0]).toEqual({
      clipId: plan.spineClips[0]!.id,
      lines: [
        { assetId: 'line-1', name: 'Maja: Hi', media: MEDIA['line-1'] },
        { assetId: 'line-2', name: 'Tymon: Hey', media: MEDIA['line-2'] },
      ],
    })
    let n = 0
    const doc = applyOp(createEmptyDoc(), applyAssembly(plan), { newId: () => `op-${++n}`, media: (id) => MEDIA[id] }).doc
    expect(doc.spine.map((c) => c.id)).toEqual(plan.spineClips.map((c) => c.id))
    const lines = layoutTimeline(doc).connected.map((c) => ({ name: c.item.clip.name, start: c.start, lane: c.lane, duration: c.end - c.start }))
    // 0.3 s in (7 frames), then 1.5 s of line and 0.25 s (6 frames) before the next.
    expect(lines).toEqual([
      { name: 'Maja: Hi', start: 7, lane: -1, duration: 36 },
      { name: 'Tymon: Hey', start: 49, lane: -1, duration: 24 },
    ])
  })

  it('marks where each scene starts', () => {
    const plan = planAssembly(story(), sources(), LINES)
    expect(plan.marks).toEqual([
      { clipId: plan.spineClips[0]!.id, kind: 'standard', name: '1 · Platform' },
      { clipId: plan.spineClips[3]!.id, kind: 'standard', name: '2 · Train' },
    ])
    let n = 0
    const doc = applyOp(createEmptyDoc(), applyAssembly(plan), { newId: () => `op-${++n}`, media: (id) => MEDIA[id] }).doc
    expect(layoutTimeline(doc).markers.map((m) => ({ frame: m.frame, name: m.name }))).toEqual([
      { frame: 0, name: '1 · Platform' },
      { frame: 288, name: '2 · Train' },
    ])
  })
})

describe('takePieces', () => {
  const shots = [shot('x', 'a'), shot('y', 'a'), shot('z', 'a')]

  it('cuts at the detected cuts matched to the plan, else at the plan scaled to the take', () => {
    expect(takePieces(shots, 12, { planned: [4, 8], total: 12, detected: [3.6, 6, 8.2] })).toEqual([
      { shotId: 'x', start: 0, end: 3.6 },
      { shotId: 'y', start: 3.6, end: 8.2 },
      { shotId: 'z', start: 8.2, end: 12 },
    ])
    expect(takePieces(shots, 6, { planned: [4, 8], total: 12 }).map((p) => p.end)).toEqual([2, 4, 6])
  })

  it('leaves out a stray opening shot: the first shot starts after it', () => {
    const [first] = takePieces(shots.slice(0, 2), 8, { planned: [4], total: 8, detected: [0.8, 4.2] })
    expect(first).toEqual({ shotId: 'x', start: 0.8, end: 4.2 })
  })
})

describe('the Story cut', () => {
  let n = 0
  const ctx = { newId: () => `c-${++n}`, media: (id: string) => MEDIA[id] }
  /** A project whose open timeline ("Main") already has an edit of its own. */
  function project() {
    const base = { ...createEmptyDoc(), story: story() }
    return applyOp(base, appendToSpine([makeTitle({ template: 'centered', text: 'Mine', duration: 48, newId: () => 'mine' })]), ctx).doc
  }
  const layOut = (doc: ReturnType<typeof project>) => applyOp(doc, layOutStoryCut(planAssembly(doc.story!, sources(), LINES), doc.story!.cutTimelineId ?? 'cut'), ctx)

  it('is made the first time, opened and filled in one step; Main is left as it was', () => {
    const before = project()
    const { doc, inversePatches } = layOut(before)
    expect(timelineSummaries(doc).map((t) => t.name)).toEqual(['Main', STORY_CUT_NAME])
    expect(currentTimelineId(doc)).toBe('cut')
    expect(doc.story!.cutTimelineId).toBe('cut')
    expect(doc.spine.map((c) => c.name)).toEqual(['Shot 1.1', 'Shot 1.2', 'Shot 1.3', 'Shot 2.1 (placeholder)', 'Shot 2.2', 'Shot 2.3 (placeholder)'])
    expect(doc.timelines!.find((t) => t.id === 'main')!.spine!.map((c) => c.id)).toEqual(['mine'])
    // The fingerprint is of the cut as saved (after the op's own clean-up), so it isn't "edited" right after.
    expect(doc.story!.cutSignature).toBe(cutSignature(cutContent(doc)!))
    expect(cutEdited(doc)).toBe(false)
    // One undo step takes it all back.
    const undone = applyPatches(doc, inversePatches)
    expect(undone).toEqual(before)
  })

  it('is replaced, not added to, the next time — from whichever timeline is open', () => {
    let doc = layOut(project()).doc
    doc = applyOp(doc, openTimeline('main'), ctx).doc
    doc = layOut(doc).doc
    expect(timelineSummaries(doc).map((t) => t.name)).toEqual(['Main', STORY_CUT_NAME])
    expect(doc.spine).toHaveLength(6)
    expect(cutEdited(doc)).toBe(false)
  })

  it('tells a hand edit, open or stashed', () => {
    let doc = layOut(project()).doc
    doc = applyOp(doc, appendToSpine([makeTitle({ template: 'centered', text: 'End', duration: 24, newId: () => 'end' })]), ctx).doc
    expect(cutEdited(doc)).toBe(true)
    doc = applyOp(doc, openTimeline('main'), ctx).doc
    expect(cutEdited(doc)).toBe(true)
    // Nothing laid out yet: nothing to lose.
    expect(cutEdited(project())).toBe(false)
  })
})
