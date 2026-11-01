import { describe, expect, it } from 'vitest'
import { extractPalette, luminance } from './palette'

/** RGBA pixels: `n` of each colour. */
function pixels(...runs: [number, [number, number, number, number]][]): Uint8ClampedArray {
  const out: number[] = []
  for (const [n, rgba] of runs) for (let i = 0; i < n; i++) out.push(...rgba)
  return new Uint8ClampedArray(out)
}

describe('extractPalette', () => {
  it('finds the main colours, biggest first, ignoring transparency', () => {
    const img = pixels([600, [200, 60, 20, 255]], [300, [250, 240, 220, 255]], [100, [20, 20, 20, 255]], [500, [0, 255, 0, 0]])
    const palette = extractPalette(img, 3)
    expect(palette.map((c) => c.hex)).toEqual(['#c83c14', '#faf0dc', '#141414'])
    expect(palette.map((c) => c.share)).toEqual([0.6, 0.3, 0.1])
  })

  it('merges near-identical colours and is deterministic', () => {
    const img = pixels([500, [100, 100, 100, 255]], [500, [104, 102, 100, 255]])
    expect(extractPalette(img, 4)).toHaveLength(1)
    const noisy = pixels([300, [10, 120, 200, 255]], [300, [240, 200, 30, 255]], [5, [255, 255, 255, 255]])
    expect(extractPalette(noisy, 3)).toEqual(extractPalette(noisy, 3))
  })

  it('returns nothing for a fully transparent image', () => {
    expect(extractPalette(pixels([10, [255, 0, 0, 0]]))).toEqual([])
  })
})

describe('luminance', () => {
  it('matches WCAG for black, white and mid grey', () => {
    expect(luminance('#000000')).toBe(0)
    expect(luminance('#ffffff')).toBeCloseTo(1)
    expect(luminance('#777777')).toBeCloseTo(0.184, 2)
  })
})
