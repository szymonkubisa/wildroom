import { applyOp, layoutTimeline, makeMediaClip, ops } from '@shared/timeline'
import type { MediaInfo } from '@shared/timeline'
import { secondsToFlicks } from '@shared/time/flicks'
import type { AssetDTO } from '@shared/types/assets'
import { createEmptyDoc } from '@shared/types/project-doc'
import { describe, expect, it } from 'vitest'
import { buildScene } from './buildScene'
import {
  type AudioSegment,
  type VideoLayer,
  dbToGain,
  duckDepth,
  heldSourceTime,
  keyframeValue,
  segmentGain,
  transitionGain,
  transitionOpacity,
} from './scene'

let n = 0
const newId = () => `id${++n}`

function asset(id: string, over: Partial<AssetDTO> = {}): AssetDTO {
  return {
    id,
    kind: 'video',
    name: id,
    status: 'ready',
    source: 'import',
    durationFlicks: secondsToFlicks(10),
    width: 1280,
    height: 720,
    fps: 24,
    hasVideo: true,
    hasAudio: true,
    variants: { original: true, proxy: true, audio: true },
    parentIds: [],
    rating: 0,
    keywords: [],
    projectIds: [],
    createdAt: '',
    ...over,
  }
}

describe('heldSourceTime', () => {
  it('keeps a video on its last frame once it has played (it never starts over)', () => {
    expect(heldSourceTime(2, 5)).toBe(2)
    expect(heldSourceTime(7.5, 5)).toBeCloseTo(4.95)
    expect(heldSourceTime(5, 5)).toBeCloseTo(4.95)
    expect(heldSourceTime(7.5, undefined)).toBe(7.5)
  })
})

describe('scene envelopes', () => {
  it('interpolates linear keyframes and clamps outside', () => {
    const keys = [
      { frame: 0, value: 0 },
      { frame: 10, value: 1 },
    ]
    expect(keyframeValue(keys, -5, 9)).toBe(0)
    expect(keyframeValue(keys, 5, 9)).toBeCloseTo(0.5)
    expect(keyframeValue(keys, 20, 9)).toBe(1)
    expect(keyframeValue(undefined, 3, 0.7)).toBe(0.7)
  })

  it('dissolves: incoming ramps up, outgoing stays opaque underneath', () => {
    const tr = { type: 'dissolve' as const, start: 100, end: 120 }
    expect(transitionOpacity({ transitions: [{ ...tr, side: 'in', solo: false }] }, 110)).toBeCloseTo(0.5)
    expect(transitionOpacity({ transitions: [{ ...tr, side: 'out', solo: false }] }, 110)).toBe(1)
    expect(transitionOpacity({ transitions: [{ ...tr, side: 'out', solo: true }] }, 110)).toBeCloseTo(0.5)
  })

  it('dips: out-side fades in the first half, in-side in the second', () => {
    const tr = { type: 'dip-black' as const, start: 0, end: 20 }
    expect(transitionOpacity({ transitions: [{ ...tr, side: 'out', solo: false }] }, 5)).toBeCloseTo(0.5)
    expect(transitionOpacity({ transitions: [{ ...tr, side: 'in', solo: false }] }, 5)).toBe(0)
    expect(transitionOpacity({ transitions: [{ ...tr, side: 'in', solo: false }] }, 15)).toBeCloseTo(0.5)
  })

  it('crossfades audio with equal power', () => {
    const tr = { type: 'dissolve' as const, start: 0, end: 10 }
    const a = transitionGain({ transitions: [{ ...tr, side: 'out', solo: false }] }, 5)
    const b = transitionGain({ transitions: [{ ...tr, side: 'in', solo: false }] }, 5)
    expect(a * a + b * b).toBeCloseTo(1)
  })

  it('ramps ducking in before and out after dialogue', () => {
    const duck = { ranges: [[100, 200]] as [number, number][], amountDb: -12, ramp: 10 }
    expect(duckDepth(duck, 80)).toBe(0)
    expect(duckDepth(duck, 95)).toBeCloseTo(0.5)
    expect(duckDepth(duck, 150)).toBe(1)
    expect(duckDepth(duck, 205)).toBeCloseTo(0.5)
    expect(duckDepth(duck, 215)).toBe(0)
  })

  it('combines gain, normalisation, ducking and fades', () => {
    const seg: AudioSegment = {
      clipId: 'c',
      assetId: 'a',
      start: 0,
      end: 100,
      sourceStart: 0,
      speed: 1,
      role: 'music',
      audio: { enabled: true, role: 'music', gainDb: -6, pan: 0, fadeIn: 10, fadeOut: 0 },
      transitions: [],
      normGainDb: 3,
      duck: { ranges: [[40, 60]], amountDb: -10, ramp: 1 },
    }
    expect(segmentGain(seg, 5)).toBeCloseTo(dbToGain(-3) * 0.5)
    expect(segmentGain(seg, 50)).toBeCloseTo(dbToGain(-13))
    expect(segmentGain(seg, 80)).toBeCloseTo(dbToGain(-3))
  })
})

describe('buildScene', () => {
  const assets = new Map<string, AssetDTO>([
    ['v1', asset('v1')],
    ['v2', asset('v2')],
    ['voice', asset('voice', { kind: 'audio', hasVideo: false, role: 'dialogue', loudness: { integratedLufs: -17, truePeakDb: -1 } })],
    ['music', asset('music', { kind: 'audio', hasVideo: false, role: 'music' })],
  ])
  const media = (id: string): MediaInfo | undefined => {
    const a = assets.get(id)
    return a && a.kind !== 'font' ? { kind: a.kind, durationFlicks: a.durationFlicks, hasVideo: a.hasVideo, hasAudio: a.hasAudio, fps: a.fps } : undefined
  }
  const ctx = { newId, media }
  const clip = (id: string, role?: string, durationFrames?: number) =>
    makeMediaClip({ assetId: id, media: media(id)!, fps: 24, role, newId, durationFrames })

  function build() {
    let doc = createEmptyDoc({ fps: 24, fpsAuto: false })
    doc = applyOp(doc, ops.appendToSpine([clip('v1', 'effects', 48), clip('v2', 'effects', 48)]), ctx).doc
    doc = applyOp(doc, ops.setTransition(doc.spine[0]!.id, 'out', { type: 'dissolve', duration: 12 }), ctx).doc
    doc = applyOp(doc, ops.connectAt(10, [clip('voice', 'dialogue', 24)], -1), ctx).doc
    doc = applyOp(doc, ops.connectAt(0, [clip('music', 'music', 84)], -2), ctx).doc
    return buildScene(doc, layoutTimeline(doc), (id) => assets.get(id))
  }

  it('lays out spine overlaps as transition envelopes', () => {
    const scene = build()
    const [a, b] = scene.video.filter((l: VideoLayer) => l.lane === 0)
    expect(scene.duration).toBe(84)
    expect(b!.start).toBe(36)
    expect(a!.transitions).toEqual([{ type: 'dissolve', start: 36, end: 48, side: 'out', solo: false }])
    expect(b!.transitions).toEqual([{ type: 'dissolve', start: 36, end: 48, side: 'in', solo: false }])
    expect(b!.z).toBeGreaterThan(a!.z)
  })

  it('normalises dialogue and ducks music under it', () => {
    const scene = build()
    const voice = scene.audio.find((s) => s.assetId === 'voice')!
    const music = scene.audio.find((s) => s.assetId === 'music')!
    expect(voice.normGainDb).toBeCloseTo(-6) // -23 target - (-17) measured
    expect(music.duck?.ranges).toEqual([[10, 34]])
    expect(scene.audio.find((s) => s.assetId === 'v1')!.duck).toBeUndefined()
  })
})
