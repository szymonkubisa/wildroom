import { open } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { imageSizeFromFile } from 'image-size/fromFile'
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny'
import type { AssetKind, FontFaceInfo } from '../../shared/types/assets'
import { readFontInfo } from './fontInfo'

export interface ProbeResult {
  kind: AssetKind
  /** Base MIME type without codec parameters (e.g. video/mp4, audio/mpeg, image/png). */
  mime: string
  /**
   * Seconds from the time origin to the end of the primary track: the first presented video frame for
   * video, the first presented audio sample for audio-only files. Undefined for images.
   */
  durationSeconds?: number
  /** Display dimensions (rotation and pixel aspect applied). */
  width?: number
  height?: number
  /** Clockwise rotation in degrees the player applies (container rotation / EXIF orientation). */
  rotation?: number
  /** Best-guess frame rate rounded to 3 decimals. */
  fps?: number
  hasVideo: boolean
  hasAudio: boolean
  sampleRate?: number
  channels?: number
  videoCodec?: string
  audioCodec?: string
  /**
   * Raw first-packet timestamps (seconds, native file timeline) as reported by Mediabunny. May be negative
   * (e.g. AAC priming behind an edit list); negative time is never presented — see `timeOrigin()`.
   */
  firstVideoTimestamp?: number
  firstAudioTimestamp?: number
  /** A font: the face its tables declare. */
  font?: FontFaceInfo
}

type ImageType = 'png' | 'jpeg' | 'gif' | 'webp' | 'heic'

const IMAGE_MIME: Record<ImageType, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
}

const IMAGE_EXT: Record<string, ImageType> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
  heic: 'heic',
  heif: 'heic',
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'])

/** Magic-byte sniffing for the supported still-image formats (content wins over the extension). */
function sniffImage(head: Buffer): ImageType | undefined {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg'
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return 'gif'
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'webp'
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    // ISO-BMFF: HEIF stills share the container with MP4/MOV, so decide by brand.
    const brand = head.subarray(8, 12).toString('latin1')
    if (HEIF_BRANDS.has(brand)) return 'heic'
  }
  return undefined
}

async function readHead(path: string, bytes = 32): Promise<Buffer> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** EXIF orientation (1–8) → clockwise display rotation; 5–8 also swap width/height. */
function exifRotation(orientation?: number): { rotation: number; swap: boolean } {
  switch (orientation) {
    case 3:
    case 4:
      return { rotation: 180, swap: false }
    case 5:
    case 6:
      return { rotation: 90, swap: true }
    case 7:
    case 8:
      return { rotation: 270, swap: true }
    default:
      return { rotation: 0, swap: false }
  }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** TrueType, OpenType (CFF), WOFF and WOFF2 by their first four bytes. */
export function sniffFont(head: Buffer): string | undefined {
  if (head.length < 4) return undefined
  const tag = head.subarray(0, 4).toString('latin1')
  if (tag === 'wOF2') return 'font/woff2'
  if (tag === 'wOFF') return 'font/woff'
  if (tag === 'OTTO') return 'font/otf'
  if (tag === 'true' || head.readUInt32BE(0) === 0x00010000) return 'font/ttf'
  return undefined
}

/** Probes a media file: fonts by their tables, images via image-size, audio/video via Mediabunny. Throws for unsupported files. */
export async function probeFile(path: string): Promise<ProbeResult> {
  const name = basename(path)
  let head: Buffer
  try {
    head = await readHead(path)
  } catch (err) {
    throw new Error(`Cannot read ${name}: ${(err as Error).message}`)
  }
  if (head.length === 0) throw new Error(`Unsupported file (${name}): the file is empty`)

  const font = sniffFont(head)
  if (font) return { kind: 'font', mime: font, hasVideo: false, hasAudio: false, font: await readFontInfo(path) }
  const sniffed = sniffImage(head)
  const byExt = IMAGE_EXT[extname(path).slice(1).toLowerCase()]
  // An ftyp header with a video brand but .heic extension is a video; only trust the extension if unsniffable.
  const imageType = sniffed ?? (byExt && head.subarray(4, 8).toString('latin1') !== 'ftyp' ? byExt : undefined)
  if (imageType) return probeImage(path, imageType)
  return probeMedia(path)
}

async function probeImage(path: string, type: ImageType): Promise<ProbeResult> {
  let size: Awaited<ReturnType<typeof imageSizeFromFile>>
  try {
    size = await imageSizeFromFile(path)
  } catch (err) {
    throw new Error(`Unsupported or corrupt image (${basename(path)}): ${(err as Error).message}`)
  }
  // HEIC containers can hold several images; image-size reports the primary one at the top level.
  const { rotation, swap } = exifRotation(size.orientation)
  return {
    kind: 'image',
    mime: IMAGE_MIME[type],
    width: swap ? size.height : size.width,
    height: swap ? size.width : size.height,
    rotation,
    hasVideo: false,
    hasAudio: false,
  }
}

async function probeMedia(path: string): Promise<ProbeResult> {
  const name = basename(path)
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(path) })
  try {
    if (!(await input.canRead())) throw new Error(`Unsupported file format (${name})`)
    const mime = (await input.getMimeType()).split(';')[0]!.trim()
    const video = await input.getPrimaryVideoTrack()
    const audio = await input.getPrimaryAudioTrack()
    if (!video && !audio) throw new Error(`No audio or video tracks in ${name}`)

    const result: ProbeResult = { kind: video ? 'video' : 'audio', mime, hasVideo: !!video, hasAudio: !!audio }

    if (audio) {
      result.sampleRate = await audio.getSampleRate()
      result.channels = await audio.getNumberOfChannels()
      result.audioCodec = (await audio.getCodec()) ?? undefined
      result.firstAudioTimestamp = await audio.getFirstTimestamp()
    }

    if (video) {
      result.width = await video.getDisplayWidth()
      result.height = await video.getDisplayHeight()
      result.rotation = await video.getRotation()
      result.videoCodec = (await video.getCodec()) ?? undefined
      result.firstVideoTimestamp = await video.getFirstTimestamp()
      const metrics = await video.computeFrameRateMetrics()
      const fps = metrics.bestGuessFrameRate
      if (Number.isFinite(fps) && fps > 0) result.fps = round3(fps)
      const end = await video.computeDuration()
      result.durationSeconds = Math.max(0, end - timeOrigin(result))
    } else if (audio) {
      const end = await audio.computeDuration()
      result.durationSeconds = Math.max(0, end - timeOrigin(result))
    }
    // Some audio-only MP4s report a video/* container type.
    if (result.kind === 'audio' && result.mime.startsWith('video/')) result.mime = result.mime.replace(/^video\//, 'audio/')
    return result
  } catch (err) {
    const msg = (err as Error).message
    if (msg.includes(name)) throw err
    throw new Error(`Unsupported or unreadable media file (${name}): ${msg}`)
  } finally {
    input.dispose()
  }
}

/**
 * The instant (native file timeline, seconds) that becomes t=0 for proxies, wavs and the timeline: the first
 * presented video frame, or the first presented audio sample for audio-only files. Mediabunny reports samples
 * hidden by an edit list (AAC priming, codec delay) at negative times; those are never presented, hence max(·, 0).
 */
export function timeOrigin(probe: Pick<ProbeResult, 'hasVideo' | 'firstVideoTimestamp' | 'firstAudioTimestamp'>): number {
  const first = probe.hasVideo ? probe.firstVideoTimestamp : probe.firstAudioTimestamp
  return Math.max(first ?? 0, 0)
}
