import type { AssetDTO } from '@shared/types/assets'
import { type Clip, type Keyframe, type ProjectDoc, type Transform, activeTake } from '@shared/types/project-doc'

/** Where the main subject is, at a frame relative to the clip start (fractions of the source picture). */
export interface SubjectPoint {
  frame: number
  x: number
  y: number
}

/**
 * Offset that puts a subject at the centre of a `fill`-conformed picture, clamped so no black edge shows.
 * Returns transform x/y as fractions of the output frame.
 */
export function centreOffset(src: { width: number; height: number }, out: { width: number; height: number }, subject: { x: number; y: number }, scale = 1) {
  const s = Math.max(out.width / src.width, out.height / src.height) * scale
  const dw = src.width * s
  const dh = src.height * s
  const maxX = Math.max(0, (dw - out.width) / 2) / out.width
  const maxY = Math.max(0, (dh - out.height) / 2) / out.height
  const clamp = (v: number, m: number) => Math.round(Math.max(-m, Math.min(m, v)) * 1000) / 1000 || 0
  return { x: clamp((-(subject.x - 0.5) * dw) / out.width, maxX), y: clamp((-(subject.y - 0.5) * dh) / out.height, maxY) }
}

/**
 * A copy of `doc` for another frame size: media clips fill the frame and follow their subject (one static offset,
 * or keyframes when the subject moves); stills, titles and generators keep their own settings.
 */
export function reframeDoc(
  doc: ProjectDoc,
  size: { width: number; height: number },
  subjects: ReadonlyMap<string, SubjectPoint[]>,
  getAsset: (id: string) => AssetDTO | undefined,
): ProjectDoc {
  const next = structuredClone(doc)
  next.settings.width = size.width
  next.settings.height = size.height
  const visit = (clip: Clip) => {
    if (clip.kind !== 'media' || !clip.video) return
    const asset = getAsset(activeTake(clip)?.assetId ?? '')
    if (!asset?.width || !asset.height || asset.kind === 'audio') return
    const crop = clip.video.crop
    const src = { width: asset.width * (1 - crop.left - crop.right), height: asset.height * (1 - crop.top - crop.bottom) }
    const points = subjects.get(clip.id) ?? [{ frame: 0, x: 0.5, y: 0.5 }]
    const base = clip.video.transform
    const at = (p: SubjectPoint): Transform => ({ ...base, ...centreOffset(src, size, p, base.scale) })
    clip.video.conform = 'fill'
    delete clip.video.transformKeys
    const moves = points.length > 1 && points.some((p) => Math.hypot(p.x - points[0]!.x, p.y - points[0]!.y) > 0.08)
    if (moves) {
      clip.video.transform = at(points[0]!)
      clip.video.transformKeys = points.map((p): Keyframe<Transform> => ({ frame: p.frame, value: at(p), ease: 'ease-in-out' }))
    } else {
      const avg = points.reduce((a, p) => ({ frame: 0, x: a.x + p.x / points.length, y: a.y + p.y / points.length }), { frame: 0, x: 0, y: 0 })
      clip.video.transform = at(avg)
    }
  }
  next.spine.forEach(visit)
  next.connected.forEach((c) => visit(c.clip))
  return next
}
