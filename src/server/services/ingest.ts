import { spawn } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny'
import { nanoid } from 'nanoid'
import type { AssetVariant, FilmstripInfo } from '../../shared/types/assets'
import { secondsToFlicks } from '../../shared/time/flicks'
import type { Env } from '../env'
import type { DerivedCache } from '../storage/derivedCache'
import type { AssetRecord } from '../storage/records'
import {
  detectEncoders,
  extractFrame,
  fmtNum,
  isAbortError,
  measureLoudness,
  runFfmpeg,
  scaleToWidthFilter,
  stderrTail,
  type Loudness,
} from './ffmpeg'
import { probeFile, timeOrigin, type ProbeResult } from './probe'

// ---------------------------------------------------------------------------------------------
// Cache layout: <derivedDir>/<sha[0:2]>/<sha256>/<step>-v<N>.<ext> (+ state.json, see DerivedCache)
// Derived files are keyed by content hash, so duplicate imports (in any project) share them; bumping a step's
// version makes every asset regenerate that step on its next ingest.
// ---------------------------------------------------------------------------------------------

export const INGEST_STEP_VERSIONS = {
  proxy: 1,
  audio: 1,
  poster: 1,
  filmstrip: 1,
  waveform: 1,
  loudness: 1,
  display: 1,
} as const

export type IngestStep = keyof typeof INGEST_STEP_VERSIONS

const STEP_EXT: Record<IngestStep, string> = {
  proxy: 'mp4',
  audio: 'wav',
  poster: 'jpg',
  filmstrip: 'jpg',
  waveform: 'bin',
  loudness: 'json',
  display: 'webp',
}

/** Which cache step produces each served variant ('original' lives in the media store). */
export const VARIANT_STEP: Record<Exclude<AssetVariant, 'original'>, IngestStep> = {
  proxy: 'proxy',
  audio: 'audio',
  poster: 'poster',
  filmstrip: 'filmstrip',
  waveform: 'waveform',
  display: 'display',
}

export function derivedDir(env: Env, sha256: string): string {
  return join(env.derivedDir, sha256.slice(0, 2), sha256)
}

export function derivedPath(env: Env, sha256: string, step: IngestStep): string {
  return join(derivedDir(env, sha256), `${step}-v${INGEST_STEP_VERSIONS[step]}.${STEP_EXT[step]}`)
}

export const PROXY_MAX_HEIGHT = 720
export const POSTER_MAX_WIDTH = 640
/** Long edge of an image's on-screen copy (canvas boards): sharp at 2× on a typical card, light to decode. */
export const DISPLAY_MAX_EDGE = 2048
export const FILMSTRIP_TILE_HEIGHT = 72
export const FILMSTRIP_MAX_COLUMNS = 12
export const WAVEFORM_RATE = 100
export const WAV_SAMPLE_RATE = 48000

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

const NTSC_RATES: Array<[number, number]> = [
  [24000, 1001],
  [30000, 1001],
  [48000, 1001],
  [60000, 1001],
  [120000, 1001],
]

/**
 * CFR rate for the proxy: the source's best-guess rate rounded to 3 decimals. NTSC rates are passed to
 * ffmpeg as exact rationals so long proxies don't drift against the original.
 */
export function proxyFrameRate(fps: number | undefined): { value: number; arg: string } {
  const f = fps !== undefined && Number.isFinite(fps) && fps > 0 && fps <= 240 ? fps : 30
  for (const [num, den] of NTSC_RATES) {
    if (Math.abs(f - num / den) < 0.002) return { value: num / den, arg: `${num}/${den}` }
  }
  const rounded = Math.round(f * 1000) / 1000
  return { value: rounded, arg: fmtNum(rounded, 3) }
}

/**
 * Filmstrip geometry: one tile per ~0.5 s (4–120 tiles, never more than the clip has frames), tiles sampled at
 * their centres (i + 0.5) * interval, 72 px tall, width from the display aspect.
 */
export function filmstripLayout(
  durationSeconds: number,
  displayWidth: number,
  displayHeight: number,
  frameCount?: number,
): FilmstripInfo {
  let count = Math.min(120, Math.max(4, Math.ceil(durationSeconds / 0.5)))
  if (frameCount !== undefined && frameCount > 0) count = Math.min(count, frameCount)
  count = Math.max(1, count)
  const aspect = displayWidth > 0 && displayHeight > 0 ? displayWidth / displayHeight : 16 / 9
  return {
    interval: durationSeconds / count,
    count,
    tileWidth: Math.max(2, Math.round((FILMSTRIP_TILE_HEIGHT * aspect) / 2) * 2),
    tileHeight: FILMSTRIP_TILE_HEIGHT,
    columns: Math.min(count, FILMSTRIP_MAX_COLUMNS),
  }
}

/** Proxy frame indices shown by each filmstrip tile (the frame on screen at the tile centre). */
export function filmstripFrameIndices(info: FilmstripInfo, fps: number, frameCount: number): number[] {
  const out: number[] = []
  for (let i = 0; i < info.count; i++) {
    const t = (i + 0.5) * info.interval
    out.push(Math.max(0, Math.min(frameCount - 1, Math.floor(t * fps + 1e-6))))
  }
  return out
}

/** Filter chain that moves audio onto the asset's time origin and converts it to the ingest WAV format. */
function wavFilter(origin: number): string {
  // With -copyts the audio keeps its native timestamps; shifting by the origin and letting aresample
  // start at pts 0 pads (audio starts late) or trims (audio starts early / priming) sample-exactly.
  return [
    `asetpts=PTS-${fmtNum(origin, 9)}/TB`,
    `aresample=${WAV_SAMPLE_RATE}:async=1:first_pts=0`,
    `aformat=sample_fmts=s16:sample_rates=${WAV_SAMPLE_RATE}:channel_layouts=stereo`,
  ].join(',')
}

const WAV_OUTPUT_ARGS = ['-c:a', 'pcm_s16le', '-ar', String(WAV_SAMPLE_RATE), '-ac', '2', '-f', 'wav']

function tempSibling(finalPath: string): string {
  const ext = extname(finalPath)
  return `${finalPath.slice(0, finalPath.length - ext.length)}.tmp-${nanoid(8)}${ext}`
}

/** Runs `make` against a temp file next to `finalPath`, then renames it into place atomically. */
async function produce(finalPath: string, make: (tmpPath: string) => Promise<void>): Promise<void> {
  const tmp = tempSibling(finalPath)
  try {
    await make(tmp)
    if (!existsSync(tmp)) throw new Error(`${extname(finalPath).slice(1)} output was not written`)
    await rename(tmp, finalPath)
  } finally {
    await rm(tmp, { force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

interface StepContext {
  env: Env
  sha: string
  original: string
  probe: ProbeResult
  /** Native timestamp that becomes t=0 (see timeOrigin). */
  origin: number
  signal: AbortSignal
}

const pathOf = (ctx: StepContext, step: IngestStep) => derivedPath(ctx.env, ctx.sha, step)

/**
 * Step 1 (video): one decode producing the proxy plus, when missing, audio.wav and poster.jpg.
 * Proxy: H.264 CFR at the source rate, ≤720 px tall, keyframe every ~0.5 s, no B-frames, no audio, faststart.
 * Proxy and WAV both start at the original's first video frame.
 */
async function buildProxy(ctx: StepContext): Promise<void> {
  const { probe, origin } = ctx
  const proxyOut = pathOf(ctx, 'proxy')
  const wavOut = pathOf(ctx, 'audio')
  const posterOut = pathOf(ctx, 'poster')
  const wantWav = probe.hasAudio && !existsSync(wavOut)
  const wantPoster = !existsSync(posterOut)

  const rate = proxyFrameRate(probe.fps)
  const gop = Math.max(1, Math.round(rate.value / 2))
  const duration = probe.durationSeconds ?? 0
  const posterFrame = Math.max(0, Math.floor(duration * 0.2 * rate.value + 1e-6))
  const { h264VideoToolbox } = await detectEncoders()

  const graph = [
    `[0:v:0]setpts=PTS-${fmtNum(origin, 9)}/TB,fps=fps=${rate.arg}:start_time=0${wantPoster ? ',split=2[pv][pp]' : '[pv]'}`,
    `[pv]scale=w='max(2,trunc(min(${PROXY_MAX_HEIGHT},ih)*dar/2)*2)':h='max(2,trunc(min(${PROXY_MAX_HEIGHT},ih)/2)*2)',setsar=1,format=yuv420p[proxy]`,
  ]
  if (wantPoster) {
    graph.push(`[pp]trim=start_frame=${posterFrame}:end_frame=${posterFrame + 1},${scaleToWidthFilter(POSTER_MAX_WIDTH)}[poster]`)
  }
  if (wantWav) graph.push(`[0:a:0]${wavFilter(origin)}[wav]`)

  const encoder = h264VideoToolbox
    ? ['-c:v', 'h264_videotoolbox', '-b:v', '5M', '-profile:v', 'high', '-allow_sw', '1']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p']

  const proxyTmp = tempSibling(proxyOut)
  const wavTmp = tempSibling(wavOut)
  const posterTmp = tempSibling(posterOut)
  const args = [
    '-copyts',
    '-i',
    ctx.original,
    '-filter_complex',
    graph.join(';'),
    '-map',
    '[proxy]',
    '-an',
    ...encoder,
    '-g',
    String(gop),
    '-bf',
    '0',
    '-fps_mode',
    'passthrough',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    proxyTmp,
  ]
  if (wantWav) args.push('-map', '[wav]', ...WAV_OUTPUT_ARGS, wavTmp)
  if (wantPoster) args.push('-map', '[poster]', '-frames:v', '1', '-q:v', '3', '-update', '1', posterTmp)

  try {
    await runFfmpeg(args, { signal: ctx.signal })
    if (!existsSync(proxyTmp)) throw new Error('proxy was not written')
    await rename(proxyTmp, proxyOut)
    if (wantWav && existsSync(wavTmp)) await rename(wavTmp, wavOut)
    // The poster branch can legitimately produce nothing (e.g. single-frame clips); the poster step retries.
    if (wantPoster && existsSync(posterTmp)) await rename(posterTmp, posterOut)
  } finally {
    await Promise.all([proxyTmp, wavTmp, posterTmp].map((p) => rm(p, { force: true })))
  }
}

/** Step 2: audio.wav (48 kHz stereo s16) aligned to the asset's time origin. */
async function buildWav(ctx: StepContext): Promise<void> {
  await produce(pathOf(ctx, 'audio'), (tmp) =>
    runFfmpeg(['-copyts', '-i', ctx.original, '-map', '0:a:0', '-af', wavFilter(ctx.origin), ...WAV_OUTPUT_ARGS, tmp], {
      signal: ctx.signal,
    }).then(() => undefined),
  )
}

/** Step 3: poster.jpg — video: frame at 20 % of the duration; image: scaled copy. Max 640 px wide. */
async function buildPoster(ctx: StepContext): Promise<void> {
  const { probe } = ctx
  await produce(pathOf(ctx, 'poster'), async (tmp) => {
    if (probe.kind === 'video') {
      const at = ctx.origin + (probe.durationSeconds ?? 0) * 0.2
      await extractFrame(ctx.original, at, tmp, { width: POSTER_MAX_WIDTH, signal: ctx.signal })
      return
    }
    try {
      await runFfmpeg(
        ['-i', ctx.original, '-map', '0:v:0', '-vf', scaleToWidthFilter(POSTER_MAX_WIDTH), '-frames:v', '1', '-q:v', '3', '-update', '1', tmp],
        { signal: ctx.signal },
      )
    } catch (err) {
      // ffmpeg 6 cannot decode HEIC; macOS's sips can.
      if (isAbortError(err) || process.platform !== 'darwin') throw err
      const width = Math.min(POSTER_MAX_WIDTH, probe.width ?? POSTER_MAX_WIDTH)
      await runTool('sips', ['-s', 'format', 'jpeg', '--resampleWidth', String(width), ctx.original, '--out', tmp], ctx.signal)
    }
  })
}

/** Images only: display.webp — at most 2048 px on the long edge, alpha kept (the JPEG poster flattens it). */
async function buildDisplay(ctx: StepContext): Promise<void> {
  const max = DISPLAY_MAX_EDGE
  await produce(pathOf(ctx, 'display'), (tmp) =>
    runFfmpeg(
      [
        '-i', ctx.original,
        '-map', '0:v:0',
        '-vf', `scale=w='min(${max},iw)':h='min(${max},ih)':force_original_aspect_ratio=decrease`,
        '-frames:v', '1',
        '-c:v', 'libwebp', '-quality', '88', '-pix_fmt', 'yuva420p',
        '-f', 'webp', tmp,
      ],
      { signal: ctx.signal },
    ).then(() => undefined),
  )
}

/** Step 4: filmstrip.jpg sampled from the (CFR) proxy at tile centres, packed with the tile filter. */
async function buildFilmstrip(ctx: StepContext): Promise<FilmstripInfo> {
  const proxy = pathOf(ctx, 'proxy')
  const rate = proxyFrameRate(ctx.probe.fps)
  const frameCount = await countVideoFrames(proxy)
  const duration = ctx.probe.durationSeconds ?? frameCount / rate.value
  const info = filmstripLayout(duration, ctx.probe.width ?? 16, ctx.probe.height ?? 9, frameCount)
  const out = pathOf(ctx, 'filmstrip')
  if (existsSync(out)) return info

  const indices = filmstripFrameIndices(info, rate.value, frameCount)
  const rows = Math.ceil(info.count / info.columns)
  const select = indices.map((n) => `eq(n,${n})`).join('+')
  const filter = [
    `select='${select}'`,
    `scale=${info.tileWidth}:${info.tileHeight},setsar=1`,
    // nb_frames defaults to the whole grid, so cells after the last tile get blank-filled (black) at EOF
    // instead of being left uninitialised.
    `tile=layout=${info.columns}x${rows}:padding=0:margin=0:color=black`,
  ].join(',')
  await produce(out, (tmp) =>
    runFfmpeg(['-i', proxy, '-map', '0:v:0', '-vf', filter, '-fps_mode', 'passthrough', '-frames:v', '1', '-q:v', '4', '-update', '1', tmp], {
      signal: ctx.signal,
    }).then(() => undefined),
  )
  return info
}

async function countVideoFrames(path: string): Promise<number> {
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(path) })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('proxy has no video track')
    return (await track.computePacketStats()).packetCount
  } finally {
    input.dispose()
  }
}

/** Step 5: waveform.bin — `peaksPerSecond` mono peaks (max |sample| per bucket, 0..255) as raw bytes. */
async function buildWaveform(ctx: StepContext): Promise<void> {
  const out = pathOf(ctx, 'waveform')
  if (existsSync(out)) return
  const peaks = await computeWaveformPeaks(pathOf(ctx, 'audio'), WAVEFORM_RATE)
  await produce(out, (tmp) => writeFile(tmp, peaks))
}

/** Step 6: EBU R128 loudness of the wav, cached as JSON (`null` when silent). */
async function buildLoudness(ctx: StepContext): Promise<Loudness | null> {
  const out = pathOf(ctx, 'loudness')
  if (existsSync(out)) return JSON.parse(await readFile(out, 'utf8')) as Loudness | null
  const loudness = await measureLoudness(pathOf(ctx, 'audio'), { signal: ctx.signal })
  await produce(out, (tmp) => writeFile(tmp, JSON.stringify(loudness)))
  return loudness
}

function runTool(cmd: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], signal })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => (stderr += c))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}: ${stderrTail(stderr)}`)),
    )
  })
}

// ---------------------------------------------------------------------------------------------
// WAV → peaks
// ---------------------------------------------------------------------------------------------

interface WavInfo {
  channels: number
  sampleRate: number
  bitsPerSample: number
  dataOffset: number
  dataBytes: number
}

export async function readWavInfo(path: string): Promise<WavInfo> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const head = Buffer.alloc(12)
    await fh.read(head, 0, 12, 0)
    if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file')
    let offset = 12
    let fmt: Omit<WavInfo, 'dataOffset' | 'dataBytes'> | undefined
    const chunk = Buffer.alloc(8)
    while (offset + 8 <= size) {
      await fh.read(chunk, 0, 8, offset)
      const id = chunk.toString('latin1', 0, 4)
      const len = chunk.readUInt32LE(4)
      const body = offset + 8
      if (id === 'fmt ') {
        const f = Buffer.alloc(16)
        await fh.read(f, 0, 16, body)
        fmt = { channels: f.readUInt16LE(2), sampleRate: f.readUInt32LE(4), bitsPerSample: f.readUInt16LE(14) }
      } else if (id === 'data') {
        if (!fmt) throw new Error('WAV data chunk before fmt chunk')
        // Streams written without a final size (or > 4 GiB) carry a bogus length: read to EOF.
        const dataBytes = len === 0 || len === 0xffffffff || body + len > size ? size - body : len
        return { ...fmt, dataOffset: body, dataBytes }
      }
      offset = body + len + (len % 2)
    }
    throw new Error('WAV has no data chunk')
  } finally {
    await fh.close()
  }
}

/**
 * Mono peak envelope of a 16-bit PCM WAV: for each 1/peaksPerSecond bucket the max |(L+R+…)/n|, scaled to
 * 0..255. Streams the file so long recordings don't need to fit in memory.
 */
export async function computeWaveformPeaks(wavPath: string, peaksPerSecond = WAVEFORM_RATE): Promise<Uint8Array> {
  const info = await readWavInfo(wavPath)
  if (info.bitsPerSample !== 16) throw new Error(`waveform expects 16-bit PCM, got ${info.bitsPerSample}-bit`)
  const { channels, sampleRate } = info
  const frameBytes = channels * 2
  const totalFrames = Math.floor(info.dataBytes / frameBytes)
  const peaks = new Uint8Array(Math.ceil((totalFrames * peaksPerSecond) / sampleRate))
  if (totalFrames === 0) return peaks

  const framesPerBucket = sampleRate / peaksPerSecond
  let frame = 0
  let bucket = 0
  let nextBoundary = framesPerBucket
  let peak = 0
  let carry: Uint8Array = new Uint8Array(0)
  const flush = () => {
    if (bucket < peaks.length) peaks[bucket] = Math.min(255, Math.round((peak / 32768) * 255))
  }

  const stream = createReadStream(wavPath, { start: info.dataOffset, end: info.dataOffset + totalFrames * frameBytes - 1 })
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let bytes: Uint8Array = chunk
    if (carry.length) {
      const merged = new Uint8Array(carry.length + chunk.length)
      merged.set(carry)
      merged.set(chunk, carry.length)
      bytes = merged
    }
    const usable = bytes.length - (bytes.length % frameBytes)
    // Int16Array views need 2-byte alignment; copy the rare misaligned chunk.
    const aligned = bytes.byteOffset % 2 === 0 ? bytes : bytes.slice()
    const samples = new Int16Array(aligned.buffer, aligned.byteOffset, usable / 2)
    for (let i = 0; i < samples.length; i += channels) {
      let sum = 0
      for (let c = 0; c < channels; c++) sum += samples[i + c]!
      const v = Math.abs(sum / channels)
      if (v > peak) peak = v
      frame++
      if (frame >= nextBoundary) {
        flush()
        bucket++
        nextBoundary = (bucket + 1) * framesPerBucket
        peak = 0
      }
    }
    carry = bytes.slice(usable)
  }
  if (frame > bucket * framesPerBucket) flush()
  return peaks
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

type ProbeFields = Pick<
  AssetRecord,
  | 'kind'
  | 'mime'
  | 'durationFlicks'
  | 'width'
  | 'height'
  | 'fps'
  | 'rotation'
  | 'hasVideo'
  | 'hasAudio'
  | 'sampleRate'
  | 'channels'
  | 'videoCodec'
  | 'audioCodec'
>

/** Probe results as asset record fields. */
export function probeColumns(probe: ProbeResult): ProbeFields {
  return {
    kind: probe.kind,
    mime: probe.mime,
    durationFlicks: probe.durationSeconds !== undefined ? secondsToFlicks(probe.durationSeconds) : null,
    width: probe.width ?? null,
    height: probe.height ?? null,
    fps: probe.fps ?? null,
    rotation: probe.rotation ?? null,
    hasVideo: probe.hasVideo,
    hasAudio: probe.hasAudio,
    sampleRate: probe.sampleRate ?? null,
    channels: probe.channels ?? null,
    videoCodec: probe.videoCodec ?? null,
    audioCodec: probe.audioCodec ?? null,
  }
}

/** The poster of an original, built on demand (project cards of closed projects). */
export async function ensurePoster(env: Env, sha: string, original: string, signal?: AbortSignal): Promise<string> {
  const out = derivedPath(env, sha, 'poster')
  if (existsSync(out)) return out
  const probe = await probeFile(original)
  await mkdir(derivedDir(env, sha), { recursive: true })
  await buildPoster({ env, sha, original, probe, origin: timeOrigin(probe), signal: signal ?? new AbortController().signal })
  return out
}

export interface IngestQueueOptions {
  env: Env
  cache: DerivedCache
  /** Originals processed in parallel (default 2). */
  concurrency?: number
  /** Called after every state change of a hash so the owner can publish `asset.upserted` for its assets. */
  onChange: (sha: string) => void
  /** Called once a hash is no longer queued or running (e.g. so a project that waited for it can close). */
  onSettled?: (sha: string) => void
}

interface Job {
  sha: string
  /** Current path of the original (it can move with its project); undefined when no copy is reachable. */
  resolveOriginal: () => string | undefined
  promise: Promise<void>
  resolve: () => void
  controller: AbortController
}

/**
 * Background ingest queue, keyed by content hash: every applicable step runs once per original (reusing cached
 * outputs) and the machine-local state in the cache is kept current — 'ready' once the essentials exist (proxy +
 * wav for video, wav for audio, poster for images), then the remaining variants are added. Failures of essential
 * steps set 'error'.
 */
export class IngestQueue {
  private readonly concurrency: number
  private waiting: Job[] = []
  private readonly jobs = new Map<string, Job>()
  private readonly running = new Map<string, Promise<void>>()
  private closed = false

  constructor(private readonly opts: IngestQueueOptions) {
    this.concurrency = Math.max(1, opts.concurrency ?? 2)
  }

  /** Queues a hash (no-op if already queued/running). Resolves when its ingest finished or failed. */
  ensure(sha: string, resolveOriginal: () => string | undefined): Promise<void> {
    const existing = this.jobs.get(sha)
    if (existing) return existing.promise
    if (this.closed) return Promise.resolve()
    let resolve!: () => void
    const promise = new Promise<void>((r) => (resolve = r))
    const job: Job = { sha, resolveOriginal, promise, resolve, controller: new AbortController() }
    this.jobs.set(sha, job)
    this.waiting.push(job)
    queueMicrotask(() => this.pump())
    return promise
  }

  /** The completion promise of a queued or running hash. */
  pending(sha: string): Promise<void> | undefined {
    return this.jobs.get(sha)?.promise
  }

  /** Hashes queued or running. */
  pendingShas(): Set<string> {
    return new Set(this.jobs.keys())
  }

  /** Stops the queue: kills running ffmpeg processes; interrupted hashes stay 'processing' for a later resume. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const dropped = this.waiting
    this.waiting = []
    for (const job of this.jobs.values()) job.controller.abort()
    await Promise.allSettled([...this.running.values()])
    for (const job of dropped) {
      this.jobs.delete(job.sha)
      job.resolve()
    }
  }

  private pump() {
    while (!this.closed && this.running.size < this.concurrency) {
      const job = this.waiting.shift()
      if (!job) return
      const run = this.process(job)
        // Only a failure to record a failure gets here (the cache can't be written): never an unhandled rejection.
        .catch((err: unknown) => console.error(`[ingest] ${job.sha.slice(0, 12)} failed:`, err))
        .finally(() => {
          this.running.delete(job.sha)
          this.jobs.delete(job.sha)
          job.resolve()
          try {
            this.opts.onSettled?.(job.sha)
          } catch (err) {
            console.error(`[ingest] ${job.sha.slice(0, 12)} settled, but its listener failed:`, err)
          }
          this.pump()
        })
      this.running.set(job.sha, run)
    }
  }

  private update(sha: string, patch: Parameters<DerivedCache['setState']>[1]) {
    this.opts.cache.setState(sha, patch)
    this.opts.onChange(sha)
  }

  private async process(job: Job): Promise<void> {
    const original = job.resolveOriginal()
    // No reachable original (e.g. its project closed, or the file hasn't synced yet): assets report 'missing'.
    if (!original || !existsSync(original)) return
    try {
      await this.ingest(job.sha, original, job.controller.signal)
    } catch (err) {
      if (isAbortError(err) && (this.closed || job.controller.signal.aborted)) return
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[ingest] ${job.sha.slice(0, 12)} (${original}) failed:`, message)
      this.update(job.sha, { status: 'error', error: `Processing failed: ${message}`, pending: undefined })
    }
  }

  private async ingest(sha: string, original: string, signal: AbortSignal): Promise<void> {
    const { env } = this.opts
    const probe = await probeFile(original)
    const ctx: StepContext = { env, sha, original, probe, origin: timeOrigin(probe), signal }
    const dir = derivedDir(env, sha)
    await mkdir(dir, { recursive: true })
    await removeStaleTemps(dir)

    const variants: Partial<Record<AssetVariant, boolean>> = { original: true }
    const has = (step: IngestStep) => existsSync(pathOf(ctx, step))
    const warnings: string[] = []
    /** Non-essential steps: a failure is logged and the variant left out, the asset stays usable. */
    const optional = async <T>(step: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn()
      } catch (err) {
        if (isAbortError(err)) throw err
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`[ingest] ${sha.slice(0, 12)} ${step} failed:`, message)
        warnings.push(`${step}: ${message}`)
        return undefined
      }
    }

    // Fonts are used as they are: nothing to derive.
    if (probe.kind === 'font') {
      this.update(sha, { status: 'ready', error: undefined, variants, pending: undefined, warnings: undefined })
      return
    }
    if (probe.kind === 'image') {
      if (!has('poster')) await buildPoster(ctx)
      variants.poster = true
      if (!has('display')) {
        // Usable from here on (the original draws on its own); the light display copy follows.
        this.update(sha, { status: 'ready', error: undefined, variants: { ...variants }, pending: true })
        if (!(await optional('display', () => buildDisplay(ctx).then(() => true)))) {
          this.update(sha, { pending: undefined, warnings })
          return
        }
      }
      variants.display = true
      this.update(sha, { status: 'ready', error: undefined, variants, pending: undefined, warnings: undefined })
      return
    }

    if (probe.kind === 'video' && !has('proxy')) await buildProxy(ctx)
    if (probe.hasAudio && !has('audio')) await buildWav(ctx)
    if (probe.kind === 'video') variants.proxy = true
    if (probe.hasAudio) variants.audio = true
    if (has('poster')) variants.poster = true
    // Usable from here on; `pending` makes a restart resume the remaining steps.
    this.update(sha, { status: 'ready', error: undefined, variants: { ...variants }, pending: true })

    let filmstrip: FilmstripInfo | undefined
    let waveformRate: number | undefined
    let loudness: Loudness | null | undefined
    if (probe.kind === 'video') {
      if (!variants.poster && (await optional('poster', () => buildPoster(ctx).then(() => true)))) variants.poster = true
      filmstrip = await optional('filmstrip', () => buildFilmstrip(ctx))
      if (filmstrip) variants.filmstrip = true
    }
    if (probe.hasAudio) {
      if (await optional('waveform', () => buildWaveform(ctx).then(() => true))) {
        variants.waveform = true
        waveformRate = WAVEFORM_RATE
      }
      loudness = (await optional('loudness', () => buildLoudness(ctx))) ?? null
    }
    this.update(sha, {
      variants,
      filmstrip,
      waveformRate,
      loudness: probe.hasAudio ? loudness : undefined,
      pending: undefined,
      warnings: warnings.length ? warnings : undefined,
    })
  }
}

async function removeStaleTemps(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[])
  await Promise.all(names.filter((n) => n.includes('.tmp-')).map((n) => rm(join(dir, n), { force: true })))
}
