import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFfmpeg } from '../services/ffmpeg'
import type { ResolvedInput } from './types'

/** What an endpoint accepts for an input image: edge lengths in px and the file size in bytes. */
export interface ImageInputLimits {
  maxEdge: number
  maxBytes: number
  minEdge?: number
  /** What a resized copy is saved as: PNG (the default) or JPEG, a tenth of the size — transparency goes onto white. */
  format?: 'png' | 'jpeg'
}

const UPLOADABLE_IMAGE = /^image\/(png|jpeg|webp)$/

/**
 * Scale factor that brings a `w`×`h` image within an endpoint's edge limits (1 when it already fits). When a very
 * long, thin image can't meet both, the maximum edge wins: past it the upload fails outright.
 */
export function inputScale(w: number, h: number, limits: { maxEdge: number; minEdge?: number }): number {
  const max = limits.maxEdge / Math.max(w, h)
  let k = Math.min(1, max)
  if (limits.minEdge && Math.min(w, h) * k < limits.minEdge) k = Math.min(limits.minEdge / Math.min(w, h), max)
  return k
}

/**
 * An image the endpoint can take: within its size limits and in a format it reads. Returns the original when it
 * already fits, else a scaled PNG (or JPEG, `limits.format`) in a temp folder (`cleanup` removes it).
 */
export async function fitImageInput(
  input: ResolvedInput,
  limits: ImageInputLimits,
  signal: AbortSignal,
): Promise<{ path: string; mime: string; cleanup: () => Promise<void> }> {
  const size = (await stat(input.path)).size
  const w = input.width ?? 0
  const h = input.height ?? 0
  let k = w && h ? inputScale(w, h, limits) : 1
  if (k === 1 && size <= limits.maxBytes && UPLOADABLE_IMAGE.test(input.mime)) return { path: input.path, mime: input.mime, cleanup: async () => {} }
  const jpeg = limits.format === 'jpeg'
  const dir = await mkdtemp(join(tmpdir(), 'studio-input-'))
  const out = join(dir, jpeg ? 'input.jpg' : 'input.png')
  const cleanup = () => rm(dir, { recursive: true, force: true })
  try {
    // An image can still be over the byte limit after scaling: shrink further from what the first pass weighed.
    for (let attempt = 0; attempt < 3; attempt++) {
      const dims = w && h ? { w: Math.max(2, Math.round(w * k)), h: Math.max(2, Math.round(h * k)) } : undefined
      const scale = dims ? `scale=${dims.w}:${dims.h}:flags=lanczos` : 'null'
      // JPEG has no alpha: a cut-out goes onto white (dropped, its hidden pixels show — often black).
      const filter = jpeg && dims ? ['-filter_complex', `color=c=white:s=${dims.w}x${dims.h}[bg];[0:v]${scale}[fg];[bg][fg]overlay=format=auto:shortest=1`] : ['-vf', scale]
      const codec = jpeg ? ['-c:v', 'mjpeg', '-q:v', '3', '-pix_fmt', 'yuvj444p'] : ['-c:v', 'png']
      await runFfmpeg(['-i', input.path, ...(jpeg && dims ? [] : ['-map', '0:v:0']), '-frames:v', '1', ...filter, '-f', 'image2', ...codec, out], { signal })
      const bytes = (await stat(out)).size
      if (bytes <= limits.maxBytes || !w || !h) break
      k *= Math.sqrt(limits.maxBytes / bytes) * 0.9
    }
    return { path: out, mime: jpeg ? 'image/jpeg' : 'image/png', cleanup }
  } catch (err) {
    await cleanup()
    throw err
  }
}
