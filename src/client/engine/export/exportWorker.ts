/// <reference lib="webworker" />
import {
  ALL_FORMATS,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  StreamTarget,
  type StreamTargetChunk,
  UrlSource,
  type VideoSample,
  VideoSampleSink,
} from 'mediabunny'
import type { ItemSource } from '../canvasDraw'
import { type CompositeLayer, Compositor, type FrameSource, layerOpacity } from '../compositor'
import { registerFonts } from '../fonts'
import { type VideoFeed, type VideoLayer, dipColorAt, heldSourceTime, layersAt, motionVideoOwner, transitionOpacity, videoFeeds } from '../scene'
import type { ExportJob, ExportWorkerMessage } from './types'

const post = (msg: ExportWorkerMessage) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg)

/** One decode stream per clip instance, fed with ascending frame-centre timestamps. */
class ClipStream {
  private iterator: AsyncGenerator<VideoSample | null, void, unknown> | undefined
  private current: VideoSample | null = null
  private opening: Promise<void> | undefined

  constructor(
    private readonly url: string,
    private readonly timestamps: number[],
  ) {}

  private async open() {
    const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(this.url) })
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error(`No video track in ${this.url}`)
    this.iterator = new VideoSampleSink(track).samplesAtTimestamps(this.timestamps)
  }

  async next(): Promise<VideoSample | null> {
    this.opening ??= this.open()
    await this.opening
    const { value, done } = await this.iterator!.next()
    const sample = done ? null : (value ?? null)
    if (this.current && this.current !== sample) this.current.close()
    this.current = sample
    return sample
  }

  close() {
    this.current?.close()
    this.current = null
    void this.iterator?.return(undefined)
  }
}

async function decodeFirst(urls: readonly string[]): Promise<ImageBitmap> {
  let error: unknown = new Error('No image to load')
  for (const url of urls) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await createImageBitmap(await res.blob())
    } catch (err) {
      error = err // try the next copy
    }
  }
  throw error
}

async function run(job: ExportJob) {
  const { scene, startFrame, endFrame } = job
  const fps = scene.fps
  const canvas = new OffscreenCanvas(job.width, job.height)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('OffscreenCanvas 2D unavailable')
  const compositor = new Compositor()
  await registerFonts((self as unknown as WorkerGlobalScope).fonts, job.fonts)

  let bytes = 0
  const writable = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      const res = await fetch(`/api/exports/${job.exportId}/video?position=${chunk.position}`, {
        method: 'PUT',
        headers: { 'X-Studio': '1', 'Content-Type': 'application/octet-stream' },
        body: chunk.data,
      })
      if (!res.ok) throw new Error(`Upload failed (${res.status})`)
      bytes = Math.max(bytes, chunk.position + chunk.data.byteLength)
    },
  })
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
    target: new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }),
  })
  const quality = job.quality === 'very-high' ? QUALITY_VERY_HIGH : job.quality === 'medium' ? QUALITY_MEDIUM : QUALITY_HIGH
  const video = new CanvasSource(canvas, { codec: job.codec, quality, keyFrameInterval: 2 })
  output.addVideoTrack(video, { frameRate: fps })
  await output.start()

  // Decode streams per clip instance, or per video element of a motion clip (created lazily when it first appears).
  const streams = new Map<string, { stream: ClipStream; end: number }>()
  const images = new Map<string, ImageBitmap>()
  const streamFor = (feed: VideoFeed) => {
    let s = streams.get(feed.owner)
    if (!s) {
      const { layer } = feed
      const info = job.assets[feed.assetId]
      const from = Math.max(layer.start, startFrame)
      const to = Math.min(layer.end, endFrame)
      const ts: number[] = []
      for (let f = from; f < to; f++) ts.push((info?.timeOffset ?? 0) + heldSourceTime(layer.sourceStart + ((f + 0.5 - layer.start) / fps) * layer.speed, info?.duration))
      s = { stream: new ClipStream(`/media/${feed.assetId}/original`, ts), end: layer.end }
      streams.set(feed.owner, s)
    }
    return s.stream
  }
  // Canvas elements must not stop the export: one that can't be decoded is left out of the picture.
  const broken = new Set<string>()
  const stillFor = async (key: string, urls: readonly string[]): Promise<ImageBitmap | undefined> => {
    if (broken.has(key)) return undefined
    let bmp = images.get(key)
    if (!bmp) {
      try {
        bmp = await decodeFirst(urls)
      } catch {
        broken.add(key)
        return undefined
      }
      images.set(key, bmp)
    }
    return bmp
  }
  const motionSources = async (layer: VideoLayer): Promise<Record<string, ItemSource>> => {
    const out: Record<string, ItemSource> = {}
    for (const it of layer.motion?.items ?? []) {
      if (it.kind !== 'asset' || !it.assetId) continue
      const info = job.assets[it.assetId]
      if (info?.kind === 'video') {
        const owner = motionVideoOwner(layer.clipId, it.id)
        const sample = broken.has(owner) ? null : await streamFor({ owner, assetId: it.assetId, layer, itemId: it.id }).next().catch(() => (broken.add(owner), null))
        if (sample) out[it.id] = { image: sample.toCanvasImageSource(), width: sample.displayWidth, height: sample.displayHeight }
      } else if (info?.kind === 'image') {
        const bmp = await stillFor(it.assetId, info.stills ?? [`/media/${it.assetId}/original`])
        if (bmp) out[it.id] = { image: bmp, width: bmp.width, height: bmp.height }
      }
    }
    return out
  }

  const total = endFrame - startFrame
  for (let f = startFrame; f < endFrame; f++) {
    const composite: CompositeLayer[] = []
    for (const layer of layersAt(scene, f)) {
      const local = f - layer.start
      let source: FrameSource | undefined
      if (layer.kind === 'media' && layer.assetId) {
        const info = job.assets[layer.assetId]
        if (info?.kind === 'image') {
          let bmp = images.get(layer.assetId)
          if (!bmp) {
            const blob = await (await fetch(`/media/${layer.assetId}/original`)).blob()
            bmp = await createImageBitmap(blob)
            images.set(layer.assetId, bmp)
          }
          source = { image: bmp, imageWidth: bmp.width, imageHeight: bmp.height, width: info.width || bmp.width, height: info.height || bmp.height }
        } else if (info?.kind === 'video') {
          const sample = await streamFor(videoFeeds(layer)[0]!).next()
          if (sample) {
            source = {
              image: sample.toCanvasImageSource(),
              imageWidth: sample.displayWidth,
              imageHeight: sample.displayHeight,
              width: info.width || sample.displayWidth,
              height: info.height || sample.displayHeight,
            }
          }
        }
      }
      const itemSources = layer.kind === 'motion' ? await motionSources(layer) : undefined
      composite.push({ layer, source, opacity: layerOpacity(layer, local) * transitionOpacity(layer, f + 0.5), localFrame: local, itemSources })
    }
    compositor.render(ctx, composite, {
      frame: f,
      fps,
      width: scene.width,
      height: scene.height,
      scale: job.width / scene.width,
      dip: dipColorAt(scene, f),
    })
    await video.add((f - startFrame) / fps, 1 / fps)
    // Close streams of clips that ended.
    for (const [owner, s] of streams) {
      if (s.end <= f + 1) {
        s.stream.close()
        streams.delete(owner)
      }
    }
    if ((f - startFrame) % 6 === 0) post({ type: 'progress', done: f - startFrame + 1, total })
  }
  for (const s of streams.values()) s.stream.close()
  for (const bmp of images.values()) bmp.close()
  await output.finalize()
  post({ type: 'progress', done: total, total })
  post({ type: 'done', bytes })
}

self.onmessage = (event: MessageEvent<ExportJob>) => {
  run(event.data).catch((err: unknown) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
}
