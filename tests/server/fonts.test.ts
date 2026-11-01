import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { SERVABLE_ORIGINAL } from '../../src/server/routes/media'
import { fontInfoFromBuffer } from '../../src/server/services/fontInfo'
import { probeFile, sniffFont } from '../../src/server/services/probe'
import { FONT_FILE, IMPORTABLE_FILE } from '../../src/shared/types/assets'

const head = (bytes: number[] | string) => (typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : Buffer.from(bytes))

describe('font files', () => {
  it('are told apart by their first bytes', () => {
    expect(sniffFont(head([0, 1, 0, 0, 0, 12]))).toBe('font/ttf')
    expect(sniffFont(head('true\0\0'))).toBe('font/ttf')
    expect(sniffFont(head('OTTO\0\0'))).toBe('font/otf')
    expect(sniffFont(head('wOFF\0\0'))).toBe('font/woff')
    expect(sniffFont(head('wOF2\0\0'))).toBe('font/woff2')
    expect(sniffFont(head([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined()
  })

  it('import as fonts, are served, and pass the upload filter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'font-'))
    const path = join(dir, 'Fraunces-BlackItalic.woff2')
    await writeFile(path, Buffer.concat([head('wOF2'), Buffer.alloc(64)]))
    expect(await probeFile(path)).toEqual({ kind: 'font', mime: 'font/woff2', hasVideo: false, hasAudio: false })
    expect(SERVABLE_ORIGINAL.test('font/woff2')).toBe(true)
    expect(IMPORTABLE_FILE.test('Inter Tight.ttf') && FONT_FILE.test('x.otf') && !FONT_FILE.test('x.png')).toBe(true)
  })
})

// ---- Tiny font files: just the tables the face is read from.

function nameTable(names: Record<number, string>): Buffer {
  const entries = Object.entries(names).map(([id, text]) => ({ id: Number(id), data: Buffer.from(text, 'utf16le').swap16() }))
  const head = Buffer.alloc(6 + entries.length * 12)
  head.writeUInt16BE(entries.length, 2)
  head.writeUInt16BE(head.length, 4)
  let offset = 0
  entries.forEach((e, i) => {
    const at = 6 + i * 12
    head.writeUInt16BE(3, at)
    head.writeUInt16BE(1, at + 2)
    head.writeUInt16BE(0x409, at + 4)
    head.writeUInt16BE(e.id, at + 6)
    head.writeUInt16BE(e.data.length, at + 8)
    head.writeUInt16BE(offset, at + 10)
    offset += e.data.length
  })
  return Buffer.concat([head, ...entries.map((e) => e.data)])
}

function os2Table(weight: number, italic: boolean): Buffer {
  const t = Buffer.alloc(78)
  t.writeUInt16BE(weight, 4)
  t.writeUInt16BE(italic ? 1 : 0x40, 62)
  return t
}

function fvarTable(min: number, max: number): Buffer {
  const t = Buffer.alloc(36)
  t.writeUInt16BE(1, 0)
  t.writeUInt16BE(16, 4)
  t.writeUInt16BE(2, 6)
  t.writeUInt16BE(1, 8)
  t.writeUInt16BE(20, 10)
  t.write('wght', 16, 'latin1')
  t.writeInt32BE(min * 65536, 20)
  t.writeInt32BE(400 * 65536, 24)
  t.writeInt32BE(max * 65536, 28)
  return t
}

type TableSet = [tag: string, data: Buffer][]

function sfnt(tables: TableSet): Buffer {
  const dir = Buffer.alloc(12 + tables.length * 16)
  dir.writeUInt32BE(0x00010000, 0)
  dir.writeUInt16BE(tables.length, 4)
  let offset = dir.length
  const bodies = tables.map(([tag, data], i) => {
    const at = 12 + i * 16
    dir.write(tag, at, 'latin1')
    dir.writeUInt32BE(offset, at + 8)
    dir.writeUInt32BE(data.length, at + 12)
    const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)])
    offset += padded.length
    return padded
  })
  return Buffer.concat([dir, ...bodies])
}

function woff(tables: TableSet): Buffer {
  const dir = Buffer.alloc(44 + tables.length * 20)
  dir.write('wOFF', 0, 'latin1')
  dir.writeUInt16BE(tables.length, 12)
  let offset = dir.length
  const bodies = tables.map(([tag, data], i) => {
    // Stored as it is when deflating doesn't make it smaller, like the spec says.
    const deflated = deflateSync(data)
    const packed = deflated.length < data.length ? deflated : data
    const at = 44 + i * 20
    dir.write(tag, at, 'latin1')
    dir.writeUInt32BE(offset, at + 4)
    dir.writeUInt32BE(packed.length, at + 8)
    dir.writeUInt32BE(data.length, at + 12)
    offset += packed.length
    return packed
  })
  return Buffer.concat([dir, ...bodies])
}

function woff2(tables: TableSet): Buffer {
  const KNOWN: Record<string, number> = { name: 5, 'OS/2': 6, fvar: 47 }
  const base128 = (n: number) => (n < 128 ? [n] : [0x80 | (n >> 7), n & 0x7f])
  const dir = tables.flatMap(([tag, data]) => [KNOWN[tag]!, ...base128(data.length)])
  const packed = brotliCompressSync(Buffer.concat(tables.map(([, d]) => d)))
  const header = Buffer.alloc(48)
  header.write('wOF2', 0, 'latin1')
  header.writeUInt32BE(0x00010000, 4)
  header.writeUInt16BE(tables.length, 12)
  header.writeUInt32BE(packed.length, 20)
  return Buffer.concat([header, Buffer.from(dir), packed])
}

describe('font faces from the font tables', () => {
  const black: TableSet = [
    ['name', nameTable({ 1: 'Fraunces Black', 2: 'Italic', 16: 'Fraunces', 17: 'Black Italic' })],
    ['OS/2', os2Table(900, true)],
  ]
  const variable: TableSet = [
    ['name', nameTable({ 1: 'JetBrains Mono', 2: 'Regular' })],
    ['OS/2', os2Table(400, false)],
    ['fvar', fvarTable(100, 800)],
  ]

  it('reads the typographic family, the weight class and italic in TrueType, WOFF and WOFF2', () => {
    for (const wrap of [sfnt, woff, woff2]) {
      expect(fontInfoFromBuffer(wrap(black))).toEqual({ family: 'Fraunces', weight: '900', style: 'italic' })
      expect(fontInfoFromBuffer(wrap(variable))).toEqual({ family: 'JetBrains Mono', weight: '100 800', style: 'normal' })
    }
  })

  it('import with the face in the asset, so a file named anything still shows its family', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'font-'))
    const path = join(dir, 'download (3).woff2')
    await writeFile(path, woff2(variable))
    expect((await probeFile(path)).font).toEqual({ family: 'JetBrains Mono', weight: '100 800', style: 'normal' })
  })
})
