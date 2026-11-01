import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from 'mediabunny'

// ---------------------------------------------------------------------------------------------
// Binary location
// ---------------------------------------------------------------------------------------------

let pathOverride: string | undefined

/** Use a user-configured ffmpeg binary instead of the bundled ffmpeg-static one (undefined resets). */
export function setFfmpegPathOverride(path?: string): void {
  const next = path?.trim() || undefined
  if (next !== pathOverride) {
    pathOverride = next
    encodersPromise = undefined
  }
}

export function ffmpegPath(): string {
  const path = pathOverride ?? bundledFfmpegPath()
  if (!path) throw new Error('No ffmpeg binary available for this platform (ffmpeg-static returned null)')
  return path
}

/**
 * ffmpeg-static's binary. Inside the packaged desktop app ffmpeg-static resolves to a path in `app.asar`,
 * which can be read but not executed; electron-builder unpacks the binary to `app.asar.unpacked`.
 */
function bundledFfmpegPath(): string | null {
  return ffmpegStatic ? ffmpegStatic.replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked') : null
}

// ---------------------------------------------------------------------------------------------
// Running ffmpeg
// ---------------------------------------------------------------------------------------------

export interface RunFfmpegOptions {
  signal?: AbortSignal
  /** Called with the output position (seconds) as ffmpeg reports progress. */
  onProgress?: (seconds: number) => void
  cwd?: string
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message)
    this.name = 'FfmpegError'
  }
}

/** Keep at most this much stderr (tail) in memory; summaries (ebur128, errors) are at the end. */
const MAX_STDERR_CHARS = 8 * 1024 * 1024

/**
 * Runs ffmpeg with `-hide_banner -nostdin -y` prepended. Resolves with the captured stderr; rejects with an
 * FfmpegError carrying the stderr tail on a non-zero exit, or with an AbortError when `signal` fires
 * (the process is terminated).
 */
export function runFfmpeg(args: string[], opts: RunFfmpegOptions = {}): Promise<{ stderr: string }> {
  const { signal, onProgress, cwd } = opts
  if (signal?.aborted) return Promise.reject(abortError(signal))
  const bin = ffmpegPath()
  const fullArgs = ['-hide_banner', '-nostdin', '-y', ...(onProgress ? ['-progress', 'pipe:1', '-nostats'] : []), ...args]

  return new Promise((resolve, reject) => {
    const child = spawn(bin, fullArgs, { cwd, stdio: ['ignore', onProgress ? 'pipe' : 'ignore', 'pipe'] })
    let stderr = ''
    let settled = false
    let killTimer: NodeJS.Timeout | undefined

    const onAbort = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (err: Error | null) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (killTimer) clearTimeout(killTimer)
      if (err) reject(err)
      else resolve({ stderr })
    }

    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > MAX_STDERR_CHARS) stderr = stderr.slice(-MAX_STDERR_CHARS / 2)
    })

    if (onProgress && child.stdout) {
      let buf = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buf += chunk
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          // out_time_us (and the misnamed out_time_ms) are microseconds.
          const m = /^out_time_(?:us|ms)=(-?\d+)$/.exec(line)
          if (m) {
            const seconds = Number(m[1]) / 1e6
            if (Number.isFinite(seconds) && seconds >= 0) {
              try {
                onProgress(seconds)
              } catch {
                // progress callbacks must not break the run
              }
            }
          }
        }
      })
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(
        err.code === 'ENOENT'
          ? new FfmpegError(`ffmpeg binary not found at ${bin}`, null, stderr)
          : new FfmpegError(`Failed to start ffmpeg: ${err.message}`, null, stderr),
      )
    })

    child.on('close', (code, sig) => {
      if (signal?.aborted) return finish(abortError(signal))
      if (code === 0) return finish(null)
      const reason = code === null ? `was killed (${sig ?? 'unknown signal'})` : `exited with code ${code}`
      finish(new FfmpegError(`ffmpeg ${reason}: ${stderrTail(stderr)}`, code, stderr))
    })
  })
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  const err = new Error('ffmpeg run aborted')
  err.name = 'AbortError'
  return err
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/** Last meaningful stderr lines (skips progress/stat noise) for error messages. */
export function stderrTail(stderr: string, maxLines = 8, maxChars = 1200): string {
  const lines = stderr
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(frame|size)=/.test(l) && !l.startsWith('Press [q]'))
  const tail = lines.slice(-maxLines).join(' | ')
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail || '(no output)'
}

// ---------------------------------------------------------------------------------------------
// Encoder detection
// ---------------------------------------------------------------------------------------------

export interface EncoderSupport {
  h264VideoToolbox: boolean
  hevcVideoToolbox: boolean
  aacAt: boolean
}

let encodersPromise: Promise<EncoderSupport> | undefined

/**
 * Which optional (hardware / Apple) encoders actually work. Being compiled in isn't enough (VideoToolbox
 * fails in VMs/CI), so each is verified with a tiny encode; an unknown encoder simply fails the same way.
 * Cached per ffmpeg binary.
 */
export function detectEncoders(): Promise<EncoderSupport> {
  encodersPromise ??= (async () => {
    const works = (args: string[]) => runFfmpeg([...args, '-f', 'null', '-']).then(() => true, () => false)
    const video = (codec: string) => works(['-f', 'lavfi', '-i', 'testsrc2=size=128x128:rate=10:duration=0.3', '-c:v', codec])
    const audio = (codec: string) => works(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.3', '-c:a', codec])
    const [h264VideoToolbox, hevcVideoToolbox, aacAt] = await Promise.all([
      video('h264_videotoolbox'),
      video('hevc_videotoolbox'),
      audio('aac_at'),
    ])
    return { h264VideoToolbox, hevcVideoToolbox, aacAt }
  })()
  return encodersPromise
}

// ---------------------------------------------------------------------------------------------
// Filtergraph helpers
// ---------------------------------------------------------------------------------------------

/**
 * Escapes a value (e.g. a file path) for use as a filter option inside a -filter_complex string:
 * one level for the option parser (`\ ' :`) and one for the graph parser (`\ ' , ; [ ]`).
 */
export function escapeFilterValue(value: string): string {
  let out = ''
  for (const ch of value) {
    const level1 = ch === '\\' || ch === "'" || ch === ':' ? `\\${ch}` : ch
    for (const c of level1) out += c === '\\' || c === "'" || c === ',' || c === ';' || c === '[' || c === ']' ? `\\${c}` : c
  }
  return out
}

/** Number formatting for filter expressions / CLI args (no exponent notation). */
export function fmtNum(n: number, digits = 6): string {
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ffmpeg: ${n}`)
  const s = n.toFixed(digits)
  return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s
}

/** Scale to at most `maxWidth` display pixels wide (square pixels, even dims); no upscaling. */
export function scaleToWidthFilter(maxWidth?: number): string {
  const w = maxWidth ? `min(${Math.round(maxWidth)},iw*sar)` : 'iw*sar'
  return `scale=w='max(2,trunc(${w}/2)*2)':h='max(2,trunc(${w}/dar/2)*2)',setsar=1`
}

// ---------------------------------------------------------------------------------------------
// Frame extraction
// ---------------------------------------------------------------------------------------------

export interface ExtractFrameOptions {
  /** Maximum output width in display pixels (keeps aspect, never upscales). */
  width?: number
  signal?: AbortSignal
}

/**
 * Writes the frame that is on screen at `seconds` (PNG or JPEG by the extension of `outPath`).
 *
 * `seconds` is a timestamp in the input's own timeline (as Mediabunny reports it / ffmpeg sees it with
 * -copyts). Proxies start at 0, so for an original use `proxySeconds + asset.timeOffset`.
 * "On screen" means the last frame whose timestamp is <= the requested time, so frame-centre times such as
 * (n + 0.5) / fps return frame n; times before the first frame return the first frame. Stills ignore `seconds`.
 */
export async function extractFrame(
  input: string,
  seconds: number,
  outPath: string,
  opts: ExtractFrameOptions = {},
): Promise<void> {
  const ext = extname(outPath).toLowerCase()
  const codecArgs = ext === '.jpg' || ext === '.jpeg' ? ['-q:v', '2'] : []
  const scale = scaleToWidthFilter(opts.width)
  const target = await locateFrame(input, seconds)

  let args: string[]
  if (target) {
    // Absolute (native) timestamps via -copyts; the input seek is only a coarse pre-roll, the exact frame is
    // picked by `select` on its known timestamp (mediabunny found it), so no -ss rounding semantics apply.
    const preroll = target.timestamp - 3
    const epsilon = 0.0005
    args = [
      '-copyts',
      '-seek_timestamp',
      '1',
      '-noaccurate_seek',
      ...(preroll > target.firstTimestamp ? ['-ss', fmtNum(preroll)] : []),
      '-i',
      input,
      '-map',
      '0:v:0',
      '-vf',
      `select='gte(t,${fmtNum(target.timestamp - epsilon, 9)})',${scale}`,
      '-fps_mode',
      'passthrough',
      '-frames:v',
      '1',
      '-update',
      '1',
      ...codecArgs,
      outPath,
    ]
  } else {
    // Not readable by mediabunny (image, exotic container): plain seek, first frame at/after `seconds`.
    const isStill = STILL_EXTS.has(extname(input).toLowerCase())
    args = [
      ...(isStill || seconds <= 0 ? [] : ['-ss', fmtNum(seconds)]),
      '-i',
      input,
      '-map',
      '0:v:0',
      '-vf',
      scale,
      '-frames:v',
      '1',
      '-update',
      '1',
      ...codecArgs,
      outPath,
    ]
  }
  await runFfmpeg(args, { signal: opts.signal })
  if (!existsSync(outPath)) throw new Error(`No frame at ${fmtNum(seconds, 3)}s in ${input}`)
}

const STILL_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.heif', '.bmp', '.tif', '.tiff'])

/** Native timestamp of the video frame on screen at native time `seconds`, via mediabunny's packet index. */
async function locateFrame(input: string, seconds: number): Promise<{ timestamp: number; firstTimestamp: number } | null> {
  if (STILL_EXTS.has(extname(input).toLowerCase())) return null
  const file = new Input({ formats: ALL_FORMATS, source: new FilePathSource(input) })
  try {
    if (!(await file.canRead())) return null
    const track = await file.getPrimaryVideoTrack()
    if (!track) return null
    const first = await track.getFirstTimestamp()
    // Negative timestamps (hidden by an edit list) are never presented.
    const origin = Math.max(first, 0)
    const sink = new EncodedPacketSink(track)
    const packet =
      (await sink.getPacket(Math.max(origin, seconds), { metadataOnly: true })) ?? (await sink.getFirstPacket({ metadataOnly: true }))
    if (!packet) return null
    return { timestamp: Math.max(packet.timestamp, origin), firstTimestamp: first }
  } catch {
    return null
  } finally {
    file.dispose()
  }
}

// ---------------------------------------------------------------------------------------------
// Loudness
// ---------------------------------------------------------------------------------------------

export interface Loudness {
  integratedLufs: number
  truePeakDb: number
}

/**
 * EBU R128 integrated loudness and true peak of the first audio stream. Returns null when the input has no
 * measurable audio (no stream, or digital silence where the values are -inf).
 */
export async function measureLoudness(input: string, opts: { signal?: AbortSignal } = {}): Promise<Loudness | null> {
  let stderr: string
  try {
    ;({ stderr } = await runFfmpeg(
      ['-nostats', '-i', input, '-map', '0:a:0', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'],
      { signal: opts.signal },
    ))
  } catch (err) {
    if (isAbortError(err)) throw err
    if (err instanceof FfmpegError && /matches no streams|does not contain any stream/i.test(err.stderr)) return null
    throw err
  }
  return parseEbur128Summary(stderr)
}

export function parseEbur128Summary(stderr: string): Loudness | null {
  const at = stderr.lastIndexOf('Summary:')
  if (at < 0) return null
  const summary = stderr.slice(at)
  const i = /I:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*LUFS/i.exec(summary)
  const peak = /Peak:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dBFS/i.exec(summary)
  if (!i || !peak) return null
  const integratedLufs = Number.parseFloat(i[1]!)
  const truePeakDb = Number.parseFloat(peak[1]!)
  if (!Number.isFinite(integratedLufs) || !Number.isFinite(truePeakDb)) return null
  return { integratedLufs, truePeakDb }
}

// ---------------------------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------------------------

const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/Library/Fonts/Arial Unicode.ttf',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/System/Library/Fonts/SFNS.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
]

let fontCache: { value: string | undefined } | undefined

/** An existing system font file usable by drawtext, or undefined (callers then skip text burn-in). */
export function systemFontPath(): string | undefined {
  fontCache ??= { value: FONT_CANDIDATES.find((p) => existsSync(p)) }
  return fontCache.value
}
