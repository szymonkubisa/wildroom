import { describe, expect, it } from 'vitest'
import { secondsToFlicks } from '../time/flicks'
import { DEFAULT_TITLE_STYLE, makeGap, makeGenerator, makeMediaClip, makeTitle } from './factories'
import { nearestProjectFps } from './fps'
import { MEDIA, f2f, idGen } from './test-utils'

describe('makeMediaClip', () => {
  it('uses the whole asset for video, with video + audio props and one take', () => {
    const clip = makeMediaClip({ assetId: 'v10', media: MEDIA.v10!, fps: 24, newId: idGen('c') })
    expect(clip).toMatchObject({ kind: 'media', id: 'c1', duration: 240, speed: 1, active: 0, enabled: true })
    expect(clip.takes).toEqual([{ id: 'c2', assetId: 'v10', sourceIn: 0 }])
    expect(clip.video).toMatchObject({ enabled: true, conform: 'fit', opacity: 1 })
    expect(clip.audio).toMatchObject({ enabled: true, role: 'dialogue', gainDb: 0 })
    expect(makeMediaClip({ assetId: 'v10', media: MEDIA.v10!, fps: 30, newId: idGen() }).duration).toBe(300)
  })

  it('starts at sourceIn and clamps an explicit duration to what is left of the asset', () => {
    const rest = makeMediaClip({ assetId: 'v10', media: MEDIA.v10!, fps: 24, sourceIn: f2f(40), newId: idGen() })
    expect(rest.duration).toBe(200)
    expect(rest.takes[0]!.sourceIn).toBe(f2f(40))
    expect(makeMediaClip({ assetId: 'v10', media: MEDIA.v10!, fps: 24, durationFrames: 500, newId: idGen() }).duration).toBe(240)
    expect(makeMediaClip({ assetId: 'v10', media: MEDIA.v10!, fps: 24, durationFrames: 48, newId: idGen() }).duration).toBe(48)
  })

  it('makes stills 5 s with video props only', () => {
    const img = makeMediaClip({ assetId: 'img', media: MEDIA.img!, fps: 25, sourceIn: 99, newId: idGen() })
    expect(img.duration).toBe(125)
    expect(img.takes[0]!.sourceIn).toBe(0)
    expect(img.video).toBeDefined()
    expect(img.audio).toBeUndefined()
  })

  it('makes audio-only clips without video props; the role can be chosen', () => {
    const a = makeMediaClip({ assetId: 'a20', media: MEDIA.a20!, fps: 24, newId: idGen() })
    expect(a.video).toBeUndefined()
    expect(a.audio!.role).toBe('dialogue')
    expect(a.duration).toBe(480)
    expect(makeMediaClip({ assetId: 'a20', media: MEDIA.a20!, fps: 24, role: 'music', newId: idGen() }).audio!.role).toBe('music')
  })

  it('makes pending clips (no asset yet) 5 s unless told otherwise', () => {
    const pending = makeMediaClip({
      generationId: 'gen1',
      media: { kind: 'video', hasVideo: true, hasAudio: false },
      fps: 24,
      name: 'Shot 1',
      newId: idGen(),
    })
    expect(pending).toMatchObject({ duration: 120, name: 'Shot 1' })
    expect(pending.takes).toEqual([{ id: 'n2', generationId: 'gen1', sourceIn: 0 }])
  })

  it('never produces zero-length clips', () => {
    const tiny = { kind: 'audio' as const, durationFlicks: secondsToFlicks(0.01), hasVideo: false, hasAudio: true }
    expect(makeMediaClip({ assetId: 'x', media: tiny, fps: 24, newId: idGen() }).duration).toBe(1)
  })
})

describe('gap / title / generator', () => {
  it('makes gaps of at least one frame', () => {
    expect(makeGap(12.4, () => 'g')).toEqual({ kind: 'gap', id: 'g', duration: 12, enabled: true })
    expect(makeGap(0, () => 'g').duration).toBe(1)
  })

  it('makes titles with the basic style', () => {
    expect(DEFAULT_TITLE_STYLE).toEqual({
      fontFamily: 'Helvetica Neue',
      fontSize: 64,
      fontWeight: 600,
      color: '#ffffff',
      align: 'center',
      shadow: true,
    })
    const t = makeTitle({ duration: 72, newId: () => 't', text: 'Hi', style: { fontSize: 80 } })
    expect(t).toMatchObject({ kind: 'title', id: 't', duration: 72, template: 'basic', text: 'Hi', animation: 'none' })
    expect(t.style).toEqual({ ...DEFAULT_TITLE_STYLE, fontSize: 80 })
    expect(t.video).toBeDefined()
    expect(makeTitle({ duration: 10, newId: () => 't' }).text).toBe('Title')
  })

  it('makes generators', () => {
    expect(makeGenerator({ duration: 10, newId: () => 'g', params: { color: '#123456' } })).toMatchObject({
      kind: 'generator',
      generator: 'solid',
      params: { color: '#123456' },
    })
  })
})

describe('nearestProjectFps', () => {
  it('picks the nearest supported rate', () => {
    expect([23.976, 24, 25, 29.97, 30, 47.95, 50, 59.94, 60, 120, 12, 27.5].map(nearestProjectFps)).toEqual([
      24, 24, 25, 30, 30, 48, 50, 60, 60, 60, 24, 25,
    ])
  })
})
