import { describe, expect, it } from 'vitest'
import { elevenLabsModels } from '../../src/shared/models/catalog/elevenlabs'
import { canExtendWithVeo, falModels } from '../../src/shared/models/catalog/fal'
import { klingModels } from '../../src/shared/models/catalog/kling'
import { mockModels } from '../../src/shared/models/catalog/mock'
import { fitParams } from '../../src/shared/models/fit'
import { defaultValues, parseParams } from '../../src/shared/models/params'
import type { ModelSpec, ParamValues } from '../../src/shared/models/types'
import { FAL_ROUTES } from '../../src/server/providers/fal'
import { minimalInput } from './helpers'

const catalog: ModelSpec[] = [...elevenLabsModels, ...klingModels, ...falModels]
const byId = (id: string) => {
  const model = catalog.find((m) => m.id === id)
  if (!model) throw new Error(`no model ${id}`)
  return model
}
const parse = (id: string, input: ParamValues) => parseParams(byId(id), { ...minimalInput(byId(id)), ...input })
const cost = (id: string, input: ParamValues = {}) => {
  const parsed = parse(id, input)
  if (!parsed.ok) throw new Error(parsed.message)
  return byId(id).estimateCost(parsed.values)
}

describe('provider catalogs', () => {
  it('defines the expected models with unique ids', () => {
    const ids = [...mockModels, ...catalog].map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(elevenLabsModels.map((m) => m.id)).toEqual([
      'eleven-v4-tts',
      'eleven-v4-turbo-tts',
      'eleven-v3-tts',
      'eleven-multilingual-v2-tts',
      'eleven-flash-v2.5-tts',
      'eleven-dialogue',
      'eleven-sfx',
      'eleven-music',
    ])
    expect(klingModels.map((m) => m.id)).toEqual(['kling-3.0', 'kling-3.0-omni', 'kling-3.0-turbo', 'kling-2.6', 'kling-2.5-turbo'])
    expect(falModels.map((m) => m.id)).toEqual([
      'fal-nano-banana-pro',
      'fal-nano-banana-2',
      'fal-seedream-5-pro',
      'fal-flux-2-pro',
      'fal-gpt-image-2.5',
      'fal-recraft-v3',
      'fal-recraft-v4.1-vector',
      'fal-ideogram-v4',
      'fal-krea-2',
      'fal-mai-image-2.5',
      'fal-veo3.1',
      'fal-veo3.1-fast',
      'fal-seedance-2.5',
      'fal-wan-3.0',
      'fal-minimax-h3-max',
      'fal-pixverse-v6',
      'fal-ltx-2.5-pro',
      'fal-happy-horse-1.1',
      'fal-gemini-omni-flash',
      'fal-luma-ray-3.2',
      'fal-kling-3.0',
      'fal-kling-o3',
      'fal-kling-o3-4k',
      'fal-veo3.1-extend',
      'fal-sync-lipsync-v3',
      'fal-mmaudio-v2',
      'fal-stable-audio-2.5',
      'fal-topaz-upscale-video',
      'fal-seedvr2-upscale-video',
      'fal-topaz-upscale-image',
      'fal-bria-rmbg',
      'fal-birefnet-v2',
      'fal-recraft-vectorize',
      'fal-custom',
      'fal-custom-image',
      'fal-custom-audio',
    ])
  })

  it('has a fal route for every fal model and no orphan routes', () => {
    expect(Object.keys(FAL_ROUTES).sort()).toEqual(falModels.map((m) => m.id).sort())
  })

  describe.each(catalog.map((m) => [m.id, m] as const))('%s', (_id, model) => {
    it('accepts its own defaults plus the minimal required input', () => {
      for (const p of model.params) {
        if (p.default !== undefined) expect(p.schema.safeParse(p.default).success, `default of ${p.key}`).toBe(true)
      }
      const result = parseParams(model, minimalInput(model))
      expect(result.ok, result.ok ? '' : result.message).toBe(true)
    })

    it('is well-formed', () => {
      expect(model.label).toBeTruthy()
      expect(model.description.length).toBeGreaterThan(10)
      expect(['elevenlabs', 'kling', 'fal']).toContain(model.provider)
      expect(model.maxVariants ?? 1).toBeGreaterThanOrEqual(1)
      if (model.output === 'audio') expect(model.defaultRole).toBeTruthy()
      if (model.kind === 'speech' || model.kind === 'dialogue') expect(model.defaultRole).toBe('dialogue')
      if (model.kind === 'music') expect(model.defaultRole).toBe('music')
      if (model.kind === 'sfx' || model.kind === 'foley') expect(model.defaultRole).toBe('effects')
      const keys = model.params.map((p) => p.key)
      expect(new Set(keys).size).toBe(keys.length)
    })

    it('estimates a cost for its defaults', () => {
      const parsed = parseParams(model, { ...defaultValues(model), ...minimalInput(model) })
      if (!parsed.ok) throw new Error(parsed.message)
      const estimate = model.estimateCost(parsed.values)
      // Date of the price table (upscalers were checked a day later; models added in October later still).
      expect(estimate.asOf).toMatch(/^2026-(09-2[89]|10-0[25])$/)
      expect(estimate.detail).toBeTruthy()
      if (estimate.usd !== null) {
        expect(Number.isFinite(estimate.usd)).toBe(true)
        expect(estimate.usd).toBeGreaterThan(0)
      }
    })
  })
})

describe('video defaults', () => {
  it('renders 720p by default wherever a video model offers it (but Kling 2.6, whose sound comes only at 1080p)', () => {
    for (const m of [...falModels, ...klingModels].filter((x) => x.kind === 'video')) {
      const p = m.params.find((x) => x.key === 'resolution')
      if (p?.ui.options?.some((o) => o.value === '720p')) expect(p.default, m.id).toBe(m.id === 'kling-2.6' ? '1080p' : '720p')
    }
  })
})

describe('cost estimates', () => {
  it('prices Kling by resolution, audio and duration', () => {
    expect(cost('kling-3.0', { resolution: '1080p' }).usd).toBeCloseTo(0.84) // 1080p, audio, 5 s × $0.168
    expect(cost('kling-3.0', { audio: false, resolution: '720p' }).usd).toBeCloseTo(0.42)
    expect(cost('kling-3.0', { resolution: '4k', duration: 10 }).usd).toBeCloseTo(4.2)
    expect(cost('kling-3.0', { resolution: '4k', duration: 10, audio: false }).usd).toBeCloseTo(4.2)
    expect(cost('kling-3.0-omni', { resolution: '1080p' }).usd).toBeCloseTo(0.7) // 1080p, audio, 5 s × $0.14
    expect(cost('kling-3.0-omni', { audio: false, resolution: '720p', duration: 10 }).usd).toBeCloseTo(0.84)
    expect(cost('kling-3.0-omni', { resolution: '4k' }).usd).toBeCloseTo(2.1)
    expect(cost('kling-3.0-turbo', { resolution: '1080p' }).usd).toBeCloseTo(0.7)
    expect(cost('kling-3.0-turbo', { resolution: '720p', duration: 10 }).usd).toBeCloseTo(1.12)
    expect(cost('kling-2.6', { duration: 10, resolution: '1080p' }).usd).toBeCloseTo(1.4) // 1080p with audio
    expect(cost('kling-2.6', { duration: 10, audio: false, resolution: '1080p' }).usd).toBeCloseTo(0.7)
    expect(cost('kling-2.6', { resolution: '720p' }).usd).toBeCloseTo(0.21) // audio not offered at 720p
    expect(cost('kling-2.5-turbo', { duration: 10, resolution: '1080p' }).usd).toBeCloseTo(0.7)
    expect(cost('kling-2.5-turbo', { resolution: '720p' }).usd).toBeCloseTo(0.21)
  })

  it('prices fal video models', () => {
    expect(cost('fal-veo3.1', { resolution: '1080p' }).usd).toBeCloseTo(3.2) // 8 s 1080p with audio
    expect(cost('fal-veo3.1', { audio: false, duration: 4, resolution: '1080p' }).usd).toBeCloseTo(0.8)
    expect(cost('fal-veo3.1', { resolution: '4k' }).usd).toBeCloseTo(4.8)
    expect(cost('fal-veo3.1-fast', { resolution: '1080p' }).usd).toBeCloseTo(1.2)
    expect(cost('fal-veo3.1-fast', { resolution: '4k', audio: false }).usd).toBeCloseTo(2.4)
    expect(cost('fal-seedance-2.5').usd).toBeCloseTo(2.365)
    expect(cost('fal-seedance-2.5', { resolution: '1080p', duration: 10 }).usd).toBeCloseTo(11.64)
    expect(cost('fal-wan-3.0', { resolution: '1080p' }).usd).toBeCloseTo(1.0)
    expect(cost('fal-wan-3.0', { resolution: '480p', duration: 10 }).usd).toBeCloseTo(0.5)
    expect(cost('fal-minimax-h3-max', { duration: 10 }).usd).toBeCloseTo(0.8)
    expect(cost('fal-minimax-h3-max', { resolution: '1080p' }).usd).toBeCloseTo(0.8)
    expect(cost('fal-pixverse-v6', { resolution: '1080p' }).usd).toBeCloseTo(0.575)
    expect(cost('fal-pixverse-v6', { resolution: '720p', audio: false, duration: 8 }).usd).toBeCloseTo(0.36)
    expect(cost('fal-ltx-2.5-pro', { resolution: '1080p' }).usd).toBeCloseTo(1.02)
    expect(cost('fal-ltx-2.5-pro', { resolution: '720p', duration: 10 }).usd).toBeCloseTo(1.2)
    expect(cost('fal-happy-horse-1.1', { resolution: '1080p' }).usd).toBeCloseTo(0.9) // 5 s 1080p
    expect(cost('fal-happy-horse-1.1', { resolution: '720p', duration: 10 }).usd).toBeCloseTo(1.4)
    expect(cost('fal-gemini-omni-flash').usd).toBeCloseTo(0.8) // 8 s 720p
    expect(cost('fal-gemini-omni-flash', { resolution: '360p', duration: 10 }).usd).toBeCloseTo(0.3)
    expect(cost('fal-gemini-omni-flash', { resolution: '4k', duration: 5 }).usd).toBeCloseTo(1.5)
    expect(cost('fal-luma-ray-3.2').usd).toBe(1) // 5 s 720p text-to-video
    expect(cost('fal-luma-ray-3.2', { duration: 10, resolution: '1080p' }).usd).toBe(4)
    expect(cost('fal-luma-ray-3.2', { firstFrame: 'asset-a', resolution: '540p' }).usd).toBe(0.15)
    expect(cost('fal-kling-3.0', { resolution: '1080p' }).usd).toBeCloseTo(0.84) // Pro 1080p, audio, 5 s × $0.168
    expect(cost('fal-kling-3.0', { resolution: '720p', audio: false, duration: 10 }).usd).toBeCloseTo(0.84)
    expect(cost('fal-kling-3.0', { resolution: '720p' }).usd).toBeCloseTo(0.63)
    expect(cost('fal-kling-o3', { resolution: '1080p' }).usd).toBeCloseTo(0.56) // Pro 1080p, silent, 5 s × $0.112
    expect(cost('fal-kling-o3', { resolution: '720p', audio: true, duration: 10 }).usd).toBeCloseTo(1.12)
    expect(cost('fal-kling-o3', { audio: true, resolution: '1080p' }).usd).toBeCloseTo(0.7)
    expect(cost('fal-kling-o3-4k').usd).toBeCloseTo(2.1)
    expect(cost('fal-kling-o3-4k', { duration: 10, audio: true }).usd).toBeCloseTo(4.2)
    expect(cost('fal-veo3.1-extend', { video: 'asset-v' }).usd).toBeCloseTo(1.05) // fast, audio, 7 s
    expect(cost('fal-veo3.1-extend', { video: 'asset-v', tier: 'standard', audio: false }).usd).toBeCloseTo(1.4)
  })

  it('prices fal image and audio models', () => {
    expect(cost('fal-nano-banana-pro').usd).toBe(0.15)
    expect(cost('fal-nano-banana-pro', { resolution: '4K' }).usd).toBe(0.3)
    expect(cost('fal-nano-banana-2').usd).toBe(0.08)
    expect(cost('fal-nano-banana-2', { resolution: '0.5K' }).usd).toBe(0.06)
    expect(cost('fal-seedream-5-pro').usd).toBe(0.135)
    expect(cost('fal-seedream-5-pro', { resolution: 'standard' }).usd).toBe(0.0675)
    expect(cost('fal-flux-2-pro').usd).toBeCloseTo(0.045) // 1920×1088 = 2 MP
    expect(cost('fal-flux-2-pro', { resolution: '1MP' }).usd).toBeCloseTo(0.03)
    expect(cost('fal-flux-2-pro', { resolution: '4MP', aspectRatio: '1:1' }).usd).toBeCloseTo(0.075)
    expect(cost('fal-gpt-image-2.5').usd).toBeCloseTo(0.0527, 3) // high, ~1 MP at 16:9
    expect(cost('fal-gpt-image-2.5', { quality: 'low' }).usd).toBeCloseTo(0.0059, 3)
    expect(cost('fal-gpt-image-2.5', { resolution: '4K', quality: 'max' }).usd).toBeCloseTo(0.2107 * (3840 * 2160) / 2 ** 20, 2)
    expect(cost('fal-recraft-v3').usd).toBe(0.04)
    expect(cost('fal-recraft-v3', { style: 'vector_illustration/line_art' }).usd).toBe(0.08)
    expect(cost('fal-recraft-v4.1-vector').usd).toBe(0.08)
    expect(cost('fal-recraft-v4.1-vector', { pro: true }).usd).toBe(0.3)
    expect(cost('fal-ideogram-v4', { aspectRatio: '1:1' }).usd).toBeCloseTo(0.015) // 1024² balanced
    expect(cost('fal-ideogram-v4', { aspectRatio: '1:1', resolution: '4MP', speed: 'quality' }).usd).toBeCloseTo(0.1)
    expect(cost('fal-krea-2').usd).toBe(0.03)
    expect(cost('fal-krea-2', { tier: 'large', referenceImages: ['asset-a'] }).usd).toBeCloseTo(0.065)
    expect(cost('fal-krea-2', { tier: 'turbo', aspectRatio: '1:1' }).usd).toBeCloseTo(0.008)
    expect(cost('fal-mai-image-2.5').usd).toBe(0.05)
    expect(cost('fal-mmaudio-v2').usd).toBeCloseTo(0.008)
    expect(cost('fal-stable-audio-2.5').usd).toBe(0.2)
    expect(cost('fal-sync-lipsync-v3').usd).toBeNull()
    expect(cost('fal-custom').usd).toBeNull()
  })

  it('reports ElevenLabs usage in characters/credits', () => {
    expect(cost('eleven-multilingual-v2-tts', { text: 'Hello world' })).toMatchObject({
      usd: null,
      detail: '11 characters ≈ 11 ElevenLabs credits',
    })
    expect(cost('eleven-flash-v2.5-tts', { text: 'Hello world' }).detail).toBe('11 characters ≈ 6 ElevenLabs credits')
    expect(cost('eleven-v4-tts', { text: 'x'.repeat(1500) }).detail).toMatch(/^1,500 characters/)
    expect(cost('eleven-dialogue', { lines: [{ voiceId: 'a', text: 'Hi.' }, { voiceId: 'b', text: 'Hello!' }] }).detail).toMatch(/^9 characters/)
  })
})

describe('validation rules', () => {
  it('requires a start frame for an end frame', () => {
    for (const id of ['kling-3.0', 'kling-2.5-turbo', 'fal-veo3.1', 'fal-seedance-2.5', 'fal-wan-3.0', 'fal-ltx-2.5-pro', 'fal-gemini-omni-flash', 'fal-kling-3.0', 'fal-kling-o3', 'fal-kling-o3-4k']) {
      const result = parse(id, { lastFrame: 'asset-b' })
      expect(result.ok, id).toBe(false)
      if (!result.ok) expect(result.message).toMatch(/start frame/)
      expect(parse(id, { firstFrame: 'asset-a', lastFrame: 'asset-b' }).ok, id).toBe(true)
    }
    // MiniMax H3 and Luma Ray 3.2 support end-only keyframes.
    expect(parse('fal-minimax-h3-max', { lastFrame: 'asset-b' }).ok).toBe(true)
    expect(parse('fal-luma-ray-3.2', { lastFrame: 'asset-b' }).ok).toBe(true)
    // Luma image-to-video is 5 s only; Happy Horse takes a start frame or references, not both.
    expect(parse('fal-luma-ray-3.2', { firstFrame: 'asset-a', duration: 10 }).ok).toBe(false)
    expect(parse('fal-luma-ray-3.2', { duration: 10 }).ok).toBe(true)
    expect(parse('fal-happy-horse-1.1', { firstFrame: 'asset-a', referenceImages: ['asset-b'] }).ok).toBe(false)
    expect(parse('fal-veo3.1-extend', {}).ok).toBe(true) // minimal input supplies the clip
    expect(parseParams(byId('fal-veo3.1-extend'), { prompt: 'More' }).ok).toBe(false)
  })

  it('checks Kling elements and shot lists on fal', () => {
    const els = { elementImages: ['a1', 'a2', 'a3', 'b1', 'b2'], elementCounts: [3, 2] }
    const shots = [
      { prompt: 'Wide shot.', duration: 3 },
      { prompt: 'Close-up.', duration: 2 },
    ]
    // Kling 3.0: elements only with a start frame, at most 3, each a front view + 1–3 angles; the shots add up to the clip.
    expect(parse('fal-kling-3.0', { firstFrame: 'kf', ...els, multiPrompt: shots, duration: 5 }).ok).toBe(true)
    const noFrame = parse('fal-kling-3.0', els)
    expect(noFrame.ok).toBe(false)
    if (!noFrame.ok) expect(noFrame.message).toMatch(/start frame/)
    expect(parse('fal-kling-3.0', { firstFrame: 'kf', elementImages: ['a1'], elementCounts: [1] }).ok).toBe(false)
    expect(parse('fal-kling-3.0', { firstFrame: 'kf', elementImages: ['a1', 'a2', 'a3'], elementCounts: [2] }).ok).toBe(false)
    expect(parse('fal-kling-3.0', { firstFrame: 'kf', elementImages: ['a1'] }).ok).toBe(false)
    const four = { elementImages: Array.from({ length: 8 }, (_, i) => `v${i}`), elementCounts: [2, 2, 2, 2] }
    expect(parse('fal-kling-3.0', { firstFrame: 'kf', ...four }).ok).toBe(false)
    const off = parse('fal-kling-3.0', { multiPrompt: shots, duration: 6 })
    expect(off.ok).toBe(false)
    if (!off.ok) expect(off.message).toMatch(/add up/)
    expect(parse('fal-kling-3.0', { multiPrompt: Array.from({ length: 7 }, () => ({ prompt: 'x', duration: 1 })), duration: 7 }).ok).toBe(false)
    expect(parse('fal-kling-3.0', { multiPrompt: [{ prompt: 'x'.repeat(513), duration: 5 }], duration: 5 }).ok).toBe(false)
    expect(parse('fal-kling-3.0', { multiPrompt: [{ prompt: 'x', duration: 0 }, { prompt: 'y', duration: 5 }], duration: 5 }).ok).toBe(false)
    expect(parse('fal-kling-3.0', { negativePrompt: 'blur' }).ok).toBe(true)
    // O3: elements without a frame too; with one at most 3; elements + reference images at most 7.
    expect(parse('fal-kling-o3', els).ok).toBe(true)
    expect(parse('fal-kling-o3', { ...four, referenceImages: ['p1', 'p2', 'p3'] }).ok).toBe(true)
    expect(parse('fal-kling-o3', { ...four, referenceImages: ['p1', 'p2', 'p3', 'p4'] }).ok).toBe(false)
    expect(parse('fal-kling-o3-4k', { ...four, firstFrame: 'kf' }).ok).toBe(false)
    expect(parse('fal-kling-o3-4k', { ...els, firstFrame: 'kf' }).ok).toBe(true)
  })

  it('takes Veo’s reference images without frames, for exactly 8 s', () => {
    for (const id of ['fal-veo3.1', 'fal-veo3.1-fast']) {
      expect(parse(id, { referenceImages: ['a', 'b', 'c'] }).ok, id).toBe(true)
      expect(parse(id, { referenceImages: ['a', 'b', 'c', 'd'] }).ok, id).toBe(false)
      expect(parse(id, { referenceImages: ['a'], firstFrame: 'kf' }).ok, id).toBe(false)
      const short = parse(id, { referenceImages: ['a'], duration: 6 })
      expect(short.ok, id).toBe(false)
      if (!short.ok) expect(short.message).toMatch(/8 s/)
    }
  })

  it('caps image lists and Kling element ids at what the model takes (fitParams)', () => {
    const fitted = fitParams(byId('fal-kling-3.0'), { prompt: 'p', elementImages: Array.from({ length: 20 }, (_, i) => `v${i}`) })
    expect(fitted.elementImages).toHaveLength(12)
    const ids = fitParams(byId('kling-3.0'), { prompt: 'p', elements: ['e1', 'e2', 'e3', 'e4', 'e5'] })
    expect((ids.elements as string[]).length).toBeLessThanOrEqual(byId('kling-3.0').params.find((p) => p.key === 'elements')!.ui.maxItems!)
  })

  it('enforces Kling durations', () => {
    expect(parse('kling-2.5-turbo', { duration: 7 }).ok).toBe(false)
    expect(parse('kling-2.5-turbo', { duration: 10 }).ok).toBe(true)
    expect(parse('kling-3.0', { duration: 15 }).ok).toBe(true)
    expect(parse('kling-3.0', { duration: 16 }).ok).toBe(false)
    expect(parse('kling-3.0', { duration: 2 }).ok).toBe(false)
    expect(parse('kling-2.6', { duration: 12 }).ok).toBe(false)
    expect(parse('kling-3.0', { duration: 7.5 }).ok).toBe(false)
  })

  it('hides params that do not apply', () => {
    const i2v = parse('kling-3.0', { firstFrame: 'asset-a', aspectRatio: '9:16' })
    expect(i2v.ok && 'aspectRatio' in i2v.values).toBe(false)
    const lowRes = parse('kling-2.6', { resolution: '720p', audio: true })
    expect(lowRes.ok && 'audio' in lowRes.values).toBe(false)
    const sfx = parse('eleven-sfx', { durationSeconds: 12 })
    expect(sfx.ok && 'durationSeconds' in sfx.values).toBe(false)
    const fixed = parse('eleven-sfx', { autoDuration: false, durationSeconds: 12 })
    expect(fixed.ok && fixed.values.durationSeconds).toBe(12)
  })

  it('limits dialogue to 2000 characters and 10 voices', () => {
    const long = parse('eleven-dialogue', { lines: [{ voiceId: 'a', text: 'x'.repeat(1200) }, { voiceId: 'b', text: 'y'.repeat(801) }] })
    expect(long.ok).toBe(false)
    if (!long.ok) expect(long.message).toMatch(/2,000/)
    expect(parse('eleven-dialogue', { lines: [{ voiceId: 'a', text: 'x'.repeat(2000) }] }).ok).toBe(true)
    const voices = Array.from({ length: 11 }, (_, i) => ({ voiceId: `v${i}`, text: 'Hi.' }))
    expect(parse('eleven-dialogue', { lines: voices }).ok).toBe(false)
    expect(parse('eleven-dialogue', { lines: [] }).ok).toBe(false)
    expect(parse('eleven-dialogue', { lines: [{ voiceId: '', text: 'Hi' }] }).ok).toBe(false)
    const missing = parseParams(byId('eleven-dialogue'), {})
    expect(missing.ok ? '' : missing.message).toBe('Add at least one line')
  })

  it('limits ElevenLabs text per model and v3 stability to presets', () => {
    expect(parse('eleven-v3-tts', { text: 'x'.repeat(5001) }).ok).toBe(false)
    expect(parse('eleven-v4-tts', { text: 'x'.repeat(10_000) }).ok).toBe(true)
    expect(parse('eleven-v3-tts', { stability: 0.3 }).ok).toBe(false)
    expect(parse('eleven-v3-tts', { stability: 1 }).ok).toBe(true)
    expect(parse('eleven-music', { durationSeconds: 601 }).ok).toBe(false)
    expect(parse('eleven-sfx', { autoDuration: false, durationSeconds: 31 }).ok).toBe(false)
  })

  it('offers Veo extend only for 720p/1080p Veo-made clips that stay within 30 s', () => {
    const veo = (modelId: string, seconds: number, width = 1920, height = 1080) => ({
      kind: 'video',
      durationFlicks: seconds * 705_600_000,
      width,
      height,
      generation: { modelId },
    })
    expect(canExtendWithVeo(veo('fal-veo3.1', 8))).toBe(true)
    expect(canExtendWithVeo(veo('fal-veo3.1', 8, 1080, 1920))).toBe(true) // 9:16
    expect(canExtendWithVeo(veo('fal-veo3.1-extend', 22, 1280, 720))).toBe(true)
    expect(canExtendWithVeo(veo('fal-veo3.1', 8, 3840, 2160))).toBe(false) // 4K input isn't accepted
    expect(canExtendWithVeo(veo('fal-veo3.1-fast', 24))).toBe(false)
    expect(canExtendWithVeo(veo('kling-3.0', 5))).toBe(false)
    expect(canExtendWithVeo({ kind: 'image', generation: { modelId: 'fal-veo3.1' } })).toBe(false)
  })

  it('checks PixVerse prompt bytes, FLUX auto aspect and custom JSON', () => {
    expect(parse('fal-pixverse-v6', { prompt: 'é'.repeat(1100) }).ok).toBe(false)
    expect(parse('fal-pixverse-v6', { prompt: 'e'.repeat(1100) }).ok).toBe(true)
    expect(parse('fal-flux-2-pro', { aspectRatio: 'auto' }).ok).toBe(false)
    expect(parse('fal-flux-2-pro', { aspectRatio: 'auto', referenceImages: ['asset-a'] }).ok).toBe(true)
    expect(parse('fal-ideogram-v4', { aspectRatio: 'auto' }).ok).toBe(false)
    expect(parse('fal-ideogram-v4', { aspectRatio: 'auto', referenceImages: ['asset-a'] }).ok).toBe(true)
    expect(parse('fal-krea-2', { tier: 'turbo', referenceImages: ['asset-a'] }).ok).toBe(false)
    expect(parse('fal-krea-2', { tier: 'large', referenceImages: ['asset-a'] }).ok).toBe(true)
    expect(parse('fal-mai-image-2.5', { referenceImages: ['asset-a', 'asset-b'] }).ok).toBe(false)
    expect(parse('fal-custom', { inputJson: '[1,2]' }).ok).toBe(false)
    expect(parse('fal-custom', { inputJson: '{"image_url": "{{image}}"}' }).ok).toBe(false)
    expect(parse('fal-custom', { inputJson: '{"image_url": "{{image}}"}', image: 'asset-a' }).ok).toBe(true)
    expect(parse('fal-custom', { endpointId: 'not an id' }).ok).toBe(false)
    expect(parse('fal-custom', { outputPath: 'video..url' }).ok).toBe(false)
  })
})
