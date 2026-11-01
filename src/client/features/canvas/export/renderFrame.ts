import type { AssetDTO } from '@shared/types/assets'
import { staticView } from '@shared/motion/evaluate'
import type { CanvasItem, GradientFill, Rect } from '@shared/types/canvas'
import { type ItemSource, drawItems, fillRectWith, stillUrls, textFonts } from '@/engine/canvasDraw'

export type ExportFormat = 'png' | 'jpeg' | 'webp'

export const FORMAT_MIME: Record<ExportFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }
export const FORMAT_EXT: Record<ExportFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' }

export { coverCrop, wrapLines } from '@/engine/canvasDraw'

const bitmaps = new Map<string, Promise<ImageBitmap>>()
const MAX_CACHED = 24

async function decode(url: string): Promise<ImageBitmap> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return createImageBitmap(await r.blob())
}

/**
 * Full-resolution picture of an asset, cached for repeated exports. Originals the browser can't decode (HEIC) fall
 * back to the display copy, then the poster; videos use their poster frame.
 */
function bitmapOf(asset: AssetDTO): Promise<ImageBitmap> {
  const key = asset.id
  let p = bitmaps.get(key)
  if (!p) {
    const urls = stillUrls(asset)
    p = (async () => {
      for (const url of urls) {
        try {
          return await decode(url)
        } catch {
          // Try the next copy.
        }
      }
      throw new Error(`Could not load “${asset.name}”`)
    })()
    p.catch(() => bitmaps.delete(key))
    bitmaps.set(key, p)
    // Keep the cache small: drop (and free) the oldest bitmaps.
    while (bitmaps.size > MAX_CACHED) {
      const [oldKey, old] = bitmaps.entries().next().value!
      bitmaps.delete(oldKey)
      void old.then((b) => b.close()).catch(() => {})
    }
  }
  return p
}

export interface RenderOptions {
  /** Area of the board to render (a frame's rectangle, or one item's). */
  area: Rect
  /** Items to draw, back to front (notes are skipped: they're never part of an export). */
  items: CanvasItem[]
  /** Background colour; transparent when unset (JPEG gets white). */
  fill?: string | GradientFill
  scale: number
  format: ExportFormat
  quality?: number
  asset: (id: string | undefined) => AssetDTO | undefined
}

/** Composites board items inside `area` into an image file, at `scale` × the board size. */
export async function renderArea(opts: RenderOptions): Promise<Blob> {
  const { area, scale } = opts
  const W = Math.max(1, Math.round(area.w * scale))
  const H = Math.max(1, Math.round(area.h * scale))
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(`${W} × ${H} px is too large to render — try a smaller scale`)
  ctx.imageSmoothingQuality = 'high'
  const fill = opts.fill ?? (opts.format === 'jpeg' ? '#ffffff' : undefined)
  if (fill) {
    fillRectWith(ctx, fill, { x: 0, y: 0, w: W, h: H })
  }
  await document.fonts.ready
  // Load what the items need first, then draw synchronously with the shared element renderer.
  const view = staticView({ id: '', kind: 'frame', ...area }, opts.items)
  const pictures = new Map<string, ItemSource>()
  for (const ri of view.items) {
    const item = ri.item
    if (item.kind === 'asset') {
      const asset = opts.asset(item.assetId)
      if (!asset || asset.kind === 'audio') continue
      const bmp = await bitmapOf(asset)
      pictures.set(item.id, { image: bmp, width: bmp.width, height: bmp.height })
    } else if (item.kind === 'text') {
      for (const font of textFonts(item)) await document.fonts.load(font).catch(() => [])
    }
  }
  ctx.scale(scale, scale)
  drawItems(ctx, view, (item) => pictures.get(item.id))
  return canvas.convertToBlob({ type: FORMAT_MIME[opts.format], quality: opts.format === 'png' ? undefined : (opts.quality ?? 0.92) })
}

/** Everything inside a frame, back to front. */
export function frameContents(items: CanvasItem[], frameId: string): CanvasItem[] {
  return items.filter((i) => i.frameId === frameId)
}

/** File name from an item's name: safe on every OS, never empty. */
export function exportName(name: string | undefined, fallback: string): string {
  const clean = (name ?? '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80)
  return clean || fallback
}
