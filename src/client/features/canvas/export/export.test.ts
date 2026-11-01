import { describe, expect, it } from 'vitest'
import { headSnippet, webManifest } from './faviconPack'
import { encodeIco } from './ico'
import { coverCrop, exportName, wrapLines } from './renderFrame'

describe('encodeIco', () => {
  it('writes the header, one directory entry per image and the PNGs back to back', () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([4, 5])
    const ico = encodeIco([
      { size: 16, png: a },
      { size: 256, png: b },
    ])
    const v = new DataView(ico.buffer)
    expect([v.getUint16(0, true), v.getUint16(2, true), v.getUint16(4, true)]).toEqual([0, 1, 2])
    // Entry 1: 16×16, 32 bpp, 3 bytes at offset 6 + 2×16.
    expect([v.getUint8(6), v.getUint8(7), v.getUint16(10, true), v.getUint16(12, true), v.getUint32(14, true), v.getUint32(18, true)]).toEqual([16, 16, 1, 32, 3, 38])
    // Entry 2: 256 is written as 0.
    expect([v.getUint8(22), v.getUint8(23), v.getUint32(30, true), v.getUint32(34, true)]).toEqual([0, 0, 2, 41])
    expect([...ico.slice(38)]).toEqual([1, 2, 3, 4, 5])
  })

  it('rejects sizes an icon cannot hold', () => {
    expect(() => encodeIco([{ size: 300, png: new Uint8Array(1) }])).toThrow(/out of range/)
  })
})

describe('favicon pack text files', () => {
  const info = { appName: 'Roastery Coffee Co', themeColor: '#7c3aed', backgroundColor: '#fff8f0', svg: true }

  it('builds a web manifest with the Android icons', () => {
    const m = JSON.parse(webManifest(info))
    expect(m).toEqual({
      name: 'Roastery Coffee Co',
      short_name: 'Roastery',
      icons: [
        { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
      ],
      theme_color: '#7c3aed',
      background_color: '#fff8f0',
      display: 'standalone',
    })
  })

  it('lists the head tags, with the SVG icon only when there is one', () => {
    expect(headSnippet(info)).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">')
    expect(headSnippet({ ...info, svg: false })).not.toContain('favicon.svg')
    expect(headSnippet(info)).toContain('<meta name="theme-color" content="#7c3aed">')
  })
})

describe('frame rendering helpers', () => {
  it('crops like object-fit: cover', () => {
    expect(coverCrop(1600, 900, { w: 1200, h: 630 })).toEqual({ x: 0, y: expect.closeTo(30, 5), w: 1600, h: expect.closeTo(840, 5) })
    expect(coverCrop(1000, 1000, { w: 200, h: 100 })).toEqual({ x: 0, y: 250, w: 1000, h: 500 })
  })

  it('wraps text the way the board shows it', () => {
    const measure = (s: string) => s.length * 10
    expect(wrapLines('Hello brave new world', 110, measure)).toEqual(['Hello brave', 'new world'])
    expect(wrapLines('One\n\nTwo', 1000, measure)).toEqual(['One', '', 'Two'])
    expect(wrapLines('Supercalifragilistic', 50, measure)).toEqual(['Super', 'calif', 'ragil', 'istic'])
  })

  it('makes safe file names', () => {
    expect(exportName('OG: launch / v2', 'Frame')).toBe('OG- launch - v2')
    expect(exportName('   ', 'Frame')).toBe('Frame')
  })
})
