import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { compactStill, opaquePng } from '../../src/server/services/compactStill'
import { runFfmpeg } from '../../src/server/services/ffmpeg'

const dir = mkdtempSync(join(tmpdir(), 'compact-still-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A detailed picture with smooth gradients, like a generated photo: lossless PNG is big for it. */
async function png(name: string, pixFmt: 'rgb24' | 'rgba') {
  const path = join(dir, name)
  await runFfmpeg(['-f', 'lavfi', '-i', 'mandelbrot=s=640x360', '-frames:v', '1', '-pix_fmt', pixFmt, path])
  return path
}

/** A PNG's signature and IHDR chunk (colour type at byte 25), then `extra` chunk names before the image data. */
const header = (colorType: number, extra = '') =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(4),
    Buffer.from('IHDR'),
    Buffer.alloc(8),
    Buffer.from([8, colorType, 0, 0, 0]),
    Buffer.alloc(4),
    Buffer.from(`${extra}IDAT`),
  ])

describe('stills kept as JPEGs', () => {
  it('turns an opaque PNG into a JPEG a fraction of its size', async () => {
    const source = await png('rgb.png', 'rgb24')
    const out = await compactStill(source, dir, 0)
    expect(out).toBe(join(dir, 'output-0.jpg'))
    expect(readFileSync(out).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(statSync(out).size).toBeLessThan(statSync(source).size / 2)
  })

  it('keeps a PNG that can be see-through, and anything that isn’t a PNG', async () => {
    const cutout = await png('rgba.png', 'rgba')
    expect(opaquePng(readFileSync(cutout))).toBe(false)
    expect(await compactStill(cutout, dir, 1)).toBe(cutout)
    expect(await compactStill(join(dir, 'clip.jpg'), dir, 2)).toBe(join(dir, 'clip.jpg'))
  })

  it('reads the header: RGB or grey without a transparency chunk is opaque', () => {
    expect(header(2)[25]).toBe(2)
    expect(opaquePng(header(2))).toBe(true)
    expect(opaquePng(header(0))).toBe(true)
    expect(opaquePng(header(6))).toBe(false)
    expect(opaquePng(header(3))).toBe(false)
    expect(opaquePng(header(2, 'tRNS'))).toBe(false)
    expect(opaquePng(Buffer.from('not a png at all, just some bytes here'))).toBe(false)
  })
})
