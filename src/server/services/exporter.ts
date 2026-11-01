import { runFfmpeg } from './ffmpeg'

interface LoudnormMeasurement {
  input_i: string
  input_tp: string
  input_lra: string
  input_thresh: string
  target_offset: string
}

/** Pass 1 of two-pass loudnorm on the mix. Returns undefined for (near-)silent audio. */
export async function measureLoudnorm(audioPath: string, target: number): Promise<LoudnormMeasurement | undefined> {
  const { stderr } = await runFfmpeg([
    '-hide_banner',
    '-nostats',
    '-i',
    audioPath,
    '-af',
    `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`,
    '-f',
    'null',
    '-',
  ])
  const json = stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1)
  try {
    const m = JSON.parse(json) as LoudnormMeasurement
    const input = Number.parseFloat(m.input_i)
    if (!Number.isFinite(input) || input < -70) return undefined
    return m
  } catch {
    return undefined
  }
}

export interface FinalizeOptions {
  videoPath: string
  audioPath: string
  outPath: string
  fps: number
  frames: number
  /** Target integrated loudness (LUFS) or null. */
  loudness: number | null
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

/**
 * Muxes the browser-encoded picture with the offline mix. Video is copied; audio is padded/trimmed to
 * exactly frames·48000/fps samples so both tracks end together, optionally loudness-normalised (linear).
 */
export async function finalizeExport(opts: FinalizeOptions) {
  const samples = Math.round((opts.frames * 48_000) / opts.fps)
  const filters: string[] = []
  if (opts.loudness != null) {
    const m = await measureLoudnorm(opts.audioPath, opts.loudness)
    if (m) {
      filters.push(
        `loudnorm=I=${opts.loudness}:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
      )
    }
  }
  filters.push('aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo', `apad=whole_len=${samples}`, `atrim=end_sample=${samples}`)
  const durationSec = opts.frames / opts.fps
  await runFfmpeg(
    [
      '-hide_banner',
      '-y',
      '-i',
      opts.videoPath,
      '-i',
      opts.audioPath,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      '-video_track_timescale',
      String(Math.round(opts.fps * 1000)),
      '-af',
      filters.join(','),
      '-c:a',
      'aac',
      '-b:a',
      '320k',
      '-ar',
      '48000',
      '-movflags',
      '+faststart',
      opts.outPath,
    ],
    { signal: opts.signal, onProgress: (s) => opts.onProgress?.(Math.min(1, s / Math.max(0.001, durationSec))) },
  )
}
