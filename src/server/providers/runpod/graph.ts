import { RUNPOD_CONTINUE_FRAMES as CONTINUE_FRAMES, RUNPOD_MAX_REFERENCES as MAX_REFERENCES, RUNPOD_REFERENCE_FRAMES as MSR_REFERENCE_FRAMES } from '../../../shared/models/catalog/runpod'
import type { GpuPrecision } from '../../../shared/types/runpod'
import core from './workflows/core_2stage.json'

/**
 * ComfyUI API graphs for LTX-2.5, built from workflows captured on the pod (Lightricks'
 * LTX-2.5_T2V_I2V_Two_Stage_Distilled, converted with comfy-cli against the pod's /object_info, with the prompt
 * enhancer and LTX API branches removed). Node ids below are that graph's; nodes this module adds use 6001+ (the 4K
 * pass) and 7001+ (every other input).
 */

export type ApiGraph = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: unknown }>
type Link = [string, number]

const N = {
  prompt: '5508',
  negative: '5509',
  fps: '5511',
  seconds: '5512',
  stage1Latent: '5514:3059',
  noise1: '5516:4832',
  noise2: '5517:4967',
  image: '2004',
  useImage: '5014:5506',
  unet: '5575:5569',
  textEncoder: '5575:5574',
  videoVae: '5575:5571',
  audioVae: '5575:5570',
  conditioning: '5014:1241',
  stage1Concat: '5514:4528',
  stage1Guider: '5516:4828',
  stage1Separate: '5516:4845',
  upsampler: '5517:4975',
  stage2Concat: '5517:4969',
  stage2Guider: '5517:4964',
  stage2Separate: '5517:4973',
  decode: '5518:5538',
  audioDecode: '5518:4848',
  createVideo: '5518:4849',
  save: '4852',
} as const

/** The image branch: loading, resizing, preprocessing and the in-place conditioning in both stages. */
const IMAGE_NODES = ['2004', '5014:4990', '5514:3336', '5514:3159', '5517:4970', '5014:5506', '5014:5019']

export const MODEL_FILES: Record<GpuPrecision, { unet: string; textEncoder: string }> = {
  bf16: { unet: 'ltx-2.5-22b-distilled-transformer-bf16.safetensors', textEncoder: 'gemma4-12b-with-proj-ltx-2.5-bf16.safetensors' },
  int8: { unet: 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', textEncoder: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors' },
}

/**
 * Every model file the core graph loads, under the volume's models folder (read ahead while a pod boots): the
 * precision's transformer and text encoder plus the shared VAEs and upscaler the workflow names.
 */
export function modelPaths(precision: GpuPrecision): string[] {
  const named = (id: string, key: string) => String((core as ApiGraph)[id]!.inputs[key])
  return [
    `text_encoders/${MODEL_FILES[precision].textEncoder}`,
    `diffusion_models/${MODEL_FILES[precision].unet}`,
    `vae/${named(N.videoVae, 'vae_name')}`,
    `vae/${named(N.audioVae, 'vae_name')}`,
    `latent_upscale_models/${named('5575:5577', 'model_name')}`,
  ]
}

/** Licon Studio's Multiple-Subject-Reference IC-LoRA (on the volume since setup): up to 4 subjects and a background. */
export const MSR_LORA = 'LTX-2.5-Licon-MSR-V2.safetensors'

/**
 * Camera-guide IC-LoRAs (on the volume since setup v2): Lightricks' Layout-To-Render follows a grey-box playblast as
 * it is (camera path, placement; the look comes from the start frame and the prompt), Union Control follows a depth
 * render (guide encoded at half size, read from the loader's latent_downscale_factor).
 */
export const GUIDE_LORAS = {
  layout: 'ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors',
  depth: 'ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors',
} as const
export type GuideKind = keyof typeof GUIDE_LORAS
/** Each guide LoRA's latent downscale factor (from its file name: "ref0.5" encodes the guide at half size). */
const GUIDE_DOWNSCALE: Record<GuideKind, number> = { layout: 1, depth: 2 }

export interface CoreGraphInput {
  prompt: string
  negative?: string
  fps: number
  /** Length of the delivered clip. */
  seconds: number
  /** Final size (multiples of 64); the first stage renders at half of it. */
  width: number
  height: number
  seed: number
  /** Uploaded start frame (a file in ComfyUI's input folder): image-to-video. */
  image?: string
  /** Uploaded end frame: the shot ends on it. */
  lastImage?: string
  /** Uploaded frames the shot passes through, spread evenly between its start and end. */
  midImages?: string[]
  /** Where each of `midImages` lands, in seconds of the delivered clip (multi-shot cuts) instead of evenly spread. */
  midSeconds?: number[]
  /** Uploaded references for people and objects (MSR pic1–pic4): the prompt calls them Image 1, Image 2… */
  references?: string[]
  /** Uploaded reference for the place (MSR background): the image after the others. */
  background?: string
  /** Uploaded voices of the first two references (MSR-V2 audio references): Audio 1 is Image 1's, Audio 2 Image 2's. */
  voices?: (string | undefined)[]
  /** Uploaded audio the video is made to (lip sync, music): it is also the clip's sound. */
  audioFile?: string
  /** Uploaded ending of a clip to continue: RUNPOD_CONTINUE_FRAMES frames at this render's size and fps. */
  continueClip?: string
  /**
   * Uploaded camera guide (a Blender previs) at this render's size, fps and frame count: the clip follows its camera
   * and placement. `layout` is a grey-box playblast (guides both stages), `depth` a depth render (guides the first).
   */
  guide?: { video: string; kind: GuideKind; strength: number }
  audio: boolean
  precision: GpuPrecision
  /** SaveVideo prefix, e.g. "wildroom/<generationId>". */
  prefix: string
  /** Add the 4K detail pass: the result is twice the size in both directions. */
  upscale4k?: boolean
}

/** Frames the graph renders: 1 + 8k (the graph computes the same from fps and seconds). */
export const graphFrames = (fps: number, seconds: number) => 1 + Math.floor((fps * seconds) / 8) * 8

/** Seconds the graph renders: a continued clip's lead-in frames come on top of the delivered length. */
export const renderedSeconds = (input: Pick<CoreGraphInput, 'fps' | 'seconds' | 'continueClip'>) =>
  input.seconds + (input.continueClip ? CONTINUE_FRAMES / input.fps : 0)

/** Where the stills land: the end frame on the last frame, the others spread evenly between the start and the end. */
export function guideFrameIndices(frames: number, midCount: number, leadIn = 0): number[] {
  const span = frames - 1 - leadIn
  return Array.from({ length: midCount }, (_, i) => leadIn + Math.round(((i + 1) * span) / (midCount + 1)))
}

/**
 * Where the stills land when their times are given (a multi-shot group's cuts): each at its second of the delivered
 * clip, kept strictly inside it and in order. Falls back to the even spread when the times don't match the stills.
 */
export function guideFrameIndicesAt(frames: number, fps: number, seconds: number[] | undefined, midCount: number, leadIn = 0): number[] {
  if (!seconds || seconds.length !== midCount) return guideFrameIndices(frames, midCount, leadIn)
  let previous = leadIn
  return seconds.map((s) => {
    const idx = Math.min(frames - 2, Math.max(previous + 1, leadIn + Math.round(s * fps)))
    previous = idx
    return idx
  })
}

/**
 * Text/image-to-video in two stages (half size, then 2× latent upscale and refine), with audio, plus every other
 * input LTX-2.5 takes: an end frame and frames in between (LTXVAddGuide), up to 4 subject references and a background
 * (Licon MSR), audio to follow (A2V: the audio latent is kept, not denoised), a clip to continue, and the 4K pass.
 * Guides are added in both stages and cropped after each, as the MSR and LTX guide nodes require.
 */
export function buildCoreGraph(input: CoreGraphInput): ApiGraph {
  const g = structuredClone(core) as ApiGraph
  const set = (id: string, key: string, value: unknown) => {
    const node = g[id]
    if (!node) throw new Error(`Workflow node ${id} is missing`)
    node.inputs[key] = value
  }
  let next = 7000
  const add = (class_type: string, inputs: Record<string, unknown>): string => {
    const id = String(++next)
    if (g[id]) throw new Error(`Workflow node ${id} is already used`)
    g[id] = { class_type, inputs }
    return id
  }
  const out = (id: string, index = 0): Link => [id, index]

  const seconds = renderedSeconds(input)
  const frames = graphFrames(input.fps, seconds)
  set(N.prompt, 'value', input.prompt)
  set(N.negative, 'value', input.negative ?? '')
  set(N.fps, 'value', input.fps)
  set(N.seconds, 'value', seconds)
  set(N.stage1Latent, 'width', Math.round(input.width / 2))
  set(N.stage1Latent, 'height', Math.round(input.height / 2))
  set(N.noise1, 'noise_seed', input.seed)
  set(N.noise2, 'noise_seed', input.seed)
  set(N.unet, 'unet_name', MODEL_FILES[input.precision].unet)
  set(N.textEncoder, 'clip_name', MODEL_FILES[input.precision].textEncoder)
  set(N.save, 'filename_prefix', input.prefix)
  // The start frame is conditioned in place (first latent frames); without one, the empty latents go straight in.
  // With a layout guide it is the look still instead (a guide before the clip, see guideStage): Lightricks'
  // Layout-To-Render workflow never pins the first frame, or the camera would stay where that picture was taken.
  const inPlace = Boolean(input.image) && input.guide?.kind !== 'layout'
  if (inPlace) {
    set(N.image, 'image', input.image)
    set(N.useImage, 'value', true)
  } else {
    for (const id of IMAGE_NODES) delete g[id]
  }
  const stageInput = { 1: out(inPlace ? '5514:3159' : N.stage1Latent), 2: out(inPlace ? '5517:4970' : N.upsampler) }

  // Subject references: the MSR LoRA on the model and a reference guide in each stage. A lone background is pic1.
  const references = (input.references ?? []).slice(0, MAX_REFERENCES)
  const pics = [...references, ...(input.background && !references.length ? [input.background] : [])].map((name) => add('LoadImage', { image: name }))
  const background = input.background && references.length ? add('LoadImage', { image: input.background }) : undefined
  const msr = pics.length ? add('ComfyUILTX25MSRICLoRALoader', { model: out(N.unet), lora_name: MSR_LORA, strength_model: 1 }) : undefined
  if (msr) {
    set(N.stage1Guider, 'model', out(msr))
    set(N.stage2Guider, 'model', out(msr))
  }
  // Camera guide: its IC-LoRA on top of the model (after MSR). Layout-To-Render keeps it in the refine stage too;
  // Union guides only the first stage, so the refine samples without it.
  const guideLora = input.guide
    ? add('LTXICLoRALoaderModelOnly', { lora_name: GUIDE_LORAS[input.guide.kind], strength_model: 1, model: out(msr ?? N.unet) })
    : undefined
  const guideFrames = input.guide ? out(add('GetVideoComponents', { video: out(add('LoadVideo', { file: input.guide.video })) })) : undefined
  const guideInStage = (stage: 1 | 2) => Boolean(guideLora) && (stage === 1 || input.guide!.kind === 'layout')
  const lookStill = input.image && input.guide?.kind === 'layout' ? add('LoadImage', { image: input.image }) : undefined
  // The guide is fitted to the first-stage latent and then downscaled: that latent must divide by the factor
  // (Union: 640×352 is 20×11 latents, and 11 does not halve). runpodSize picks such sizes.
  const factor = input.guide ? GUIDE_DOWNSCALE[input.guide.kind] : 1
  if (factor > 1 && ((input.width / 2) % (32 * factor) || (input.height / 2) % (32 * factor))) {
    throw new Error(`A ${input.guide!.kind} guide needs a size in steps of ${64 * factor} px (got ${input.width}×${input.height})`)
  }
  if (guideLora) {
    set(N.stage1Guider, 'model', out(guideLora))
    if (guideInStage(2)) set(N.stage2Guider, 'model', out(guideLora))
  }
  // Voices of the first two references, encoded once and given to both stages' guides.
  const voices: Record<string, Link> = {}
  ;(input.voices ?? []).slice(0, 2).forEach((name, i) => {
    if (!name || i >= references.length) return
    const encoded = add('LTXVAudioVAEEncode', { audio: out(add('LoadAudio', { audio: name })), audio_vae: out(N.audioVae) })
    voices[`audio_ref${i + 1}`] = out(encoded)
  })

  // Frames to pass through: a clip's ending at the start, stills between, the end frame last.
  const leadIn = input.continueClip ? CONTINUE_FRAMES : 0
  const guides: { source: Link; frameIdx: number; still: boolean }[] = []
  if (input.continueClip) {
    const clip = add('GetVideoComponents', { video: out(add('LoadVideo', { file: input.continueClip })) })
    guides.push({ source: out(clip), frameIdx: 0, still: false })
  }
  const mids = input.midImages ?? []
  guideFrameIndicesAt(frames, input.fps, input.midSeconds, mids.length, leadIn).forEach((frameIdx, i) => {
    guides.push({ source: out(add('LoadImage', { image: mids[i] })), frameIdx, still: true })
  })
  if (input.lastImage) guides.push({ source: out(add('LoadImage', { image: input.lastImage })), frameIdx: -1, still: true })

  const guideStage = (stage: 1 | 2, latentIn: Link) => {
    const width = stage === 1 ? Math.round(input.width / 2) : input.width
    const height = stage === 1 ? Math.round(input.height / 2) : input.height
    let positive = out(N.conditioning, 0)
    let negative = out(N.conditioning, 1)
    let latent = latentIn
    if (msr) {
      const refs: Record<string, Link> = Object.fromEntries(pics.map((id, i) => [`pic${i + 1}`, out(id)]))
      const node = add('ComfyUILTX25MSRMultiReferenceGuide', {
        positive,
        negative,
        vae: out(N.videoVae),
        latent,
        ...refs,
        ...(background ? { background: out(background) } : {}),
        ...voices,
        strength: 1,
        reference_frames: String(MSR_REFERENCE_FRAMES),
        use_tiled_encode: false,
        tile_size: 256,
        tile_overlap: 64,
        msr_parameters: out(msr, 1),
      })
      ;[positive, negative, latent] = [out(node, 0), out(node, 1), out(node, 2)]
    }
    if (guideFrames && guideInStage(stage)) {
      // The guide is encoded at its own size over the LoRA's downscale factor, so both sides must be multiples of
      // 32 × that factor (Union's ref0.5: 64), as Lightricks' workflows snap it; the node fits it to the latent.
      const step = 32 * GUIDE_DOWNSCALE[input.guide!.kind]
      const snap = (v: number) => Math.max(step, Math.round(v / step) * step)
      const scaled = add('ImageScale', { image: guideFrames, upscale_method: 'lanczos', width: snap(width), height: snap(height), crop: 'center' })
      const icGuide = (image: Link, frameIdx: number, strength: number, crop: string) => {
        const node = add('LTXAddVideoICLoRAGuide', {
          positive,
          negative,
          vae: out(N.videoVae),
          latent,
          image,
          frame_idx: frameIdx,
          strength,
          latent_downscale_factor: out(guideLora!, 1),
          crop,
          use_tiled_encode: false,
          tile_size: 256,
          tile_overlap: 64,
          use_streaming: false,
          tile_frames: 97,
        })
        ;[positive, negative, latent] = [out(node, 0), out(node, 1), out(node, 2)]
      }
      icGuide(out(scaled), 0, input.guide!.strength, 'disabled')
      // Layout-To-Render's look still: a guide just before the clip (frame -1), in both stages.
      if (lookStill) icGuide(out(lookStill), -1, 1, 'center')
    }
    for (const guide of guides) {
      const scaled = add('ImageScale', { image: guide.source, upscale_method: 'lanczos', width, height, crop: 'center' })
      // Stills get the same light compression as the start frame, so they sit among video frames. Like the start
      // frame (and Comfy's first-last-frame template), they guide the first stage at 0.7 and pin the refine at 1.
      const image = guide.still ? add('LTXVPreprocess', { image: out(scaled), img_compression: 18 }) : scaled
      const strength = guide.still && stage === 1 ? 0.7 : 1
      const node = add('LTXVAddGuide', { positive, negative, vae: out(N.videoVae), latent, image: out(image), frame_idx: guide.frameIdx, strength })
      ;[positive, negative, latent] = [out(node, 0), out(node, 1), out(node, 2)]
    }
    return { positive, negative, latent, guided: Boolean(msr) || guides.length > 0 || guideInStage(stage) }
  }
  /** The stage's sampled video latent, with the appended guide frames and reference slots removed. */
  const cropped = (stage: { positive: Link; negative: Link; guided: boolean }, separated: string): Link =>
    stage.guided ? out(add('LTXVCropGuides', { positive: stage.positive, negative: stage.negative, latent: out(separated, 0) }), 2) : out(separated, 0)

  const stage1 = guideStage(1, stageInput[1])
  set(N.stage1Concat, 'video_latent', stage1.latent)
  set(N.stage1Guider, 'positive', stage1.positive)
  set(N.stage1Guider, 'negative', stage1.negative)
  set(N.upsampler, 'samples', cropped(stage1, N.stage1Separate))

  const stage2 = guideStage(2, stageInput[2])
  set(N.stage2Concat, 'video_latent', stage2.latent)
  set(N.stage2Guider, 'positive', stage2.positive)
  set(N.stage2Guider, 'negative', stage2.negative)
  const finalLatent = cropped(stage2, N.stage2Separate)
  set(N.decode, 'samples', finalLatent)

  // Audio to follow: encoded and masked so neither stage changes it; the clip's sound is the audio itself.
  let sound: Link | undefined = input.audio ? out(N.audioDecode) : undefined
  if (input.audioFile) {
    const trimmed = add('TrimAudioDuration', { audio: out(add('LoadAudio', { audio: input.audioFile })), start_index: 0, duration: frames / input.fps })
    const encoded = add('LTXVAudioVAEEncode', { audio: out(trimmed), audio_vae: out(N.audioVae) })
    const kept = add('SetLatentNoiseMask', { samples: out(encoded), mask: out(add('SolidMask', { value: 0, width: 1024, height: 1024 })) })
    set(N.stage1Concat, 'audio_latent', out(kept))
    set(N.stage2Concat, 'audio_latent', out(kept))
    sound = out(trimmed)
  }

  let images: Link = input.upscale4k ? addDetailPass(g, input, finalLatent) : out(N.decode)
  // A continued clip: cut the lead-in, which repeats the clip's ending.
  if (leadIn) {
    images = out(add('ImageFromBatch', { image: images, batch_index: leadIn, length: frames - leadIn }))
    if (sound) sound = out(add('TrimAudioDuration', { audio: sound, start_index: leadIn / input.fps, duration: (frames - leadIn) / input.fps }))
  }
  set(N.createVideo, 'images', images)
  if (sound) set(N.createVideo, 'audio', sound)
  else delete g[N.createVideo]!.inputs.audio
  return g
}

/** The IC-LoRA the 4K pass refines details with (on the volume since setup). */
export const DETAIL_LORA = 'ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors'
/**
 * The 4K pass's prompt, Lightricks' own: look and finish only. Anything it names (a person, an object) would be
 * stamped into every tile, so the user's prompt is not used here.
 */
export const DETAIL_PROMPT = 'The same scene, sharper and more detailed, fine textures, clean edges.'

/**
 * The second stage of Lightricks' LTX-2.5_V2V_TiledFusion_Native_4K_8K, run on this graph's 1080p result: the final
 * latent is upscaled ×2, then 3 distilled steps of the tiled fusion sampler (overlapping Full HD tiles fused after
 * every step) refine it at full size with the Refine-Details IC-LoRA, guided by the decoded 1080p frames. Returns the
 * decoded 4K frames.
 */
function addDetailPass(g: ApiGraph, input: CoreGraphInput, latent: Link): Link {
  const vae = [N.videoVae, 0]
  const frames = ['5014:4988', 0]
  const fps = ['5014:5017', 0]
  const tiles = '6005'
  const nodes: ApiGraph = {
    '6001': { class_type: 'LTXICLoRALoaderModelOnly', inputs: { lora_name: DETAIL_LORA, strength_model: 1, model: [N.unet, 0] } },
    '6002': { class_type: 'LTXVLatentUpsampler', inputs: { samples: latent, upscale_model: ['5575:5577', 0], vae } },
    '6003': { class_type: 'CLIPTextEncode', inputs: { text: DETAIL_PROMPT, clip: [N.textEncoder, 0] } },
    '6004': { class_type: 'LTXVConditioning', inputs: { positive: ['6003', 0], negative: [N.conditioning, 1], frame_rate: fps } },
    [tiles]: {
      class_type: 'LTXVGetTilingSizes',
      inputs: { width: input.width, height: input.height, frame_count: frames, tile_size: 'FullHD', initial_canvas_size: 'FullHD', output_size: '4K' },
    },
    '6006': {
      class_type: 'ImageScale',
      inputs: { upscale_method: 'lanczos', crop: 'disabled', image: [N.decode, 0], width: input.width * 2, height: input.height * 2 },
    },
    '6007': {
      class_type: 'LTXAddVideoICLoRAGuide',
      inputs: {
        frame_idx: 0,
        strength: 1,
        crop: 'disabled',
        use_tiled_encode: false,
        tile_size: 256,
        tile_overlap: 64,
        use_streaming: true,
        positive: ['6004', 0],
        negative: ['6004', 1],
        vae,
        latent: ['6002', 0],
        image: ['6006', 0],
        latent_downscale_factor: ['6001', 1],
        tile_frames: [tiles, 7],
      },
    },
    '6008': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '6009': { class_type: 'ManualSigmas', inputs: { sigmas: '0.909375, 0.725, 0.421875, 0.0' } },
    '6010': {
      class_type: 'LTXVTiledFusionSampler',
      inputs: {
        seed: input.seed,
        cfg: 1,
        blend_var: 0.05,
        grid_cycle: 1,
        canvas_device: 'auto',
        model: ['6001', 0],
        positive: ['6007', 0],
        negative: ['6007', 1],
        latents: ['6007', 2],
        sigmas: ['6009', 0],
        sampler: ['6008', 0],
        tile_width: [tiles, 2],
        tile_height: [tiles, 3],
        overlap_frac: [tiles, 6],
        tile_frames: [tiles, 7],
        vae,
      },
    },
    '6011': { class_type: 'VAEDecodeTiled', inputs: { tile_size: 512, overlap: 64, temporal_size: 128, temporal_overlap: 32, samples: ['6010', 0], vae } },
  }
  for (const id of Object.keys(nodes)) if (g[id]) throw new Error(`Workflow node ${id} is already used`)
  Object.assign(g, nodes)
  return ['6011', 0]
}

export interface UpscaleGraphInput {
  /** Uploaded source clip, already at `fps` and cut to `frames` (8k+1). */
  video: string
  frames: number
  fps: number
  /** Delivered size (multiples of 64); the source is encoded at half of it and the latent upscaled ×2. */
  width: number
  height: number
  seed: number
  /** Keep the source's sound. */
  audio: boolean
  precision: GpuPrecision
  prefix: string
}

/**
 * Upscales someone else's clip (e.g. a 480p Seedance render) to 1080p with Lightricks' V2V refine, the same pass as
 * the 4K one: the source is encoded at half the delivered size, its latent upscaled ×2, then 3 distilled steps of the
 * tiled fusion sampler refine it at full size with the Refine-Details IC-LoRA, guided by the source frames scaled to
 * that size. The picture follows the source frame for frame; the sound is the source's.
 */
export function buildUpscaleGraph(input: UpscaleGraphInput): ApiGraph {
  const half = { width: Math.round(input.width / 2), height: Math.round(input.height / 2) }
  const vae: Link = ['3', 0]
  const tiles = '15'
  const g: ApiGraph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: MODEL_FILES[input.precision].unet, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: MODEL_FILES[input.precision].textEncoder, type: 'ltxv', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: String((core as ApiGraph)[N.videoVae]!.inputs.vae_name) } },
    '4': { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: String((core as ApiGraph)['5575:5577']!.inputs.model_name) } },
    '5': { class_type: 'LoadVideo', inputs: { file: input.video } },
    '6': { class_type: 'GetVideoComponents', inputs: { video: ['5', 0] } },
    '7': { class_type: 'ImageFromBatch', inputs: { image: ['6', 0], batch_index: 0, length: input.frames } },
    '8': { class_type: 'ImageScale', inputs: { image: ['7', 0], upscale_method: 'lanczos', width: half.width, height: half.height, crop: 'center' } },
    '9': { class_type: 'VAEEncode', inputs: { pixels: ['8', 0], vae } },
    '10': { class_type: 'LTXVLatentUpsampler', inputs: { samples: ['9', 0], upscale_model: ['4', 0], vae } },
    '11': { class_type: 'LTXICLoRALoaderModelOnly', inputs: { lora_name: DETAIL_LORA, strength_model: 1, model: ['1', 0] } },
    '12': { class_type: 'CLIPTextEncode', inputs: { text: DETAIL_PROMPT, clip: ['2', 0] } },
    '13': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
    '14': { class_type: 'LTXVConditioning', inputs: { positive: ['12', 0], negative: ['13', 0], frame_rate: input.fps } },
    [tiles]: {
      class_type: 'LTXVGetTilingSizes',
      inputs: { width: half.width, height: half.height, frame_count: input.frames, tile_size: 'FullHD', initial_canvas_size: 'qHD', output_size: 'FullHD' },
    },
    '16': { class_type: 'ImageScale', inputs: { image: ['7', 0], upscale_method: 'lanczos', width: input.width, height: input.height, crop: 'center' } },
    '17': {
      class_type: 'LTXAddVideoICLoRAGuide',
      inputs: {
        frame_idx: 0,
        strength: 1,
        crop: 'disabled',
        use_tiled_encode: false,
        tile_size: 256,
        tile_overlap: 64,
        use_streaming: true,
        positive: ['14', 0],
        negative: ['14', 1],
        vae,
        latent: ['10', 0],
        image: ['16', 0],
        latent_downscale_factor: ['11', 1],
        tile_frames: [tiles, 7],
      },
    },
    '18': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '19': { class_type: 'ManualSigmas', inputs: { sigmas: '0.909375, 0.725, 0.421875, 0.0' } },
    '20': {
      class_type: 'LTXVTiledFusionSampler',
      inputs: {
        seed: input.seed,
        cfg: 1,
        blend_var: 0.05,
        grid_cycle: 1,
        canvas_device: 'auto',
        model: ['11', 0],
        positive: ['17', 0],
        negative: ['17', 1],
        latents: ['17', 2],
        sigmas: ['19', 0],
        sampler: ['18', 0],
        tile_width: [tiles, 2],
        tile_height: [tiles, 3],
        overlap_frac: [tiles, 6],
        tile_frames: [tiles, 7],
        vae,
      },
    },
    '21': { class_type: 'VAEDecodeTiled', inputs: { tile_size: 512, overlap: 64, temporal_size: 128, temporal_overlap: 32, samples: ['20', 0], vae } },
    '22': { class_type: 'CreateVideo', inputs: { bit_depth: 8, color_space: 'sRGB', images: ['21', 0], fps: input.fps, ...(input.audio ? { audio: ['6', 1] } : {}) } },
    '23': { class_type: 'SaveVideo', inputs: { filename_prefix: input.prefix, format: 'auto', video: ['22', 0], 'format.codec': 'auto' } },
  }
  return g
}

/** Links pointing at nodes that are not in the graph (a broken edit). */
export function danglingLinks(g: ApiGraph): string[] {
  const out: string[] = []
  for (const [id, node] of Object.entries(g)) {
    for (const [key, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && !(value[0] in g)) out.push(`${id}.${key} → ${value[0]}`)
    }
  }
  return out
}
