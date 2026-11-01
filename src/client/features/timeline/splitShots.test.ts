import { secondsToFlicks } from '@shared/time/flicks'
import { appendToSpine, connectAt, makeMediaClip } from '@shared/timeline'
import type { AssetDTO } from '@shared/types/assets'
import type { MediaClip } from '@shared/types/project-doc'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAssetsStore } from '@/stores/assets'
import { useProjectStore } from '@/stores/project'
import { cutFrames, expectedCutsFromParams, useSplitShots } from './splitShots'

class FakeEventSource {
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  close() {}
}

const MULTI_SHOT = { prompt: 'Shot 1 (2s): the harbour\nShot 2 (3s): the keeper', duration: 5, multiShot: true }

function videoAsset(id: string, params?: Record<string, unknown>): AssetDTO {
  return {
    id,
    kind: 'video',
    name: id,
    status: 'ready',
    source: 'generation',
    durationFlicks: secondsToFlicks(5),
    fps: 24,
    hasVideo: true,
    hasAudio: false,
    variants: { proxy: true },
    parentIds: [],
    rating: 0,
    keywords: [],
    projectIds: ['p1'],
    createdAt: '2026-09-29T00:00:00.000Z',
    generation: params
      ? { generationId: `gen-${id}`, modelId: 'kling-3.0', modelLabel: 'Kling 3.0', provider: 'kling', params }
      : undefined,
  }
}

/** Stubs the scene-cuts endpoint; returns the request bodies it received. */
function serveCuts(cuts: number[], source = 'refined') {
  const bodies: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toMatch(/^\/api\/assets\/[^/]+\/scene-cuts$/)
      bodies.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ cuts, source, detected: cuts }), { status: 200 })
    }),
  )
  return bodies
}

describe('split into shots', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function addClip(assetId: string, patch: Partial<MediaClip> = {}, sourceSeconds = 0) {
    const project = useProjectStore()
    const ctx = project.opContext()
    const clip = { ...makeMediaClip({ assetId, media: ctx.media(assetId)!, fps: 24, sourceIn: secondsToFlicks(sourceSeconds), newId: ctx.newId }), ...patch }
    project.apply(appendToSpine([clip]), 'Add clip')
    return clip.id
  }

  it('reads planned cuts from the generation params', () => {
    expect(expectedCutsFromParams(MULTI_SHOT)).toEqual([2])
    expect(expectedCutsFromParams({ ...MULTI_SHOT, multiShot: false })).toEqual([])
    expect(expectedCutsFromParams({ prompt: 'a plain prompt', duration: 5, multiShot: true })).toEqual([])
    expect(expectedCutsFromParams(undefined)).toEqual([])
  })

  it('blades a multi-shot clip at the refined cuts in one undoable edit', async () => {
    useAssetsStore().upsert(videoAsset('a1', MULTI_SHOT))
    const project = useProjectStore()
    const clipId = addClip('a1')
    const bodies = serveCuts([2.0])
    const undoDepth = project.undoStack.length

    expect(await useSplitShots().splitIntoShots(clipId)).toBe(1)
    expect(bodies).toEqual([{ expected: [2] }])
    expect(project.doc.spine.map((s) => s.duration)).toEqual([48, 72])
    expect(project.doc.spine[0]!.id).toBe(clipId)
    const right = project.doc.spine[1] as MediaClip
    expect(right.takes[0]!.sourceIn).toBe(secondsToFlicks(2))
    expect(project.undoStack.length).toBe(undoDepth + 1)
    expect(project.undoStack.at(-1)!.label).toBe('Split into 2 shots')
  })

  it('maps cuts through the source in-point and speed, skipping cuts outside the visible range', async () => {
    useAssetsStore().upsert(videoAsset('a2'))
    const project = useProjectStore()
    // Source 1 s…3 s at double speed: 24 frames on the timeline.
    const clipId = addClip('a2', { speed: 2, duration: 24 }, 1)
    const bodies = serveCuts([0.5, 2, 2.5, 4.5], 'detected')
    expect(await useSplitShots().splitIntoShots(clipId)).toBe(2)
    expect(bodies).toEqual([{}]) // no plan in the params: the server detects (or uses its stored plan)
    expect(project.doc.spine.map((s) => s.duration)).toEqual([12, 6, 6])
  })

  it('splits connected clips and leaves clips without cuts alone', async () => {
    const assets = useAssetsStore()
    assets.upsert(videoAsset('base'))
    assets.upsert(videoAsset('broll', MULTI_SHOT))
    const project = useProjectStore()
    addClip('base')
    const ctx = project.opContext()
    const broll = makeMediaClip({ assetId: 'broll', media: ctx.media('broll')!, fps: 24, newId: ctx.newId })
    project.apply(connectAt(24, [broll], 1), 'Connect')
    serveCuts([2])
    expect(await useSplitShots().splitIntoShots(broll.id)).toBe(1)
    const connected = project.layout.connected.map((c) => [c.start, c.end])
    expect(connected).toEqual([
      [24, 72],
      [72, 144],
    ])

    serveCuts([])
    const before = project.doc
    expect(await useSplitShots().splitIntoShots(project.doc.spine[0]!.id)).toBe(0)
    expect(project.doc).toBe(before)
  })

  it('computes frames for cut times', () => {
    const clip = { ...makeMediaClip({ assetId: 'x', media: { kind: 'video', hasVideo: true, hasAudio: false }, fps: 24, durationFrames: 120, newId: () => 'c' }) }
    expect(cutFrames(clip, 100, [1, 2.5, 0, 5, 7], 24)).toEqual([160, 124])
  })
})
