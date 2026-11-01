import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fluxEstimateSeconds, fluxSize, ltxEstimateSeconds, ltxFrames, ltxSize } from '../../shared/models/catalog/local'
import { FluxProgress, LtxProgress, createLocalAdapter, fluxArgs, fluxInstall, ltxArgs, ltxInstall } from './local'

describe('ltxSize', () => {
  it('keeps both sides on the 64 px grid near the requested aspect', () => {
    for (const quality of ['draft', 'standard', 'high'] as const) {
      for (const aspect of [16 / 9, 9 / 16, 1, 4 / 3, 2.39]) {
        const { width, height } = ltxSize(aspect, quality)
        expect(width % 64).toBe(0)
        expect(height % 64).toBe(0)
        expect(Math.abs(width / height - aspect) / aspect).toBeLessThan(0.12)
      }
    }
  })

  it('maps the tiers to the documented sizes', () => {
    expect(ltxSize(16 / 9, 'draft')).toEqual({ width: 576, height: 320 })
    expect(ltxSize(16 / 9, 'standard')).toEqual({ width: 768, height: 448 })
    expect(ltxSize(16 / 9, 'high')).toEqual({ width: 1024, height: 576 })
    expect(ltxSize(9 / 16, 'high')).toEqual({ width: 576, height: 1024 })
  })
})

describe('ltxFrames', () => {
  it('rounds a duration to 8k + 1 frames', () => {
    expect(ltxFrames(4, 24)).toBe(97)
    expect(ltxFrames(2, 25)).toBe(49)
    expect(ltxFrames(8, 30)).toBe(241)
    for (const s of [2, 3, 5, 7]) expect(ltxFrames(s, 24) % 8).toBe(1)
  })
})

describe('LtxProgress', () => {
  it('follows the phases and both denoising passes monotonically', () => {
    const p = new LtxProgress()
    const seen: number[] = []
    const feed = (s: string) => {
      p.feed(s)
      seen.push(p.progress)
    }
    feed('[Loading text encoder (Gemma)] ...\n')
    feed('[Loading text encoder (Gemma)] done in 12.0s\n[Encoding prompt] ...\n[Encoding prompt] done in 3.1s\n')
    feed('[Loading transformer (transformer-distilled.safetensors)] ...\n[Loading transformer (transformer-distilled.safetensors)] done in 4.0s\n')
    feed('Denoising (ancestral):  38%|███▊      | 3/8 [00:30<00:50, 10.0s/it]\r')
    expect(p.phase).toBe('Rendering')
    feed('Denoising (ancestral): 100%|██████████| 8/8 [01:20<00:00, 10.0s/it]\n')
    feed('Denoising:  33%|███▎      | 1/3 [00:10<00:20, 10.0s/it]\r')
    expect(p.phase).toBe('Refining')
    feed("[Loading decoders (VAE + audio + vocoder)] ...\n[Decoding video + audio + muxing] ...\n")
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!)
    expect(seen[3]).toBeCloseTo(0.2 + 0.35 * (3 / 8))
    expect(p.progress).toBeGreaterThan(0.9)
    expect(p.progress).toBeLessThan(1)
  })

  it('waits for the rest of a line split across chunks and ignores other output', () => {
    const p = new LtxProgress()
    p.feed('Denoising (ancestral):  38%|███▊      | 3/8 [00:30<00:50, 10.0s/it]\rsome warning: blah\nDenoising (anc')
    expect(p.progress).toBeCloseTo(0.2 + 0.35 * (3 / 8))
    // The fragment "estral):  50%|…| 4/8" must not be taken for the second pass.
    p.feed('estral):  50%|█████     | 4/8 [00:40<00')
    expect(p.progress).toBeCloseTo(0.2 + 0.35 * (3 / 8))
    p.feed(':40, 10.0s/it]\r')
    expect(p.progress).toBeCloseTo(0.375)
    expect(p.phase).toBe('Rendering')
  })
})

describe('ltxInstall', () => {
  it('reports what is missing until runtime and weights are in place', () => {
    const modelsDir = mkdtempSync(join(tmpdir(), 'ltx-'))
    expect(ltxInstall({ modelsDir })).toMatchObject({ installed: false, detail: expect.stringMatching(/Runtime not installed/) })
    mkdirSync(join(modelsDir, 'ltx-2-mlx/.venv/bin'), { recursive: true })
    writeFileSync(join(modelsDir, 'ltx-2-mlx/.venv/bin/ltx-2-mlx'), '')
    expect(ltxInstall({ modelsDir })).toMatchObject({ installed: false, detail: expect.stringMatching(/weights incomplete/) })
    mkdirSync(join(modelsDir, 'ltx-2.5-mlx-q4'))
    for (const f of ['transformer-distilled.safetensors', 'text_encoder.safetensors', 'connector.safetensors', 'embedded_config.json'])
      writeFileSync(join(modelsDir, 'ltx-2.5-mlx-q4', f), 'x')
    expect(ltxInstall({ modelsDir })).toMatchObject({ installed: true })
  })
})

describe('ltxEstimateSeconds', () => {
  it('matches the measured 16 GB M4 renders within ~15%', () => {
    const near = (estimate: number, measured: number) => expect(Math.abs(estimate - measured) / measured).toBeLessThan(0.15)
    near(ltxEstimateSeconds(576, 320, 49), 130) // Draft 2 s
    near(ltxEstimateSeconds(768, 448, 97), 393) // Standard 4 s from a start frame
    near(ltxEstimateSeconds(1920, 1088, 49), 1192) // Full HD 2 s
    // Full HD 4 s: under an hour, so several fit in a night.
    expect(ltxEstimateSeconds(1920, 1088, 97)).toBeLessThan(60 * 60)
  })
})

describe('Quality mode', () => {
  it('estimates the guided pipeline several times slower than Fast', () => {
    // Measured: 2 s at Draft took 840 s in Quality mode.
    expect(Math.abs(ltxEstimateSeconds(576, 320, 49, 'quality') - 840) / 840).toBeLessThan(0.15)
    const fast = ltxEstimateSeconds(768, 448, 97, 'fast')
    const quality = ltxEstimateSeconds(768, 448, 97, 'quality')
    expect(quality / fast).toBeGreaterThan(3)
    expect(quality / fast).toBeLessThan(10)
  })

  it('gives stage 1 most of the bar when it is the long pass', () => {
    const p = new LtxProgress(0.8)
    p.feed('Denoising (guided):  50%|█████     | 15/30 [10:00<10:00, 40.0s/it]\r')
    expect(p.progress).toBeCloseTo(0.2 + 0.6 * 0.5)
    p.feed('Denoising:  33%|███▎      | 1/3 [00:30<01:00, 30.0s/it]\r')
    expect(p.phase).toBe('Refining')
    expect(p.progress).toBeCloseTo(0.8 + 0.1 / 3)
  })
})

describe('ltxArgs', () => {
  const frame = (path: string) => ({ assetId: path, kind: 'image' as const, path, mime: 'image/jpeg', width: 1600, height: 900 })
  const opts = { pack: '/models/ltx', output: '/tmp/out.mp4', lowRam: true }

  it('keeps a prompt that starts with a dash attached to its flag', () => {
    const args = ltxArgs({ prompt: '- slow push-in, she turns', mode: 'quality', negativePrompt: '-blurry' }, {}, opts)
    expect(args).toContain('--prompt=- slow push-in, she turns')
    expect(args).toContain('--negative-prompt=-blurry')
    expect(args).not.toContain('--prompt')
  })

  it('anchors start and end frames at the first and last frame, at the frame aspect', () => {
    const args = ltxArgs({ prompt: 'x', duration: 4, fps: 24, quality: 'standard' }, { firstFrame: frame('/a.jpg'), lastFrame: frame('/b.jpg') }, opts)
    const images = args.flatMap((a, i) => (a === '--image' ? [args.slice(i + 1, i + 4)] : []))
    expect(images).toEqual([['/a.jpg', '0', '1.0'], ['/b.jpg', '96', '1.0']])
    expect(args.slice(args.indexOf('-W'), args.indexOf('-W') + 4)).toEqual(['-W', '768', '-H', '448'])
    expect(args).toContain('--distilled')
    expect(args).toContain('--low-ram')
  })

  it('sends a negative prompt only in Quality mode (the distilled pipeline rejects it)', () => {
    expect(ltxArgs({ prompt: 'x', negativePrompt: 'blur' }, {}, opts).some((a) => a.startsWith('--negative-prompt'))).toBe(false)
    expect(ltxArgs({ prompt: 'x', negativePrompt: 'blur', mode: 'quality' }, {}, opts)).toContain('--two-stage')
  })
})

describe('fluxSize', () => {
  it('uses the FLUX.2 [pro] sizes for the named aspects', () => {
    expect(fluxSize(9 / 16, '1MP')).toEqual({ width: 768, height: 1344 })
    expect(fluxSize(9 / 16, '2MP')).toEqual({ width: 1088, height: 1920 })
    expect(fluxSize(16 / 9, '2MP')).toEqual({ width: 1920, height: 1088 })
    expect(fluxSize(1, '1MP')).toEqual({ width: 1024, height: 1024 })
  })

  it('keeps other aspects (Auto from a reference) on the 16 px grid', () => {
    for (const aspect of [2.39, 0.8, 1.5]) {
      const { width, height } = fluxSize(aspect, '1MP')
      expect(width % 16).toBe(0)
      expect(height % 16).toBe(0)
      expect(Math.abs(width / height - aspect) / aspect).toBeLessThan(0.03)
    }
  })
})

describe('fluxArgs', () => {
  const ref = (path: string, width = 1600, height = 900) => ({ assetId: path, kind: 'image' as const, path, mime: 'image/png', width, height })
  const opts = { pack: '/models/flux2-klein-4b-mflux-q4', base: 'flux2-klein-4b', output: '/tmp/out.png', lowRam: true }

  it('renders text-to-image at the aspect size with 4 steps and a dash-safe prompt', () => {
    const { edit, argv } = fluxArgs({ prompt: '- a meadow', aspectRatio: '9:16', resolution: '1MP', seed: 7 }, {}, opts)
    expect(edit).toBe(false)
    expect(argv).toContain('--prompt=- a meadow')
    expect(argv.slice(argv.indexOf('--width'), argv.indexOf('--width') + 4)).toEqual(['--width', '768', '--height', '1344'])
    expect(argv.slice(argv.indexOf('--steps'), argv.indexOf('--steps') + 2)).toEqual(['--steps', '4'])
    expect(argv.slice(argv.indexOf('--seed'), argv.indexOf('--seed') + 2)).toEqual(['--seed', '7'])
    expect(argv).toContain('--low-ram')
    expect(argv).toContain('--base-model')
    expect(argv).not.toContain('--vae-tiling')
  })

  it('decodes untiled (tiles shift the colours) unless asked for the low-memory fallback', () => {
    const params = { prompt: 'x', aspectRatio: '9:16', resolution: '2MP' }
    expect(fluxArgs(params, {}, opts).argv).not.toContain('--vae-tiling')
    expect(fluxArgs(params, {}, { ...opts, tiled: true }).argv).toContain('--vae-tiling')
  })

  it('switches to the edit entry point with reference images and follows the first one on Auto', () => {
    const { edit, argv } = fluxArgs(
      { prompt: 'x', aspectRatio: 'auto', resolution: '1MP' },
      { referenceImages: [ref('/a.png', 900, 1600), ref('/b.png')] },
      opts,
    )
    expect(edit).toBe(true)
    expect(argv.slice(argv.indexOf('--image-paths'), argv.indexOf('--image-paths') + 3)).toEqual(['--image-paths', '/a.png', '/b.png'])
    expect(argv.slice(argv.indexOf('--width'), argv.indexOf('--width') + 4)).toEqual(['--width', '768', '--height', '1344'])
  })
})

describe('FluxProgress', () => {
  it('follows the 4 denoising steps, then the decode, and picks up the saved path', () => {
    const p = new FluxProgress()
    expect(p.phase).toBe('Loading')
    p.feed(' 25%|██▌       | 1/4 [00:14<00:43, 14.40s/it]\r 50%|█████     | 2')
    expect(p.progress).toBeCloseTo(0.25 + 0.6 * 0.25)
    expect(p.phase).toBe('Rendering')
    p.feed('/4 [00:25<00:24, 12.37s/it]\r100%|██████████| 4/4 [00:47<00:00, 11.80s/it]\n')
    expect(p.phase).toBe('Decoding')
    expect(p.progress).toBeCloseTo(0.9)
    p.feed('INFO: Image saved successfully at: /tmp/out_1.png\nPeak MLX memory: 10.02 GB\n')
    expect(p.savedPath).toBe('/tmp/out_1.png')
    expect(p.progress).toBeLessThan(1)
  })
})

describe('fluxInstall', () => {
  it('needs the runtime and at least one finished pack, and lists the modes it has', () => {
    const modelsDir = mkdtempSync(join(tmpdir(), 'flux-'))
    expect(fluxInstall({ modelsDir })).toMatchObject({ installed: false, detail: expect.stringMatching(/not installed/) })
    mkdirSync(join(modelsDir, 'mflux/.venv/bin'), { recursive: true })
    writeFileSync(join(modelsDir, 'mflux/.venv/bin/mflux-generate-flux2'), '')
    // A download still in progress has no .complete marker.
    mkdirSync(join(modelsDir, 'flux2-klein-4b-mflux-q4/transformer'), { recursive: true })
    expect(fluxInstall({ modelsDir })).toMatchObject({ installed: false, detail: expect.stringMatching(/not downloaded/) })
    writeFileSync(join(modelsDir, 'flux2-klein-4b-mflux-q4/.complete'), '')
    const install = fluxInstall({ modelsDir })
    expect(install).toMatchObject({ installed: true, detail: expect.stringMatching(/Fast modes.*models:flux2-max/) })
    expect(Object.keys(install.packs)).toEqual(['fast'])
  })
})

describe('local adapter status', () => {
  it('reports each model on its own so a missing LTX does not hide FLUX.2', () => {
    const modelsDir = mkdtempSync(join(tmpdir(), 'local-'))
    mkdirSync(join(modelsDir, 'mflux/.venv/bin'), { recursive: true })
    writeFileSync(join(modelsDir, 'mflux/.venv/bin/mflux-generate-flux2'), '')
    mkdirSync(join(modelsDir, 'flux2-klein-4b-mflux-q8'))
    writeFileSync(join(modelsDir, 'flux2-klein-4b-mflux-q8/.complete'), '')
    const status = createLocalAdapter({ env: { modelsDir } }).status!()
    expect(status.configured).toBe(true)
    expect(status.models?.['local-flux-2']).toMatchObject({ ready: true })
    expect(status.models?.['local-ltx-2.5']).toMatchObject({ ready: false })
  })
})

describe('fluxEstimateSeconds', () => {
  it('matches the measured 16 GB M4 renders within ~10%', () => {
    const near = (estimate: number, measured: number) => expect(Math.abs(estimate - measured) / measured).toBeLessThan(0.1)
    near(fluxEstimateSeconds(768, 1344, 'quality'), 51)
    near(fluxEstimateSeconds(768, 1344, 'fast'), 53)
    near(fluxEstimateSeconds(1088, 1920, 'quality'), 108)
    expect(fluxEstimateSeconds(1088, 1920, 'max')).toBeGreaterThan(fluxEstimateSeconds(1088, 1920, 'quality'))
  })
})
