import type { CanvasDoc } from '../types/canvas'

export interface FinishedJob {
  status: string
  outputAssetIds: string[]
}

export interface KnownSize {
  width?: number
  height?: number
}

export interface CanvasResolution {
  boardId: string
  itemId: string
  /** The generation's result, for a placeholder. */
  assetId?: string
  /** New height that follows the asset's aspect ratio (`fit` items only). */
  h?: number
}

/**
 * What to fill in on the canvas: placeholders whose generation succeeded get its first result, and `fit` items whose
 * asset size is now known get the matching height. Pure, so the caller can skip the document update when it's empty.
 */
export function canvasResolutions(
  canvas: CanvasDoc | undefined,
  job: (generationId: string) => FinishedJob | undefined,
  size: (assetId: string) => KnownSize | undefined,
): CanvasResolution[] {
  const out: CanvasResolution[] = []
  for (const board of canvas?.boards ?? []) {
    for (const item of board.items) {
      if (item.kind !== 'asset') continue
      let assetId = item.assetId
      const res: CanvasResolution = { boardId: board.id, itemId: item.id }
      if (!assetId && item.generationId) {
        const j = job(item.generationId)
        if (j?.status === 'succeeded' && j.outputAssetIds[0]) res.assetId = assetId = j.outputAssetIds[0]
      }
      if (item.fit && assetId) {
        const s = size(assetId)
        if (s?.width && s.height) {
          const h = Math.round((item.w * s.height) / s.width)
          if (h !== Math.round(item.h)) res.h = h
          else if (!res.assetId) res.h = item.h // size confirmed: only clears `fit`
        }
      }
      if (res.assetId !== undefined || res.h !== undefined) out.push(res)
    }
  }
  return out
}

/** Applies resolutions to a (draft) canvas. Items whose height was settled stop following the asset. */
export function applyCanvasResolutions(canvas: CanvasDoc, list: CanvasResolution[]): void {
  for (const r of list) {
    const item = canvas.boards.find((b) => b.id === r.boardId)?.items.find((i) => i.id === r.itemId)
    if (item?.kind !== 'asset') continue
    if (r.assetId) item.assetId = r.assetId
    if (r.h !== undefined) {
      item.h = r.h
      delete item.fit
    }
  }
}
