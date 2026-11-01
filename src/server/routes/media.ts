import { Hono } from 'hono'
import type { AssetVariant } from '../../shared/types/assets'
import type { AppDeps } from '../app'
import { serveFile } from './files'

const VARIANT_MIME: Record<Exclude<AssetVariant, 'original'>, string> = {
  proxy: 'video/mp4',
  poster: 'image/jpeg',
  filmstrip: 'image/jpeg',
  waveform: 'application/octet-stream',
  audio: 'audio/wav',
  display: 'image/webp',
}

/** Media types an original may be served as (SVG originals are always PNG renderings; their SVG has its own route). */
export const SERVABLE_ORIGINAL = /^(image\/(png|jpeg|webp|gif|avif|heic|heif|tiff|bmp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|font\/(ttf|otf|woff|woff2))$/

export function mediaRoutes(deps: AppDeps) {
  const r = new Hono()
  r.get('/:assetId/:variant', (c) => {
    const row = deps.media.get(c.req.param('assetId'))
    if (!row) return c.json({ error: 'Asset not found' }, 404)
    const variant = c.req.param('variant') as AssetVariant | 'svg'
    if (variant === 'svg') {
      // The original SVG of a vector asset. Imported SVGs can carry scripts: never let them run on the app's origin.
      const path = deps.media.vectorPath(row)
      if (!path) return c.json({ error: 'Not a vector asset' }, 404)
      return serveFile(c, path, 'image/svg+xml', {
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      })
    }
    if (variant === 'original') {
      // Originals are served on the app's origin: only as media, never as something a browser would run.
      const mime = (row.mime ?? '').toLowerCase()
      if (!SERVABLE_ORIGINAL.test(mime)) return c.json({ error: 'This file type is not served' }, 415)
      return serveFile(c, deps.media.originalPath(row), mime, { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' })
    }
    // Own keys only: `in` is also true for "constructor", "toString"… (which would re-ingest a ready asset).
    if (!Object.hasOwn(VARIANT_MIME, variant)) return c.json({ error: 'Unknown variant' }, 404)
    const path = deps.media.variantPath(row, variant)
    if (!path) return c.json({ error: 'Variant not ready' }, 404)
    return serveFile(c, path, VARIANT_MIME[variant as Exclude<AssetVariant, 'original'>], { 'X-Content-Type-Options': 'nosniff' })
  })
  return r
}
