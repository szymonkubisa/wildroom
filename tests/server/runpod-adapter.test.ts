import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseParams } from '../../src/shared/models/params'
import { getModel } from '../../src/shared/models/registry'
import { runpodEstimateSeconds, runpodOutputSize, runpodSize } from '../../src/shared/models/catalog/runpod'
import { createRunpodAdapter } from '../../src/server/providers/runpod/adapter'
import type { ComfyClient } from '../../src/server/providers/runpod/comfy'
import { type ApiGraph, DETAIL_LORA, DETAIL_PROMPT, GUIDE_LORAS, MODEL_FILES, MSR_LORA, buildCoreGraph, buildUpscaleGraph, danglingLinks, guideFrameIndices } from '../../src/server/providers/runpod/graph'
import type { GpuSession } from '../../src/server/providers/runpod/session'
import { runFfmpeg } from '../../src/server/services/ffmpeg'
import { makeCtx, makeFixtures } from '../providers/helpers'

const fixtures = makeFixtures()
afterAll(() => fixtures.cleanup())

const base = { prompt: 'a rainy street', fps: 24, seconds: 5, width: 1920, height: 1088, seed: 7, audio: true, precision: 'bf16' as const, prefix: 'wildroom/gen1' }

describe('LTX-2.5 graph', () => {
  it('builds text-to-video without the image branch and with every value in place', () => {
    const g = buildCoreGraph(base)
    expect(danglingLinks(g)).toEqual([])
    expect(g['2004']).toBeUndefined()
    expect(g['5508']!.inputs.value).toBe('a rainy street')
    expect(g['5514:3059']!.inputs).toMatchObject({ width: 960, height: 544 })
    expect(g['5516:4832']!.inputs.noise_seed).toBe(7)
    expect(g['5517:4967']!.inputs.noise_seed).toBe(7)
    expect(g['4852']!.inputs.filename_prefix).toBe('wildroom/gen1')
    expect(g['5575:5569']!.inputs.unet_name).toBe(MODEL_FILES.bf16.unet)
    // No prompt enhancer, LTX API or preview branches: only local models the volume has.
    const classes = Object.values(g).map((n) => n.class_type)
    expect(classes).not.toContain('TextGenerateLTX2Prompt')
    expect(classes).not.toContain('GemmaAPITextEncode')
    expect(classes).not.toContain('PreviewAny')
  })

  it('keeps the image branch for image-to-video, switches weights for int8 cards and can drop the audio', () => {
    const g = buildCoreGraph({ ...base, image: 'studio_gen1.png', precision: 'int8', audio: false })
    expect(danglingLinks(g)).toEqual([])
    expect(g['2004']!.inputs.image).toBe('studio_gen1.png')
    expect(g['5014:5506']!.inputs.value).toBe(true)
    expect(g['5575:5569']!.inputs.unet_name).toBe(MODEL_FILES.int8.unet)
    expect(g['5575:5574']!.inputs.clip_name).toBe(MODEL_FILES.int8.textEncoder)
    expect(g['5518:4849']!.inputs.audio).toBeUndefined()
  })

  it('adds the 4K detail pass on the 1080p result, guided by its frames, with the look-only prompt', () => {
    const g = buildCoreGraph({ ...base, prompt: 'a red car', upscale4k: true })
    expect(danglingLinks(g)).toEqual([])
    // The saved video is made of the 4K frames, with the 1080p render's audio.
    expect(g['4852']!.inputs.video).toEqual(['5518:4849', 0])
    expect(g['5518:4849']!.inputs).toMatchObject({ images: ['6011', 0], audio: ['5518:4848', 0] })
    // The final 1080p latent ×2, refined by the tiled fusion sampler with the Refine-Details IC-LoRA.
    expect(g['6002']!.inputs.samples).toEqual(['5517:4973', 0])
    expect(g['6001']!.inputs).toMatchObject({ lora_name: DETAIL_LORA, model: ['5575:5569', 0] })
    expect(g['6010']!.inputs).toMatchObject({ model: ['6001', 0], seed: 7, latents: ['6007', 2] })
    expect(g['6006']!.inputs).toMatchObject({ image: ['5518:5538', 0], width: 3840, height: 2176 })
    // The user's prompt names objects: it would stamp into every tile, so the pass uses Lightricks' look prompt.
    expect(g['6003']!.inputs.text).toBe(DETAIL_PROMPT)
    expect(buildCoreGraph({ ...base, upscale4k: true, audio: false })['5518:4849']!.inputs.audio).toBeUndefined()
    expect(buildCoreGraph(base)['6001']).toBeUndefined()
  })

  const nodes = (g: ApiGraph, type: string) => Object.entries(g).filter(([, n]) => n.class_type === type)

  it('guides an end frame and frames in between in both stages, then crops the guides before upscaling and decoding', () => {
    const g = buildCoreGraph({ ...base, image: 'start.png', lastImage: 'end.png', midImages: ['a.png', 'b.png'] })
    expect(danglingLinks(g)).toEqual([])
    const guides = nodes(g, 'LTXVAddGuide')
    // 3 stills per stage: the middle ones spread evenly over 121 frames, the end frame on the last one.
    expect(guides.map(([, n]) => n.inputs.frame_idx)).toEqual([40, 80, -1, 40, 80, -1])
    expect(guides.map(([, n]) => n.inputs.strength)).toEqual([0.7, 0.7, 0.7, 1, 1, 1])
    // The first stage's stills are half size, the refine's full size.
    const scales = nodes(g, 'ImageScale').map(([, n]) => [n.inputs.width, n.inputs.height])
    expect(scales).toEqual([[960, 544], [960, 544], [960, 544], [1920, 1088], [1920, 1088], [1920, 1088]])
    // The start frame stays in place; the stage inputs chain through the guides.
    expect(guides[0]![1].inputs.latent).toEqual(['5514:3159', 0])
    expect(guides[3]![1].inputs.latent).toEqual(['5517:4970', 0])
    const [crop1, crop2] = nodes(g, 'LTXVCropGuides')
    expect(g['5517:4975']!.inputs.samples).toEqual([crop1![0], 2])
    expect(g['5518:5538']!.inputs.samples).toEqual([crop2![0], 2])
    expect(g['5516:4828']!.inputs.positive).toEqual([guides[2]![0], 0])
  })

  it('keeps up to 4 references and a location with Licon MSR, plus the voices of the first two', () => {
    const g = buildCoreGraph({ ...base, references: ['p1.png', 'p2.png'], background: 'room.png', voices: ['v1.wav', undefined] })
    expect(danglingLinks(g)).toEqual([])
    const [[loader]] = nodes(g, 'ComfyUILTX25MSRICLoRALoader') as [[string, unknown]]
    expect(g[loader]!.inputs).toMatchObject({ lora_name: MSR_LORA, model: ['5575:5569', 0] })
    expect(g['5516:4828']!.inputs.model).toEqual([loader, 0])
    expect(g['5517:4964']!.inputs.model).toEqual([loader, 0])
    const guides = nodes(g, 'ComfyUILTX25MSRMultiReferenceGuide')
    expect(guides).toHaveLength(2)
    for (const [, guide] of guides) {
      expect(Object.keys(guide.inputs)).toEqual(expect.arrayContaining(['pic1', 'pic2', 'background', 'audio_ref1', 'msr_parameters']))
      expect(guide.inputs.pic3).toBeUndefined()
      expect(guide.inputs.audio_ref2).toBeUndefined()
    }
    expect(nodes(g, 'LTXVCropGuides')).toHaveLength(2)
    // A lone location is the first reference.
    const lone = buildCoreGraph({ ...base, background: 'room.png' })
    const [[, guide]] = nodes(lone, 'ComfyUILTX25MSRMultiReferenceGuide') as [[string, ApiGraph[string]]]
    expect(guide.inputs.pic1).toBeDefined()
    expect(guide.inputs.background).toBeUndefined()
  })

  it('makes the video to given audio: kept (not denoised) in both stages and used as the clip sound', () => {
    const g = buildCoreGraph({ ...base, audioFile: 'song.mp3' })
    expect(danglingLinks(g)).toEqual([])
    const [[masked]] = nodes(g, 'SetLatentNoiseMask') as [[string, unknown]]
    expect(g['5514:4528']!.inputs.audio_latent).toEqual([masked, 0])
    expect(g['5517:4969']!.inputs.audio_latent).toEqual([masked, 0])
    const [[trim, trimNode]] = nodes(g, 'TrimAudioDuration') as [[string, ApiGraph[string]]]
    expect(trimNode.inputs).toMatchObject({ start_index: 0, duration: 121 / 24 })
    expect(g['5518:4849']!.inputs.audio).toEqual([trim, 0])
    expect(nodes(g, 'SolidMask')[0]![1].inputs.value).toBe(0)
  })

  it('continues a clip: its ending leads in, then is cut from the picture and the sound', () => {
    const g = buildCoreGraph({ ...base, continueClip: 'tail.mp4' })
    expect(danglingLinks(g)).toEqual([])
    // 5 s delivered + 25 lead-in frames rendered: 145 frames.
    expect(g['5512']!.inputs.value).toBeCloseTo(5 + 25 / 24)
    const guides = nodes(g, 'LTXVAddGuide')
    expect(guides.map(([, n]) => n.inputs.frame_idx)).toEqual([0, 0])
    expect(nodes(g, 'LTXVPreprocess')).toHaveLength(0)
    const [[cut, cutNode]] = nodes(g, 'ImageFromBatch') as [[string, ApiGraph[string]]]
    expect(cutNode.inputs).toMatchObject({ batch_index: 25, length: 120, image: ['5518:5538', 0] })
    expect(g['5518:4849']!.inputs.images).toEqual([cut, 0])
    const [[trim, trimNode]] = nodes(g, 'TrimAudioDuration') as [[string, ApiGraph[string]]]
    expect(trimNode.inputs).toMatchObject({ audio: ['5518:4848', 0], start_index: 25 / 24, duration: 5 })
    expect(g['5518:4849']!.inputs.audio).toEqual([trim, 0])
    // With 4K, the cut applies to the 4K frames.
    const big = buildCoreGraph({ ...base, continueClip: 'tail.mp4', upscale4k: true })
    expect(nodes(big, 'ImageFromBatch')[0]![1].inputs.image).toEqual(['6011', 0])
    expect(guideFrameIndices(121, 2, 25)).toEqual([57, 88])
  })

  it('follows a grey-box camera guide in both stages with Layout-To-Render, on top of MSR, and crops it', () => {
    const g = buildCoreGraph({ ...base, image: 'start.png', references: ['a.png'], guide: { video: 'guide.mp4', kind: 'layout', strength: 0.9 } })
    expect(danglingLinks(g)).toEqual([])
    const [[lora, loraNode]] = nodes(g, 'LTXICLoRALoaderModelOnly') as [[string, ApiGraph[string]]]
    expect(loraNode.inputs.lora_name).toBe(GUIDE_LORAS.layout)
    // Chained after MSR, and both stages sample with it.
    const [[msr]] = nodes(g, 'ComfyUILTX25MSRICLoRALoader') as [[string, ApiGraph[string]]]
    expect(loraNode.inputs.model).toEqual([msr, 0])
    expect(g['5516:4828']!.inputs.model).toEqual([lora, 0])
    expect(g['5517:4964']!.inputs.model).toEqual([lora, 0])
    // Per stage: the layout at frame 0, then the start frame as the look still just before the clip (frame -1).
    const guides = nodes(g, 'LTXAddVideoICLoRAGuide')
    expect(guides.map(([, n]) => [n.inputs.frame_idx, n.inputs.strength, n.inputs.crop])).toEqual([
      [0, 0.9, 'disabled'],
      [-1, 1, 'center'],
      [0, 0.9, 'disabled'],
      [-1, 1, 'center'],
    ])
    for (const [, n] of guides) expect(n.inputs.latent_downscale_factor).toEqual([lora, 1])
    expect(nodes(g, 'LoadVideo')[0]![1].inputs.file).toBe('guide.mp4')
    // Never pinned in place (Lightricks' workflow): the camera would stay where the picture was taken.
    expect(g['2004']).toBeUndefined()
    expect(nodes(g, 'LoadImage').map(([, n]) => n.inputs.image)).toContain('start.png')
    expect(nodes(g, 'LTXVCropGuides')).toHaveLength(2)
  })

  it('follows a depth guide with Union Control in the first stage only, at sizes whose half-size latent halves', () => {
    // 1080p with a depth guide is 1920×1024 (runpodSize's 128-px steps): stage 1 is 960×512, 30×16 latents.
    expect(runpodSize({ resolution: '1080p', aspectRatio: '16:9', guideVideo: 'd', guideKind: 'depth' })).toEqual({ width: 1920, height: 1024 })
    expect(runpodSize({ resolution: '720p', aspectRatio: '16:9', guideVideo: 'd', guideKind: 'depth' })).toEqual({ width: 1280, height: 768 })
    // 640×352 (20×11 latents) failed live on the GPU: refused before it is sent.
    expect(() => buildCoreGraph({ ...base, width: 1280, height: 704, guide: { video: 'depth.mp4', kind: 'depth', strength: 1 } })).toThrow(/steps of 128/)
    const g = buildCoreGraph({ ...base, width: 1920, height: 1024, guide: { video: 'depth.mp4', kind: 'depth', strength: 1 } })
    expect(danglingLinks(g)).toEqual([])
    const [[lora, loraNode]] = nodes(g, 'LTXICLoRALoaderModelOnly') as [[string, ApiGraph[string]]]
    expect(loraNode.inputs).toMatchObject({ lora_name: GUIDE_LORAS.depth, model: ['5575:5569', 0] })
    expect(g['5516:4828']!.inputs.model).toEqual([lora, 0])
    expect(g['5517:4964']!.inputs.model).toEqual(['5575:5569', 0])
    const guides = nodes(g, 'LTXAddVideoICLoRAGuide')
    expect(guides).toHaveLength(1)
    // The guide goes in at the first stage's size.
    expect(g[(guides[0]![1].inputs.image as [string, number])[0]]!.inputs).toMatchObject({ width: 960, height: 512 })
    expect(nodes(g, 'LTXVCropGuides')).toHaveLength(1)
  })

  it('sizes renders on the 64 px grid and estimates from the measured times', () => {
    expect(runpodSize({ resolution: '1080p', aspectRatio: '16:9' })).toEqual({ width: 1920, height: 1088 })
    expect(runpodSize({ resolution: '720p', aspectRatio: '16:9' })).toEqual({ width: 1280, height: 704 })
    expect(runpodSize({ resolution: '1080p' }, { width: 1080, height: 1920 })).toEqual({ width: 1088, height: 1920 })
    expect(runpodEstimateSeconds(1280, 704, 5)).toBeCloseTo(32, -1)
    expect(runpodEstimateSeconds(1920, 1088, 5)).toBeGreaterThan(55)
    expect(runpodEstimateSeconds(1920, 1088, 10)).toBeGreaterThan(140)
    // 4K: generated at 1080p, delivered at twice the size, several times longer.
    expect(runpodSize({ resolution: '4K', aspectRatio: '16:9' })).toEqual({ width: 1920, height: 1088 })
    expect(runpodOutputSize({ resolution: '4K', aspectRatio: '16:9' })).toEqual({ width: 3840, height: 2176 })
    expect(runpodOutputSize({ resolution: '4K' }, { width: 1080, height: 1920 })).toEqual({ width: 2176, height: 3840 })
    expect(runpodEstimateSeconds(1920, 1088, 5, 24, { upscale4k: true })).toBeGreaterThan(4 * runpodEstimateSeconds(1920, 1088, 5))
  })
})

describe('LTX upscale graph', () => {
  it('encodes the source at half size, upscales the latent ×2 and refines it with Refine-Details, guided by the source at full size', () => {
    const g = buildUpscaleGraph({ video: 'src.mp4', frames: 97, fps: 24, width: 1920, height: 1088, seed: 5, audio: true, precision: 'int8', prefix: 'wildroom/u1' })
    expect(danglingLinks(g)).toEqual([])
    const byClass = (c: string) => Object.entries(g).filter(([, n]) => n.class_type === c)
    expect(g['1']!.inputs.unet_name).toBe(MODEL_FILES.int8.unet)
    expect(byClass('ImageFromBatch')[0]![1].inputs).toMatchObject({ length: 97 })
    expect(byClass('ImageScale').map(([, n]) => [n.inputs.width, n.inputs.height])).toEqual([
      [960, 544],
      [1920, 1088],
    ])
    expect(byClass('VAEEncode')).toHaveLength(1)
    expect(byClass('LTXICLoRALoaderModelOnly')[0]![1].inputs.lora_name).toBe(DETAIL_LORA)
    expect(byClass('CLIPTextEncode').map(([, n]) => n.inputs.text)).toContain(DETAIL_PROMPT)
    expect(byClass('LTXVTiledFusionSampler')[0]![1].inputs).toMatchObject({ seed: 5, cfg: 1 })
    // The source's sound, at the source's frame rate.
    expect(byClass('CreateVideo')[0]![1].inputs).toMatchObject({ audio: ['6', 1], fps: 24 })
    expect(byClass('SaveVideo')[0]![1].inputs.filename_prefix).toBe('wildroom/u1')
    const silent = buildUpscaleGraph({ video: 'src.mp4', frames: 97, fps: 24, width: 1920, height: 1088, seed: 5, audio: false, precision: 'int8', prefix: 'p' })
    expect(Object.values(silent).find((n) => n.class_type === 'CreateVideo')!.inputs).not.toHaveProperty('audio')
  })
})

describe('RunPod adapter', () => {
  const model = getModel('runpod-ltx-2.5')!

  function fakes() {
    const prompts: { graph: Record<string, { inputs: Record<string, unknown> }>; clientId: string }[] = []
    const uploads: string[] = []
    const interrupted: string[] = []
    let history: unknown
    let queue = { running: [] as string[], pending: [] as string[] }
    const comfy = {
      authHeaders: { authorization: 'Bearer pod-token' },
      upload: async (_path: string, _mime: string, name: string) => (uploads.push(name), { filename: name, subfolder: '', type: 'input' }),
      prompt: async (graph: Record<string, { inputs: Record<string, unknown> }>, clientId: string) => (prompts.push({ graph, clientId }), 'p1'),
      history: async () => history,
      queue: async () => queue,
      viewUrl: (f: { filename: string; subfolder: string; type: string }) => `https://pod1-8188.proxy.runpod.net/api/view?filename=${f.filename}&subfolder=${f.subfolder}`,
      interrupt: async (promptId?: string) => void interrupted.push(promptId ?? ''),
      deleteQueued: async () => {},
    } as unknown as ComfyClient
    const session = { podId: 'pod1', reconciled: true, precision: 'bf16', costPerHr: 2.09, client: () => comfy, ensure: () => ({ ready: true }) } as unknown as GpuSession
    return {
      comfy,
      session,
      prompts,
      uploads,
      interrupted,
      setHistory: (h: unknown) => (history = h),
      setQueue: (q: typeof queue) => (queue = q),
    }
  }

  it('queues the graph under the studio client id and follows it to the finished video', async () => {
    const f = fakes()
    const adapter = createRunpodAdapter({ session: f.session })
    const { ctx } = makeCtx(model, { prompt: 'a rainy street', duration: 5, resolution: '720p', seed: 3 })
    const submitted = await adapter.submit(ctx)
    expect(submitted).toMatchObject({ type: 'async', taskId: 'p1', meta: { podId: 'pod1', width: 1280, height: 704 } })
    expect(f.prompts[0]!.clientId).toBe('studio-runpod')
    expect(f.prompts[0]!.graph['5514:3059']!.inputs).toMatchObject({ width: 640, height: 352 })

    const running = { ...ctx, providerTaskId: 'p1', providerMeta: { podId: 'pod1', width: 1280, height: 704 } }
    f.setQueue({ running: ['other'], pending: ['x', 'p1'] })
    expect(await adapter.poll!(running)).toMatchObject({ type: 'running', detail: 'In the GPU queue (#2)' })
    f.setQueue({ running: ['p1'], pending: [] })
    // The first render on a fresh pod loads the models first.
    expect(await adapter.poll!(running)).toMatchObject({ type: 'running', detail: 'Loading the models (first render on this GPU)…' })

    f.setHistory({
      outputs: { '4852': { images: [{ filename: 'wildroom_00001_.mp4', subfolder: 'wildroom/gen1', type: 'output' }], animated: [true] } },
      status: { status_str: 'success', messages: [['execution_start', { timestamp: 1_000 }], ['execution_success', { timestamp: 61_000 }]] },
    })
    const done = await adapter.poll!(running)
    expect(done).toMatchObject({
      type: 'done',
      outputs: [{ kind: 'url', ext: 'mp4', headers: { authorization: 'Bearer pod-token' } }],
      costUsd: Math.round((60_000 / 3_600_000) * 2.09 * 10_000) / 10_000,
    })
  })

  it('uploads the start frame and conditions on it', async () => {
    const f = fakes()
    const adapter = createRunpodAdapter({ session: f.session })
    const frame = fixtures.file('frame.PNG', 'png')
    const { ctx } = makeCtx(model, { prompt: 'she turns', firstFrame: 'asset1', resolution: '1080p' }, {
      inputs: { firstFrame: { assetId: 'asset1', kind: 'image', path: frame, mime: 'image/png', width: 1080, height: 1920 } },
    })
    await adapter.submit(ctx)
    expect(f.uploads).toEqual([`studio_${ctx.generationId}_start.png`])
    expect(f.prompts[0]!.graph['2004']!.inputs.image).toBe(`studio_${ctx.generationId}_start.png`)
    // Portrait frame → portrait render.
    expect(f.prompts[0]!.graph['5514:3059']!.inputs).toMatchObject({ width: 544, height: 960 })
  })

  it('sends every input: end and middle frames, references with a location and voices, audio to follow', async () => {
    const f = fakes()
    const adapter = createRunpodAdapter({ session: f.session })
    const image = (id: string) => ({ assetId: id, kind: 'image' as const, path: fixtures.file(`${id}.png`, 'png'), mime: 'image/png', width: 1080, height: 1920 })
    const sound = (id: string, seconds: number) => ({ assetId: id, kind: 'audio' as const, path: fixtures.file(`${id}.mp3`, 'mp3'), mime: 'audio/mpeg', durationSeconds: seconds })
    const { ctx, records } = makeCtx(
      model,
      {
        prompt: 'Image 1: a man. Image 2: a woman. Image 3: a diner. Image 1 talks to Image 2.',
        duration: 8,
        resolution: '1080p',
        lastFrame: 'end',
        midFrames: ['mid'],
        referenceImages: ['man', 'woman'],
        referenceBackground: 'diner',
        voice1: 'v1',
        audioClip: 'song',
      },
      {
        inputs: {
          lastFrame: image('end'),
          midFrames: [image('mid')],
          referenceImages: [image('man'), image('woman')],
          referenceBackground: image('diner'),
          voice1: sound('v1', 4),
          audioClip: sound('song', 6.5),
        },
      },
    )
    const submitted = await adapter.submit(ctx)
    const id = ctx.generationId
    expect(f.uploads).toEqual([
      `studio_${id}_end.png`,
      `studio_${id}_mid1.png`,
      `studio_${id}_ref1.png`,
      `studio_${id}_ref2.png`,
      `studio_${id}_location.png`,
      `studio_${id}_voice1.mp3`,
      `studio_${id}_audio.mp3`,
    ])
    const g = f.prompts[0]!.graph as unknown as ApiGraph
    expect(danglingLinks(g)).toEqual([])
    // The end frame gives the shot its shape; the audio caps its length at 6.5 s.
    expect(g['5514:3059']!.inputs).toMatchObject({ width: 544, height: 960 })
    expect(g['5512']!.inputs.value).toBe(6.5)
    expect(records[0]).toMatchObject({ seconds: 6.5, references: [`studio_${id}_ref1.png`, `studio_${id}_ref2.png`], voices: [`studio_${id}_voice1.mp3`, undefined] })
    // References add guide frames: the progress estimate counts them.
    expect((submitted as unknown as { meta: { estimateMs: number } }).meta.estimateMs).toBeGreaterThan(runpodEstimateSeconds(1088, 1920, 6.5) * 1000)
  })

  it('continues a clip from its last second, cut at the render size', async () => {
    const f = fakes()
    const adapter = createRunpodAdapter({ session: f.session })
    const clip = join(fixtures.dir, 'clip.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=2', '-pix_fmt', 'yuv420p', clip])
    const sent: string[] = []
    ;(f.comfy as unknown as { upload: unknown }).upload = async (path: string, _mime: string, name: string) => {
      sent.push(path)
      f.uploads.push(name)
      return { filename: name, subfolder: '', type: 'input' }
    }
    const { ctx } = makeCtx(model, { prompt: 'the camera keeps moving', continueFrom: 'clip', resolution: '720p' }, {
      inputs: { continueFrom: { assetId: 'clip', kind: 'video', path: clip, mime: 'video/mp4', width: 640, height: 360, durationSeconds: 2 } },
    })
    await adapter.submit(ctx)
    expect(f.uploads).toEqual([`studio_${ctx.generationId}_continue.mp4`])
    const probe = await runFfmpeg(['-i', sent[0]!, '-map', '0:v:0', '-f', 'null', '-'])
    expect(probe.stderr).toMatch(/1280x704/)
    expect(probe.stderr).toMatch(/frame=\s*25\b/)
    // Too short to lead in: refused before anything is sent.
    const short = makeCtx(model, { prompt: 'x', continueFrom: 'clip' }, {
      inputs: { continueFrom: { assetId: 'clip', kind: 'video', path: clip, mime: 'video/mp4', durationSeconds: 0.5 } },
    })
    await expect(adapter.submit(short.ctx)).rejects.toMatchObject({ jobError: { code: 'invalid_params' } })
  })

  it('sends a camera guide fitted to the render size and cut to the rendered frames, and sets the length from it', async () => {
    const f = fakes()
    const adapter = createRunpodAdapter({ session: f.session })
    const previs = join(fixtures.dir, 'previs.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=24:d=3', '-pix_fmt', 'yuv420p', previs])
    const sent: string[] = []
    ;(f.comfy as unknown as { upload: unknown }).upload = async (path: string, _mime: string, name: string) => {
      sent.push(path)
      f.uploads.push(name)
      return { filename: name, subfolder: '', type: 'input' }
    }
    const { ctx } = makeCtx(model, { prompt: 'a detective walks down a wet alley', guideVideo: 'previs', guideKind: 'depth', duration: 8, resolution: '720p' }, {
      inputs: { guideVideo: { assetId: 'previs', kind: 'video', path: previs, mime: 'video/mp4', width: 1920, height: 1080, durationSeconds: 3 } },
    })
    await adapter.submit(ctx)
    expect(f.uploads).toEqual([`studio_${ctx.generationId}_guide.mp4`])
    // 3 s at 24 fps → 1 + 8·9 = 73 frames (the guide's 72, its last one held); a depth guide renders at 1280×768.
    const probe = await runFfmpeg(['-i', sent[0]!, '-map', '0:v:0', '-f', 'null', '-'])
    expect(probe.stderr).toMatch(/1280x768/)
    expect(probe.stderr).toMatch(/frame=\s*73\b/)
    const graph = f.prompts[0]!.graph as unknown as ApiGraph
    expect(Object.values(graph).filter((n) => n.class_type === 'LTXAddVideoICLoRAGuide')).toHaveLength(1)
    expect(graph['5512']!.inputs.value).toBe(3)
  })

  it('refuses a grey-box guide without a start frame (it would render the grey box itself)', async () => {
    // Refused before it's queued (the GPU isn't started for it), and by the adapter if it gets there anyway.
    expect(parseParams(model, { prompt: 'x', guideVideo: 'previs', guideKind: 'layout' })).toMatchObject({ ok: false, message: expect.stringContaining('start frame') })
    expect(parseParams(model, { prompt: 'x', guideVideo: 'previs', guideKind: 'depth' }).ok).toBe(true)
    const f = fakes()
    const adapter = createRunpodAdapter({ session: f.session })
    const { ctx } = makeCtx(model, { prompt: 'x', guideVideo: 'previs', guideKind: 'depth' }, {
      inputs: { guideVideo: { assetId: 'previs', kind: 'video', path: fixtures.file('previs.mp4', 'mp4'), mime: 'video/mp4', durationSeconds: 3 } },
    })
    ctx.params.guideKind = 'layout'
    await expect(adapter.submit(ctx)).rejects.toMatchObject({ jobError: { code: 'invalid_params', message: expect.stringContaining('start frame') } })
    expect(f.uploads).toEqual([])
  })

  it('refuses a camera guide together with a clip to continue', async () => {
    const f = fakes()
    const adapter = createRunpodAdapter({ session: f.session })
    const { ctx } = makeCtx(model, { prompt: 'x', guideVideo: 'previs', continueFrom: 'clip' }, {
      inputs: {
        guideVideo: { assetId: 'previs', kind: 'video', path: fixtures.file('previs.mp4', 'mp4'), mime: 'video/mp4', durationSeconds: 3 },
        continueFrom: { assetId: 'clip', kind: 'video', path: fixtures.file('clip.mp4', 'mp4'), mime: 'video/mp4', durationSeconds: 3 },
      },
    })
    await expect(adapter.submit(ctx)).rejects.toMatchObject({ jobError: { code: 'invalid_params', message: expect.stringContaining('camera guide') } })
    expect(f.uploads).toEqual([])
  })

  it('refuses to continue a clip and follow an audio clip at once (the lead-in would cut the audio’s first second)', async () => {
    const f = fakes()
    const adapter = createRunpodAdapter({ session: f.session })
    const { ctx } = makeCtx(model, { prompt: 'x', continueFrom: 'clip', audioClip: 'song' }, {
      inputs: {
        continueFrom: { assetId: 'clip', kind: 'video', path: fixtures.file('clip.mp4', 'mp4'), mime: 'video/mp4', durationSeconds: 3 },
        audioClip: { assetId: 'song', kind: 'audio', path: fixtures.file('song.mp3', 'mp3'), mime: 'audio/mpeg', durationSeconds: 4 },
      },
    })
    await expect(adapter.submit(ctx)).rejects.toMatchObject({ jobError: { code: 'invalid_params', message: expect.stringContaining('first second') } })
    expect(f.uploads).toEqual([])
    expect(f.prompts).toHaveLength(0)
  })

  it('stops a render that hangs on the GPU long past its estimate, counted from when it started rendering', async () => {
    const f = fakes()
    let clock = 0
    const adapter = createRunpodAdapter({ session: f.session, now: () => clock })
    const { ctx } = makeCtx(model, { prompt: 'x' })
    // A 1-minute estimate: stopped after 10 min (the floor), not 4 × 1 min + the model load.
    const running = { ...ctx, providerTaskId: 'p1', providerMeta: { podId: 'pod1', estimateMs: 60_000 } }
    // Queued behind another prompt for an hour: that doesn't count.
    f.setQueue({ running: ['other'], pending: ['p1'] })
    clock += 60 * 60_000
    expect(await adapter.poll!(running)).toMatchObject({ type: 'running' })
    f.setQueue({ running: ['p1'], pending: [] })
    expect(await adapter.poll!(running)).toMatchObject({ type: 'running' })
    clock += 9 * 60_000
    expect(await adapter.poll!(running)).toMatchObject({ type: 'running', progress: 0.95 })
    expect(f.interrupted).toEqual([])
    clock += 2 * 60_000
    expect(await adapter.poll!(running)).toMatchObject({ type: 'failed', error: { code: 'timeout', retryable: true, message: expect.stringContaining('stopped as stuck') } })
    expect(f.interrupted).toEqual(['p1'])

    // A long render gets several times its estimate.
    const long = { ...ctx, providerTaskId: 'p2', providerMeta: { podId: 'pod1', estimateMs: 20 * 60_000 } }
    f.setQueue({ running: ['p2'], pending: [] })
    await adapter.poll!(long)
    clock += 80 * 60_000
    expect(await adapter.poll!(long)).toMatchObject({ type: 'running' })
    clock += 6 * 60_000
    expect(await adapter.poll!(long)).toMatchObject({ type: 'failed' })
    expect(f.interrupted).toEqual(['p1', 'p2'])
  })

  it('upscales a clip: the source at 24 fps cut to 8k+1 frames with its sound, to 1920×1088', async () => {
    const f = fakes()
    const adapter = createRunpodAdapter({ session: f.session })
    const path = join(fixtures.dir, 'seedance.mp4')
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=s=854x480:r=24:d=4.06', '-f', 'lavfi', '-i', 'sine=d=4.06', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path])
    const upscaler = getModel('runpod-ltx-2.5-upscale')!
    expect(upscaler).toMatchObject({ kind: 'upscale', provider: 'runpod', output: 'video' })
    const { ctx, records } = makeCtx(upscaler, { video: 'clip1', seed: 9 }, { inputs: { video: { assetId: 'clip1', kind: 'video', path, mime: 'video/mp4', width: 854, height: 480, durationSeconds: 4.06 } } })
    expect(await adapter.submit(ctx)).toMatchObject({ type: 'async', taskId: 'p1', meta: { width: 1920, height: 1088, upscale4k: false } })
    expect(f.uploads).toEqual([`studio_${ctx.generationId}_source.mp4`])
    const graph = f.prompts[0]!.graph
    expect(Object.values(graph).find((n) => (n as { class_type?: string }).class_type === 'ImageFromBatch')!.inputs.length).toBe(97)
    expect(records[0]).toMatchObject({ workflow: 'v2v_upscale_1080p', frames: 97, audio: true })

    // ComfyUI lists the LoadVideo input among the outputs, under a lower node id than SaveVideo: the saved one is delivered.
    f.setHistory({
      outputs: {
        '5': { images: [{ filename: `studio_${ctx.generationId}_source.mp4`, subfolder: '', type: 'input' }] },
        '23': { images: [{ filename: 'wildroom_00001_.mp4', subfolder: 'wildroom/gen1', type: 'output' }], animated: [true] },
      },
      status: { status_str: 'success', messages: [['execution_start', { timestamp: 1_000 }], ['execution_success', { timestamp: 81_000 }]] },
    })
    const done = await adapter.poll!({ ...ctx, providerTaskId: 'p1', providerMeta: { podId: 'pod1', width: 1920, height: 1088 } })
    expect(done).toMatchObject({ type: 'done', outputs: [{ url: expect.stringContaining('filename=wildroom_00001_.mp4') }] })

    const long = makeCtx(upscaler, { video: 'clip2' }, { inputs: { video: { assetId: 'clip2', kind: 'video', path, mime: 'video/mp4', durationSeconds: 25 } } }).ctx
    // The probe reads the real file (4 s), so a stale 25 s duration on the asset doesn't block it.
    await expect(adapter.submit(long)).resolves.toMatchObject({ type: 'async' })
  })

  it('holds the last frame of a whole-second clip (one short of 8k+1), and refuses a clip that isn’t 16:9', async () => {
    const f = fakes()
    const adapter = createRunpodAdapter({ session: f.session })
    const upscaler = getModel('runpod-ltx-2.5-upscale')!
    const path = join(fixtures.dir, 'five.mp4')
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=s=854x480:r=24:d=5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path])
    const frames: string[] = []
    ;(f.comfy as unknown as { upload: unknown }).upload = async (file: string, _mime: string, name: string) => {
      frames.push((await runFfmpeg(['-i', file, '-map', '0:v:0', '-f', 'null', '-'])).stderr)
      return { filename: name, subfolder: '', type: 'input' }
    }
    const { ctx } = makeCtx(upscaler, { video: 'c5' }, { inputs: { video: { assetId: 'c5', kind: 'video', path, mime: 'video/mp4', durationSeconds: 5 } } })
    await adapter.submit(ctx)
    expect(frames[0]).toMatch(/frame=\s*121\b/)
    const tall = join(fixtures.dir, 'tall.mp4')
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=s=480x854:r=24:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', tall])
    const portrait = makeCtx(upscaler, { video: 't' }, { inputs: { video: { assetId: 't', kind: 'video', path: tall, mime: 'video/mp4', durationSeconds: 2 } } }).ctx
    await expect(adapter.submit(portrait)).rejects.toMatchObject({ jobError: { code: 'invalid_params', message: expect.stringContaining('16:9') } })
  })

  it('renders 4K with the detail pass on 80 GB+ cards and refuses it on smaller ones', async () => {
    const f = fakes()
    const adapter = createRunpodAdapter({ session: f.session })
    const { ctx } = makeCtx(model, { prompt: 'a rainy street', duration: 5, resolution: '4K' })
    expect(await adapter.submit(ctx)).toMatchObject({ meta: { width: 1920, height: 1088, upscale4k: true } })
    expect(f.prompts[0]!.graph['5518:4849']!.inputs.images).toEqual(['6011', 0])
    expect(f.prompts[0]!.graph['6006']!.inputs).toMatchObject({ width: 3840, height: 2176 })

    const small = createRunpodAdapter({ session: { ...(f.session as unknown as Record<string, unknown>), precision: 'int8' } as unknown as GpuSession })
    await expect(small.submit(makeCtx(model, { prompt: 'x', resolution: '4K' }).ctx)).rejects.toMatchObject({
      jobError: { code: 'invalid_params', message: expect.stringContaining('80 GB') },
    })
    expect(f.prompts).toHaveLength(1)
  })

  it('waits after a restart until the session has looked for its pod, instead of giving the render up', async () => {
    const f = fakes()
    const session = { ...(f.session as unknown as Record<string, unknown>), podId: undefined, reconciled: false } as unknown as GpuSession
    const adapter = createRunpodAdapter({ session })
    const { ctx } = makeCtx(model, { prompt: 'x' })
    expect(await adapter.poll!({ ...ctx, providerTaskId: 'p1', providerMeta: { podId: 'pod1' } })).toMatchObject({ type: 'running', detail: 'Reconnecting to the GPU…' })
  })

  it('fails the render ComfyUI crashed on (not rendered again on the next GPU), and queues again the ones only waiting there', async () => {
    const f = fakes()
    const session = f.session as unknown as { podId: string | undefined; crashed: (id: string) => boolean }
    session.crashed = () => false
    const adapter = createRunpodAdapter({ session: f.session })
    const { ctx } = makeCtx(model, { prompt: 'x', resolution: '4K' })
    const rendering = { ...ctx, providerTaskId: 'p1', providerMeta: { podId: 'pod1', upscale4k: true } }
    const waiting = { ...ctx, providerTaskId: 'p2', providerMeta: { podId: 'pod1' } }
    f.setQueue({ running: ['p1'], pending: ['p2'] })
    await adapter.poll!(rendering)
    await adapter.poll!(waiting)
    // The session found ComfyUI dead and stopped the pod.
    session.podId = undefined
    session.crashed = (id) => id === 'pod1'
    expect(await adapter.poll!(rendering)).toMatchObject({
      type: 'failed',
      error: { code: 'provider', retryable: true, message: expect.stringContaining('try 1080p') },
    })
    expect(await adapter.poll!(waiting)).toMatchObject({ type: 'requeue' })
  })

  it('queues a render again when its GPU went away or forgot it, and reports GPU errors', async () => {
    const f = fakes()
    const adapter = createRunpodAdapter({ session: f.session })
    const { ctx } = makeCtx(model, { prompt: 'x' })
    expect(await adapter.poll!({ ...ctx, providerTaskId: 'p1', providerMeta: { podId: 'old-pod' } })).toMatchObject({ type: 'requeue' })
    expect(await adapter.poll!({ ...ctx, providerTaskId: 'p1', providerMeta: { podId: 'pod1' } })).toMatchObject({ type: 'requeue' })
    f.setHistory({ outputs: {}, status: { status_str: 'error', messages: [['execution_error', { node_type: 'VAEDecodeTiled', exception_message: 'CUDA out of memory' }]] } })
    expect(await adapter.poll!({ ...ctx, providerTaskId: 'p1', providerMeta: { podId: 'pod1' } })).toMatchObject({
      type: 'failed',
      error: { message: expect.stringContaining('VAEDecodeTiled') },
    })
  })
})
