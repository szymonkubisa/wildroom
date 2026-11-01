import { ApiError, ValidationError } from '@fal-ai/client'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { falModels } from '../../src/shared/models/catalog/fal'
import { parseParams } from '../../src/shared/models/params'
import type { ModelSpec, ParamValues } from '../../src/shared/models/types'
import { join } from 'node:path'
import { type FalClientLike, createFalAdapter, fillPlaceholders, inputScale, outputsAtPath } from '../../src/server/providers/fal'
import { runFfmpeg } from '../../src/server/services/ffmpeg'
import { type JobContext, ProviderError } from '../../src/server/providers/types'
import { installFetch, jsonResponse, makeCtx, makeFixtures } from './helpers'

const model = (id: string): ModelSpec => falModels.find((m) => m.id === id)!
const fixtures = makeFixtures()
const CREDS = { apiKey: 'fal-test-key' }
const img = fixtures.image('img-a', 'AAAA')
const img2 = fixtures.image('img-b', 'BBBBBB')
const img3 = fixtures.image('img-c', 'CCCCCCCC')
const img4 = fixtures.image('img-d', 'DDDDDDDDDD')
const img5 = fixtures.image('img-e', 'EEEEEEEEEEEE')
const vid = fixtures.video('vid-a')
const aud = fixtures.audio('aud-a')
const uploaded = (n: number) => `https://v3.fal.media/files/upload-${n}`

afterEach(() => {
  vi.unstubAllGlobals()
})
afterAll(() => fixtures.cleanup())

function fakeFal() {
  let n = 0
  const uploads: { size: number; type: string }[] = []
  /** Bytes of each upload, read while uploading (temporary inputs are deleted right after). */
  const contents: ArrayBuffer[] = []
  const client = {
    queue: {
      submit: vi.fn(async (_endpointId: string, _options: { input: Record<string, unknown>; abortSignal?: AbortSignal }) => ({
        request_id: 'req-1',
      })),
      status: vi.fn(async (_endpointId: string, _options: { requestId: string; logs?: boolean; abortSignal?: AbortSignal }) => ({
        status: 'IN_PROGRESS' as string,
      })),
      result: vi.fn(async (_endpointId: string, _options: { requestId: string; abortSignal?: AbortSignal }) => ({ data: {} as unknown })),
      cancel: vi.fn(async (_endpointId: string, _options: { requestId: string }) => {}),
    },
    storage: {
      upload: vi.fn(async (blob: Blob) => {
        uploads.push({ size: blob.size, type: blob.type })
        contents.push(await blob.arrayBuffer())
        return uploaded(++n)
      }),
    },
  } satisfies FalClientLike
  const factory = vi.fn((_apiKey: string) => client)
  return { client, factory, uploads, contents }
}

async function submitWith(modelId: string, params: ParamValues, inputs: JobContext['inputs'] = {}) {
  const fal = fakeFal()
  const adapter = createFalAdapter({ createClient: fal.factory })
  const { ctx, records } = makeCtx(model(modelId), params, { inputs, credentials: CREDS })
  const result = await adapter.submit(ctx)
  const call = fal.client.queue.submit.mock.calls[0]!
  return { result, endpointId: call[0], input: call[1].input, records, fal }
}

describe('fal request mapping', () => {
  it.each([
    [
      'nano banana pro text-to-image',
      'fal-nano-banana-pro',
      { prompt: 'A castle at dawn' },
      {},
      'fal-ai/nano-banana-pro',
      { prompt: 'A castle at dawn', aspect_ratio: '16:9', resolution: '2K', num_images: 1, output_format: 'png' },
    ],
    [
      'nano banana pro edit',
      'fal-nano-banana-pro',
      { prompt: 'Put her in the castle', referenceImages: ['img-a', 'img-b'], aspectRatio: 'auto', seed: 11 },
      { referenceImages: [img, img2] },
      'fal-ai/nano-banana-pro/edit',
      {
        prompt: 'Put her in the castle',
        image_urls: [uploaded(1), uploaded(2)],
        aspect_ratio: 'auto',
        resolution: '2K',
        seed: 11,
        num_images: 1,
        output_format: 'png',
      },
    ],
    [
      'nano banana 2',
      'fal-nano-banana-2',
      { prompt: 'Storyboard frame', resolution: '0.5K', aspectRatio: '9:16' },
      {},
      'fal-ai/nano-banana-2',
      { prompt: 'Storyboard frame', aspect_ratio: '9:16', resolution: '0.5K', num_images: 1, output_format: 'png' },
    ],
    [
      'nano banana 2 edit',
      'fal-nano-banana-2',
      { prompt: 'Same shot at night', referenceImages: ['img-a'] },
      { referenceImages: [img] },
      'fal-ai/nano-banana-2/edit',
      { prompt: 'Same shot at night', image_urls: [uploaded(1)], aspect_ratio: '16:9', resolution: '1K', num_images: 1, output_format: 'png' },
    ],
    [
      'seedream 5 pro',
      'fal-seedream-5-pro',
      { prompt: 'Desert road' },
      {},
      'bytedance/seedream/v5/pro/text-to-image',
      { prompt: 'Desert road', image_size: { width: 2560, height: 1440 }, num_images: 1, output_format: 'png' },
    ],
    [
      'seedream 5 pro edit',
      'fal-seedream-5-pro',
      { prompt: 'Add rain', referenceImages: ['img-a'], aspectRatio: 'auto', resolution: 'standard' },
      { referenceImages: [img] },
      'bytedance/seedream/v5/pro/edit',
      { prompt: 'Add rain', image_urls: [uploaded(1)], image_size: 'auto_1K', num_images: 1, output_format: 'png' },
    ],
    [
      'flux 2 pro',
      'fal-flux-2-pro',
      { prompt: 'Neon alley', seed: 5 },
      {},
      'fal-ai/flux-2-pro',
      { prompt: 'Neon alley', image_size: { width: 1920, height: 1088 }, seed: 5, output_format: 'png' },
    ],
    [
      'flux 2 pro edit',
      'fal-flux-2-pro',
      { prompt: 'Make it snow', referenceImages: ['img-a'], aspectRatio: 'auto' },
      { referenceImages: [img] },
      'fal-ai/flux-2-pro/edit',
      { prompt: 'Make it snow', image_urls: [uploaded(1)], image_size: 'auto', output_format: 'png' },
    ],
    [
      'veo 3.1 text-to-video',
      'fal-veo3.1',
      { prompt: 'Drone shot over a fjord', negativePrompt: 'blurry' },
      {},
      'fal-ai/veo3.1',
      {
        prompt: 'Drone shot over a fjord',
        negative_prompt: 'blurry',
        duration: '8s',
        aspect_ratio: '16:9',
        resolution: '720p',
        generate_audio: true,
      },
    ],
    [
      'veo 3.1 image-to-video',
      'fal-veo3.1',
      { prompt: 'She smiles', firstFrame: 'img-a', duration: 4, resolution: '4k', audio: false, seed: 3 },
      { firstFrame: img },
      'fal-ai/veo3.1/image-to-video',
      { prompt: 'She smiles', image_url: uploaded(1), duration: '4s', resolution: '4k', generate_audio: false, seed: 3 },
    ],
    [
      'veo 3.1 first+last frame',
      'fal-veo3.1',
      { prompt: 'Morph', firstFrame: 'img-a', lastFrame: 'img-b', duration: 6 },
      { firstFrame: img, lastFrame: img2 },
      'fal-ai/veo3.1/first-last-frame-to-video',
      { prompt: 'Morph', first_frame_url: uploaded(1), last_frame_url: uploaded(2), duration: '6s', resolution: '720p', generate_audio: true },
    ],
    [
      'veo 3.1 fast image-to-video',
      'fal-veo3.1-fast',
      { prompt: 'Wind in the trees', firstFrame: 'img-a', resolution: '720p' },
      { firstFrame: img },
      'fal-ai/veo3.1/fast/image-to-video',
      { prompt: 'Wind in the trees', image_url: uploaded(1), duration: '8s', resolution: '720p', generate_audio: true },
    ],
    [
      'veo 3.1 reference-to-video: 8 s, no negative prompt or seed',
      'fal-veo3.1',
      { prompt: 'Maja and Tymon walk along the platform', referenceImages: ['img-a', 'img-b'], negativePrompt: 'subtitles', seed: 3 },
      { referenceImages: [img, img2] },
      'fal-ai/veo3.1/reference-to-video',
      {
        prompt: 'Maja and Tymon walk along the platform',
        image_urls: [uploaded(1), uploaded(2)],
        duration: '8s',
        aspect_ratio: '16:9',
        resolution: '720p',
        generate_audio: true,
      },
    ],
    [
      'veo 3.1 fast reference-to-video',
      'fal-veo3.1-fast',
      { prompt: 'She waves', referenceImages: ['img-a'], aspectRatio: '9:16', resolution: '720p', audio: false },
      { referenceImages: [img] },
      'fal-ai/veo3.1/fast/reference-to-video',
      { prompt: 'She waves', image_urls: [uploaded(1)], duration: '8s', aspect_ratio: '9:16', resolution: '720p', generate_audio: false },
    ],
    [
      'veo 3.1 fast text-to-video',
      'fal-veo3.1-fast',
      { prompt: 'Rain on glass', aspectRatio: '9:16' },
      {},
      'fal-ai/veo3.1/fast',
      { prompt: 'Rain on glass', duration: '8s', aspect_ratio: '9:16', resolution: '720p', generate_audio: true },
    ],
    [
      'seedance 2.5 text-to-video',
      'fal-seedance-2.5',
      { prompt: 'A chase through a market', duration: 12, aspectRatio: '21:9' },
      {},
      'bytedance/seedance-2.5/text-to-video',
      { prompt: 'A chase through a market', duration: '12', resolution: '720p', aspect_ratio: '21:9', generate_audio: true },
    ],
    [
      'seedance 2.5 image-to-video with end frame',
      'fal-seedance-2.5',
      { prompt: 'Door opens', firstFrame: 'img-a', lastFrame: 'img-b', audio: false, resolution: '1080p' },
      { firstFrame: img, lastFrame: img2 },
      'bytedance/seedance-2.5/image-to-video',
      { prompt: 'Door opens', image_url: uploaded(1), end_image_url: uploaded(2), duration: '5', resolution: '1080p', generate_audio: false },
    ],
    [
      'wan 3.0 text-to-video',
      'fal-wan-3.0',
      { prompt: 'Koi pond', seed: 9 },
      {},
      'alibaba/wan-3.0/text-to-video',
      { prompt: 'Koi pond', duration: 5, resolution: '720p', aspect_ratio: '16:9', audio: true, seed: 9 },
    ],
    [
      'wan 3.0 image-to-video',
      'fal-wan-3.0',
      { prompt: 'Petals fall', firstFrame: 'img-a', lastFrame: 'img-b', duration: 20, resolution: '480p' },
      { firstFrame: img, lastFrame: img2 },
      'alibaba/wan-3.0/image-to-video',
      { prompt: 'Petals fall', start_image_url: uploaded(1), end_image_url: uploaded(2), duration: 20, resolution: '480p', audio: true },
    ],
    [
      'minimax h3 max text-to-video',
      'fal-minimax-h3-max',
      { prompt: 'Parkour over rooftops' },
      {},
      'minimax/h3-max/text-to-video',
      { prompt: 'Parkour over rooftops', duration: 5, resolution: '768P', aspect_ratio: '16:9', prompt_expansion_mode: 'balanced' },
    ],
    [
      'minimax h3 max end-frame only',
      'fal-minimax-h3-max',
      { prompt: 'Land on the ledge', lastFrame: 'img-b', resolution: '1080p', promptExpansion: 'disabled', duration: 8 },
      { lastFrame: img2 },
      'minimax/h3-max/image-to-video',
      { prompt: 'Land on the ledge', end_image_url: uploaded(1), duration: 8, resolution: '1080P', prompt_expansion_mode: 'disabled' },
    ],
    [
      'pixverse v6 text-to-video',
      'fal-pixverse-v6',
      { prompt: 'Clay robot waves', multiClip: true, duration: 8 },
      {},
      'fal-ai/pixverse/v6/text-to-video',
      {
        prompt: 'Clay robot waves',
        duration: 8,
        resolution: '720p',
        aspect_ratio: '16:9',
        generate_audio_switch: true,
        generate_multi_clip_switch: true,
      },
    ],
    [
      'pixverse v6 image-to-video',
      'fal-pixverse-v6',
      { prompt: 'It starts to dance', firstFrame: 'img-a', audio: false, negativePrompt: 'text' },
      { firstFrame: img },
      'fal-ai/pixverse/v6/image-to-video',
      {
        prompt: 'It starts to dance',
        negative_prompt: 'text',
        image_url: uploaded(1),
        duration: 5,
        resolution: '720p',
        generate_audio_switch: false,
        generate_multi_clip_switch: false,
      },
    ],
    [
      'ltx 2.5 pro text-to-video',
      'fal-ltx-2.5-pro',
      { prompt: 'Slow push-in on a candle' },
      {},
      'lightricks/ltx-2.5/text-to-video/pro',
      { prompt: 'Slow push-in on a candle', duration: 6, resolution: '720p', aspect_ratio: '16:9', fps: 24, generate_audio: true },
    ],
    [
      'ltx 2.5 pro image-to-video',
      'fal-ltx-2.5-pro',
      { prompt: 'Camera rises', firstFrame: 'img-a', lastFrame: 'img-b', cameraMotion: 'jib_up', fps: 50, duration: 10 },
      { firstFrame: img, lastFrame: img2 },
      'lightricks/ltx-2.5/image-to-video/pro',
      {
        prompt: 'Camera rises',
        image_url: uploaded(1),
        end_image_url: uploaded(2),
        duration: 10,
        resolution: '720p',
        fps: 50,
        generate_audio: true,
        camera_motion: 'jib_up',
      },
    ],
    [
      'sync lipsync 3',
      'fal-sync-lipsync-v3',
      { video: 'vid-a', audioClip: 'aud-a', syncMode: 'loop' },
      { video: vid, audioClip: aud },
      'fal-ai/sync-lipsync/v3',
      { video_url: uploaded(1), audio_url: uploaded(2), sync_mode: 'loop' },
    ],
    [
      'mmaudio foley',
      'fal-mmaudio-v2',
      { video: 'vid-a', prompt: 'Footsteps on gravel', negativePrompt: 'music', durationSeconds: 12, seed: 4 },
      { video: vid },
      'fal-ai/mmaudio-v2',
      { video_url: uploaded(1), prompt: 'Footsteps on gravel', negative_prompt: 'music', duration: 12, seed: 4 },
    ],
    [
      'stable audio 2.5',
      'fal-stable-audio-2.5',
      { prompt: 'Lo-fi piano', durationSeconds: 90 },
      {},
      'fal-ai/stable-audio-25/text-to-audio',
      { prompt: 'Lo-fi piano', seconds_total: 90 },
    ],
    [
      'topaz video upscale (defaults: 2×, source fps)',
      'fal-topaz-upscale-video',
      { video: 'vid-a' },
      { video: vid },
      'fal-ai/topaz/upscale/video',
      { video_url: uploaded(1), model: 'Proteus', upscale_factor: 2, H264_output: true },
    ],
    [
      'topaz video upscale with frame interpolation',
      'fal-topaz-upscale-video',
      { video: 'vid-a', scale: 4, targetFps: 60 },
      { video: vid },
      'fal-ai/topaz/upscale/video',
      { video_url: uploaded(1), model: 'Proteus', upscale_factor: 4, target_fps: 60, H264_output: true },
    ],
    [
      'seedvr2 video upscale',
      'fal-seedvr2-upscale-video',
      { video: 'vid-a' },
      { video: vid },
      'fal-ai/seedvr/upscale/video',
      { video_url: uploaded(1), upscale_mode: 'factor', upscale_factor: 2, output_format: 'X264 (.mp4)', output_quality: 'high' },
    ],
    [
      'seedvr2 video upscale 4× with seed',
      'fal-seedvr2-upscale-video',
      { video: 'vid-a', scale: 4, seed: 12 },
      { video: vid },
      'fal-ai/seedvr/upscale/video',
      { video_url: uploaded(1), upscale_mode: 'factor', upscale_factor: 4, seed: 12, output_format: 'X264 (.mp4)', output_quality: 'high' },
    ],
    [
      'topaz image upscale',
      'fal-topaz-upscale-image',
      { image: 'img-a' },
      { image: img },
      'fal-ai/topaz/upscale/image',
      { image_url: uploaded(1), model: 'Standard V2', upscale_factor: 2, face_enhancement: true, output_format: 'png' },
    ],
    [
      'topaz image upscale 4× without face recovery',
      'fal-topaz-upscale-image',
      { image: 'img-a', scale: 4, faceEnhancement: false },
      { image: img },
      'fal-ai/topaz/upscale/image',
      { image_url: uploaded(1), model: 'Standard V2', upscale_factor: 4, face_enhancement: false, output_format: 'png' },
    ],
    [
      'bria background removal',
      'fal-bria-rmbg',
      { image: 'img-a' },
      { image: img },
      'fal-ai/bria/background/remove',
      { image_url: uploaded(1) },
    ],
    [
      'birefnet v2 defaults (light 2K at 2048)',
      'fal-birefnet-v2',
      { image: 'img-a' },
      { image: img },
      'fal-ai/birefnet/v2',
      { image_url: uploaded(1), model: 'General Use (Light 2K)', operating_resolution: '2048x2048', refine_foreground: true, output_format: 'png' },
    ],
    [
      'birefnet v2 matting at 1024',
      'fal-birefnet-v2',
      { image: 'img-a', mode: 'Matting', resolution: '1024x1024' },
      { image: img },
      'fal-ai/birefnet/v2',
      { image_url: uploaded(1), model: 'Matting', operating_resolution: '1024x1024', refine_foreground: true, output_format: 'png' },
    ],
    [
      'recraft vectorize',
      'fal-recraft-vectorize',
      { image: 'img-a' },
      { image: img },
      'fal-ai/recraft/vectorize',
      { image_url: uploaded(1) },
    ],
    [
      'gpt image 2.5 flare (1K 16:9)',
      'fal-gpt-image-2.5',
      { prompt: 'Poster that says HELLO' },
      {},
      'openai/gpt-image-2.5/flare/text-to-image',
      { prompt: 'Poster that says HELLO', image_size: { width: 1360, height: 768 }, quality: 'high', num_images: 1, output_format: 'png' },
    ],
    [
      'gpt image 2.5 sunburst 4K square, transparent',
      'fal-gpt-image-2.5',
      { prompt: 'Sticker of a fox', tier: 'sunburst', resolution: '4K', aspectRatio: '1:1', quality: 'max', transparent: true },
      {},
      'openai/gpt-image-2.5/sunburst/text-to-image',
      {
        prompt: 'Sticker of a fox',
        image_size: { width: 2880, height: 2880 },
        quality: 'max',
        background: 'transparent',
        num_images: 1,
        output_format: 'png',
      },
    ],
    [
      'gpt image 2.5 edit keeps the input shape',
      'fal-gpt-image-2.5',
      { prompt: 'Swap the label', referenceImages: ['img-a'], aspectRatio: 'auto' },
      { referenceImages: [img] },
      'openai/gpt-image-2.5/flare/edit',
      { prompt: 'Swap the label', image_urls: [uploaded(1)], image_size: 'auto', quality: 'high', num_images: 1, output_format: 'png' },
    ],
    [
      'recraft v3',
      'fal-recraft-v3',
      { prompt: 'Fox mascot', style: 'vector_illustration/line_art' },
      {},
      'fal-ai/recraft/v3/text-to-image',
      { prompt: 'Fox mascot', style: 'vector_illustration/line_art', image_size: 'landscape_16_9' },
    ],
    [
      'recraft v4.1 vector pro',
      'fal-recraft-v4.1-vector',
      { prompt: 'Coffee logo', pro: true },
      {},
      'fal-ai/recraft/v4.1/pro/text-to-vector',
      { prompt: 'Coffee logo', image_size: 'square_hd' },
    ],
    [
      'ideogram v4',
      'fal-ideogram-v4',
      { prompt: 'Poster: NIGHT SHIFT' },
      {},
      'ideogram/v4',
      {
        prompt: 'Poster: NIGHT SHIFT',
        image_size: { width: 1360, height: 768 },
        rendering_speed: 'BALANCED',
        expansion_model: 'None',
        num_images: 1,
        output_format: 'png',
      },
    ],
    [
      'ideogram v4 remix',
      'fal-ideogram-v4',
      { prompt: 'Make it retro', referenceImages: ['img-a'], aspectRatio: 'auto', speed: 'quality', promptExpansion: true, seed: 3 },
      { referenceImages: [img] },
      'ideogram/v4/image-to-image',
      {
        prompt: 'Make it retro',
        image_url: uploaded(1),
        strength: 0.8,
        image_size: 'auto',
        rendering_speed: 'QUALITY',
        expansion_model: 'Medium',
        seed: 3,
        num_images: 1,
        output_format: 'png',
      },
    ],
    [
      'krea 2 large with style references',
      'fal-krea-2',
      { prompt: 'Lighthouse', tier: 'large', referenceImages: ['img-a'], aspectRatio: '2.35:1', creativity: 'high' },
      { referenceImages: [img] },
      'krea/v2/large/text-to-image',
      { prompt: 'Lighthouse', aspect_ratio: '2.35:1', creativity: 'high', image_style_references: [{ image_url: uploaded(1), strength: 1 }] },
    ],
    [
      'krea 2 turbo',
      'fal-krea-2',
      { prompt: 'Quick sketch', tier: 'turbo', aspectRatio: '1:1' },
      {},
      'fal-ai/krea-2/turbo',
      { prompt: 'Quick sketch', image_size: { width: 1024, height: 1024 }, num_images: 1, output_format: 'png' },
    ],
    [
      'mai image 2.5 edit',
      'fal-mai-image-2.5',
      { prompt: 'Remove the car', referenceImages: ['img-a'], aspectRatio: 'auto' },
      { referenceImages: [img] },
      'microsoft/mai-image-2.5/edit',
      { prompt: 'Remove the car', image_urls: [uploaded(1)], aspect_ratio: 'auto', num_images: 1, output_format: 'png' },
    ],
    [
      'happy horse text-to-video',
      'fal-happy-horse-1.1',
      { prompt: 'A presenter says hello' },
      {},
      'alibaba/happy-horse/v1.1/text-to-video',
      { prompt: 'A presenter says hello', duration: 5, aspect_ratio: '16:9', resolution: '720p' },
    ],
    [
      'happy horse image-to-video',
      'fal-happy-horse-1.1',
      { prompt: 'She waves', firstFrame: 'img-a', duration: 8, resolution: '720p' },
      { firstFrame: img },
      'alibaba/happy-horse/v1.1/image-to-video',
      { prompt: 'She waves', image_url: uploaded(1), duration: 8, resolution: '720p' },
    ],
    [
      'happy horse reference-to-video',
      'fal-happy-horse-1.1',
      { prompt: 'The two of them talk', referenceImages: ['img-a', 'img-b'], aspectRatio: '9:16', seed: 4 },
      { referenceImages: [img, img2] },
      'alibaba/happy-horse/v1.1/reference-to-video',
      { prompt: 'The two of them talk', image_urls: [uploaded(1), uploaded(2)], duration: 5, aspect_ratio: '9:16', resolution: '720p', seed: 4 },
    ],
    [
      'gemini omni flash text-to-video',
      'fal-gemini-omni-flash',
      { prompt: 'Glass tips over', resolution: '360p' },
      {},
      'google/gemini-omni-flash/v1.1/text-to-video',
      { prompt: 'Glass tips over', duration: 8, aspect_ratio: '16:9', resolution: '360p' },
    ],
    [
      'gemini omni flash first-last frame',
      'fal-gemini-omni-flash',
      { prompt: 'Morph', firstFrame: 'img-a', lastFrame: 'img-b', duration: 5 },
      { firstFrame: img, lastFrame: img2 },
      'google/gemini-omni-flash/v1.1/image-to-video',
      { prompt: 'Morph', image_url: uploaded(1), end_image_url: uploaded(2), duration: 5, aspect_ratio: '16:9', resolution: '720p' },
    ],
    [
      'luma ray 3.2 loop',
      'fal-luma-ray-3.2',
      { prompt: 'Waves rolling', loop: true, duration: 10 },
      {},
      'luma/agent/ray/v3.2/text-to-video',
      { prompt: 'Waves rolling', duration: '10s', aspect_ratio: '16:9', resolution: '720p', loop: true },
    ],
    [
      'luma ray 3.2 end frame only',
      'fal-luma-ray-3.2',
      { prompt: 'Arrive at the door', lastFrame: 'img-b' },
      { lastFrame: img2 },
      'luma/agent/ray/v3.2/image-to-video',
      { prompt: 'Arrive at the door', end_image_url: uploaded(1), duration: '5s', aspect_ratio: '16:9', resolution: '720p' },
    ],
    [
      'kling 3.0 standard text-to-video (defaults)',
      'fal-kling-3.0',
      { prompt: 'Fireflies at dusk' },
      {},
      'fal-ai/kling-video/v3/standard/text-to-video',
      { prompt: 'Fireflies at dusk', duration: '5', aspect_ratio: '16:9', generate_audio: true },
    ],
    [
      'kling 3.0 standard image-to-video, silent',
      'fal-kling-3.0',
      { prompt: 'She looks up', firstFrame: 'img-a', lastFrame: 'img-b', resolution: '720p', audio: false, duration: 12 },
      { firstFrame: img, lastFrame: img2 },
      'fal-ai/kling-video/v3/standard/image-to-video',
      { prompt: 'She looks up', start_image_url: uploaded(1), end_image_url: uploaded(2), duration: '12', generate_audio: false },
    ],
    [
      'kling 3.0 image-to-video with elements, a shot list instead of the prompt, and a negative prompt',
      'fal-kling-3.0',
      {
        prompt: 'Shot 1 (3s): @Element1 waits. Shot 2 (2s): @Element2 smiles.',
        firstFrame: 'img-a',
        elementImages: ['img-b', 'img-c', 'img-d', 'img-e'],
        elementCounts: [2, 2],
        multiPrompt: [
          { prompt: 'Wide shot. @Element1 waits at the ticket machine.', duration: 3 },
          { prompt: 'Close-up shot. @Element2 smiles.', duration: 2 },
        ],
        negativePrompt: 'subtitles, captions',
      },
      { firstFrame: img, elementImages: [img2, img3, img4, img5] },
      'fal-ai/kling-video/v3/standard/image-to-video',
      {
        multi_prompt: [
          { prompt: 'Wide shot. @Element1 waits at the ticket machine.', duration: '3' },
          { prompt: 'Close-up shot. @Element2 smiles.', duration: '2' },
        ],
        shot_type: 'customize',
        negative_prompt: 'subtitles, captions',
        start_image_url: uploaded(1),
        elements: [
          { frontal_image_url: uploaded(2), reference_image_urls: [uploaded(3)] },
          { frontal_image_url: uploaded(4), reference_image_urls: [uploaded(5)] },
        ],
        duration: '5',
        generate_audio: true,
      },
    ],
    [
      'kling 3.0 image-to-video with one element of three views and a prompt',
      'fal-kling-3.0',
      { prompt: '@Element1 checks her phone', firstFrame: 'img-a', elementImages: ['img-b', 'img-c', 'img-d'], elementCounts: [3], duration: 4 },
      { firstFrame: img, elementImages: [img2, img3, img4] },
      'fal-ai/kling-video/v3/standard/image-to-video',
      {
        prompt: '@Element1 checks her phone',
        start_image_url: uploaded(1),
        elements: [{ frontal_image_url: uploaded(2), reference_image_urls: [uploaded(3), uploaded(4)] }],
        duration: '4',
        generate_audio: true,
      },
    ],
    [
      'kling 3.0 text-to-video with a shot list',
      'fal-kling-3.0',
      {
        prompt: 'Two shots',
        duration: 7,
        aspectRatio: '9:16',
        multiPrompt: [
          { prompt: 'Rain on the platform.', duration: 4 },
          { prompt: 'A train arrives.', duration: 3 },
        ],
      },
      {},
      'fal-ai/kling-video/v3/standard/text-to-video',
      {
        multi_prompt: [
          { prompt: 'Rain on the platform.', duration: '4' },
          { prompt: 'A train arrives.', duration: '3' },
        ],
        shot_type: 'customize',
        duration: '7',
        aspect_ratio: '9:16',
        generate_audio: true,
      },
    ],
    [
      'kling o3 reference-to-video with elements and a place photo',
      'fal-kling-o3',
      { prompt: '@Element1 waits in @Image1', referenceImages: ['img-a'], elementImages: ['img-b', 'img-c'], elementCounts: [2] },
      { referenceImages: [img], elementImages: [img2, img3] },
      'fal-ai/kling-video/o3/standard/reference-to-video',
      {
        prompt: '@Element1 waits in @Image1',
        duration: '5',
        generate_audio: false,
        image_urls: [uploaded(1)],
        elements: [{ frontal_image_url: uploaded(2), reference_image_urls: [uploaded(3)] }],
        aspect_ratio: '16:9',
      },
    ],
    [
      'kling o3 4k: a start frame with elements goes to reference-to-video',
      'fal-kling-o3-4k',
      { prompt: '@Element1 turns', firstFrame: 'img-a', elementImages: ['img-b', 'img-c', 'img-d', 'img-e'], elementCounts: [4], duration: 6 },
      { firstFrame: img, elementImages: [img2, img3, img4, img5] },
      'fal-ai/kling-video/o3/4k/reference-to-video',
      {
        prompt: '@Element1 turns',
        duration: '6',
        generate_audio: false,
        elements: [{ frontal_image_url: uploaded(2), reference_image_urls: [uploaded(3), uploaded(4), uploaded(5)] }],
        start_image_url: uploaded(1),
        aspect_ratio: '16:9',
      },
    ],
    [
      'kling o3 standard text-to-video (defaults)',
      'fal-kling-o3',
      { prompt: 'City at night' },
      {},
      'fal-ai/kling-video/o3/standard/text-to-video',
      { prompt: 'City at night', duration: '5', generate_audio: false, aspect_ratio: '16:9' },
    ],
    [
      'kling o3 standard reference-to-video with audio',
      'fal-kling-o3',
      { prompt: 'Product spins', referenceImages: ['img-a'], resolution: '720p', audio: true, aspectRatio: '9:16' },
      { referenceImages: [img] },
      'fal-ai/kling-video/o3/standard/reference-to-video',
      { prompt: 'Product spins', duration: '5', generate_audio: true, image_urls: [uploaded(1)], aspect_ratio: '9:16' },
    ],
    [
      'kling o3 4k text-to-video',
      'fal-kling-o3-4k',
      { prompt: 'Aerial over a glacier' },
      {},
      'fal-ai/kling-video/o3/4k/text-to-video',
      { prompt: 'Aerial over a glacier', duration: '5', generate_audio: false, aspect_ratio: '16:9' },
    ],
    [
      'kling o3 4k image-to-video with audio',
      'fal-kling-o3-4k',
      { prompt: 'He turns', firstFrame: 'img-a', lastFrame: 'img-b', audio: true, duration: 10 },
      { firstFrame: img, lastFrame: img2 },
      'fal-ai/kling-video/o3/4k/image-to-video',
      { prompt: 'He turns', duration: '10', generate_audio: true, image_url: uploaded(1), end_image_url: uploaded(2) },
    ],
    [
      'kling o3 4k reference-to-video',
      'fal-kling-o3-4k',
      { prompt: 'Product spins', referenceImages: ['img-a'], aspectRatio: '1:1' },
      { referenceImages: [img] },
      'fal-ai/kling-video/o3/4k/reference-to-video',
      { prompt: 'Product spins', duration: '5', generate_audio: false, image_urls: [uploaded(1)], aspect_ratio: '1:1' },
    ],
    [
      'veo 3.1 extend (fast, default)',
      'fal-veo3.1-extend',
      { prompt: 'The boat sails on', video: 'vid-a' },
      { video: vid },
      'fal-ai/veo3.1/fast/extend-video',
      { prompt: 'The boat sails on', video_url: uploaded(1), generate_audio: true },
    ],
    [
      'veo 3.1 extend standard, silent',
      'fal-veo3.1-extend',
      { prompt: 'Night falls', video: 'vid-a', tier: 'standard', audio: false },
      { video: vid },
      'fal-ai/veo3.1/extend-video',
      { prompt: 'Night falls', video_url: uploaded(1), generate_audio: false },
    ],
  ] as const)('%s', async (_name, modelId, params, inputs, endpoint, expected) => {
    const { endpointId, input, result, records } = await submitWith(modelId, params as ParamValues, inputs as JobContext['inputs'])
    expect(endpointId).toBe(endpoint)
    expect(input).toEqual(expected)
    expect(result).toEqual({ type: 'async', taskId: 'req-1', meta: { endpointId: endpoint } })
    expect(records).toEqual([{ endpointId: endpoint, input: expected }])
  })

  it('fills a custom endpoint’s JSON template', async () => {
    const { endpointId, input, result } = await submitWith(
      'fal-custom',
      {
        prompt: 'a red fox',
        endpointId: 'fal-ai/new-model/image-to-video',
        inputJson: '{"prompt": "{{prompt}}, cinematic", "image_url": "{{image}}", "num_frames": 97, "nested": {"list": ["{{prompt}}", true]}}',
        image: 'img-a',
      },
      { image: img },
    )
    expect(endpointId).toBe('fal-ai/new-model/image-to-video')
    expect(input).toEqual({ prompt: 'a red fox, cinematic', image_url: uploaded(1), num_frames: 97, nested: { list: ['a red fox', true] } })
    expect(result).toMatchObject({ meta: { endpointId: 'fal-ai/new-model/image-to-video' } })
  })

  it('scales images that are over an endpoint’s limits before uploading them', async () => {
    const big = join(fixtures.dir, 'wide.png')
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=5000x300', '-frames:v', '1', big])
    const wide = { assetId: 'wide', kind: 'image' as const, path: big, mime: 'image/png', width: 5000, height: 300 }
    const { fal } = await submitWith('fal-recraft-vectorize', { image: 'wide' }, { image: wide })
    expect(fal.uploads).toHaveLength(1)
    expect(fal.uploads[0]!.type).toBe('image/png')
    // PNG header: width and height are big-endian at bytes 16 and 20.
    const view = new DataView(fal.contents[0]!)
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([4096, 246])
  })

  it('computes the input scale from edge limits', () => {
    expect(inputScale(1000, 800, { maxEdge: 4096 })).toBe(1)
    expect(inputScale(8192, 4096, { maxEdge: 4096 })).toBe(0.5)
    expect(inputScale(200, 100, { maxEdge: 4096, minEdge: 256 })).toBeCloseTo(2.56)
  })

  it('refuses Kling elements it can’t send: none without a start frame, counts that don’t match the images', async () => {
    const fal = fakeFal()
    const adapter = createFalAdapter({ createClient: fal.factory })
    // Past the catalog's own checks (they reject both), straight to the adapter.
    const submit = (params: ParamValues, inputs: JobContext['inputs']) => {
      const { ctx } = makeCtx(model('fal-kling-3.0'), { prompt: 'p' }, { inputs, credentials: CREDS })
      return adapter.submit({ ...ctx, params: { ...ctx.params, ...params } }).catch((e: unknown) => e)
    }
    const noFrame = await submit({ elementImages: ['img-b', 'img-c'], elementCounts: [2] }, { elementImages: [img2, img3] })
    expect((noFrame as ProviderError).jobError).toMatchObject({ code: 'invalid_params', message: 'Kling elements need a start frame' })
    const mismatch = await submit({ firstFrame: 'img-a', elementImages: ['img-b', 'img-c', 'img-d'], elementCounts: [2] }, { firstFrame: img, elementImages: [img2, img3, img4] })
    expect((mismatch as ProviderError).jobError.code).toBe('invalid_params')
    expect(fal.client.queue.submit).not.toHaveBeenCalled()
  })

  it('uploads each input file once, with its MIME type', async () => {
    const { input, fal } = await submitWith('fal-veo3.1', { prompt: 'Loop', firstFrame: 'img-a', lastFrame: 'img-a' }, { firstFrame: img, lastFrame: img })
    expect(fal.uploads).toEqual([{ size: 4, type: 'image/png' }])
    expect(input).toMatchObject({ first_frame_url: uploaded(1), last_frame_url: uploaded(1) })
    expect(fal.factory).toHaveBeenCalledWith('fal-test-key')
  })
})

describe('fal submit errors', () => {
  const submitError = async (setup: (fal: ReturnType<typeof fakeFal>) => void, modelId = 'fal-veo3.1', inputs: JobContext['inputs'] = {}) => {
    const fal = fakeFal()
    setup(fal)
    const params: ParamValues = inputs.firstFrame ? { prompt: 'p', firstFrame: 'img-a' } : { prompt: 'p' }
    const error = await createFalAdapter({ createClient: fal.factory })
      .submit(makeCtx(model(modelId), params, { inputs, credentials: CREDS }).ctx)
      .catch((e: unknown) => e)
    return { error, fal }
  }

  it('maps HTTP errors from the queue', async () => {
    const validation = new ValidationError({
      message: 'Unprocessable Entity',
      status: 422,
      body: { detail: [{ loc: ['body', 'duration'], msg: "Input should be '4s', '6s' or '8s'", type: 'literal_error' }] },
    })
    const { error } = await submitError((fal) => fal.client.queue.submit.mockRejectedValueOnce(validation))
    expect((error as ProviderError).jobError).toMatchObject({ code: 'invalid_params', message: "fal: duration: Input should be '4s', '6s' or '8s'" })

    const locked = new ApiError({
      message: 'Forbidden',
      status: 403,
      body: { detail: 'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing.' },
    })
    expect(((await submitError((fal) => fal.client.queue.submit.mockRejectedValueOnce(locked))).error as ProviderError).jobError.code).toBe(
      'insufficient_credits',
    )

    const limited = new ApiError({ message: 'Too Many Requests', status: 429, body: {} })
    expect(((await submitError((fal) => fal.client.queue.submit.mockRejectedValueOnce(limited))).error as ProviderError).jobError).toMatchObject({
      code: 'rate_limited',
      retryable: true,
    })
  })

  it('lets network errors through as an unknown outcome', async () => {
    const { error } = await submitError((fal) => fal.client.queue.submit.mockRejectedValueOnce(new TypeError('fetch failed')))
    expect(error).toBeInstanceOf(TypeError)
    expect(error).not.toBeInstanceOf(ProviderError)
  })

  it('fails retryably (and never submits) when an upload fails', async () => {
    const { error, fal } = await submitError(
      (f) => f.client.storage.upload.mockRejectedValueOnce(new Error('socket hang up')),
      'fal-veo3.1',
      { firstFrame: img },
    )
    expect((error as ProviderError).jobError).toMatchObject({ code: 'network', retryable: true, maybeCharged: false })
    expect((error as ProviderError).message).toContain('socket hang up')
    expect(fal.client.queue.submit).not.toHaveBeenCalled()
  })

  it('requires an API key', async () => {
    const fal = fakeFal()
    const error = await createFalAdapter({ createClient: fal.factory })
      .submit(makeCtx(model('fal-veo3.1'), { prompt: 'p' }, { credentials: {} }).ctx)
      .catch((e: unknown) => e)
    expect((error as ProviderError).jobError.code).toBe('auth')
    expect(fal.factory).not.toHaveBeenCalled()
  })
})

describe('fal poll', () => {
  const pollWith = async (modelId: string, setup: (fal: ReturnType<typeof fakeFal>) => void, params: ParamValues = { prompt: 'p' }) => {
    const fal = fakeFal()
    setup(fal)
    const { ctx } = makeCtx(model(modelId), params, {
      credentials: CREDS,
      providerTaskId: 'req-1',
      providerMeta: { endpointId: 'some/endpoint' },
    })
    const adapter = createFalAdapter({ createClient: fal.factory })
    const result = await adapter.poll!(ctx).catch((e: unknown) => e)
    return { result, fal }
  }

  it('reports queued and running requests', async () => {
    const queued = await pollWith('fal-veo3.1', (fal) => fal.client.queue.status.mockResolvedValueOnce({ status: 'IN_QUEUE', queue_position: 3 } as never))
    expect(queued.result).toEqual({ type: 'running' })
    expect(queued.fal.client.queue.status).toHaveBeenCalledWith('some/endpoint', expect.objectContaining({ requestId: 'req-1', logs: true }))
    expect(queued.fal.client.queue.result).not.toHaveBeenCalled()
    const running = await pollWith('fal-veo3.1', () => {})
    expect(running.result).toEqual({ type: 'running' })
  })

  it('returns video, image and audio outputs when completed', async () => {
    const complete = (data: unknown) => (fal: ReturnType<typeof fakeFal>) => {
      fal.client.queue.status.mockResolvedValueOnce({ status: 'COMPLETED' })
      fal.client.queue.result.mockResolvedValueOnce({ data })
    }
    const video = await pollWith(
      'fal-veo3.1',
      complete({ video: { url: 'https://v3.fal.media/files/out', content_type: 'video/mp4', file_size: 123 }, seed: 99 }),
    )
    expect(video.result).toMatchObject({
      type: 'done',
      outputs: [{ kind: 'url', url: 'https://v3.fal.media/files/out', ext: 'mp4', meta: { seed: 99 } }],
    })
    expect(video.fal.client.queue.result).toHaveBeenCalledWith('some/endpoint', expect.objectContaining({ requestId: 'req-1' }))

    const images = await pollWith(
      'fal-nano-banana-pro',
      complete({
        images: [
          { url: 'https://v3.fal.media/files/a.png', content_type: 'image/png', width: 1376, height: 768 },
          { url: 'https://v3.fal.media/files/b', content_type: 'image/jpeg' },
        ],
        description: '',
      }),
    )
    expect(images.result).toMatchObject({
      type: 'done',
      outputs: [
        { kind: 'url', url: 'https://v3.fal.media/files/a.png', ext: 'png', meta: { width: 1376, height: 768 } },
        { kind: 'url', url: 'https://v3.fal.media/files/b', ext: 'jpg' },
      ],
    })

    const audio = await pollWith('fal-stable-audio-2.5', complete({ audio: { url: 'https://v3.fal.media/files/track.wav' }, seed: 1 }))
    expect(audio.result).toMatchObject({ type: 'done', outputs: [{ kind: 'url', url: 'https://v3.fal.media/files/track.wav', ext: 'wav' }] })

    const foley = await pollWith('fal-mmaudio-v2', complete({ video: { url: 'https://v3.fal.media/files/foley.mp4' } }), {
      prompt: 'rain',
      video: 'vid-a',
    })
    expect(foley.result).toMatchObject({ type: 'done', outputs: [{ ext: 'mp4', meta: { audioInVideoContainer: true } }] })
  })

  it('returns upscaled video and image outputs', async () => {
    const complete = (data: unknown) => (fal: ReturnType<typeof fakeFal>) => {
      fal.client.queue.status.mockResolvedValueOnce({ status: 'COMPLETED' })
      fal.client.queue.result.mockResolvedValueOnce({ data })
    }
    const topaz = await pollWith(
      'fal-topaz-upscale-video',
      complete({ video: { url: 'https://v3.fal.media/files/upscaled.mp4', content_type: 'video/mp4', file_size: 10_593_020 } }),
      { video: 'vid-a', targetFps: 60 },
    )
    expect(topaz.result).toMatchObject({ type: 'done', outputs: [{ kind: 'url', url: 'https://v3.fal.media/files/upscaled.mp4', ext: 'mp4' }] })

    const seedvr = await pollWith(
      'fal-seedvr2-upscale-video',
      complete({ video: { url: 'https://v3.fal.media/files/seedvr-output', content_type: 'video/mp4' }, seed: 42 }),
      { video: 'vid-a', scale: 4 },
    )
    expect(seedvr.result).toMatchObject({
      type: 'done',
      outputs: [{ kind: 'url', url: 'https://v3.fal.media/files/seedvr-output', ext: 'mp4', meta: { seed: 42 } }],
    })

    const image = await pollWith(
      'fal-topaz-upscale-image',
      complete({ image: { url: 'https://v3.fal.media/files/up', content_type: 'image/png', file_name: 'up.png', width: 3840, height: 2160 } }),
      { image: 'img-a' },
    )
    expect(image.result).toMatchObject({
      type: 'done',
      outputs: [{ kind: 'url', url: 'https://v3.fal.media/files/up', ext: 'png', meta: { width: 3840, height: 2160 } }],
    })

    const vector = await pollWith(
      'fal-recraft-vectorize',
      complete({ image: { url: 'https://v3.fal.media/files/koala/image.svg', content_type: 'image/svg+xml', file_name: 'image.svg' } }),
      { image: 'img-a' },
    )
    expect(vector.result).toMatchObject({ type: 'done', outputs: [{ kind: 'url', url: 'https://v3.fal.media/files/koala/image.svg', ext: 'svg' }] })

    // A result without the file fails instead of "succeeding" with nothing.
    const empty = await pollWith('fal-topaz-upscale-image', complete({ images: [{ url: 'https://x/wrong-field.png' }] }), { image: 'img-a' })
    expect(empty.result).toMatchObject({ type: 'failed', error: { code: 'provider', maybeCharged: true } })
  })

  it('reads a custom output path, including [*]', async () => {
    const { result } = await pollWith(
      'fal-custom-image',
      (fal) => {
        fal.client.queue.status.mockResolvedValueOnce({ status: 'COMPLETED' })
        fal.client.queue.result.mockResolvedValueOnce({ data: { images: [{ url: 'https://x/1.webp' }, { url: 'https://x/2.webp' }] } })
      },
      { prompt: 'p', endpointId: 'fal-ai/x' },
    )
    expect(result).toMatchObject({ type: 'done', outputs: [{ url: 'https://x/1.webp', ext: 'webp' }, { url: 'https://x/2.webp', ext: 'webp' }] })

    const miss = await pollWith(
      'fal-custom',
      (fal) => {
        fal.client.queue.status.mockResolvedValueOnce({ status: 'COMPLETED' })
        fal.client.queue.result.mockResolvedValueOnce({ data: { output: { video: 'https://x/v.mp4' } } })
      },
      { prompt: 'p', endpointId: 'fal-ai/x' },
    )
    expect(miss.result).toMatchObject({ type: 'failed', error: { code: 'provider', message: expect.stringContaining('at "video.url"') } })
  })

  it('turns model errors into final failures', async () => {
    const moderated = await pollWith('fal-veo3.1', (fal) => {
      fal.client.queue.status.mockResolvedValueOnce({ status: 'COMPLETED' })
      fal.client.queue.result.mockRejectedValueOnce(
        new ValidationError({
          message: 'Unprocessable Entity',
          status: 422,
          body: {
            detail: [
              {
                loc: ['body', 'prompt'],
                msg: 'The content could not be processed because it contained material flagged by a content checker.',
                type: 'content_policy_violation',
              },
            ],
          },
        }),
      )
    })
    expect(moderated.result).toMatchObject({ type: 'failed', error: { code: 'moderation', retryable: false } })

    const crashed = await pollWith('fal-veo3.1', (fal) => {
      fal.client.queue.status.mockResolvedValueOnce({ status: 'COMPLETED' })
      fal.client.queue.result.mockRejectedValueOnce(
        new ApiError({ message: 'Internal Server Error', status: 500, body: { detail: [{ loc: [], msg: 'CUDA out of memory', type: 'internal_server_error' }] } }),
      )
    })
    expect(crashed.result).toMatchObject({ type: 'failed', error: { code: 'provider', retryable: true, message: expect.stringContaining('CUDA') } })
  })

  it('re-polls after transient errors and stops on auth errors', async () => {
    const gateway = await pollWith('fal-veo3.1', (fal) => {
      fal.client.queue.status.mockResolvedValueOnce({ status: 'COMPLETED' })
      fal.client.queue.result.mockRejectedValueOnce(new ApiError({ message: 'Bad Gateway', status: 502, body: undefined }))
    })
    expect(gateway.result).toBeInstanceOf(ProviderError)
    expect((gateway.result as ProviderError).jobError.retryable).toBe(true)

    const network = await pollWith('fal-veo3.1', (fal) => fal.client.queue.status.mockRejectedValueOnce(new TypeError('fetch failed')))
    expect(network.result).toBeInstanceOf(TypeError)

    const auth = await pollWith('fal-veo3.1', (fal) =>
      fal.client.queue.status.mockRejectedValueOnce(new ApiError({ message: 'Unauthorized', status: 401, body: { detail: 'Invalid key' } })),
    )
    expect((auth.result as ProviderError).jobError).toMatchObject({ code: 'auth', retryable: false })
  })

  it('fails when the endpoint id is missing', async () => {
    const fal = fakeFal()
    const { ctx } = makeCtx(model('fal-veo3.1'), { prompt: 'p' }, { credentials: CREDS, providerTaskId: 'req-1' })
    expect(await createFalAdapter({ createClient: fal.factory }).poll!(ctx)).toMatchObject({ type: 'failed', error: { code: 'internal' } })
  })

  it('cancels at the provider and reuses one client per key', async () => {
    const fal = fakeFal()
    const adapter = createFalAdapter({ createClient: fal.factory })
    const { ctx } = makeCtx(model('fal-veo3.1'), { prompt: 'p' }, { credentials: CREDS, providerTaskId: 'req-9', providerMeta: { endpointId: 'fal-ai/veo3.1' } })
    await adapter.poll!(ctx)
    await adapter.cancel!(ctx)
    expect(fal.client.queue.cancel).toHaveBeenCalledWith('fal-ai/veo3.1', { requestId: 'req-9' })
    expect(fal.factory).toHaveBeenCalledTimes(1)
  })
})

describe('fal test()', () => {
  it('shows the balance for admin keys', async () => {
    const { calls } = installFetch(() => jsonResponse({ username: 'szymon', credits: { current_balance: 12.5, currency: 'USD' } }))
    const result = await createFalAdapter().test(CREDS)
    expect(calls[0]!.url).toBe('https://api.fal.ai/v1/account/billing?expand=credits')
    expect(calls[0]!.headers.authorization).toBe('Key fal-test-key')
    expect(result).toEqual({ ok: true, message: 'Connected as szymon', credits: { label: 'fal balance', remaining: 12.5, unit: 'USD' } })
  })

  it('rejects invalid keys and accepts non-admin keys that authenticate', async () => {
    installFetch(() => jsonResponse({ detail: 'Invalid API key' }, 401))
    expect(await createFalAdapter().test(CREDS)).toEqual({ ok: false, message: 'fal: invalid API key (Invalid API key)' })

    const nonAdmin = installFetch((call) =>
      call.url.includes('api.fal.ai') ? jsonResponse({ detail: 'Admin API key required' }, 403) : jsonResponse({ detail: 'Request not found' }, 404),
    )
    expect(await createFalAdapter().test(CREDS)).toEqual({ ok: true, message: 'Connected — the balance is only visible to ADMIN-scoped keys' })
    expect(nonAdmin.calls[1]!.url).toMatch(/^https:\/\/queue\.fal\.run\//)

    installFetch((call) => (call.url.includes('api.fal.ai') ? jsonResponse({ detail: 'Forbidden' }, 403) : jsonResponse({ detail: 'Bad key' }, 401)))
    expect(await createFalAdapter().test(CREDS)).toEqual({ ok: false, message: 'fal: API key rejected (Bad key)' })

    installFetch(() => jsonResponse({ detail: 'User is locked. Reason: Exhausted balance.' }, 403))
    expect(await createFalAdapter().test(CREDS)).toEqual({ ok: false, message: 'fal: User is locked. Reason: Exhausted balance.' })
  })
})

describe('fal upscaler params', () => {
  it('parses the defaults plus an input asset id', () => {
    expect(parseParams(model('fal-topaz-upscale-video'), { video: 'asset-1' })).toEqual({
      ok: true,
      values: { video: 'asset-1', scale: 2, targetFps: 0 },
    })
    expect(parseParams(model('fal-seedvr2-upscale-video'), { video: 'asset-1' })).toEqual({ ok: true, values: { video: 'asset-1', scale: 2 } })
    expect(parseParams(model('fal-topaz-upscale-image'), { image: 'asset-2' })).toEqual({
      ok: true,
      values: { image: 'asset-2', scale: 2, faceEnhancement: true },
    })
    // Numbers from selects arrive as strings from some clients.
    expect(parseParams(model('fal-topaz-upscale-video'), { video: 'asset-1', scale: '4', targetFps: '30' })).toMatchObject({
      ok: true,
      values: { scale: 4, targetFps: 30 },
    })
  })

  it('requires the input and rejects factors / frame rates the API does not take', () => {
    expect(parseParams(model('fal-topaz-upscale-video'), {})).toMatchObject({ ok: false, errors: { video: expect.any(String) } })
    expect(parseParams(model('fal-topaz-upscale-video'), { video: '' })).toMatchObject({ ok: false, errors: { video: 'Video is required' } })
    expect(parseParams(model('fal-topaz-upscale-image'), { image: '' })).toMatchObject({ ok: false, errors: { image: 'Image is required' } })
    expect(parseParams(model('fal-seedvr2-upscale-video'), { video: 'a', scale: 3 }).ok).toBe(false)
    expect(parseParams(model('fal-topaz-upscale-video'), { video: 'a', targetFps: 120 }).ok).toBe(false)
    expect(parseParams(model('fal-topaz-upscale-video'), { video: 'a', targetFps: 15 }).ok).toBe(false)
  })

  it('shows rate cards instead of guessing a total', () => {
    const estimate = (id: string, values: ParamValues) => {
      const parsed = parseParams(model(id), values)
      if (!parsed.ok) throw new Error(parsed.message)
      return model(id).estimateCost(parsed.values)
    }
    expect(estimate('fal-topaz-upscale-video', { video: 'a' })).toEqual({
      usd: null,
      detail: 'Per second of output: $0.08 above 1080p, $0.02 up to 1080p, $0.01 up to 720p (doubled for 60 fps output)',
      asOf: '2026-09-29',
    })
    expect(estimate('fal-topaz-upscale-video', { video: 'a', targetFps: 60 }).detail).toMatch(/doubled at 60 fps$/)
    expect(estimate('fal-seedvr2-upscale-video', { video: 'a' })).toMatchObject({ usd: null, detail: expect.stringContaining('$0.001 per megapixel') })
    expect(estimate('fal-topaz-upscale-image', { image: 'a' }).detail).toBe(
      '$0.08 per image up to 24 MP output (a ≤6 MP input), $0.16 up to 48 MP, $0.32 up to 96 MP',
    )
    expect(estimate('fal-topaz-upscale-image', { image: 'a', scale: 4 }).detail).toContain('(a ≤1.5 MP input)')
  })
})

describe('fal custom helpers', () => {
  it('replaces placeholders everywhere and leaves unknown ones', () => {
    expect(fillPlaceholders({ a: '{{prompt}}', b: ['x {{ image }} y'], c: 1, d: '{{other}}' }, { prompt: 'P', image: 'I' })).toEqual({
      a: 'P',
      b: ['x I y'],
      c: 1,
      d: '{{other}}',
    })
  })

  it('resolves output paths', () => {
    const data = { video: { url: 'https://x/v.mp4' }, images: [{ url: 'https://x/a.png' }, { url: 'https://x/b.png' }], audio_url: 'https://x/s.mp3' }
    expect(outputsAtPath(data, 'video.url', 'mp4')).toEqual([{ kind: 'url', url: 'https://x/v.mp4', ext: 'mp4' }])
    expect(outputsAtPath(data, 'video', 'mp4')).toEqual([{ kind: 'url', url: 'https://x/v.mp4', ext: 'mp4' }])
    expect(outputsAtPath(data, 'images[1].url', 'png').map((o) => o.kind === 'url' && o.url)).toEqual(['https://x/b.png'])
    expect(outputsAtPath(data, 'images', 'png')).toHaveLength(2)
    expect(outputsAtPath(data, 'audio_url', 'wav')).toEqual([{ kind: 'url', url: 'https://x/s.mp3', ext: 'mp3' }])
    expect(outputsAtPath(data, 'images[5].url', 'png')).toEqual([])
  })
})
