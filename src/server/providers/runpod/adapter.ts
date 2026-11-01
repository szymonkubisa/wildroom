import { rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import {
  RUNPOD_CONTINUE_FRAMES,
  RUNPOD_SHAPE_INPUTS,
  RUNPOD_UPSCALE_MAX_SECONDS,
  RUNPOD_UPSCALE_SIZE,
  type RunpodResolution,
  isRunpod4k,
  runpodEstimateSeconds,
  runpodGuideKind,
  runpodGuideLatentFrames,
  runpodSize,
} from '../../../shared/models/catalog/runpod'
import type { ProviderTestResult } from '../../../shared/types/api'
import type { GpuPrecision } from '../../../shared/types/runpod'
import { runFfmpeg } from '../../services/ffmpeg'
import { probeFile } from '../../services/probe'
import type { Credentials } from '../../services/keychain'
import { fitImageInput } from '../imageInput'
import { type JobContext, type PollResult, type ProviderAdapter, ProviderError, type ResolvedInput, type SubmitResult, jobError } from '../types'
import { RunpodApi, RunpodError } from './api'
import { type ComfyClient, ComfyError, type ComfyFile, type ComfyHistoryEntry } from './comfy'
import { type CoreGraphInput, buildCoreGraph, buildUpscaleGraph, danglingLinks, graphFrames, renderedSeconds } from './graph'
import { historyError, historyFiles, historyRenderMs, renderCost } from './history'
import type { GpuSession } from './session'

/** The websocket client id the app's prompts carry (ComfyUI routes their progress there; the inbox skips them). */
export const STUDIO_CLIENT_ID = 'studio-runpod'
const VIDEO_EXT = /\.(mp4|webm|mov|mkv)$/i
/**
 * The first render on a fresh pod also loads ~70 GB of weights: ~4 min straight from the network volume, ~30 s when the
 * pod's preload (scripts/runpod/preload.sh) has read them into memory while it booted (measured 2026-10-06).
 */
const MODEL_LOAD_MS = 45_000
/**
 * A render still running this long after it started on the GPU is taken for hung (e.g. the 4K tiled sampler) and
 * stopped, instead of billing the pod at 95 % until the worker's 4 h limit: several times the estimate, plus the slowest
 * model load (~4 min straight from the volume), never under STALL_MIN_MS.
 */
const STALL_FACTOR = 4
const STALL_LOAD_MS = 5 * 60_000
const STALL_MIN_MS = 10 * 60_000

/**
 * LTX-2.5 on a rented RunPod GPU (ComfyUI on a pod). The key lives in Settings → Providers; the GPU session starts a
 * pod when RunPod jobs are queued (`beforeSubmit` holds them until ComfyUI answers) and stops it when they are done.
 */
export function createRunpodAdapter(opts: { session?: GpuSession; now?: () => number } = {}): ProviderAdapter {
  const { session } = opts
  const now = opts.now ?? Date.now
  /** When each prompt was first seen rendering (for a progress estimate). */
  const renderingSince = new Map<string, number>()
  /** Pods that finished a render: the models are in memory there. */
  const warmPods = new Set<string>()

  const client = () => {
    const c = session?.client()
    if (!c) throw new ProviderError(jobError('rate_limited', 'The GPU is not ready yet', { retryable: true }))
    return c
  }

  return {
    id: 'runpod',
    label: 'RunPod',
    version: '2026-10-26.2',
    credentialFields: ['apiKey'],
    requiredFields: ['apiKey'],
    // Several prompts can wait in the pod's ComfyUI queue; it renders one at a time.
    defaultConcurrency: 4,
    pollIntervalMs: 3000,
    maxRunMs: 4 * 60 * 60_000,
    billing: 'machine-time',
    async test(credentials: Credentials): Promise<ProviderTestResult> {
      const api = new RunpodApi({ apiKey: credentials.apiKey ?? '' })
      try {
        const volumes = await api.listVolumes()
        const account = await api.account().catch(() => undefined)
        const count = volumes.length === 1 ? '1 network volume' : `${volumes.length} network volumes`
        return {
          ok: true,
          message: `Connected — ${count}.`,
          credits: account?.clientBalance != null ? { label: 'RunPod balance', remaining: Math.round(account.clientBalance * 100) / 100, unit: 'USD' } : undefined,
        }
      } catch (err) {
        if (err instanceof RunpodError && err.kind === 'auth') return { ok: false, message: 'Invalid API key' }
        if (err instanceof RunpodError && err.kind === 'forbidden') return { ok: false, message: 'This key is restricted — it needs read/write access to pods and volumes' }
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },
    beforeSubmit: session ? () => session.ensure() : undefined,

    async submit(ctx: JobContext): Promise<SubmitResult> {
      const comfy = client()
      const podId = session!.podId
      if (ctx.model.kind === 'upscale') return submitUpscale(ctx, comfy, String(podId), session!.precision).catch((err) => Promise.reject(asProviderError(err)))
      const values = ctx.params
      const one = (key: string) => ctx.inputs[key] as ResolvedInput | undefined
      const many = (key: string) => (ctx.inputs[key] as ResolvedInput[] | undefined) ?? []
      const upscale4k = isRunpod4k(values)
      // The 4K pass is tested with the full-precision weights only (80 GB+ cards).
      if (upscale4k && session!.precision !== 'bf16') {
        throw new ProviderError(jobError('invalid_params', '4K needs a GPU with 80 GB or more (RTX PRO 6000, H100, A100, H200) — this session runs on a smaller one. Render at 1080p, or stop the GPU and choose a bigger one'))
      }
      const lead = one('continueFrom')
      if (lead?.durationSeconds !== undefined && lead.durationSeconds * Number(values.fps ?? 24) < RUNPOD_CONTINUE_FRAMES) {
        throw new ProviderError(jobError('invalid_params', 'The clip to continue is too short — it needs at least about a second'))
      }
      // The lead-in frames would take the audio's first second with them (it is cut with them): not supported together.
      if (lead && one('audioClip')) {
        throw new ProviderError(jobError('invalid_params', 'Continuing a clip and following an audio clip don’t work together yet — the audio would lose its first second. Use one of them'))
      }
      const shape = RUNPOD_SHAPE_INPUTS.map(one).find(Boolean)
      const { width, height } = runpodSize(values, shape)
      const fps = Number(values.fps ?? 24)
      // Audio to follow: the clip is no longer than it.
      const audioClip = one('audioClip')
      // A camera guide sets the clip's length (up to the model's 10 s); the guide is cut to the frames rendered.
      const guide = one('guideVideo')
      if (guide && lead) {
        throw new ProviderError(jobError('invalid_params', 'A camera guide and continuing a clip don’t work together — the guide sets the whole shot. Use a start frame instead'))
      }
      // Layout-To-Render takes its look from the start frame; without one it renders the grey box itself (seen live).
      if (guide && runpodGuideKind(values) === 'layout' && !one('firstFrame')) {
        throw new ProviderError(jobError('invalid_params', 'A grey-box guide needs a start frame for the look — without one the clip comes out grey. Add a styled first frame, or use a depth guide'))
      }
      const requested = guide?.durationSeconds ? Math.max(1, Math.min(10, guide.durationSeconds)) : Number(values.duration ?? 5)
      const seconds = audioClip?.durationSeconds ? Math.max(1, Math.min(requested, audioClip.durationSeconds)) : requested
      const upload = async (file: ResolvedInput | undefined, slot: string): Promise<string | undefined> => {
        if (!file) return undefined
        const name = (ext: string) => `studio_${ctx.generationId}_${slot}${ext}`
        if (file.kind === 'image') {
          // References and stills are resized on the GPU anyway: no need to send more than a 2K picture.
          const fitted = await fitImageInput(file, { maxEdge: 2048, maxBytes: 20_000_000 }, ctx.signal)
          try {
            return (await comfy.upload(fitted.path, fitted.mime, name(extname(fitted.path).toLowerCase() || '.png'))).filename
          } finally {
            await fitted.cleanup()
          }
        }
        return (await comfy.upload(file.path, file.mime, name(extname(file.path).toLowerCase() || '.bin'))).filename
      }
      try {
        const continueFrom = one('continueFrom')
        const inputs = {
          image: await upload(one('firstFrame'), 'start'),
          lastImage: await upload(one('lastFrame'), 'end'),
          midImages: await uploadAll(many('midFrames'), 'mid', upload),
          references: await uploadAll(many('referenceImages'), 'ref', upload),
          background: await upload(one('referenceBackground'), 'location'),
          voices: [await upload(one('voice1'), 'voice1'), await upload(one('voice2'), 'voice2')],
          audioFile: await upload(audioClip, 'audio'),
          continueClip: continueFrom
            ? await upload({ ...continueFrom, path: await clipEnding(continueFrom, { width, height, fps }, ctx), mime: 'video/mp4' }, 'continue')
            : undefined,
          guideClip: guide
            ? await upload({ ...guide, path: await clipGuide(guide, { width, height, fps, frames: graphFrames(fps, seconds) }, ctx), mime: 'video/mp4' }, 'guide')
            : undefined,
        }
        const graphInput: CoreGraphInput = {
          prompt: String(values.prompt ?? ''),
          negative: typeof values.negativePrompt === 'string' ? values.negativePrompt : undefined,
          fps,
          seconds,
          width,
          height,
          seed: typeof values.seed === 'number' ? values.seed : Math.floor(Math.random() * 2 ** 31),
          ...inputs,
          midSeconds: Array.isArray(values.midFrameTimes) ? values.midFrameTimes.map(Number) : undefined,
          guide: inputs.guideClip
            ? { video: inputs.guideClip, kind: runpodGuideKind(values), strength: Number(values.guideStrength ?? 1) }
            : undefined,
          audio: values.audio !== false,
          precision: session!.precision,
          prefix: `wildroom/${ctx.generationId}`,
          upscale4k,
        }
        const graph = buildCoreGraph(graphInput)
        const broken = danglingLinks(graph)
        if (broken.length) throw new ProviderError(jobError('internal', `Broken workflow: ${broken.join(', ')}`))
        const output = upscale4k ? { width: width * 2, height: height * 2 } : { width, height }
        const estimateMs =
          runpodEstimateSeconds(width, height, renderedSeconds(graphInput), fps, { upscale4k, guideFrames: runpodGuideLatentFrames({ ...values, duration: seconds }) }) * 1000
        ctx.recordRequest({
          workflow: [upscale4k ? 'core_2stage+detail_4k' : 'core_2stage', graphInput.guide && `guide_${graphInput.guide.kind}`].filter(Boolean).join('+'),
          width,
          height,
          output,
          seconds,
          resolution: values.resolution as RunpodResolution,
          ...inputs,
          precision: session!.precision,
          podId,
          // The workflow exactly as queued in ComfyUI: every node, strength and the prompt it was given.
          graph,
        })
        const promptId = await comfy.prompt(graph, STUDIO_CLIENT_ID)
        return { type: 'async', taskId: promptId, meta: { podId, promptId, width, height, upscale4k, estimateMs } }
      } catch (err) {
        throw asProviderError(err)
      }
    },

    async poll(ctx: JobContext): Promise<PollResult> {
      const promptId = ctx.providerTaskId!
      const podId = ctx.providerMeta.podId
      // Just restarted: the session has not looked for its pod yet (it may still be rendering this).
      if (session && !session.reconciled) return { type: 'running', detail: 'Reconnecting to the GPU…' }
      if (!session || session.podId !== podId) {
        const wasRendering = renderingSince.delete(promptId)
        // ComfyUI died with this render on it: rendering it again would most likely crash the next GPU the same way.
        if (wasRendering && session?.crashed(String(podId))) {
          const hint = ctx.providerMeta.upscale4k === true ? ' — 4K needs the most memory: try 1080p' : ' — try it shorter or at a lower resolution'
          return {
            type: 'failed',
            error: jobError('provider', `ComfyUI crashed on the GPU while rendering this (most likely out of memory), so the GPU was stopped${hint}`, {
              retryable: true,
            }),
          }
        }
        return { type: 'requeue', detail: 'The GPU it was rendering on stopped — queued again' }
      }
      const comfy = session.client()
      if (!comfy) return { type: 'running', detail: 'Reconnecting to the GPU…' }
      try {
        const entry = await comfy.history(promptId)
        if (entry) return finished(entry, comfy.viewUrl.bind(comfy), comfy.authHeaders)
        const queue = await comfy.queue()
        if (queue.running.includes(promptId)) {
          const since = renderingSince.get(promptId) ?? now()
          renderingSince.set(promptId, since)
          const width = Number(ctx.providerMeta.width ?? 1920)
          const height = Number(ctx.providerMeta.height ?? 1088)
          const cold = !warmPods.has(String(podId))
          const render =
            typeof ctx.providerMeta.estimateMs === 'number'
              ? ctx.providerMeta.estimateMs
              : runpodEstimateSeconds(width, height, Number(ctx.params.duration ?? 5), Number(ctx.params.fps ?? 24), { upscale4k: ctx.providerMeta.upscale4k === true }) * 1000
          const elapsed = now() - since
          const expected = render + (cold ? MODEL_LOAD_MS : 0)
          const limit = Math.max(STALL_MIN_MS, STALL_FACTOR * render + STALL_LOAD_MS)
          if (elapsed > limit) {
            // Hung on the GPU: stop it there (the pod would render nothing else meanwhile) and fail the job. Not queued
            // again by itself: the same render would likely hang the same way, billing again.
            await comfy.interrupt(promptId)
            renderingSince.delete(promptId)
            const min = (ms: number) => Math.max(1, Math.round(ms / 60_000))
            return {
              type: 'failed',
              error: jobError('timeout', `The render ran ${min(elapsed)} min on the GPU (about ${min(expected)} min expected) and was stopped as stuck. Render again, or try it shorter or at a lower resolution`, {
                retryable: true,
              }),
            }
          }
          const detail = cold && elapsed < MODEL_LOAD_MS ? 'Loading the models (first render on this GPU)…' : 'Rendering on the GPU'
          return { type: 'running', progress: Math.min(0.95, elapsed / expected), detail }
        }
        const position = queue.pending.indexOf(promptId)
        if (position >= 0) return { type: 'running', detail: position === 0 ? 'Next on the GPU' : `In the GPU queue (#${position + 1})` }
        // Neither queued nor running: it may have finished since the history was read — look once more.
        const late = await comfy.history(promptId)
        if (late) return finished(late, comfy.viewUrl.bind(comfy), comfy.authHeaders)
        // Not there either: ComfyUI restarted and forgot it.
        renderingSince.delete(promptId)
        return { type: 'requeue', detail: 'The GPU lost this render — queued again' }
      } catch (err) {
        throw asProviderError(err)
      }

      function finished(entry: ComfyHistoryEntry, viewUrl: (f: ComfyFile) => string, headers: Record<string, string>): PollResult {
        const since = renderingSince.get(promptId)
        renderingSince.delete(promptId)
        const error = historyError(entry)
        if (error) {
          const where = error.nodeType ? ` (${error.nodeType})` : ''
          return { type: 'failed', error: jobError('provider', `The render failed on the GPU${where}: ${error.message}`, { retryable: true }) }
        }
        // Only what the graph saved: a LoadVideo node also lists its input (type "input") among the outputs, and with
        // a lower node id than SaveVideo it would come first (the upscaler delivered its own source that way).
        const video = historyFiles(entry).find((f) => f.type === 'output' && VIDEO_EXT.test(f.filename))
        if (!video) return { type: 'failed', error: jobError('provider', 'The GPU finished without a video', { retryable: true }) }
        warmPods.add(String(podId))
        const renderMs = historyRenderMs(entry) ?? (since ? now() - since : undefined)
        const rate = session?.costPerHr
        return {
          type: 'done',
          outputs: [{ kind: 'url', url: viewUrl(video), headers, ext: extname(video.filename).slice(1).toLowerCase() }],
          costUsd: renderCost(renderMs, rate),
          response: { promptId, renderMs, gpuRateUsdHr: rate },
        }
      }
    },

    async cancel(ctx: JobContext): Promise<void> {
      const promptId = ctx.providerTaskId
      const comfy = session?.client()
      if (!promptId || !comfy || session?.podId !== ctx.providerMeta.podId) return
      renderingSince.delete(promptId)
      const queue = await comfy.queue()
      if (queue.running.includes(promptId)) await comfy.interrupt(promptId)
      else await comfy.deleteQueued([promptId])
    },
  }
}

async function uploadAll(files: ResolvedInput[], slot: string, upload: (file: ResolvedInput, slot: string) => Promise<string | undefined>) {
  const names: string[] = []
  for (const [i, file] of files.entries()) {
    const name = await upload(file, `${slot}${i + 1}`)
    if (name) names.push(name)
  }
  return names
}

/**
 * The last RUNPOD_CONTINUE_FRAMES frames of a clip to continue, at the render's size and frame rate (a small file
 * instead of the whole clip): the GPU conditions the new shot on them.
 */
async function clipEnding(clip: ResolvedInput, size: { width: number; height: number; fps: number }, ctx: JobContext): Promise<string> {
  const out = join(ctx.tmpDir, `continue-${ctx.generationId}.mp4`)
  const frames = RUNPOD_CONTINUE_FRAMES
  // Seek a little before the end, then keep exactly the last frames (reverse, take, reverse back).
  const lead = (frames + 8) / size.fps
  const vf = [
    `fps=${size.fps}`,
    `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${size.width}:${size.height}`,
    'setsar=1',
    'reverse',
    `trim=end_frame=${frames}`,
    'reverse',
    'setpts=N/FRAME_RATE/TB',
  ].join(',')
  try {
    await runFfmpeg(['-sseof', `-${lead.toFixed(3)}`, '-i', clip.path, '-an', '-vf', vf, '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', out], { signal: ctx.signal })
  } catch (err) {
    throw new ProviderError(jobError('invalid_params', `Could not read the clip to continue (${err instanceof Error ? err.message : String(err)})`))
  }
  return out
}

/**
 * A camera guide (a Blender previs) at the render's size and frame rate, cut to exactly the frames the graph renders
 * (8k+1) and without sound: the IC-LoRA guide must line up frame for frame with the clip.
 */
async function clipGuide(clip: ResolvedInput, size: { width: number; height: number; fps: number; frames: number }, ctx: JobContext): Promise<string> {
  const out = join(ctx.tmpDir, `guide-${ctx.generationId}.mp4`)
  const vf = [
    `fps=${size.fps}`,
    `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${size.width}:${size.height}`,
    'setsar=1',
    // A guide shorter than the clip holds its last frame.
    `tpad=stop_mode=clone:stop=${size.frames}`,
    `trim=end_frame=${size.frames}`,
    'setpts=N/FRAME_RATE/TB',
  ].join(',')
  try {
    await runFfmpeg(['-i', clip.path, '-an', '-vf', vf, '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', out], { signal: ctx.signal })
  } catch (err) {
    throw new ProviderError(jobError('invalid_params', `Could not read the camera guide (${err instanceof Error ? err.message : String(err)})`))
  }
  return out
}

/**
 * The LTX upscaler: the source clip at 24 fps, cut to 8k+1 frames (with its sound), goes to the V2V refine graph,
 * which delivers it at 1920×1088.
 */
async function submitUpscale(ctx: JobContext, comfy: ComfyClient, podId: string, precision: GpuPrecision): Promise<SubmitResult> {
  const invalid = (message: string) => new ProviderError(jobError('invalid_params', message))
  const source = ctx.inputs.video as ResolvedInput | undefined
  if (!source || source.kind !== 'video') throw invalid('Choose a clip to upscale')
  const fps = 24
  const info = await probeFile(source.path)
  const duration = info.durationSeconds ?? source.durationSeconds ?? 0
  if (duration > RUNPOD_UPSCALE_MAX_SECONDS + 0.5) throw invalid(`The upscaler takes clips up to ${RUNPOD_UPSCALE_MAX_SECONDS} s — trim this one first`)
  const frames = graphFrames(fps, duration)
  if (frames < 9) throw invalid('The clip is too short to upscale')
  // The detail pass renders 1920×1088: another shape would come back cropped to its middle.
  if (info.width && info.height && Math.abs(info.width / info.height - 16 / 9) > 0.06) throw invalid('The upscaler takes 16:9 clips only — this one would come back cropped')
  const prepared = join(ctx.tmpDir, `upscale-${ctx.generationId}.mp4`)
  const audio = info.hasAudio
  try {
    // Cut to 8k+1 frames; a whole-second clip (24·s frames) is one short, so its last frame is held (tpad).
    await runFfmpeg(
      [
        '-i',
        source.path,
        '-vf',
        `fps=${fps},tpad=stop_mode=clone:stop=${frames},trim=end_frame=${frames},setpts=N/FRAME_RATE/TB,setsar=1`,
        '-c:v',
        'libx264',
        '-crf',
        '12',
        '-pix_fmt',
        'yuv420p',
        ...(audio ? ['-af', `atrim=end=${(frames / fps).toFixed(4)}`, '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
        prepared,
      ],
      { signal: ctx.signal },
    )
  } catch (err) {
    throw invalid(`Could not read the clip to upscale (${err instanceof Error ? err.message : String(err)})`)
  }
  let video: string
  try {
    video = (await comfy.upload(prepared, 'video/mp4', `studio_${ctx.generationId}_source.mp4`)).filename
  } finally {
    await rm(prepared, { force: true })
  }
  const { width, height } = RUNPOD_UPSCALE_SIZE
  const graph = buildUpscaleGraph({
    video,
    frames,
    fps,
    width,
    height,
    seed: typeof ctx.params.seed === 'number' ? ctx.params.seed : Math.floor(Math.random() * 2 ** 31),
    audio,
    precision,
    prefix: `wildroom/${ctx.generationId}`,
  })
  const broken = danglingLinks(graph)
  if (broken.length) throw new ProviderError(jobError('internal', `Broken workflow: ${broken.join(', ')}`))
  const estimateMs = runpodEstimateSeconds(width, height, frames / fps, fps) * 1000
  ctx.recordRequest({ workflow: 'v2v_upscale_1080p', source: video, frames, output: { width, height }, audio, precision, podId, graph })
  const promptId = await comfy.prompt(graph, STUDIO_CLIENT_ID)
  return { type: 'async', taskId: promptId, meta: { podId, promptId, width, height, upscale4k: false, estimateMs } }
}

/** ComfyUI failures as job errors: unreachable/starting are retried by the worker, a rejected graph fails the job. */
function asProviderError(err: unknown): unknown {
  if (err instanceof ProviderError) return err
  if (err instanceof ComfyError) {
    if (err.kind === 'rejected') return new ProviderError(jobError('invalid_params', err.message))
    if (err.kind === 'unauthorized') return new ProviderError(jobError('auth', 'The GPU did not accept the access token — prepare the volume again'))
    return new ProviderError(jobError('network', err.message, { retryable: true }))
  }
  return err
}
