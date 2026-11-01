import { fitInside, unionRect } from '@shared/canvas/geometry'
import { type BrandKit, emptyBrand } from '@shared/types/brand'
import { type CanvasItem, DEFAULT_TEXT } from '@shared/types/canvas'
import { addItems, newItemId } from '@/features/canvas/useCanvasDoc'
import { useAssetsStore } from '@/stores/assets'
import { useCanvasStore } from '@/stores/canvas'
import { useEditorStore } from '@/stores/editor'
import { useGenerateStore } from '@/stores/generate'
import { useProjectStore } from '@/stores/project'
import { luminance } from './palette'

/** Edits the project's brand kit as one undoable step ("Brand: …"). */
export function editBrand(label: string, fn: (brand: BrandKit) => void): boolean {
  return useProjectStore().apply((draft) => {
    if (!draft.brand) draft.brand = emptyBrand()
    fn(draft.brand)
  }, `Brand: ${label}`)
}

/** One line about the brand for prompts: name, tagline, what it is. */
export function brandContext(b: BrandKit): string {
  return [b.name, b.tagline, b.description].map((s) => s.trim()).filter(Boolean).join(' — ')
}

/** Opens the image generator on the Logo preset with what the kit says about the brand. */
export function generateLogos(b: BrandKit) {
  const about = brandContext(b) || 'a new brand'
  const style = b.styleText.trim() ? ` Style: ${b.styleText.trim()}.` : ''
  useGenerateStore().open('image', {
    presetId: 'logo',
    params: { prompt: `Logo for ${about}. Simple, memorable mark that works small and in one colour, on a plain white background.${style}` },
  })
}

/**
 * A brand board on the canvas: a frame with the logo, name and tagline, the palette as labelled swatches and a sample
 * of each font — a one-page overview to share or export.
 */
export function createBrandBoard(b: BrandKit) {
  const editor = useEditorStore()
  const canvas = useCanvasStore()
  const assets = useAssetsStore()
  editor.workspace = 'canvas'
  const W = 1600
  const H = 1000
  const bounds = unionRect(canvas.items)
  const c = canvas.viewCenter()
  const x0 = Math.round(bounds ? bounds.x + bounds.w + 200 : c.x - W / 2)
  const y0 = Math.round(bounds ? bounds.y : c.y - H / 2)
  const bg = b.colors.find((col) => col.role === 'background')?.hex ?? '#ffffff'
  const ink = b.colors.find((col) => col.role === 'text')?.hex ?? (luminance(bg) > 0.4 ? '#111111' : '#f5f5f5')
  const heading = b.fonts.find((f) => f.role === 'heading')?.family ?? DEFAULT_TEXT.fontFamily
  const body = b.fonts.find((f) => f.role === 'body')?.family ?? heading
  const frameId = newItemId()
  const items: CanvasItem[] = [{ kind: 'frame', id: frameId, name: `Brand board — ${b.name || 'Brand'}`, fill: bg, x: x0, y: y0, w: W, h: H }]
  const inFrame = { frameId }
  const text = (t: string, x: number, y: number, w: number, size: number, weight: number, family: string, color = ink): CanvasItem => ({
    kind: 'text',
    id: newItemId(),
    text: t,
    ...DEFAULT_TEXT,
    fontFamily: family,
    fontSize: size,
    fontWeight: weight,
    color,
    x: x0 + x,
    y: y0 + y,
    w,
    h: Math.round(size * DEFAULT_TEXT.lineHeight),
    ...inFrame,
  })

  let textX = 80
  const logo = b.logoAssetIds[0] ? assets.get(b.logoAssetIds[0]) : undefined
  if (logo) {
    const size = logo.width && logo.height ? fitInside(logo.width, logo.height, 220) : { w: 220, h: 220 }
    items.push({ kind: 'asset', id: newItemId(), assetId: logo.id, x: x0 + 80, y: y0 + 80, ...size, ...inFrame })
    textX = 80 + size.w + 60
  }
  items.push(text(b.name || 'Brand name', textX, 100, W - textX - 80, 96, 800, heading))
  if (b.tagline) items.push(text(b.tagline, textX, 230, W - textX - 80, 36, 400, body))

  // Palette: swatches with the name and hex underneath.
  const colors = b.colors.slice(0, 8)
  const sw = colors.length ? Math.min(180, Math.floor((W - 160 - (colors.length - 1) * 24) / colors.length)) : 0
  colors.forEach((col, i) => {
    const x = 80 + i * (sw + 24)
    items.push({ kind: 'shape', id: newItemId(), shape: 'rect', fill: col.hex, radius: 16, x: x0 + x, y: y0 + 420, w: sw, h: sw, ...inFrame })
    items.push(text(`${col.name ?? col.role ?? ''}\n${col.hex.toUpperCase()}`.trim(), x, 420 + sw + 14, sw, 20, 500, body))
  })

  // Type specimens.
  const fonts = b.fonts.length ? b.fonts : [{ family: heading, role: 'heading' as const }]
  fonts.slice(0, 3).forEach((f, i) => {
    items.push(text(`${f.family} · ${f.role}`, 80 + i * 480, 780, 440, 18, 500, body))
    items.push(text('Aa Bb Cc 123', 80 + i * 480, 812, 440, 56, f.role === 'heading' ? 700 : 400, f.family))
  })

  addItems(canvas.board.id, items, 'Brand board')
  canvas.select([frameId])
  canvas.requestZoom('selection')
}
