import { readFile } from 'node:fs/promises'
import { brotliDecompressSync, inflateSync } from 'node:zlib'
import type { FontFaceInfo } from '../../shared/types/assets'

/** WOFF2's known-table index (spec §5.1): a table's tag when its flags' low six bits are not 63. */
// prettier-ignore
const WOFF2_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG',
  'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC',
  'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc',
  'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
]
/** The tables the face description is read from. */
const WANTED = new Set(['name', 'OS/2', 'head', 'fvar'])

type Tables = Map<string, Buffer>

function sfntTables(buf: Buffer): Tables {
  const tables: Tables = new Map()
  const count = buf.readUInt16BE(4)
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16
    const tag = buf.toString('latin1', at, at + 4)
    if (!WANTED.has(tag)) continue
    const offset = buf.readUInt32BE(at + 8)
    tables.set(tag, buf.subarray(offset, offset + buf.readUInt32BE(at + 12)))
  }
  return tables
}

function woffTables(buf: Buffer): Tables {
  const tables: Tables = new Map()
  const count = buf.readUInt16BE(12)
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20
    const tag = buf.toString('latin1', at, at + 4)
    if (!WANTED.has(tag)) continue
    const offset = buf.readUInt32BE(at + 4)
    const compLength = buf.readUInt32BE(at + 8)
    const origLength = buf.readUInt32BE(at + 12)
    const data = buf.subarray(offset, offset + compLength)
    tables.set(tag, compLength < origLength ? inflateSync(data) : data)
  }
  return tables
}

function woff2Tables(buf: Buffer): Tables {
  if (buf.toString('latin1', 4, 8) === 'ttcf') throw new Error('font collections are not supported')
  const count = buf.readUInt16BE(12)
  const compressedSize = buf.readUInt32BE(20)
  let at = 48
  const base128 = () => {
    let value = 0
    for (let i = 0; i < 5; i++) {
      const b = buf[at++]!
      value = value * 128 + (b & 0x7f)
      if (!(b & 0x80)) return value
    }
    throw new Error('bad WOFF2 table directory')
  }
  const entries: { tag: string; length: number }[] = []
  for (let i = 0; i < count; i++) {
    const flags = buf[at++]!
    const tag = (flags & 0x3f) === 63 ? buf.toString('latin1', at, (at += 4)) : WOFF2_TAGS[flags & 0x3f]!
    const version = flags >> 6
    const origLength = base128()
    // glyf and loca are transformed at version 0, every other table at any version but 0.
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0
    entries.push({ tag, length: transformed ? base128() : origLength })
  }
  const data = brotliDecompressSync(buf.subarray(at, at + compressedSize))
  const tables: Tables = new Map()
  let offset = 0
  for (const e of entries) {
    if (WANTED.has(e.tag)) tables.set(e.tag, data.subarray(offset, offset + e.length))
    offset += e.length
  }
  return tables
}

/** A name record by the first id that has one, best first: Windows English, other Unicode, then Mac Roman. */
function nameOf(name: Buffer | undefined, ...ids: number[]): string | undefined {
  if (!name || name.length < 6) return undefined
  const count = name.readUInt16BE(2)
  const strings = name.readUInt16BE(4)
  for (const id of ids) {
    let best: { score: number; text: string } | undefined
    for (let i = 0; i < count; i++) {
      const at = 6 + i * 12
      if (at + 12 > name.length || name.readUInt16BE(at + 6) !== id) continue
      const platform = name.readUInt16BE(at)
      const start = strings + name.readUInt16BE(at + 10)
      const raw = name.subarray(start, start + name.readUInt16BE(at + 8))
      let text: string
      let score: number
      if (platform === 3 || platform === 0) {
        text = Buffer.from(raw.subarray(0, raw.length & ~1)).swap16().toString('utf16le')
        score = platform === 3 && name.readUInt16BE(at + 4) === 0x409 ? 3 : 2
      } else if (platform === 1) {
        text = raw.toString('latin1')
        score = 1
      } else continue
      text = text.replace(/\0/g, '').trim()
      if (text && (!best || score > best.score)) best = { score, text }
    }
    if (best) return best.text
  }
  return undefined
}

/** The family, weight (a range for a variable font) and style a font file declares in its own tables. */
export function fontInfoFromBuffer(buf: Buffer): FontFaceInfo | undefined {
  const tag = buf.toString('latin1', 0, 4)
  const tables = tag === 'wOF2' ? woff2Tables(buf) : tag === 'wOFF' ? woffTables(buf) : sfntTables(buf)
  const name = tables.get('name')
  const family = nameOf(name, 16, 1)
  if (!family) return undefined
  const subfamily = nameOf(name, 17, 2) ?? ''
  const os2 = tables.get('OS/2')
  const head = tables.get('head')
  let weight = os2 && os2.length >= 6 ? String(Math.min(1000, Math.max(1, os2.readUInt16BE(4)))) : /bold/i.test(subfamily) ? '700' : '400'
  const fvar = tables.get('fvar')
  if (fvar && fvar.length >= 16) {
    const axes = fvar.readUInt16BE(4)
    const size = fvar.readUInt16BE(10)
    for (let i = 0; i < fvar.readUInt16BE(8); i++) {
      const at = axes + i * size
      if (at + 20 > fvar.length || fvar.toString('latin1', at, at + 4) !== 'wght') continue
      weight = `${Math.round(fvar.readInt32BE(at + 4) / 65536)} ${Math.round(fvar.readInt32BE(at + 12) / 65536)}`
    }
  }
  const italic =
    (os2 && os2.length >= 64 && (os2.readUInt16BE(62) & 0x201) !== 0) ||
    (head && head.length >= 46 && (head.readUInt16BE(44) & 2) !== 0) ||
    /italic|oblique/i.test(subfamily)
  return { family, weight, style: italic ? 'italic' : 'normal' }
}

/** Best effort: a font whose tables cannot be read is still usable, named after its file. */
export async function readFontInfo(path: string): Promise<FontFaceInfo | undefined> {
  try {
    return fontInfoFromBuffer(await readFile(path))
  } catch (err) {
    console.warn(`[fonts] cannot read the tables of ${path}:`, (err as Error).message)
    return undefined
  }
}
