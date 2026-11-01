import type { AssetDTO, FontFaceInfo } from '@shared/types/assets'

/** A project font file, as the board, the PNG export and the export worker register it. */
export interface FontSpec extends FontFaceInfo {
  url: string
}

const WEIGHTS: [RegExp, number][] = [
  [/^(thin|hairline)$/, 100],
  [/^(extra|ultra)light$/, 200],
  [/^light$/, 300],
  [/^(regular|normal|book|roman)?$/, 400],
  [/^medium$/, 500],
  [/^(semi|demi)bold$/, 600],
  [/^bold$/, 700],
  [/^(extra|ultra)bold$/, 800],
  [/^(black|heavy)$/, 900],
]
const STYLE_WORD = /^(thin|hairline|(extra|ultra)?light|regular|normal|book|roman|medium|(semi|demi|extra|ultra)?bold|black|heavy)?(italic|oblique)?$/i

/**
 * A guess from the file name, for a font whose tables could not be read:
 * "PlayfairDisplay-BoldItalic.ttf" → Playfair Display, 700, italic; "Inter[wght].woff2" → Inter, 100 900.
 */
export function fontFaceInfo(fileName: string): FontFaceInfo {
  let base = fileName.replace(/\.(ttf|otf|woff2?)$/i, '')
  const variable = /\[[^\]]*wght[^\]]*\]/i.test(base)
  base = base.replace(/\[[^\]]*\]/g, '').trim()
  // The style is the last "-" part ("Lora-SemiBoldItalic"), or the last words ("Lora SemiBold Italic").
  let family = base
  let styleWord = ''
  const dash = base.lastIndexOf('-')
  if (dash > 0 && STYLE_WORD.test(base.slice(dash + 1).replace(/[\s_]/g, ''))) {
    family = base.slice(0, dash)
    styleWord = base.slice(dash + 1)
  } else {
    const words = base.split(/[\s_]+/)
    for (let n = 1; n < words.length; n++) {
      const tail = words.slice(n).join('')
      if (!STYLE_WORD.test(tail)) continue
      family = words.slice(0, n).join(' ')
      styleWord = tail
      break
    }
  }
  family = family
    .replace(/_+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  const word = styleWord.toLowerCase().replace(/[\s_-]/g, '')
  const italic = /(italic|oblique)$/.test(word)
  const weightWord = word.replace(/(italic|oblique)$/, '')
  const weight = variable ? '100 900' : String(WEIGHTS.find(([re]) => re.test(weightWord))?.[1] ?? 400)
  return { family: family || 'Untitled font', weight, style: italic ? 'italic' : 'normal' }
}

/** The face of a font asset: what its tables declare, else a guess from its name. */
export const assetFontFace = (a: AssetDTO): FontFaceInfo => a.font ?? fontFaceInfo(a.name)

/** The project's font files that can be loaded. */
export function fontSpecs(assets: Iterable<AssetDTO>): FontSpec[] {
  const out: FontSpec[] = []
  for (const a of assets) if (a.kind === 'font' && a.status === 'ready') out.push({ ...assetFontFace(a), url: `/media/${a.id}/original` })
  return out
}

/** The families in a set of font specs, sorted, once each. */
export const fontFamilies = (specs: FontSpec[]) => [...new Set(specs.map((s) => s.family))].sort((a, b) => a.localeCompare(b))

const added = new WeakMap<FontFaceSet, Map<string, { face: FontFace; key: string }>>()

/**
 * Adds each font to the set once (by file) and waits for them to load; fonts no longer in the list are removed.
 * A font that fails to load is left out — text falls back to the next family.
 */
export async function registerFonts(set: FontFaceSet, specs: FontSpec[]): Promise<void> {
  let faces = added.get(set)
  if (!faces) added.set(set, (faces = new Map()))
  const wanted = new Set(specs.map((s) => s.url))
  for (const [url, { face }] of faces) {
    if (wanted.has(url)) continue
    set.delete(face)
    faces.delete(url)
  }
  const loads: Promise<unknown>[] = []
  for (const s of specs) {
    const key = `${s.family}|${s.weight}|${s.style}`
    const known = faces.get(s.url)
    if (known?.key === key) continue
    if (known) set.delete(known.face)
    const face = new FontFace(s.family, `url(${s.url})`, { weight: s.weight, style: s.style })
    faces.set(s.url, { face, key })
    set.add(face)
    loads.push(face.load().catch(() => set.delete(face)))
  }
  await Promise.all(loads)
}
