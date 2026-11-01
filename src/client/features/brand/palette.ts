import type { AssetDTO } from '@shared/types/assets'

export interface PaletteColor {
  hex: string
  /** Share of the image's (opaque) pixels closest to this colour, 0..1. */
  share: number
}

const toHex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`

/** Deterministic pseudo-random numbers (mulberry32), so the same image always gives the same palette. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const dist2 = (a: number[], b: number[]) => (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2

/**
 * The `k` main colours of RGBA pixels (transparent ones ignored): k-means++ seeding, a few Lloyd rounds, then
 * near-duplicates merged. Sorted by how much of the image they cover.
 */
export function extractPalette(rgba: Uint8ClampedArray | Uint8Array, k = 6, seed = 7): PaletteColor[] {
  const pts: number[][] = []
  for (let i = 0; i + 3 < rgba.length; i += 4) if (rgba[i + 3]! >= 128) pts.push([rgba[i]!, rgba[i + 1]!, rgba[i + 2]!])
  if (!pts.length) return []
  const random = rng(seed)
  const centers: number[][] = [pts[Math.floor(random() * pts.length)]!.slice()]
  while (centers.length < Math.min(k, pts.length)) {
    // k-means++: the next centre is likely far from the existing ones.
    const d = pts.map((p) => Math.min(...centers.map((c) => dist2(p, c))))
    const total = d.reduce((s, x) => s + x, 0)
    if (total === 0) break
    let r = random() * total
    let idx = 0
    while (r > d[idx]! && idx < d.length - 1) r -= d[idx++]!
    centers.push(pts[idx]!.slice())
  }
  const assign = new Array<number>(pts.length).fill(0)
  for (let round = 0; round < 12; round++) {
    let moved = false
    pts.forEach((p, i) => {
      let best = 0
      let bestD = Infinity
      centers.forEach((c, j) => {
        const dd = dist2(p, c)
        if (dd < bestD) {
          bestD = dd
          best = j
        }
      })
      if (assign[i] !== best) moved = true
      assign[i] = best
    })
    const sums = centers.map(() => [0, 0, 0, 0])
    pts.forEach((p, i) => {
      const s = sums[assign[i]!]!
      s[0]! += p[0]!
      s[1]! += p[1]!
      s[2]! += p[2]!
      s[3]! += 1
    })
    sums.forEach((s, j) => {
      if (s[3]) centers[j] = [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!]
    })
    if (!moved && round > 0) break
  }
  const counts = centers.map((_, j) => assign.filter((a) => a === j).length)
  const colors = centers
    .map((c, j) => ({ c, n: counts[j]! }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
  // Merge colours a viewer couldn't tell apart.
  const merged: { c: number[]; n: number }[] = []
  for (const col of colors) {
    const near = merged.find((m) => dist2(m.c, col.c) < 18 ** 2)
    if (near) near.n += col.n
    else merged.push({ ...col })
  }
  return merged.map((m) => ({ hex: toHex(m.c[0]!, m.c[1]!, m.c[2]!), share: m.n / pts.length }))
}

/** Palette of an image asset, from a small copy of its display image. */
export async function paletteOfAsset(asset: AssetDTO, k = 6): Promise<PaletteColor[]> {
  const url = asset.variants.display ? `/media/${asset.id}/display` : `/media/${asset.id}/original`
  const blob = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Could not load “${asset.name}”`)
    return r.blob()
  })
  const bmp = await createImageBitmap(blob, { resizeWidth: 96, resizeHeight: Math.max(1, Math.round((96 * (asset.height ?? 96)) / (asset.width ?? 96))), resizeQuality: 'medium' })
  const canvas = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bmp, 0, 0)
  return extractPalette(ctx.getImageData(0, 0, bmp.width, bmp.height).data, k)
}

/** Relative luminance (WCAG), for picking readable text on a swatch. */
export function luminance(hex: string): number {
  const v = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!
}
