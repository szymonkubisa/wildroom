import { describe, expect, it } from 'vitest'
import { P, defaultValues } from './params'
import { allModels, getModel } from './registry'
import type { ModelSpec } from './types'
import { STORYBOARD_MANAGED, clipAtLeast, clipSeconds, dialectOf, followsRecordedAudio, maxClipSeconds, modelFamily, rendersSeparately, workflowFor } from './workflow'

const model = (id: string): ModelSpec => {
  const m = getModel(id)
  if (!m) throw new Error(`No model ${id}`)
  return m
}

describe('dialectOf', () => {
  it('reads the family from the id and vendor, Happy Horse included', () => {
    expect(dialectOf(model('runpod-ltx-2.5'))).toBe('ltx')
    expect(dialectOf(model('fal-ltx-2.5-pro'))).toBe('ltx')
    expect(dialectOf(model('kling-3.0'))).toBe('kling')
    expect(dialectOf(model('fal-kling-o3'))).toBe('kling')
    expect(dialectOf(model('fal-veo3.1'))).toBe('veo')
    expect(dialectOf(model('fal-gemini-omni-flash'))).toBe('veo')
    expect(dialectOf(model('fal-happy-horse-1.1'))).toBe('happyhorse')
    expect(dialectOf(undefined)).toBe('generic')
  })

  it('writes Seedance like LTX, though its camera wording is its own', () => {
    expect(modelFamily(model('fal-seedance-2.5'))).toBe('seedance')
    expect(dialectOf(model('fal-seedance-2.5'))).toBe('generic')
    expect(dialectOf(model('fal-wan-3.0'))).toBe('generic')
  })
})

describe('workflowFor', () => {
  it('resolves every video model to a complete profile', () => {
    const video = allModels().filter((m) => m.kind === 'video' || m.output === 'video')
    expect(video.length).toBeGreaterThan(10)
    for (const m of video) {
      const w = workflowFor(m)
      expect(w.multishot.maxShots, m.id).toBeGreaterThanOrEqual(2)
      expect(w.multishot.maxSeconds, m.id).toBeGreaterThan(0)
      expect(['ltx', 'kling', 'veo', 'happyhorse', 'generic'], m.id).toContain(w.dialect)
      if (w.cast) {
        expect(m.params.some((p) => p.key === w.cast!.param), m.id).toBe(true)
        expect(w.cast.token, m.id).toContain('{')
        expect(w.cast.max + w.cast.maxWithKeyframe, m.id).toBeGreaterThan(0)
      }
      if (w.sources.includes('keyframe')) expect(m.params.some((p) => p.key === 'firstFrame'), m.id).toBe(true)
    }
  })

  it('never throws, whatever the model', () => {
    for (const m of allModels()) expect(() => workflowFor(m), m.id).not.toThrow()
  })

  it('falls back to the storyboard’s LTX defaults without a model, and writes an unknown family like LTX', () => {
    expect(workflowFor(undefined)).toEqual({
      dialect: 'ltx',
      // Three shots of about three seconds in a 10 s clip (Lightricks: a cut every 2 s plays like a slideshow).
      multishot: { method: 'prose', maxShots: 3, maxSeconds: 10, minShotSeconds: 3 },
      speech: { languages: 'any' },
      negative: 'ineffective',
      sources: ['keyframe'],
      // Lightricks: one paragraph of at most 200 words.
      maxWords: 200,
    })
    const mystery: ModelSpec = {
      id: 'mystery-video',
      label: 'Mystery',
      vendor: 'Nobody',
      provider: 'fal',
      kind: 'video',
      description: '',
      badges: [],
      output: 'video',
      params: [P.prompt(), P.image('firstFrame', 'Start frame')],
      estimateCost: () => ({ usd: null, detail: '', asOf: '2026-10-09' }),
    }
    expect(workflowFor(mystery)).toEqual({
      dialect: 'generic',
      multishot: { method: 'prose', maxShots: 3, maxSeconds: 10, minShotSeconds: 3 },
      speech: { languages: 'any' },
      negative: 'none',
      sources: ['keyframe'],
    })
  })

  it('RunPod LTX: four Licon references named Image n, two voices, the place as the background, prose cuts', () => {
    const w = workflowFor(model('runpod-ltx-2.5'))
    expect(w.dialect).toBe('ltx')
    expect(w.cast).toMatchObject({ param: 'referenceImages', max: 4, maxWithKeyframe: 0, token: 'Image {n}', voices: 2 })
    expect(w.scene).toEqual({ param: 'referenceBackground' })
    expect(w.multishot).toEqual({ method: 'prose', maxShots: 3, maxSeconds: 10, minShotSeconds: 3 })
    expect(w.negative).toBe('ineffective')
    expect(w.speech.languages).toBe('any')
    expect(w.sources[0]).toBe('references')
    expect(w.sources).toEqual(['references', 'keyframe'])
    expect(w.maxWords).toBe(200)
    // Other families count characters (their prompt params), not words.
    expect(workflowFor(model('kling-3.0')).maxWords).toBeUndefined()
  })

  it('local LTX: no cast, 8 s clips, from a keyframe only', () => {
    const w = workflowFor(model('local-ltx-2.5'))
    expect(w.dialect).toBe('ltx')
    expect(w.cast).toBeUndefined()
    expect(w.scene).toBeUndefined()
    // 8 s clips: two shots of three seconds or more.
    expect(w.multishot).toEqual({ method: 'prose', maxShots: 2, maxSeconds: 8, minShotSeconds: 3 })
    expect(w.sources).toEqual(['keyframe'])
  })

  it('Kling 3.0 (direct): native shot list of 6 × 512 characters in 15 s, elements only with a start frame', () => {
    const w = workflowFor(model('kling-3.0'))
    expect(w.dialect).toBe('kling')
    expect(w.multishot).toEqual({ method: 'native', maxShots: 6, maxSeconds: 15, maxShotChars: 512 })
    expect(w.speech).toEqual({ languages: ['English', 'Chinese'], lowercaseEnglish: true })
    // The token withKlingElementMentions writes.
    expect(w.cast).toMatchObject({ param: 'elements', max: 0, maxWithKeyframe: 3, token: '@element_{n}', needsAngles: true })
    expect(w.sources).toEqual(['both', 'keyframe'])
  })

  it('Kling 3.0 Omni (direct): up to 7 elements without a frame, 3 with one', () => {
    const w = workflowFor(model('kling-3.0-omni'))
    expect(w.cast).toMatchObject({ param: 'elements', max: 7, maxWithKeyframe: 3 })
    expect(w.multishot.method).toBe('native')
    expect(w.sources).toEqual(['references', 'both', 'keyframe'])
  })

  it('Kling without a shot list of its own writes the cuts in prose, 2–4 of them', () => {
    expect(workflowFor(model('kling-3.0-turbo')).multishot).toEqual({ method: 'prose', maxShots: 4, maxSeconds: 15, minShotSeconds: 3 })
    expect(workflowFor(model('fal-kling-o3')).multishot).toEqual({ method: 'prose', maxShots: 4, maxSeconds: 15, minShotSeconds: 3 })
  })

  it('Kling 3.0 (fal): its multiPrompt makes the shot list native; elements made from the Cast, only with a start frame', () => {
    const w = workflowFor(model('fal-kling-3.0'))
    expect(w.dialect).toBe('kling')
    expect(w.multishot).toEqual({ method: 'native', maxShots: 6, maxSeconds: 15, maxShotChars: 512 })
    expect(w.cast).toMatchObject({ param: 'elementImages', max: 0, maxWithKeyframe: 3, token: '@Element{n}', needsAngles: true, label: 'Kling elements' })
    expect(w.negative).toBe('effective')
    expect(w.sources).toEqual(['both', 'keyframe'])
  })

  it('Veo 3.1: timestamped shots in 8 s, English speech, a working negative prompt, up to 3 ingredients for a fixed 8 s', () => {
    for (const id of ['fal-veo3.1', 'fal-veo3.1-fast']) {
      const w = workflowFor(model(id))
      expect(w.dialect).toBe('veo')
      expect(w.multishot).toEqual({ method: 'timestamps', maxShots: 4, maxSeconds: 8 })
      expect(w.speech.languages).toEqual(['English'])
      expect(w.negative).toBe('effective')
      expect(w.cast).toEqual({ param: 'referenceImages', max: 3, maxWithKeyframe: 0, token: '{name}', fixedSeconds: 8, label: 'Ingredients' })
      expect(w.sources).toEqual(['references', 'keyframe'])
    }
  })

  it('Happy Horse 1.1: up to 9 characters named character n, or a start frame, never both; beats', () => {
    const w = workflowFor(model('fal-happy-horse-1.1'))
    expect(w.dialect).toBe('happyhorse')
    expect(w.cast).toMatchObject({ param: 'referenceImages', max: 9, maxWithKeyframe: 0, token: 'character{n}', label: 'Characters' })
    expect(w.multishot).toEqual({ method: 'beats', maxShots: 6, maxSeconds: 15 })
    expect(w.speech.languages).toBe('any')
    expect(w.sources).toEqual(['references', 'keyframe'])
  })

  it('Kling O3 (fal): up to 3 elements named @Element n, the place as reference image @Image n', () => {
    for (const id of ['fal-kling-o3', 'fal-kling-o3-4k']) {
      const w = workflowFor(model(id))
      expect(w.dialect).toBe('kling')
      expect(w.cast).toMatchObject({ param: 'elementImages', max: 3, maxWithKeyframe: 3, token: '@Element{n}', needsAngles: true })
      expect(w.scene).toEqual({ param: 'referenceImages', token: '@Image{n}' })
      expect(w.sources).toEqual(['references', 'both', 'keyframe'])
    }
  })

  it('hands out copies: changing a profile doesn’t change the catalog', () => {
    const w = workflowFor(model('kling-3.0'))
    ;(w.speech.languages as string[]).push('Polish')
    w.sources.length = 0
    expect(workflowFor(model('kling-3.0')).speech.languages).toEqual(['English', 'Chinese'])
    expect(workflowFor(model('kling-3.0')).sources).toEqual(['both', 'keyframe'])
  })
})

describe('followsRecordedAudio', () => {
  it('is LTX taking an audio track; without a model the caller says', () => {
    expect(followsRecordedAudio(model('runpod-ltx-2.5'), false)).toBe(true)
    expect(followsRecordedAudio(model('fal-ltx-2.5-pro'), true)).toBe(false)
    expect(followsRecordedAudio(model('kling-3.0'), true)).toBe(false)
    expect(followsRecordedAudio(undefined, true)).toBe(true)
    expect(followsRecordedAudio(undefined, false)).toBe(false)
  })
})

describe('rendersSeparately', () => {
  it('is LTX taking a start frame, on any host; Kling, Veo and the rest keep their groups; without a model the caller says', () => {
    expect(rendersSeparately(model('runpod-ltx-2.5'), false)).toBe(true)
    expect(rendersSeparately(model('local-ltx-2.5'), false)).toBe(true)
    expect(rendersSeparately(model('fal-ltx-2.5-pro'), false)).toBe(true)
    for (const id of ['kling-3.0', 'fal-veo3.1', 'fal-happy-horse-1.1', 'fal-seedance-2.5']) expect(rendersSeparately(model(id), true)).toBe(false)
    // LTX from references only (no start frame) has nothing to render a shot from on its own.
    const ltx = model('runpod-ltx-2.5')
    expect(rendersSeparately({ ...ltx, params: ltx.params.filter((p) => p.key !== 'firstFrame') }, true)).toBe(false)
    expect(rendersSeparately(undefined, true)).toBe(true)
    expect(rendersSeparately(undefined, false)).toBe(false)
  })
})

describe('clip lengths', () => {
  it('Luma Ray 3.2: 5 s from a keyframe, though its duration takes 10 s too (from text)', () => {
    const luma = model('fal-luma-ray-3.2')
    // An 8 s shot asked for 10 s, which Luma's own rule rejects with a start frame.
    expect(clipSeconds(luma, 8)).toBe(5)
    expect(clipAtLeast(luma, 8)).toBe(5)
    expect(maxClipSeconds(luma)).toBe(5)
    expect(workflowFor(luma).multishot.maxSeconds).toBe(5)
  })

  it('every clip length the storyboard picks renders from a keyframe', () => {
    for (const m of allModels()) {
      if (m.output !== 'video' || !m.params.some((p) => p.key === 'firstFrame')) continue
      const lengths = new Set([maxClipSeconds(m)])
      for (let s = 1; s <= 30; s++) lengths.add(clipSeconds(m, s)).add(clipAtLeast(m, s))
      for (const duration of lengths) {
        const problem = m.validate?.({ ...defaultValues(m), prompt: 'probe', firstFrame: 'probe', duration }) ?? null
        expect([m.id, duration, problem]).toEqual([m.id, duration, null])
      }
    }
  })
})

describe('STORYBOARD_MANAGED', () => {
  it('covers what the storyboard sets per shot or group, and leaves the render’s own choices alone', () => {
    for (const key of ['prompt', 'duration', 'firstFrame', 'referenceImages', 'voice1', 'elements', 'multiShot', 'multiPrompt', 'multiClip', 'cameraMotion'])
      expect(STORYBOARD_MANAGED.has(key), key).toBe(true)
    for (const key of ['resolution', 'audio', 'fps', 'quality', 'mode']) expect(STORYBOARD_MANAGED.has(key), key).toBe(false)
  })
})
