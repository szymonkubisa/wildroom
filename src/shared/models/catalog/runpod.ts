import { z } from 'zod'
import { DEFAULT_GPU_IDS, ltxGpu } from '../../types/runpod'
import { P, hasAsset, param } from '../params'
import type { ModelSpec, ParamValues } from '../types'
import { ASPECT_RATIOS, type LtxAspect, formatDuration, ltxSizeForPixels } from './local'

/**
 * LTX-2.5 on a rented RunPod GPU: ComfyUI on a pod, full-quality weights (bf16 on 80 GB+ cards). The GPU starts when a
 * render is queued and stops when the queue has been empty for a few minutes (src/server/providers/runpod).
 */

const AS_OF = '2026-10-06'

export type RunpodResolution = '720p' | '1080p' | '4K'
/**
 * Pixel budgets of the generated video: 1280×704 and 1920×1088 at 16:9 (both sides multiples of 64, the two-stage
 * pipeline needs it). 4K is generated at 1080p, then the detail pass doubles both sides (3840×2176).
 */
export const RUNPOD_PIXELS: Record<RunpodResolution, number> = { '720p': 901_120, '1080p': 2_088_960, '4K': 2_088_960 }

const count = (v: unknown) => (Array.isArray(v) ? v.length : 0)
export const isRunpod4k = (values: ParamValues) => values.resolution === '4K'

/** People/objects the MSR LoRA keeps (pic1–pic4); a location reference comes on top. */
export const RUNPOD_MAX_REFERENCES = 4
/** Stills a shot can pass through between its start and end. */
export const RUNPOD_MAX_MID_FRAMES = 4
/** Frames each MSR reference is encoded as (25 or 33; 33 is the node's default and its sample's choice). */
export const RUNPOD_REFERENCE_FRAMES = 33
/**
 * Frames of a clip to continue that lead into the new shot (8n+1, ~1 s): the shot starts by repeating them, then
 * they are cut from the result so it picks up right where the clip ends.
 */
export const RUNPOD_CONTINUE_FRAMES = 25

/** A shot's shape comes from its camera guide, or the picture it starts from, continues or ends on, in that order. */
export const RUNPOD_SHAPE_INPUTS = ['guideVideo', 'firstFrame', 'continueFrom', 'lastFrame'] as const

export type RunpodGuideKind = 'layout' | 'depth'
export const runpodGuideKind = (values: ParamValues): RunpodGuideKind => (values.guideKind === 'depth' ? 'depth' : 'layout')

/** Latent frames the guides add to each stage: they cost render time like frames of the clip. */
export function runpodGuideLatentFrames(values: ParamValues): number {
  const references = Math.min(count(values.referenceImages), RUNPOD_MAX_REFERENCES) + (hasAsset(values.referenceBackground) ? 1 : 0)
  const stills = count(values.midFrames) + (hasAsset(values.lastFrame) ? 1 : 0)
  const lead = hasAsset(values.continueFrom) ? (RUNPOD_CONTINUE_FRAMES - 1) / 8 + 1 : 0
  // A camera guide runs alongside the whole clip: full size for a layout, a quarter of the tokens for depth (half size).
  const clipFrames = Math.floor((Number(values.fps ?? 24) * Number(values.duration ?? 5)) / 8) + 1
  const guide = hasAsset(values.guideVideo) ? clipFrames * (runpodGuideKind(values) === 'depth' ? 0.25 : 1) : 0
  return references * ((RUNPOD_REFERENCE_FRAMES - 1) / 8 + 1) + stills + lead + guide
}

/** Generated size for a request (before the 4K pass): the start frame's shape when there is one, else the chosen aspect. */
export function runpodSize(values: ParamValues, frame?: { width?: number; height?: number }): { width: number; height: number } {
  const aspect =
    frame?.width && frame.height ? frame.width / frame.height : (ASPECT_RATIOS[(values.aspectRatio as LtxAspect) ?? '16:9'] ?? 16 / 9)
  // A depth guide (Union, guide at half size) needs a first-stage latent that halves evenly: sides of 128 px steps.
  const step = hasAsset(values.guideVideo) && runpodGuideKind(values) === 'depth' ? 128 : 64
  return ltxSizeForPixels(aspect, RUNPOD_PIXELS[(values.resolution as RunpodResolution) ?? '720p'] ?? RUNPOD_PIXELS['720p'], step)
}

/** Size of the delivered video. */
export function runpodOutputSize(values: ParamValues, frame?: { width?: number; height?: number }): { width: number; height: number } {
  const size = runpodSize(values, frame)
  return isRunpod4k(values) ? { width: size.width * 2, height: size.height * 2 } : size
}

/**
 * Render time on a warm RTX PRO 6000, fitted to measured two-stage renders with audio (2026-10-06): 720p 5 s 27 s,
 * 1080p 5 s 64 s, 1080p 10 s 157 s — roughly tokens^1.17, plus a few seconds of upload and download. The first
 * render of a session also waits for the GPU to start (1–2 min) and load the models (~30 s with the pod's preload).
 *
 * Guides (references, stills, a clip's lead-in) are counted as extra latent frames. The 4K pass is not measured yet:
 * 3 steps on 9 overlapping Full HD tiles, each with its guide, is about 6× the work of the 1080p render it refines
 * (provisional).
 */
export function runpodEstimateSeconds(
  width: number,
  height: number,
  seconds: number,
  fps = 24,
  opts: { upscale4k?: boolean; guideFrames?: number } = {},
): number {
  const frames = 1 + Math.floor((fps * seconds) / 8) * 8
  const tokens = ((frames - 1) / 8 + 1 + (opts.guideFrames ?? 0)) * (width / 32) * (height / 32)
  const base = 5 + 27 * (tokens / 14_080) ** 1.17
  return opts.upscale4k ? base + RUNPOD_4K_FACTOR * (base - 5) + 30 : base
}

/** The 4K pass relative to the 1080p render (provisional until measured). */
const RUNPOD_4K_FACTOR = 6

/** Starting the GPU and loading the models, paid once per session. */
export const RUNPOD_WARMUP_SECONDS = 3 * 60

/** What starting the GPU costs (its first minutes on the default GPU), when it is off. */
export const runpodWarmupUsd = () => (RUNPOD_WARMUP_SECONDS / 3600) * ltxGpu(DEFAULT_GPU_IDS[0]!)!.priceUsdHr

const ltx25: ModelSpec = {
  id: 'runpod-ltx-2.5',
  label: 'LTX-2.5 (RunPod GPU)',
  vendor: 'Lightricks',
  provider: 'runpod',
  kind: 'video',
  description:
    'Full-quality LTX-2.5 on a rented GPU: 1080p with audio in about a minute, or 4K with a tiled detail pass. Takes start, end and in-between frames, up to 4 references plus a location (and two voices), audio to follow, or a clip to continue. The GPU starts when you render (the first clip waits ~2–3 min for it) and stops by itself when the queue is empty.',
  badges: ['GPU', 'Audio', '4K', 'References'],
  output: 'video',
  // Refused here, before the GPU is started for them (the adapter refuses them too).
  validate: (values) => {
    if (!hasAsset(values.guideVideo)) return null
    if (hasAsset(values.continueFrom)) return 'A camera guide and continuing a clip don’t work together — the guide sets the whole shot. Use a start frame instead'
    if (runpodGuideKind(values) === 'layout' && !hasAsset(values.firstFrame))
      return 'A grey-box guide needs a start frame for the look — without one the clip comes out grey. Add a styled first frame, or use a depth guide'
    return null
  },
  params: [
    P.prompt({
      max: 5000,
      help: 'With references, describe each as “Image 1: …”, “Image 2: …” (the location is the next number), then the shot using those names — e.g. “Image 1 walks into Image 3”. With voices, add “Audio 1: …, belongs only to Image 1”',
    }),
    P.image('firstFrame', 'Start frame', {
      help: 'Animate from this image (image-to-video)',
      visibleIf: (values: ParamValues) => !hasAsset(values.continueFrom),
    }),
    P.image('lastFrame', 'End frame', { help: 'The shot ends on this image — alone or with a start frame' }),
    P.images('midFrames', 'Frames in between', RUNPOD_MAX_MID_FRAMES, {
      help: 'Stills the shot passes through, spread evenly between its start and end',
      advanced: true,
    }),
    // Set by the storyboard's multi-shot groups (never drawn): each in-between still lands at its cut, in seconds.
    param('midFrameTimes', z.array(z.coerce.number().min(0).max(30)).max(RUNPOD_MAX_MID_FRAMES).optional(), {
      label: 'In-between frame times',
      control: 'text',
      advanced: true,
      hidden: true,
      visibleIf: (values: ParamValues) => count(values.midFrames) > 0,
    }),
    P.images('referenceImages', 'References', RUNPOD_MAX_REFERENCES, {
      help: 'People, products or props to keep the same (Licon MSR) — Image 1 to Image 4 in the prompt, in this order',
    }),
    P.image('referenceBackground', 'Location reference', {
      help: 'The place the shot is set in — the image after the references (Image 3 with two references)',
    }),
    {
      ...P.audio('voice1', 'Voice of Image 1', false),
      ui: { label: 'Voice of Image 1', control: 'audio', help: 'A few seconds of this person speaking: their lines get this voice (“Audio 1” in the prompt)', visibleIf: (values: ParamValues) => count(values.referenceImages) >= 1 },
    },
    {
      ...P.audio('voice2', 'Voice of Image 2', false),
      ui: { label: 'Voice of Image 2', control: 'audio', help: 'The second person’s voice (“Audio 2” in the prompt)', visibleIf: (values: ParamValues) => count(values.referenceImages) >= 2 },
    },
    {
      ...P.audio('audioClip', 'Audio to follow', false),
      ui: {
        label: 'Audio to follow',
        control: 'audio',
        help: 'The video is made to this sound — speech (lip sync) or music — and keeps it as its audio. The clip is no longer than the audio',
      },
    },
    {
      ...P.video('continueFrom', 'Continue from clip', false),
      ui: {
        label: 'Continue from clip',
        control: 'video',
        help: 'The shot picks up where this clip ends: its motion, look and framing carry over',
        visibleIf: (values: ParamValues) => !hasAsset(values.firstFrame),
      },
    },
    {
      ...P.video('guideVideo', 'Camera guide (previs)', false),
      ui: {
        label: 'Camera guide (previs)',
        control: 'video',
        help: 'A Blender previs the clip follows: its camera moves, framing and where things are. The look comes from the start frame and the prompt — use a styled first frame, never the grey one, and describe the look in a sentence or two',
        visibleIf: (values: ParamValues) => !hasAsset(values.continueFrom),
      },
    },
    P.segmented('guideKind', 'Guide type', ['layout', 'depth'] as const, 'layout', {
      labels: (v) => (v === 'layout' ? 'Grey box' : 'Depth'),
      help: 'Grey box: the previs render itself (best with a start frame). Depth: a depth render (light = near), for shots without a start frame',
      visibleIf: (values: ParamValues) => hasAsset(values.guideVideo),
    }),
    P.slider('guideStrength', 'Guide strength', 0.3, 1, 0.05, 1, {
      advanced: true,
      help: 'Lower lets the clip drift from the previs',
      visibleIf: (values: ParamValues) => hasAsset(values.guideVideo),
    }),
    {
      ...P.slider('duration', 'Duration', 2, 10, 1, 5, { unit: 's', help: 'Longer clips take more than proportionally longer. With a camera guide, the clip is as long as the guide (up to 10 s)' }),
      schema: z.coerce.number().int().min(2).max(10),
    },
    P.segmented('aspectRatio', 'Aspect', ['16:9', '9:16', '1:1'] as const, '16:9', {
      help: 'A start frame, clip or end frame keeps its own shape',
      visibleIf: (values: ParamValues) => !RUNPOD_SHAPE_INPUTS.some((key) => hasAsset(values[key])),
    }),
    P.segmented('resolution', 'Resolution', ['720p', '1080p', '4K'] as const, '720p', {
      help: '1080p renders at 1920×1088 (16:9); 720p is about twice as fast. 4K (3840×2176) renders 1080p, then adds detail at full size with Lightricks’ tiled refine pass — several times longer. 4K needs an 80 GB+ GPU',
    }),
    P.toggle('audio', 'Generate audio', true, {
      help: 'Dialogue, ambience and effects from the prompt',
      visibleIf: (values: ParamValues) => !hasAsset(values.audioClip),
    }),
    P.negativePrompt(),
    P.segmented('fps', 'FPS', [24, 25] as const, 24, { advanced: true }),
    P.seed(),
  ],
  estimateCost: (values) => {
    const gpu = ltxGpu(DEFAULT_GPU_IDS[0]!)!
    const { width, height } = runpodOutputSize(values)
    const seconds = ltx25.estimateSeconds!(values)
    const usd = (seconds / 3600) * gpu.priceUsdHr
    const warm = (RUNPOD_WARMUP_SECONDS / 3600) * gpu.priceUsdHr
    return {
      usd,
      detail: `≈ ${formatDuration(seconds)} on ${gpu.name} ($${gpu.priceUsdHr.toFixed(2)}/h, ${width}×${height}); if the GPU is off, starting it adds ~${Math.round(RUNPOD_WARMUP_SECONDS / 60)} min (~$${warm.toFixed(2)}) once`,
      asOf: AS_OF,
    }
  },
  estimateSeconds: (values) => {
    const { width, height } = runpodSize(values)
    const fps = Number(values.fps ?? 24)
    // A continued clip's lead-in is rendered too, then cut.
    const seconds = Number(values.duration ?? 5) + (hasAsset(values.continueFrom) ? RUNPOD_CONTINUE_FRAMES / fps : 0)
    return runpodEstimateSeconds(width, height, seconds, fps, {
      upscale4k: isRunpod4k(values),
      guideFrames: runpodGuideLatentFrames(values),
    })
  },
  maxVariants: 4,
  // Licon MSR is reference-to-video: from a start frame the references stay out. The graph samples at CFG 1, so
  // the negative prompt has no effect. Lightricks: 2–4 cuts per multi-shot clip.
  workflow: { cast: { maxWithKeyframe: 0 }, negative: 'ineffective', multishot: { maxShots: 4 } },
}

/** The upscaler's delivered size: Full HD (16:9), the size LTX-2.5 renders 1080p at. */
export const RUNPOD_UPSCALE_SIZE = { width: 1920, height: 1088 } as const
/** Longest clip it takes (the tiled sampler works in chunks of up to 121 frames, so longer is a matter of time). */
export const RUNPOD_UPSCALE_MAX_SECONDS = 20

/**
 * LTX-2.5's own refine pass on any clip: a cheap low-resolution render (e.g. Seedance at 480p) upscaled to 1080p on
 * the GPU. The time is not measured yet: one Full HD tile, 3 steps with the source as guide — about one 1080p render.
 */
const ltx25Upscale: ModelSpec = {
  id: 'runpod-ltx-2.5-upscale',
  label: 'LTX-2.5 Upscale (RunPod GPU)',
  vendor: 'Lightricks',
  provider: 'runpod',
  kind: 'upscale',
  description:
    'Lightricks’ V2V detail pass on a rented GPU: takes any 16:9 clip (a 480p or 720p render) to 1920×1088, adding fine detail while following it frame for frame. Keeps its sound. Up to 20 s.',
  badges: ['GPU', '1080p', 'Detail'],
  output: 'video',
  params: [P.video('video', 'Video'), P.seed()],
  estimateCost: () => {
    const gpu = ltxGpu(DEFAULT_GPU_IDS[0]!)!
    const perSecond = runpodEstimateSeconds(RUNPOD_UPSCALE_SIZE.width, RUNPOD_UPSCALE_SIZE.height, 5) / 5
    return {
      usd: null,
      detail: `≈ ${Math.round(perSecond)} s of GPU per second of clip on ${gpu.name} (≈ $${((perSecond / 3600) * gpu.priceUsdHr).toFixed(3)}/s, provisional); if the GPU is off, starting it adds ~${Math.round(RUNPOD_WARMUP_SECONDS / 60)} min once`,
      asOf: AS_OF,
    }
  },
  maxVariants: 1,
}

export const runpodModels: ModelSpec[] = [ltx25, ltx25Upscale]
