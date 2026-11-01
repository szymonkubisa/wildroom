import type { AssetDTO } from '@shared/types/assets'
import { type MediaClip, createEmptyDoc, defaultVideoProps } from '@shared/types/project-doc'
import { describe, expect, it } from 'vitest'
import { centreOffset, reframeDoc } from './reframe'

describe('smart reframe', () => {
  const src = { width: 1920, height: 1080 }
  const vertical = { width: 1080, height: 1920 }

  it('centres the subject and never shows an edge', () => {
    expect(centreOffset(src, vertical, { x: 0.5, y: 0.5 })).toEqual({ x: 0, y: 0 })
    const right = centreOffset(src, vertical, { x: 0.75, y: 0.5 })
    expect(right.x).toBeLessThan(0)
    // Subject at the far right edge: clamped to the picture edge.
    const edge = centreOffset(src, vertical, { x: 1, y: 0.5 })
    const max = (1920 * (1920 / 1080) - 1080) / 2 / 1080
    expect(edge.x).toBeCloseTo(-max, 2)
  })

  it('keyframes clips whose subject moves and keeps static ones static', () => {
    const doc = createEmptyDoc()
    const clip = (id: string): MediaClip => ({ kind: 'media', id, duration: 100, enabled: true, takes: [{ id: `${id}t`, assetId: 'v', sourceIn: 0 }], active: 0, speed: 1, video: defaultVideoProps() })
    doc.spine = [clip('A'), clip('B')]
    const asset = { id: 'v', kind: 'video', width: 1920, height: 1080 } as AssetDTO
    const subjects = new Map([
      ['A', [{ frame: 0, x: 0.3, y: 0.5 }, { frame: 50, x: 0.32, y: 0.5 }]],
      ['B', [{ frame: 0, x: 0.2, y: 0.5 }, { frame: 99, x: 0.8, y: 0.5 }]],
    ])
    const out = reframeDoc(doc, vertical, subjects, () => asset)
    expect(out.settings).toMatchObject(vertical)
    const [a, b] = out.spine as MediaClip[]
    expect(a!.video!.conform).toBe('fill')
    expect(a!.video!.transformKeys).toBeUndefined()
    expect(a!.video!.transform.x).toBeGreaterThan(0)
    expect(b!.video!.transformKeys).toHaveLength(2)
    expect(doc.settings.width).toBe(1920)
  })
})
