import { z } from 'zod'
import { P, hasAsset } from '../params'
import type { ModelSpec, ParamValues } from '../types'
import { FLUX2_SIZES, type FalAspect } from './fal'

/**
 * Models that run on this Mac. LTX-2.5 runs through the MLX port (github.com/dgrauet/ltx-2-mlx) with the
 * 4-bit pack, installed by scripts/install-local-ltx.sh; src/server/providers/local.ts drives its CLI.
 */

const AS_OF = '2026-09-30'

export type LtxQuality = 'draft' | 'standard' | 'high' | 'fullhd'
export type LtxAspect = '16:9' | '9:16' | '1:1'

/** Pixel budget per quality tier; `standard` is the pipeline's own default (704×480), `fullhd` lands on 1920×1088. */
const PIXELS: Record<LtxQuality, number> = { draft: 200_000, standard: 337_920, high: 589_824, fullhd: 2_088_960 }

/**
 * Output size for an aspect ratio (width / height) at a quality tier. Both sides are multiples of 64: the
 * distilled pipeline renders stage 1 at half size, which has to stay on the model's 32 px grid.
 */
export function ltxSize(aspect: number, quality: LtxQuality): { width: number; height: number } {
  return ltxSizeForPixels(aspect, PIXELS[quality])
}

/** Like ltxSize, for a pixel budget (2_088_960 lands on 1920×1088, 901_120 on 1280×704, 8_355_840 on 3840×2176). */
export function ltxSizeForPixels(aspect: number, pixels: number, step = 64): { width: number; height: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? Math.min(3, Math.max(1 / 3, aspect)) : 16 / 9
  const height = Math.sqrt(pixels / a)
  const snap = (v: number) => Math.max(256, Math.round(v / step) * step)
  return { width: snap(height * a), height: snap(height) }
}

/** Frame count for a duration: LTX needs 8k + 1 frames. */
export function ltxFrames(seconds: number, fps: number): number {
  return Math.max(1, Math.round((seconds * fps) / 8)) * 8 + 1
}

export const ASPECT_RATIOS: Record<LtxAspect, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 }

/**
 * `fast` is the distilled pipeline (8 half-size steps, no guidance). `quality` is the dev model with guidance
 * (`--two-stage`: 30 half-size steps × 4 passes — cond, uncond, STG, modality), refined by the same 3 distilled
 * full-size steps. Measured: Quality took 840 s for the 2 s Draft clip that Fast renders in 130 s.
 */
export type LtxMode = 'fast' | 'quality'

/** Model forwards in stage 1 per mode. */
const STAGE1_FORWARDS: Record<LtxMode, number> = { fast: 8, quality: 30 * 4 }

/**
 * Rough render time on a 16 GB M4 (--low-ram), fitted to measured distilled renders: Draft 2 s 130 s, Standard 4 s
 * 393 s, Full HD 2 s 1192 s. A forward costs ~1.5 s + 13.5 ms per latent token (32 px × 32 px × 8 frames) plus an
 * attention term that grows with its square; stage 1 runs at half size, stage 2 runs 3 forwards at full size, plus
 * ~25 s of prompt encoding and ~5 ms per token of decode.
 */
export function ltxEstimateSeconds(width: number, height: number, frames: number, mode: LtxMode = 'fast'): number {
  const latentFrames = (frames - 1) / 8 + 1
  const stage1 = (width / 64) * (height / 64) * latentFrames
  const stage2 = (width / 32) * (height / 32) * latentFrames
  const forward = (tokens: number) => 1.5 + 0.0135 * tokens + 2.4e-7 * tokens ** 2
  return 25 + STAGE1_FORWARDS[mode] * forward(stage1) + 3 * forward(stage2) + 0.005 * stage2
}

export function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds / 5) * 5} s`
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`
  return `${(seconds / 3600).toFixed(1)} h`
}

/** Output size and frame count for a set of params (frame-driven shots are estimated at the chosen aspect). */
function ltxRender(values: ParamValues): { width: number; height: number; frames: number } {
  const aspect = ASPECT_RATIOS[(values.aspectRatio as LtxAspect) ?? '16:9'] ?? 16 / 9
  const { width, height } = ltxSize(aspect, (values.quality as LtxQuality) ?? 'standard')
  return { width, height, frames: ltxFrames(Number(values.duration ?? 4), Number(values.fps ?? 24)) }
}

const noFrames = (values: ParamValues) => !hasAsset(values.firstFrame) && !hasAsset(values.lastFrame)

const ltx25: ModelSpec = {
  id: 'local-ltx-2.5',
  label: 'LTX-2.5 (this Mac)',
  vendor: 'Lightricks',
  provider: 'local',
  kind: 'video',
  description:
    'Runs on your Mac (MLX, 4-bit): free and private, with audio and start/end frames. Slow on 16 GB — expect several minutes per clip.',
  badges: ['Local', 'Free', 'Audio', 'First+Last'],
  output: 'video',
  params: [
    P.prompt({ max: 5000 }),
    P.image('firstFrame', 'Start frame', { help: 'Animate from this image (image-to-video)' }),
    P.image('lastFrame', 'End frame', { help: 'The shot ends on this image — works alone or with a start frame' }),
    {
      ...P.slider('duration', 'Duration', 2, 8, 1, 4, { unit: 's', help: 'Longer clips need more memory' }),
      schema: z.coerce.number().int().min(2).max(8),
    },
    P.segmented('aspectRatio', 'Aspect', ['16:9', '9:16', '1:1'] as const, '16:9', {
      help: 'Frame shots follow the image',
      visibleIf: noFrames,
    }),
    P.segmented('quality', 'Resolution', ['draft', 'standard', 'high', 'fullhd'] as const, 'standard', {
      labels: (v) => ({ draft: 'Draft', standard: 'Standard', high: 'High', fullhd: 'Full HD' })[v],
      help: 'Draft ≈ 576×320, Standard ≈ 768×448, High ≈ 1024×576, Full HD 1920×1088 — slow: queue it overnight',
    }),
    P.segmented('mode', 'Mode', ['fast', 'quality'] as const, 'fast', {
      labels: (v) => ({ fast: 'Fast', quality: 'Quality' })[v],
      help: 'Quality runs the full model with guidance: better detail, motion and prompt-following, several times slower',
    }),
    P.toggle('audio', 'Generate audio', true, { help: 'Turn off for a faster, lighter render' }),
    { ...P.negativePrompt(), ui: { ...P.negativePrompt().ui, visibleIf: (values: ParamValues) => values.mode === 'quality' } },
    P.segmented('fps', 'FPS', [24, 25, 30] as const, 24, { advanced: true }),
    P.seed(),
  ],
  estimateCost: (values) => {
    const { width, height } = ltxRender(values)
    const time = formatDuration(ltx25.estimateSeconds!(values))
    return { usd: 0, detail: `Free — about ${time} on a 16 GB M4 (${width}×${height})`, asOf: AS_OF }
  },
  estimateSeconds: (values) => {
    const { width, height, frames } = ltxRender(values)
    return ltxEstimateSeconds(width, height, frames, (values.mode as LtxMode) ?? 'fast')
  },
  maxVariants: 1,
  // Lightricks: 2–4 cuts per multi-shot clip.
  workflow: { multishot: { maxShots: 4 } },
}

// ------------------------------------------------------------------------------------ FLUX.2 [klein]

/**
 * FLUX.2 [klein] runs through mflux (MLX) with pre-quantized weights, installed by scripts/install-local-flux2.sh.
 * All modes are the 4-step distilled model; quality comes from the bigger quant or model, not more steps.
 * `fast` = 4B 4-bit, `quality` = 4B 8-bit (both Apache-2.0), `max` = 9B 4-bit (FLUX Non-Commercial licence, an
 * optional install that only just fits a 16 GB Mac).
 */
export type FluxMode = 'fast' | 'quality' | 'max'
export type FluxResolution = '1MP' | '2MP'

const FLUX_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', 'auto'] as const

export const FLUX_ASPECT_RATIOS: Record<FalAspect, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4 }

/** Output size for an aspect ratio (width / height): the same sizes FLUX.2 [pro] uses on fal, on mflux's 16 px grid. */
export function fluxSize(aspect: number, resolution: FluxResolution): { width: number; height: number } {
  const named = (Object.entries(FLUX_ASPECT_RATIOS) as [FalAspect, number][]).find(([, r]) => Math.abs(r - aspect) < 0.01)
  if (named) return { ...FLUX2_SIZES[resolution][named[0]] }
  const a = Number.isFinite(aspect) && aspect > 0 ? Math.min(3, Math.max(1 / 3, aspect)) : 1
  const area = resolution === '2MP' ? 1920 * 1088 : 1344 * 768
  const height = Math.sqrt(area / a)
  const snap = (v: number) => Math.max(256, Math.round(v / 16) * 16)
  return { width: snap(height * a), height: snap(height) }
}

/**
 * Rough time per image on a 16 GB M4 (--low-ram), fitted to measured mflux 0.21 runs (768×1344: 51–53 s,
 * 1088×1920: 108–111 s; 4-bit and 8-bit ran at the same speed): load + prompt + decode grow a little with size,
 * and each of the 4 steps grows with the latent token count (16 px × 16 px) and its square (attention).
 * Reference images add their tokens to every step. Max (9B) is an estimate at about twice the work.
 */
const FLUX_TIMING: Record<FluxMode, { scale: number; load: number }> = {
  fast: { scale: 1, load: 2 },
  quality: { scale: 1, load: 2 },
  max: { scale: 2, load: 10 },
}

export function fluxEstimateSeconds(width: number, height: number, mode: FluxMode = 'quality', refs = 0): number {
  const { scale, load } = FLUX_TIMING[mode]
  const tokens = (width / 16) * (height / 16) * (1 + refs)
  const step = 0.00267 * tokens + 4.54e-8 * tokens ** 2
  return load + 0.0011 * tokens + 4 * step * scale
}

/** Output size for a set of params; Auto (follow the reference) is estimated as square. */
function fluxRender(values: ParamValues): { width: number; height: number } {
  const aspect = FLUX_ASPECT_RATIOS[values.aspectRatio as FalAspect] ?? 1
  return fluxSize(aspect, (values.resolution as FluxResolution) ?? '1MP')
}

const refCount = (values: ParamValues) => (Array.isArray(values.referenceImages) ? values.referenceImages.length : 0)

const FLUX_AS_OF = '2026-10-04'

const flux2Klein: ModelSpec = {
  id: 'local-flux-2',
  label: 'FLUX.2 [klein] (this Mac)',
  vendor: 'Black Forest Labs',
  provider: 'local',
  kind: 'image',
  description:
    'Runs on your Mac (MLX): free and private photoreal stills, plus edits from reference images. About 50 s per image on a 16 GB M4.',
  badges: ['Local', 'Free', 'Refs', 'Edit'],
  output: 'image',
  params: [
    P.prompt({ max: 5000 }),
    P.images('referenceImages', 'Reference images', 4, { help: 'Up to 4 images to edit or compose from' }),
    P.select('aspectRatio', 'Aspect', FLUX_ASPECTS, '16:9', {
      labels: (v) => (v === 'auto' ? 'Auto' : v),
      help: 'Auto keeps the first reference image’s shape',
    }),
    P.segmented('mode', 'Mode', ['fast', 'quality', 'max'] as const, 'quality', {
      labels: (v) => ({ fast: 'Fast', quality: 'Quality', max: 'Max' })[v],
      help: 'Quality: 4B 8-bit — finer textures, faces and text. Fast: 4B 4-bit — same speed on an M4, lighter on memory. Max: 9B (pnpm models:flux2-max, non-commercial licence) — sharpest, about twice as slow and tight on 16 GB',
    }),
    P.segmented('resolution', 'Resolution', ['1MP', '2MP'] as const, '1MP', {
      help: '1MP ≈ 1344×768 (about 50 s), 2MP ≈ 1920×1088 Full HD (about 2 min)',
    }),
    P.seed(),
  ],
  validate: (values) => (values.aspectRatio === 'auto' && !refCount(values) ? 'Auto aspect ratio needs reference images' : null),
  estimateCost: (values) => {
    const { width, height } = fluxRender(values)
    const time = formatDuration(flux2Klein.estimateSeconds!(values))
    return { usd: 0, detail: `Free — about ${time} on a 16 GB M4 (${width}×${height})`, asOf: FLUX_AS_OF }
  },
  estimateSeconds: (values) => {
    const { width, height } = fluxRender(values)
    return fluxEstimateSeconds(width, height, (values.mode as FluxMode) ?? 'quality', refCount(values))
  },
  maxVariants: 4,
}

export const localModels: ModelSpec[] = [flux2Klein, ltx25]
