import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { AlignedWord } from '../../shared/types/assets'
import { ApiError, apiErrorFrom } from '../http'
import { ELEVENLABS_BASE_URL, elevenLabsError } from '../providers/elevenlabs'
import { extractFrame, runFfmpeg } from './ffmpeg'

/**
 * Media analysis used by editor tools: audio decoding for beat tracking, frame colour statistics (match colour,
 * continuity), how alike two stills are, reversed media, and ElevenLabs speech-to-text / voice isolation.
 */

const tmp = (dir: string, ext: string) => join(dir, `analysis-${nanoid(8)}.${ext}`)

/** Mono float PCM at `rate` Hz (whole file, or `maxSeconds` of it). */
export async function decodeMono(input: string, rate: number, tmpDir: string, maxSeconds = 900): Promise<Float32Array> {
  const out = tmp(tmpDir, 'f32')
  try {
    await runFfmpeg(['-i', input, '-t', String(maxSeconds), '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', out])
    const buf = await readFile(out)
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4))
  } finally {
    await rm(out, { force: true })
  }
}

export interface FrameRgb {
  width: number
  height: number
  data: Uint8Array
}

/** A small RGB thumbnail of the frame at `seconds` (images ignore the time). */
export async function frameRgb(input: string, seconds: number, tmpDir: string, width = 96, still = false): Promise<FrameRgb> {
  const out = tmp(tmpDir, 'rgb')
  const height = Math.round((width * 9) / 16)
  try {
    const seek = still ? [] : ['-ss', Math.max(0, seconds).toFixed(3)]
    await runFfmpeg([...seek, '-i', input, '-frames:v', '1', '-vf', `scale=${width}:${height}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', out])
    const data = new Uint8Array(await readFile(out))
    return { width, height, data }
  } finally {
    await rm(out, { force: true })
  }
}

/** JPEG of the frame at `seconds`, for vision models. */
export async function frameJpeg(input: string, seconds: number, tmpDir: string, width = 640): Promise<Buffer> {
  const out = tmp(tmpDir, 'jpg')
  try {
    await extractFrame(input, seconds, out, { width })
    return await readFile(out)
  } finally {
    await rm(out, { force: true })
  }
}

export interface ColorStats {
  /** Mean R, G, B in 0..1 (sRGB-encoded values). */
  mean: [number, number, number]
  lumaMean: number
  lumaStd: number
  saturation: number
  /** 4×4 grid of mean luma (row-major), for rough composition comparisons. */
  grid: number[]
  /** Luma-weighted centroid of the brightest 10% of pixels (0..1), a crude "where is the subject" hint. */
  highlight: { x: number; y: number }
}

export function colorStats(frame: FrameRgb): ColorStats {
  const { width, height, data } = frame
  const n = width * height
  let r = 0
  let g = 0
  let b = 0
  let sat = 0
  const luma = new Float32Array(n)
  const grid = new Array<number>(16).fill(0)
  const gridCount = new Array<number>(16).fill(0)
  for (let i = 0; i < n; i++) {
    const R = data[i * 3]! / 255
    const G = data[i * 3 + 1]! / 255
    const B = data[i * 3 + 2]! / 255
    r += R
    g += G
    b += B
    const max = Math.max(R, G, B)
    const min = Math.min(R, G, B)
    sat += max > 0 ? (max - min) / max : 0
    const y = 0.2126 * R + 0.7152 * G + 0.0722 * B
    luma[i] = y
    const cell = Math.min(3, Math.floor(((i % width) / width) * 4)) + 4 * Math.min(3, Math.floor((Math.floor(i / width) / height) * 4))
    grid[cell]! += y
    gridCount[cell]!++
  }
  const lumaMean = luma.reduce((a, v) => a + v, 0) / n
  const lumaStd = Math.sqrt(luma.reduce((a, v) => a + (v - lumaMean) ** 2, 0) / n)
  const threshold = [...luma].sort((a, v) => a - v)[Math.floor(n * 0.9)] ?? 1
  let hx = 0
  let hy = 0
  let hw = 0
  for (let i = 0; i < n; i++) {
    if (luma[i]! < threshold) continue
    hx += (i % width) * luma[i]!
    hy += Math.floor(i / width) * luma[i]!
    hw += luma[i]!
  }
  return {
    mean: [r / n, g / n, b / n],
    lumaMean,
    lumaStd,
    saturation: sat / n,
    grid: grid.map((v, i) => v / Math.max(1, gridCount[i]!)),
    highlight: hw > 0 ? { x: hx / hw / width, y: hy / hw / height } : { x: 0.5, y: 0.5 },
  }
}

/**
 * How alike two stills are: the SSIM of small grey copies, 1 being the same picture (a video is read at its first
 * frame). The storyboard's end-frame check: LTX lands on an end frame whatever it shows, so one barely different from
 * the start froze the clip and a recomposed one cut it in two (shared/story/endFrame). Local and free.
 */
export async function stillSsim(a: string, b: string): Promise<number> {
  const graph = '[0:v]scale=256:144,format=gray[a];[1:v]scale=256:144,format=gray[b];[a][b]ssim'
  const { stderr } = await runFfmpeg(['-i', a, '-i', b, '-filter_complex', graph, '-frames:v', '1', '-f', 'null', '-'])
  const ssim = parseSsim(stderr)
  if (ssim === undefined) throw new ApiError(500, 'ffmpeg compared the two pictures but reported no similarity')
  return ssim
}

/** The score ffmpeg's ssim filter logs when it ends ("SSIM Y:0.912345 (10.58) All:0.912345 (10.58)"); 0..1. */
export function parseSsim(stderr: string): number | undefined {
  const last = [...stderr.matchAll(/\bAll:\s*(\d*\.?\d+)/g)].at(-1)?.[1]
  const value = last === undefined ? Number.NaN : Number(last)
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined
}

/** Writes a reversed copy (video and audio). Long clips are refused — ffmpeg's reverse buffers every frame. */
export async function reverseMedia(input: string, out: string, opts: { hasVideo: boolean; hasAudio: boolean; seconds: number }) {
  if (opts.seconds > 180) throw new ApiError(400, 'Reverse works on clips up to 3 minutes — blade the clip first')
  const args = ['-i', input]
  if (opts.hasVideo) args.push('-vf', 'reverse', '-c:v', 'libx264', '-crf', '16', '-preset', 'veryfast', '-pix_fmt', 'yuv420p')
  else args.push('-vn')
  if (opts.hasAudio) args.push('-af', 'areverse', '-c:a', 'aac', '-b:a', '256k')
  else args.push('-an')
  await runFfmpeg([...args, out])
}

/** Longest voice sample: LTX encodes the whole file as the voice reference. */
export const VOICE_SAMPLE_SECONDS = 6

/**
 * A voice sample for LTX's subject references (Licon MSR V2): the speech, with a quiet bed under it (−20 dB, looped
 * if short) when given — Licon: the clip's ambience comes through only when the voice sample has music under it —
 * 0.3 s of the bed after the last word, at most VOICE_SAMPLE_SECONDS, as 48 kHz stereo WAV (ComfyUI's LoadAudio reads it).
 */
export async function mixVoiceSample(speech: string, bed: string | undefined, out: string) {
  const max = VOICE_SAMPLE_SECONDS
  const voice = '[0:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=pad_dur=0.3'
  const tail = `atrim=0:${max},afade=t=out:st=${max - 0.4}:d=0.4[out]`
  const args = ['-i', speech]
  let graph = `${voice},${tail}`
  if (bed) {
    args.push('-stream_loop', '-1', '-i', bed)
    graph = `${voice}[s];[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=-20dB[b];[s][b]amix=inputs=2:duration=first:normalize=0,${tail}`
  }
  await runFfmpeg([...args, '-filter_complex', graph, '-map', '[out]', '-vn', '-c:a', 'pcm_s16le', '-ar', '48000', out])
}

/** Local stand-in for voice isolation in demo mode: denoise, band-limit and level. */
export async function demoCleanVoice(input: string, out: string) {
  await runFfmpeg(['-i', input, '-vn', '-af', 'highpass=f=80,lowpass=f=12000,afftdn=nf=-25,dynaudnorm=f=150:g=15', '-c:a', 'pcm_s16le', out])
}

// ------------------------------------------------------------------------------------------ ElevenLabs

async function elevenFetch(apiKey: string, path: string, form: FormData, timeoutMs: number): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`${ELEVENLABS_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new ApiError(502, `ElevenLabs request failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  // ElevenLabs answers 401 for a used-up quota and 403 for plan limits too: its own error code tells them apart.
  if (!res.ok) throw apiErrorFrom(elevenLabsError(res.status, await res.text().catch(() => '')))
  return res
}

async function fileBlob(path: string, mime: string): Promise<Blob> {
  return new Blob([new Uint8Array(await readFile(path))], { type: mime })
}

interface ScribeWord {
  text?: string
  start?: number
  end?: number
  type?: string
  speaker_id?: string
}

/** Speech-to-text with word timings (ElevenLabs Scribe). */
export async function elevenTranscribe(apiKey: string, audioPath: string): Promise<{ words: AlignedWord[]; language?: string; text: string }> {
  const form = new FormData()
  form.set('model_id', 'scribe_v1')
  form.set('timestamps_granularity', 'word')
  form.set('diarize', 'true')
  form.set('tag_audio_events', 'false')
  form.set('file', await fileBlob(audioPath, 'audio/wav'), 'audio.wav')
  const res = await elevenFetch(apiKey, '/v1/speech-to-text', form, 15 * 60_000)
  const json = (await res.json()) as { text?: string; language_code?: string; words?: ScribeWord[] }
  const words: AlignedWord[] = (json.words ?? [])
    .filter((w) => (w.type ?? 'word') === 'word' && w.text?.trim())
    .map((w) => ({ text: w.text!.trim(), start: Number(w.start) || 0, end: Number(w.end) || Number(w.start) || 0, ...(w.speaker_id ? { voiceId: w.speaker_id } : {}) }))
  return { words, language: json.language_code, text: json.text ?? words.map((w) => w.text).join(' ') }
}

/** Removes background noise and music, keeping the voice (ElevenLabs audio isolation). Returns MP3 bytes. */
export async function elevenIsolate(apiKey: string, audioPath: string): Promise<Buffer> {
  const form = new FormData()
  form.set('audio', await fileBlob(audioPath, 'audio/wav'), 'audio.wav')
  const res = await elevenFetch(apiKey, '/v1/audio-isolation', form, 15 * 60_000)
  return Buffer.from(await res.arrayBuffer())
}

const DEMO_SENTENCES = [
  'So, um, this is a demo transcript generated locally.',
  'Uh, add an ElevenLabs key to get the real words.',
  'You can, like, delete words to cut the video.',
  'Filler words such as um and uh can be removed in one click.',
]

/** Placeholder transcript for demo mode: plausible words spread over the audio, with some fillers. */
export function demoTranscript(durationSeconds: number): AlignedWord[] {
  const words: AlignedWord[] = []
  let t = 0.3
  let s = 0
  while (t < durationSeconds - 0.3) {
    for (const text of DEMO_SENTENCES[s % DEMO_SENTENCES.length]!.split(' ')) {
      const len = 0.12 + text.length * 0.045
      if (t + len > durationSeconds - 0.2) break
      words.push({ text, start: Math.round(t * 1000) / 1000, end: Math.round((t + len) * 1000) / 1000 })
      t += len + 0.08
    }
    t += 0.6
    s++
  }
  return words
}
