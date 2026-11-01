import type { AssetDTO } from '@shared/types/assets'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fontFaceInfo, fontSpecs, registerFonts } from './fonts'

describe('project fonts', () => {
  it('reads family, weight and style from the file name', () => {
    expect(fontFaceInfo('PlayfairDisplay-BoldItalic.ttf')).toEqual({ family: 'Playfair Display', weight: '700', style: 'italic' })
    expect(fontFaceInfo('Lora-Italic.woff2')).toEqual({ family: 'Lora', weight: '400', style: 'italic' })
    expect(fontFaceInfo('Inter[wght].woff2')).toEqual({ family: 'Inter', weight: '100 900', style: 'normal' })
    expect(fontFaceInfo('Fraunces-Italic[SOFT,WONK,opsz,wght].ttf')).toEqual({ family: 'Fraunces', weight: '100 900', style: 'italic' })
    expect(fontFaceInfo('SFProDisplay-SemiBold.otf')).toEqual({ family: 'SF Pro Display', weight: '600', style: 'normal' })
    expect(fontFaceInfo('Instrument Serif Regular.ttf')).toEqual({ family: 'Instrument Serif', weight: '400', style: 'normal' })
    expect(fontFaceInfo('Space_Grotesk Light.otf')).toEqual({ family: 'Space Grotesk', weight: '300', style: 'normal' })
    expect(fontFaceInfo('Anton.ttf')).toEqual({ family: 'Anton', weight: '400', style: 'normal' })
  })

  it('lists only ready font assets', () => {
    const a = (id: string, kind: AssetDTO['kind'], status: AssetDTO['status'] = 'ready') => ({ id, kind, status, name: `${id}.ttf` }) as AssetDTO
    expect(fontSpecs([a('Anton', 'font'), a('Pic', 'image'), a('Lora', 'font', 'processing')])).toEqual([
      { family: 'Anton', weight: '400', style: 'normal', url: '/media/Anton/original' },
    ])
  })

  describe('registerFonts', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('adds each file once, swaps a renamed one and drops removed ones', async () => {
      class FakeFace {
        constructor(
          public family: string,
          public src: string,
          public desc: FontFaceDescriptors,
        ) {}
        load = () => Promise.resolve(this)
      }
      vi.stubGlobal('FontFace', FakeFace)
      const faces = new Set<FakeFace>()
      const set = { add: (f: FakeFace) => faces.add(f), delete: (f: FakeFace) => faces.delete(f) } as unknown as FontFaceSet
      const anton = { family: 'Anton', weight: '400', style: 'normal' as const, url: '/media/a/original' }
      const lora = { family: 'Lora', weight: '400', style: 'italic' as const, url: '/media/l/original' }
      await registerFonts(set, [anton, lora])
      await registerFonts(set, [anton, lora])
      expect([...faces].map((f) => f.family)).toEqual(['Anton', 'Lora'])
      await registerFonts(set, [{ ...anton, family: 'Anton SC' }])
      expect([...faces].map((f) => [f.family, f.src, f.desc.style])).toEqual([['Anton SC', 'url(/media/a/original)', 'normal']])
    })
  })
})
