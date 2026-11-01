import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { runFfmpeg } from './ffmpeg'

/**
 * True for a PNG that can't be see-through: RGB or grey, no transparency chunk. An RGBA or palette PNG may hold a
 * cut-out (Remove BG, a transparent canvas picture), so it stays a PNG even when every pixel happens to be opaque.
 */
export function opaquePng(head: Buffer): boolean {
  if (head.length < 33 || head[0] !== 0x89 || head.subarray(1, 4).toString('latin1') !== 'PNG') return false
  const colorType = head[25]
  if (colorType !== 0 && colorType !== 2) return false
  const idat = head.indexOf('IDAT')
  return !head.subarray(0, idat > 0 ? idat : head.length).includes('tRNS')
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await file.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

/**
 * A generated still kept as a JPEG that looks the same (quality ~95, no chroma subsampling) when it can't be
 * see-through: image models send lossless PNGs, a sixth of the size (a 2.5 MB keyframe → 394 KB) — PNG stills were
 * 1 GB of the projects' 2.8 GB of media on 2026-10-12. Anything else (a cut-out, a JPEG or WebP already, an SVG) is
 * returned as it is.
 */
export async function compactStill(path: string, dir: string, index: number, signal?: AbortSignal): Promise<string> {
  if (!/\.png$/i.test(path)) return path
  if (!opaquePng(await readHead(path, 1 << 16))) return path
  const out = join(dir, `output-${index}.jpg`)
  await runFfmpeg(['-hide_banner', '-y', '-i', path, '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '2', '-pix_fmt', 'yuvj444p', out], { signal })
  return out
}
