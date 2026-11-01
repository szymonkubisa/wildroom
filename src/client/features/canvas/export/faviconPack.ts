import type { AssetDTO } from '@shared/types/assets'
import { coverCrop } from './renderFrame'
import { encodeIco } from './ico'

/** PNG icons in a favicon pack: browsers, iOS home screen, Android / PWA. */
export const FAVICON_PNGS = [
  { name: 'favicon-16x16.png', size: 16 },
  { name: 'favicon-32x32.png', size: 32 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'android-chrome-192x192.png', size: 192 },
  { name: 'android-chrome-512x512.png', size: 512 },
] as const

/** Sizes inside favicon.ico (legacy browsers, Windows). */
export const ICO_SIZES = [16, 32, 48] as const

export interface PackFile {
  name: string
  data: Blob
}

export interface PackInfo {
  appName: string
  themeColor: string
  backgroundColor: string
  /** The pack includes favicon.svg (a vector source). */
  svg: boolean
}

export function webManifest(info: PackInfo): string {
  const shortName = info.appName.length > 12 ? info.appName.split(/\s+/)[0]!.slice(0, 12) : info.appName
  return `${JSON.stringify(
    {
      name: info.appName,
      short_name: shortName,
      icons: [
        { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
      ],
      theme_color: info.themeColor,
      background_color: info.backgroundColor,
      display: 'standalone',
    },
    null,
    2,
  )}\n`
}

/** The tags to paste into the site's <head>. */
export function headSnippet(info: PackInfo): string {
  return [
    '<link rel="icon" href="/favicon.ico" sizes="48x48">',
    ...(info.svg ? ['<link rel="icon" href="/favicon.svg" type="image/svg+xml">'] : []),
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">',
    '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">',
    '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
    `<meta name="theme-color" content="${info.themeColor}">`,
    '',
  ].join('\n')
}

/** A square PNG of the source, cover-cropped. Large steps are halved first so tiny icons stay crisp, not aliased. */
async function squarePng(source: ImageBitmap, size: number, background?: string): Promise<Blob> {
  const crop = coverCrop(source.width, source.height, { w: 1, h: 1 })
  let img: CanvasImageSource = source
  let sx = crop.x
  let sy = crop.y
  let side = crop.w
  while (side / 2 >= size * 2) {
    const half = Math.round(side / 2)
    const step = new OffscreenCanvas(half, half)
    const c = step.getContext('2d')!
    c.imageSmoothingQuality = 'high'
    c.drawImage(img, sx, sy, side, side, 0, 0, half, half)
    img = step
    sx = 0
    sy = 0
    side = half
  }
  const out = new OffscreenCanvas(size, size)
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  if (background) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, size, size)
  }
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)
  return out.convertToBlob({ type: 'image/png' })
}

/**
 * Every file of a favicon pack, made from one image (cropped to a square from its centre). The Apple touch icon gets
 * the background colour, since iOS fills transparency with black.
 */
export async function buildFaviconPack(source: Blob, info: PackInfo & { svgSource?: Blob }): Promise<PackFile[]> {
  const bmp = await createImageBitmap(source)
  const files: PackFile[] = []
  for (const { name, size } of FAVICON_PNGS) {
    files.push({ name, data: await squarePng(bmp, size, name === 'apple-touch-icon.png' ? info.backgroundColor : undefined) })
  }
  const icoImages = await Promise.all(
    ICO_SIZES.map(async (size) => ({ size, png: new Uint8Array(await (await squarePng(bmp, size)).arrayBuffer()) })),
  )
  files.push({ name: 'favicon.ico', data: new Blob([encodeIco(icoImages)], { type: 'image/x-icon' }) })
  if (info.svgSource) files.push({ name: 'favicon.svg', data: info.svgSource })
  files.push({ name: 'site.webmanifest', data: new Blob([webManifest(info)], { type: 'application/manifest+json' }) })
  files.push({ name: 'favicon-snippet.html', data: new Blob([headSnippet(info)], { type: 'text/html' }) })
  return files
}

/** The best source file for an icon: the original image (its SVG too, when it's a vector). */
export async function iconSources(asset: AssetDTO): Promise<{ image: Blob; svg?: Blob }> {
  // Originals the browser can't decode (HEIC) use the display copy.
  const drawable = /^image\/(png|jpe?g|webp|gif|avif)$/.test(asset.mime ?? '')
  const variant = drawable || !asset.variants.display ? 'original' : 'display'
  const image = await fetch(`/media/${asset.id}/${variant}`).then((r) => {
    if (!r.ok) throw new Error(`Could not load “${asset.name}”`)
    return r.blob()
  })
  const svg = asset.vector ? await fetch(`/media/${asset.id}/svg`).then((r) => (r.ok ? r.blob() : undefined)) : undefined
  return { image, svg }
}
