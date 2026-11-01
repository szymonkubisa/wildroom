import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type OpenRouterImageModel, openRouterModels } from '../../src/shared/models/catalog/openrouter'
import { parseParams } from '../../src/shared/models/params'
import { allModels, getModel } from '../../src/shared/models/registry'
import type { ModelSpec, ParamValues } from '../../src/shared/models/types'
import {
  OPENROUTER_IMAGE_ROUTES,
  OPENROUTER_VIDEO_ROUTES,
  createOpenRouterAdapter,
  describePricing,
  fitImageRequest,
  type GuideHost,
  GUIDE_HOST_MISSING,
  guideSeconds,
  imageRequest,
  parseUploadTarget,
  resetImageCatalogue,
  toImageModel,
} from '../../src/server/providers/openrouter'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { modelFamily } from '../../src/shared/models/workflow'
import { probeFile } from '../../src/server/services/probe'
import { ProviderError, httpError } from '../../src/server/providers/types'
import { runFfmpeg } from '../../src/server/services/ffmpeg'
import { installFetch, jsonResponse, makeCtx, makeFixtures, minimalInput } from './helpers'

const byId = (id: string): ModelSpec => {
  const m = openRouterModels.find((x) => x.id === id)
  if (!m) throw new Error(`no model ${id}`)
  return m
}
const cost = (id: string, input: ParamValues = {}) => {
  const parsed = parseParams(byId(id), { ...minimalInput(byId(id)), ...input })
  if (!parsed.ok) throw new Error(parsed.message)
  return byId(id).estimateCost(parsed.values)
}

/** The catalogue entries the tests use, shaped like GET /api/v1/images/models (checked 2026-10-05). */
const CATALOGUE = {
  data: [
    {
      id: 'openai/gpt-image-2.5-sunburst',
      name: 'OpenAI: GPT Image 2.5 Sunburst',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
      supported_parameters: {
        aspect_ratio: { type: 'enum', values: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9', 'auto'] },
        quality: { type: 'enum', values: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
        background: { type: 'enum', values: ['auto', 'transparent', 'opaque'] },
        n: { type: 'range', min: 1, max: 10 },
        input_references: { type: 'range', min: 0, max: 16 },
      },
    },
    {
      id: 'bytedance-seed/seedream-5-0-flash',
      name: 'ByteDance Seed: Seedream 5.0 Flash',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
      supported_parameters: {
        resolution: { type: 'enum', values: ['1K', '2K'] },
        aspect_ratio: { type: 'enum', values: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', 'auto'] },
        input_references: { type: 'range', min: 0, max: 14 },
        seed: { type: 'boolean' },
      },
    },
    {
      id: 'recraft/recraft-v4.1-vector',
      name: 'Recraft: Recraft V4.1 Vector',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
      supported_parameters: {
        aspect_ratio: { type: 'enum', values: ['1:1', '4:3', '3:4', '16:9', '9:16', 'auto'] },
        output_format: { type: 'enum', values: ['svg'] },
        input_references: { type: 'range', min: 0, max: 1 },
      },
    },
    { id: 'meta/muse-image', name: 'Meta: Muse Image', architecture: { input_modalities: ['text', 'image'] }, supported_parameters: {} },
    { id: 'not a model id' },
  ],
}

const PNG_B64 = Buffer.from('\x89PNG\r\n\x1a\nfake-png', 'latin1').toString('base64')

/** A fake OpenRouter: the image catalogue, then scripted answers to POST /images. */
function fakeOpenRouter(answers: Response[]) {
  return installFetch((call) => {
    if (call.url.endsWith('/images/models')) return jsonResponse(CATALOGUE)
    const next = answers.shift()
    if (!next) throw new Error(`unexpected call ${call.url}`)
    return next
  })
}

const posts = <T extends { url: string }>(calls: T[]) => calls.filter((c) => c.url.endsWith('/api/v1/images'))

beforeEach(() => resetImageCatalogue())
afterEach(() => vi.unstubAllGlobals())

describe('OpenRouter image catalog', () => {
  it('registers every model with a route, unique ids and valid defaults', () => {
    const ofKind = (kind: string) => openRouterModels.filter((m) => m.kind === kind).map((m) => m.id).sort()
    expect(Object.keys(OPENROUTER_IMAGE_ROUTES).sort()).toEqual(ofKind('image'))
    expect(Object.keys(OPENROUTER_VIDEO_ROUTES).sort()).toEqual(ofKind('video'))
    expect(ofKind('image').length + ofKind('video').length).toBe(openRouterModels.length)
    const ids = allModels().map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const m of openRouterModels) {
      expect(m.provider).toBe('openrouter')
      const parsed = parseParams(m, minimalInput(m))
      expect(parsed.ok, `${m.id}: ${parsed.ok ? '' : parsed.message}`).toBe(true)
    }
  })

  it('names twins that exist, with the keys presets set on the original', () => {
    for (const m of openRouterModels.filter((x) => x.twinOf)) {
      const original = getModel(m.twinOf!)
      expect(original, m.id).toBeDefined()
      expect(original?.kind).toBe(m.kind)
      for (const key of ['prompt', 'referenceImages', 'aspectRatio']) {
        if (original?.params.some((p) => p.key === key)) expect(m.params.some((p) => p.key === key), `${m.id} lacks ${key}`).toBe(true)
      }
    }
  })

  it('maps tiers and Pro toggles to sibling OpenRouter models', () => {
    expect(OPENROUTER_IMAGE_ROUTES['or-gpt-image-2.5']!.model({ tier: 'sunburst' })).toBe('openai/gpt-image-2.5-sunburst')
    expect(OPENROUTER_IMAGE_ROUTES['or-gpt-image-2.5']!.model({ tier: 'flare' })).toBe('openai/gpt-image-2.5-flare')
    expect(OPENROUTER_IMAGE_ROUTES['or-recraft-v4.1-vector']!.model({ pro: true })).toBe('recraft/recraft-v4.1-pro-vector')
    expect(OPENROUTER_IMAGE_ROUTES['or-image-any']!.model({ orModel: ' x-ai/grok-imagine-image-2.0 ' })).toBe('x-ai/grok-imagine-image-2.0')
  })

  it('estimates prices from the 2026-10-05 price lists', () => {
    expect(cost('or-seedream-5-pro', { resolution: '2K', referenceImages: ['a', 'b'] }).usd).toBe(0.096)
    expect(cost('or-flux-3', { resolution: '4K' }).usd).toBe(0.607)
    expect(cost('or-grok-imagine-2', { quality: 'low', resolution: '2K' }).usd).toBe(0.06)
    expect(cost('or-recraft-v4.1-vector', { pro: true }).usd).toBe(0.3)
    expect(cost('or-nano-banana-pro', { resolution: '4K' }).usd).toBe(0.24)
    expect(cost('or-image-any').usd).toBeNull()
  })

  it('rejects a malformed model id for "any model"', () => {
    const any = byId('or-image-any')
    expect(parseParams(any, { prompt: 'x', orModel: 'not a model' }).ok).toBe(false)
    expect(parseParams(any, { prompt: 'x', orModel: 'openai/gpt-image-2.5-flare' }).ok).toBe(true)
  })
})

describe('catalogue entries', () => {
  it('reads limits, tiers and formats; text-only and unknown models are told apart', () => {
    const [gpt, seedream, vector, muse] = CATALOGUE.data.map((m) => toImageModel(m)) as OpenRouterImageModel[]
    expect(gpt).toMatchObject({ name: 'GPT Image 2.5 Sunburst', refs: { min: 0, max: 16 }, transparent: true, seed: false, svg: false })
    expect(seedream).toMatchObject({ resolutions: ['1K', '2K'], seed: true, transparent: false })
    expect(vector).toMatchObject({ svg: true, formats: ['svg'], refs: { min: 0, max: 1 } })
    expect(muse).toMatchObject({ refs: { min: 0, max: 16 }, aspects: undefined })
    expect(toImageModel(CATALOGUE.data[4]!)).toBeUndefined()
  })

  it('describes endpoint prices in words', () => {
    expect(
      describePricing([
        { billable: 'output_image', unit: 'image', cost_usd: 0.045 },
        { billable: 'output_image', unit: 'image', cost_usd: 0.09, variant: 'high_resolution' },
        { billable: 'input_image', unit: 'image', cost_usd: 0.003 },
        { billable: 'input_image', unit: 'image', cost_usd: 0 },
        { billable: 'input_text', unit: 'token', cost_usd: 0.000005 },
        { billable: 'output_image', unit: 'token', cost_usd: 0.00003 },
        { billable: 'output_image', unit: 'megapixel', cost_usd: 0.03 },
      ]),
    ).toEqual(['$0.045 per image', '$0.09 per image (high resolution)', '$30 per 1M image tokens', '$0.03 per output megapixel', '$0.003 per input image'])
  })
})

describe('fitting a request to the model', () => {
  const seedream = toImageModel(CATALOGUE.data[1]!)!
  const gpt = toImageModel(CATALOGUE.data[0]!)!

  it('snaps aspect, resolution and quality to the nearest offered; drops what the model lacks', () => {
    const body = imageRequest('bytedance-seed/seedream-5-0-flash', { prompt: 'p', aspectRatio: '21:9', resolution: '4K', quality: 'high', seed: 7 }, [])
    expect(fitImageRequest(body, seedream)).toEqual({ model: 'bytedance-seed/seedream-5-0-flash', prompt: 'p', aspect_ratio: '16:9', resolution: '2K', seed: 7 })
    const gptBody = fitImageRequest(imageRequest('openai/gpt-image-2.5-sunburst', { prompt: 'p', aspectRatio: '5:4', resolution: '1K', quality: 'max', seed: 3 }, []), gpt)
    expect(gptBody).toEqual({ model: 'openai/gpt-image-2.5-sunburst', prompt: 'p', aspect_ratio: '4:3', quality: 'max' })
  })

  it('asks for a PNG with alpha for transparency, and refuses models that can’t', () => {
    const body = imageRequest('openai/gpt-image-2.5-sunburst', { prompt: 'logo', transparent: true }, [])
    expect(fitImageRequest(body, gpt)).toMatchObject({ background: 'transparent', output_format: 'png' })
    expect(() => fitImageRequest({ ...body, model: seedream.id }, seedream)).toThrow(/can’t make transparent backgrounds/)
  })

  it('checks the number of reference images', () => {
    const vector = toImageModel(CATALOGUE.data[2]!)!
    const two = imageRequest(vector.id, { prompt: 'p' }, ['data:image/png;base64,a', 'data:image/png;base64,b'])
    expect(() => fitImageRequest(two, vector)).toThrow(/takes up to 1 reference image$/)
    expect(fitImageRequest(imageRequest(vector.id, { prompt: 'p' }, []), vector).output_format).toBe('svg')
  })
})

describe('OpenRouter image jobs', () => {
  const fx = makeFixtures()
  afterAll(() => fx.cleanup())

  it('sends the Image API request with references inline and returns the image with its real cost', async () => {
    const { calls } = fakeOpenRouter([jsonResponse({ data: [{ b64_json: PNG_B64, media_type: 'image/png' }], usage: { cost: 0.0527 } })])
    const adapter = createOpenRouterAdapter()
    const ref = fx.image('ref1')
    const { ctx, records } = makeCtx(
      byId('or-gpt-image-2.5'),
      { prompt: 'A poster', referenceImages: ['ref1'], tier: 'sunburst', quality: 'high', transparent: true, aspectRatio: '3:4' },
      { inputs: { referenceImages: [ref] }, credentials: { apiKey: 'sk-or-test' } },
    )
    const result = await adapter.submit(ctx)
    const post = posts(calls)[0]!
    expect(post.headers.authorization).toBe('Bearer sk-or-test')
    expect(post.headers['x-title']).toBe('Wildroom')
    expect(post.body).toEqual({
      model: 'openai/gpt-image-2.5-sunburst',
      prompt: 'A poster',
      aspect_ratio: '3:4',
      quality: 'high',
      background: 'transparent',
      output_format: 'png',
      input_references: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('png-bytes-ref1').toString('base64')}` } }],
    })
    expect(JSON.stringify(records[0])).toContain('<base64')
    expect(result.type).toBe('done')
    if (result.type !== 'done') return
    expect(result.costUsd).toBe(0.0527)
    expect(result.outputs).toHaveLength(1)
    expect(result.outputs[0]).toMatchObject({ kind: 'buffer', ext: 'png', meta: { openrouterModel: 'openai/gpt-image-2.5-sunburst' } })
    expect(JSON.stringify(result.response)).not.toContain(PNG_B64)
  })

  it('sends big references as small JPEGs: a ~7 MB body of PNGs was cut off mid-upload (EPIPE)', async () => {
    const { calls } = fakeOpenRouter([jsonResponse({ data: [{ b64_json: PNG_B64, media_type: 'image/png' }] })])
    const path = join(fx.dir, 'noisy.png')
    // Noise doesn't compress: a 2000×1200 PNG of it is several MB, like a generated place photo.
    await runFfmpeg(['-f', 'lavfi', '-i', 'nullsrc=s=2000x1200,geq=random(1)*255:128:128', '-frames:v', '1', path])
    const ref = { assetId: 'big', kind: 'image' as const, path, mime: 'image/png', width: 2000, height: 1200 }
    const { ctx } = makeCtx(byId('or-gpt-image-2.5'), { prompt: 'A lake', referenceImages: ['big'], tier: 'sunburst' }, { inputs: { referenceImages: [ref] }, credentials: { apiKey: 'sk-or-test' } })
    await createOpenRouterAdapter().submit(ctx)
    const url = (posts(calls)[0]!.body as { input_references: { image_url: { url: string } }[] }).input_references[0]!.image_url.url
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(Buffer.from(url.split(',')[1]!, 'base64').length).toBeLessThanOrEqual(700_000)
  })

  it('runs any listed model, fitted to what it takes; vectors come back as SVG', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')
    const { calls } = fakeOpenRouter([
      jsonResponse({ data: [{ b64_json: PNG_B64 }] }),
      jsonResponse({ data: [{ b64_json: svg, media_type: 'image/svg+xml' }], usage: { cost: 0.08 } }),
    ])
    const adapter = createOpenRouterAdapter()
    const any = makeCtx(byId('or-image-any'), { prompt: 'Fox', orModel: 'bytedance-seed/seedream-5-0-flash', resolution: '4K', aspectRatio: '21:9', seed: 5 })
    const first = await adapter.submit(any.ctx)
    expect(posts(calls)[0]!.body).toEqual({ model: 'bytedance-seed/seedream-5-0-flash', prompt: 'Fox', aspect_ratio: '16:9', resolution: '2K', seed: 5 })
    expect(first.type === 'done' && first.outputs[0]).toMatchObject({ ext: 'png', modelLabel: 'Seedream 5.0 Flash' })

    const vector = makeCtx(byId('or-recraft-v4.1-vector'), { prompt: 'Fox logo' })
    const second = await adapter.submit(vector.ctx)
    expect(posts(calls)[1]!.body).toMatchObject({ model: 'recraft/recraft-v4.1-vector', output_format: 'svg', aspect_ratio: '1:1' })
    expect(second.type === 'done' && second.outputs[0]).toMatchObject({ ext: 'svg' })
  })

  it('refuses unknown models and maps failures (failed images are not billed)', async () => {
    const adapter = createOpenRouterAdapter()
    fakeOpenRouter([])
    const unknown = makeCtx(byId('or-image-any'), { prompt: 'x', orModel: 'acme/no-such-model' })
    await expect(adapter.submit(unknown.ctx)).rejects.toThrow(/no image model “acme\/no-such-model”/)

    const run = async (res: Response) => {
      vi.unstubAllGlobals()
      resetImageCatalogue()
      fakeOpenRouter([res])
      try {
        await adapter.submit(makeCtx(byId('or-gpt-image-2.5'), { prompt: 'x', tier: 'sunburst' }).ctx)
      } catch (err) {
        return err instanceof ProviderError ? err.jobError : err
      }
      throw new Error('expected a failure')
    }
    expect(await run(jsonResponse({ error: { message: 'Insufficient credits' } }, 402))).toMatchObject({ code: 'insufficient_credits', maybeCharged: false })
    expect(await run(jsonResponse({}, 413))).toMatchObject({ code: 'invalid_params' })
    expect(await run(jsonResponse({}, 529))).toMatchObject({ code: 'provider', retryable: true, maybeCharged: false })
    expect(await run(jsonResponse({ data: [] }))).toMatchObject({ code: 'provider', message: expect.stringMatching(/returned no image/) })
  })

  it('still sends the request, unfitted, when the catalogue can’t be loaded', async () => {
    const { calls } = installFetch((call) =>
      call.url.endsWith('/images/models') ? jsonResponse({}, 503) : jsonResponse({ data: [{ b64_json: PNG_B64 }] }),
    )
    const result = await createOpenRouterAdapter().submit(makeCtx(byId('or-qwen-image-3-pro'), { prompt: 'x', resolution: '2K' }).ctx)
    expect(result.type).toBe('done')
    expect(posts(calls)[0]!.body).toMatchObject({ model: 'qwen/qwen-image-3-pro', resolution: '2K', aspect_ratio: '16:9' })
  })
})

describe('OpenRouter video: Seedance 2.5', () => {
  const fx = makeFixtures()
  afterAll(() => fx.cleanup())
  const seedance = () => byId('or-seedance-2.5')
  const parse = (input: ParamValues) => parseParams(seedance(), { prompt: 'p', ...input })
  const accepted = jsonResponse({ id: 'gen-vid-123', polling_url: 'https://openrouter.ai/api/v1/videos/gen-vid-123', status: 'pending' }, 202)
  const videoPosts = <T extends { url: string; method: string }>(calls: T[]) => calls.filter((c) => c.url.endsWith('/api/v1/videos') && c.method === 'POST')

  it('is a Seedance-family video model, the twin of fal’s, routed to bytedance/seedance-2.5', () => {
    expect(seedance()).toMatchObject({ kind: 'video', provider: 'openrouter', twinOf: 'fal-seedance-2.5' })
    expect(modelFamily(seedance())).toBe('seedance')
    expect(OPENROUTER_VIDEO_ROUTES['or-seedance-2.5']!.model).toBe('bytedance/seedance-2.5')
    expect(parseParams(seedance(), { prompt: 'p' })).toMatchObject({ ok: true, values: { duration: 5, resolution: '720p', aspectRatio: '16:9', audio: true } })
    expect(parse({ resolution: '1080p' }).ok).toBe(false)
    expect(parse({ duration: 3 }).ok).toBe(false)
    expect(parse({ duration: 31 }).ok).toBe(false)
  })

  it('estimates from OpenRouter’s token prices, cheaper with a reference video (2026-10-26)', () => {
    expect(cost('or-seedance-2.5').usd).toBe(1.1556) // 720p 5 s: $0.2311/s
    expect(cost('or-seedance-2.5', { resolution: '480p', duration: 10 }).usd).toBe(1.028) // $0.1028/s
    // With video input: $0.1382/s (720p) or $0.0615/s (480p), over the clip's seconds and the guide's.
    expect(cost('or-seedance-2.5', { guideVideo: 'g' }).usd).toBe(1.3824)
    expect(cost('or-seedance-2.5', { resolution: '480p', duration: 4, guideVideo: 'g' }).usd).toBe(0.4919) // billed $0.494 live
    expect(cost('or-seedance-2.5').asOf).toBe('2026-10-26')
  })

  it('refuses a camera guide with an end frame, and references with frames unless a guide makes the keyframe one', () => {
    expect(parse({ firstFrame: 'k', lastFrame: 'e', guideVideo: 'g' })).toMatchObject({ ok: false, message: expect.stringMatching(/camera guide and an end frame/) })
    expect(parse({ lastFrame: 'e' })).toMatchObject({ ok: false, message: 'An end frame needs a start frame' })
    expect(parse({ firstFrame: 'k', referenceImages: ['r'] })).toMatchObject({ ok: false, message: expect.stringMatching(/not both/) })
    expect(parse({ firstFrame: 'k', referenceImages: ['r'], guideVideo: 'g' }).ok).toBe(true)
    expect(parse({ firstFrame: 'k', referenceImages: Array.from({ length: 9 }, (_, i) => `r${i}`), guideVideo: 'g' }).ok).toBe(false)
    // The aspect stays with a guide (the keyframe is only a reference then); a start frame alone sets the shape.
    expect(parse({ firstFrame: 'k', guideVideo: 'g', aspectRatio: '9:16' })).toMatchObject({ ok: true, values: { aspectRatio: '9:16' } })
    const alone = parse({ firstFrame: 'k', aspectRatio: '9:16' })
    expect(alone.ok).toBe(true)
    expect(alone.ok && alone.values).not.toHaveProperty('aspectRatio')
  })

  it('keeps the clip’s length as asked (and priced) with a guide, in whole seconds within 4–30', () => {
    // The length asked for (and priced), not the guide's: a 20 s previs on a 5 s clip bills 5 + 5 s.
    expect(guideSeconds(5)).toBe(5)
    expect(guideSeconds(2)).toBe(4)
    expect(guideSeconds(41)).toBe(30)
  })

  it('submits a plain prompt as text-to-video and returns the job id to poll', async () => {
    const { calls } = installFetch(() => accepted.clone())
    const { ctx } = makeCtx(seedance(), { prompt: 'A lighthouse at dusk', seed: 42 }, { credentials: { apiKey: 'sk-or-test' } })
    const result = await createOpenRouterAdapter().submit(ctx)
    expect(result).toEqual({ type: 'async', taskId: 'gen-vid-123', meta: { openrouterModel: 'bytedance/seedance-2.5', seconds: 5 } })
    const post = videoPosts(calls)[0]!
    expect(post.headers.authorization).toBe('Bearer sk-or-test')
    expect(post.body).toEqual({
      model: 'bytedance/seedance-2.5',
      prompt: 'A lighthouse at dusk',
      duration: 5,
      resolution: '720p',
      aspect_ratio: '16:9',
      generate_audio: true,
      seed: 42,
    })
  })

  it('sends start and end frames as frame_images (image-to-video)', async () => {
    const { calls } = installFetch(() => accepted.clone())
    const first = fx.image('kf-start')
    const last = fx.image('kf-end')
    const { ctx } = makeCtx(seedance(), { prompt: 'She turns', firstFrame: 'kf-start', lastFrame: 'kf-end', duration: 8, resolution: '480p', audio: false }, { inputs: { firstFrame: first, lastFrame: last } })
    await createOpenRouterAdapter().submit(ctx)
    const url = (id: string) => `data:image/png;base64,${Buffer.from(`png-bytes-${id}`).toString('base64')}`
    expect(videoPosts(calls)[0]!.body).toEqual({
      model: 'bytedance/seedance-2.5',
      prompt: 'She turns',
      duration: 8,
      resolution: '480p',
      generate_audio: false,
      frame_images: [
        { type: 'image_url', image_url: { url: url('kf-start') }, frame_type: 'first_frame' },
        { type: 'image_url', image_url: { url: url('kf-end') }, frame_type: 'last_frame' },
      ],
    })
  })

  /** A guide host that keeps the uploaded file and records removals. */
  const fakeHost = () => {
    const removed: string[] = []
    const kept: { file?: string } = {}
    const host: GuideHost = {
      async put(file) {
        kept.file = join(fx.dir, 'sent.mp4')
        writeFileSync(kept.file, readFileSync(file))
        return { url: 'https://media.example/wildroom-tmp/wildroom-guide-0123456789abcdef01234567.mp4', key: 'wildroom-guide-0123456789abcdef01234567.mp4' }
      },
      async remove(key) {
        removed.push(key)
      },
    }
    return { host, removed, kept }
  }

  it('with a camera guide: the keyframe as the first reference image, the previs hosted at an https URL at 720p, cut to the clip’s length', async () => {
    const { calls } = installFetch(() => accepted.clone())
    const { host, removed, kept } = fakeHost()
    const path = join(fx.dir, 'previs.mp4')
    // 6.4 s of a 1440×810 test pattern with sound: re-encoded to 1280×720, cut to the clip’s 5 s at 24 fps, no audio.
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=s=1440x810:r=10:d=6.4', '-f', 'lavfi', '-i', 'sine=d=6.4', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path])
    const guide = { assetId: 'layout', kind: 'video' as const, path, mime: 'video/mp4', width: 1440, height: 810, durationSeconds: 6.4 }
    const keyframe = fx.image('kf3')
    const { ctx, records } = makeCtx(
      seedance(),
      { prompt: 'Maja checks her phone and sighs.', firstFrame: 'kf3', guideVideo: 'layout', guideKind: 'layout', duration: 5, aspectRatio: '16:9', resolution: '480p' },
      { inputs: { firstFrame: keyframe, guideVideo: guide } },
    )
    const result = await createOpenRouterAdapter(fetch, { guideHost: () => host }).submit(ctx)
    expect(result).toMatchObject({ type: 'async', meta: { seconds: 5, guideKey: 'wildroom-guide-0123456789abcdef01234567.mp4' } })
    expect(removed).toEqual([])
    const body = videoPosts(calls)[0]!.body as Record<string, unknown> & { input_references: { type: string; video_url?: { url: string } }[] }
    expect(body).not.toHaveProperty('frame_images')
    expect(body).toMatchObject({
      model: 'bytedance/seedance-2.5',
      duration: 5,
      resolution: '480p',
      aspect_ratio: '16:9',
      generate_audio: true,
      prompt: expect.stringMatching(/^Maja checks her phone and sighs\.\n\nStart from @Image1: .* Follow @Video1 only for the camera move/s),
    })
    expect(body.input_references.map((r) => r.type)).toEqual(['image_url', 'video_url'])
    expect(body.input_references[0]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('png-bytes-kf3').toString('base64')}` } })
    expect(body.input_references[1]).toEqual({ type: 'video_url', video_url: { url: 'https://media.example/wildroom-tmp/wildroom-guide-0123456789abcdef01234567.mp4' } })
    // Even for a 480p clip the guide is 720p: Seedance refuses reference videos under 407,696 pixels a frame.
    const info = await probeFile(kept.file!)
    expect(info).toMatchObject({ width: 1280, height: 720 })
    expect(info.hasAudio).toBe(false)
    expect(info.durationSeconds).toBeCloseTo(5, 1)
    expect(JSON.stringify(records[0])).toContain('https://media.example/wildroom-tmp/')
  })

  it('a small guide is scaled up to 720p, and a portrait one to 720 wide', async () => {
    installFetch(() => accepted.clone())
    for (const [w, h, ow, oh] of [[640, 360, 1280, 720], [360, 640, 720, 1280]] as const) {
      const path = join(fx.dir, `small-${w}.mp4`)
      await runFfmpeg(['-y', '-f', 'lavfi', '-i', `testsrc=s=${w}x${h}:r=24:d=4`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path])
      const { host, kept } = fakeHost()
      const { ctx } = makeCtx(seedance(), { prompt: 'x', guideVideo: 'g' }, { inputs: { guideVideo: { assetId: 'g', kind: 'video', path, mime: 'video/mp4', width: w, height: h, durationSeconds: 4 } } })
      await createOpenRouterAdapter(fetch, { guideHost: () => host }).submit(ctx)
      expect(await probeFile(kept.file!)).toMatchObject({ width: ow, height: oh })
    }
  })

  it('refuses a camera guide when no upload folder is set, and takes the hosted guide back when the request fails', async () => {
    installFetch(() => accepted.clone())
    const { ctx } = makeCtx(seedance(), { prompt: 'x', guideVideo: 'g' }, { inputs: { guideVideo: fx.video('g') } })
    await expect(createOpenRouterAdapter(fetch, { guideHost: () => undefined }).submit(ctx)).rejects.toMatchObject({ jobError: { code: 'invalid_params', message: GUIDE_HOST_MISSING } })

    installFetch(() => jsonResponse({ error: { message: 'Only HTTPS URLs are allowed' } }, 400))
    const path = join(fx.dir, 'g4.mp4')
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=s=1280x720:r=24:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path])
    const { host, removed } = fakeHost()
    const failing = makeCtx(seedance(), { prompt: 'x', guideVideo: 'g' }, { inputs: { guideVideo: { assetId: 'g', kind: 'video', path, mime: 'video/mp4', durationSeconds: 4 } } }).ctx
    await expect(createOpenRouterAdapter(fetch, { guideHost: () => host }).submit(failing)).rejects.toBeInstanceOf(ProviderError)
    expect(removed).toEqual(['wildroom-guide-0123456789abcdef01234567.mp4'])
  })

  it('removes the hosted guide once the job is done or failed, not while it runs', async () => {
    const answers = [jsonResponse({ id: 'gen-vid-9', status: 'in_progress' }), jsonResponse({ id: 'gen-vid-9', status: 'failed', error: 'boom' })]
    installFetch(() => answers.shift()!)
    const { host, removed } = fakeHost()
    const adapter = createOpenRouterAdapter(fetch, { guideHost: () => host })
    const { ctx } = makeCtx(seedance(), { prompt: 'x' }, { providerTaskId: 'gen-vid-9', providerMeta: { guideKey: 'wildroom-guide-0123456789abcdef01234567.mp4' } })
    expect(await adapter.poll!(ctx)).toMatchObject({ type: 'running' })
    expect(removed).toEqual([])
    expect(await adapter.poll!(ctx)).toMatchObject({ type: 'failed' })
    expect(removed).toEqual(['wildroom-guide-0123456789abcdef01234567.mp4'])
  })

  it('reads the upload folder as user@host:/dir and its https address, refusing anything else', () => {
    expect(parseUploadTarget('root@hardlite.example:/var/www/wildroom-tmp/', 'https://hardlite.example/wildroom-tmp')).toEqual({
      host: 'root@hardlite.example',
      dir: '/var/www/wildroom-tmp',
      baseUrl: 'https://hardlite.example/wildroom-tmp/',
    })
    expect(parseUploadTarget('host:/srv/x', 'https://h.example/x/')).toMatchObject({ host: 'host', dir: '/srv/x' })
    expect(parseUploadTarget('root@host:relative', 'https://h/')).toMatch(/user@host:/)
    expect(parseUploadTarget("root@host:/x'; rm -rf /", 'https://h/')).toMatch(/user@host:/)
    expect(parseUploadTarget('root@host:/x', 'http://h/x/')).toMatch(/https URL/)
    expect(parseUploadTarget('-Fx:/dir', 'https://h/')).toMatch(/user@host:/)
    expect(parseUploadTarget('-oProxyCommand=x@h:/dir', 'https://h/')).toMatch(/user@host:/)
  })

  it('takes the guide off the host when a job is canceled or ends without its result', async () => {
    const { host, removed } = fakeHost()
    const ctx = makeCtx(seedance(), { prompt: 'x' }, { providerMeta: { guideKey: 'wildroom-guide-0123456789abcdef01234567.mp4' } }).ctx
    const adapter = createOpenRouterAdapter(fetch, { guideHost: () => host })
    await adapter.cancel!(ctx)
    await adapter.release!(ctx)
    expect(removed).toEqual(['wildroom-guide-0123456789abcdef01234567.mp4', 'wildroom-guide-0123456789abcdef01234567.mp4'])
  })

  it('refuses a guide with an end frame at the adapter too', async () => {
    installFetch(() => accepted.clone())
    const ctx = makeCtx(seedance(), { prompt: 'x' }).ctx
    ctx.params = { ...ctx.params, firstFrame: 'k', lastFrame: 'e', guideVideo: 'g' }
    ctx.inputs = { firstFrame: fx.image('k'), lastFrame: fx.image('e'), guideVideo: fx.video('g') }
    await expect(createOpenRouterAdapter().submit(ctx)).rejects.toMatchObject({ jobError: { code: 'invalid_params', message: expect.stringMatching(/end frame/) } })
  })

  it('polls the job: queued and rendering keep running; done downloads with the key and records the real cost', async () => {
    const answers = [
      jsonResponse({ id: 'gen-vid-123', status: 'pending' }),
      jsonResponse({ id: 'gen-vid-123', status: 'in_progress' }),
      jsonResponse({
        id: 'gen-vid-123',
        status: 'completed',
        unsigned_urls: ['https://openrouter.ai/api/v1/videos/gen-vid-123/content?index=0'],
        urls: ['https://storage.example/signed?token=secret'],
        usage: { cost: 0.6912 },
      }),
    ]
    const { calls } = installFetch(() => answers.shift()!)
    const adapter = createOpenRouterAdapter()
    const { ctx } = makeCtx(seedance(), { prompt: 'x' }, { providerTaskId: 'gen-vid-123', credentials: { apiKey: 'sk-or-test' } })
    expect(await adapter.poll!(ctx)).toMatchObject({ type: 'running' })
    expect(await adapter.poll!(ctx)).toMatchObject({ type: 'running' })
    const done = await adapter.poll!(ctx)
    expect(calls[0]).toMatchObject({ url: 'https://openrouter.ai/api/v1/videos/gen-vid-123', method: 'GET', headers: { authorization: 'Bearer sk-or-test' } })
    expect(done).toMatchObject({
      type: 'done',
      costUsd: 0.6912,
      outputs: [{ kind: 'url', url: 'https://openrouter.ai/api/v1/videos/gen-vid-123/content?index=0', ext: 'mp4', headers: { Authorization: 'Bearer sk-or-test' } }],
    })
    expect(JSON.stringify(done)).not.toContain('token=secret')
  })

  it('maps failed, cancelled and expired jobs to errors that cost nothing; a 404 right after submitting keeps polling', async () => {
    const poll = async (res: Response) => {
      vi.unstubAllGlobals()
      installFetch(() => res)
      const { ctx } = makeCtx(seedance(), { prompt: 'x' }, { providerTaskId: 'gen-vid-9' })
      return createOpenRouterAdapter().poll!(ctx)
    }
    expect(await poll(jsonResponse({ status: 'failed', error: 'The output was flagged by content moderation' }))).toMatchObject({
      type: 'failed',
      error: { code: 'moderation', maybeCharged: false },
    })
    expect(await poll(jsonResponse({ status: 'failed', error: { message: 'Internal render error' } }))).toMatchObject({
      type: 'failed',
      error: { code: 'provider', message: 'OpenRouter: Internal render error', retryable: true, maybeCharged: false },
    })
    expect(await poll(jsonResponse({ status: 'expired' }))).toMatchObject({ type: 'failed', error: { message: 'OpenRouter: the job was expired', maybeCharged: false } })
    await expect(poll(jsonResponse({ error: { message: 'Not found' } }, 404))).rejects.toMatchObject({ jobError: { retryable: true } })
  })
})

describe('httpError', () => {
  const code = (status: number, body: unknown) => httpError(status, typeof body === 'string' ? body : JSON.stringify(body), 'OpenRouter').jobError
  it('blames the key only for 401 or an auth-sounding 403', () => {
    expect(code(401, { error: { message: 'No auth credentials found' } }).code).toBe('auth')
    expect(code(403, { error: { message: 'Invalid API key' } }).code).toBe('auth')
    expect(code(403, 'Forbidden').code).toBe('auth')
  })
  it('keeps moderation and spend limits apart from a bad key', () => {
    expect(code(403, { error: { message: 'Your input was flagged by moderation' } })).toMatchObject({ code: 'moderation' })
    const capped = code(403, { error: { message: 'Key limit exceeded (total limit)' } })
    expect(capped).toMatchObject({ code: 'provider' })
    expect(capped.message).toBe('OpenRouter refused the request: Key limit exceeded (total limit)')
  })
})
