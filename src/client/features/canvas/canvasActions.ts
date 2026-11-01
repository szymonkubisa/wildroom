import { formatTimecode } from '@shared/time/timecode'
import type { CanvasAssetItem, CanvasItem } from '@shared/types/canvas'
import { toast } from 'vue-sonner'
import { runImageTool, toolCost, toolModel, useResultActions } from '@/features/generate/resultActions'
import { currentFrame } from '@/features/editor/transport'
import { useTimelineCommands } from '@/features/timeline/commands'
import { api, errorMessage } from '@/lib/api'
import { useAssetsStore } from '@/stores/assets'
import { useCanvasStore } from '@/stores/canvas'
import { useEditorStore } from '@/stores/editor'
import { useGenerateStore } from '@/stores/generate'
import { useProjectStore } from '@/stores/project'
import { coverCrop, renderArea } from './export/renderFrame'
import { addItems, newItemId } from './useCanvasDoc'

/** Asset items of a selection that have finished media of `kind` (default: images). */
export function assetItems(items: CanvasItem[], kind: 'image' | 'video' | 'any' = 'image'): CanvasAssetItem[] {
  const assets = useAssetsStore()
  return items.filter((i): i is CanvasAssetItem => {
    if (i.kind !== 'asset' || !i.assetId) return false
    const a = assets.get(i.assetId)
    return Boolean(a && a.status === 'ready' && (kind === 'any' ? a.kind !== 'audio' : a.kind === kind))
  })
}

/**
 * Opens the Composer from these images; the result lands next to them. On the kind a picture was last generated into
 * (else the one the Composer is on): on Video one picture is the clip's start frame (several its references), otherwise
 * they are an image's references. The model is the kind's last one picked.
 */
export function useAsReference(assetIds: string[]) {
  const generate = useGenerateStore()
  // What a picture was last generated into (a clip from a photo stays a clip), else the kind the Composer is on.
  const kind = generate.fromPictureKind ?? (generate.kind === 'video' ? 'video' : 'image')
  if (kind === 'video') return generate.open('video', { params: assetIds.length === 1 ? { firstFrame: assetIds[0] } : { referenceImages: assetIds } })
  generate.open('image', { params: { referenceImages: assetIds } })
}

/** The picture as a clip's start frame (the board's Animate): the result actions' Start frame. */
export function animate(assetId: string) {
  const asset = useAssetsStore().get(assetId)
  if (asset) useResultActions().startFrame(asset)
}

export function upscale(assetId: string) {
  const asset = useAssetsStore().get(assetId)
  if (asset) useResultActions().upscale(asset)
}

/** Adds the media to the end of the video timeline. */
export function useInVideo(assetIds: string[]) {
  useResultActions().toTimeline(assetIds)
}

/** The frame as an animated motion clip at the playhead (its elements come in one after another). */
export function frameToTimeline(boardId: string, frameId: string, overlay = false) {
  const editor = useEditorStore()
  const clip = useTimelineCommands().addMotion(boardId, frameId, overlay)
  if (!clip) return
  const where = overlay ? 'over the whole timeline' : `to the timeline at ${formatTimecode(currentFrame(), useProjectStore().doc.settings.fps)}`
  toast.success(`“${clip.name}” added ${where}`, {
    action: { label: 'Open Edit', onClick: () => (editor.workspace = 'edit') },
  })
}

export async function reveal(assetId: string) {
  try {
    await api.assets.reveal(assetId)
  } catch (err) {
    toast.error('Could not show the file', { description: errorMessage(err) })
  }
}

/** The one-click tools: shared with every result's actions now (resultActions). */
export { runImageTool, toolCost, toolModel }

/** The board shows only part of the image (its box has another shape than the picture). */
export function isCropped(item: CanvasAssetItem): boolean {
  const a = useAssetsStore().get(item.assetId)
  if (!a?.width || !a.height) return false
  return Math.abs(item.w / item.h - a.width / a.height) > 0.01
}

/** Saves the part of the image the board shows as a new image (full resolution), next to the original. */
export async function saveCrop(item: CanvasAssetItem) {
  const assets = useAssetsStore()
  const canvas = useCanvasStore()
  const a = assets.get(item.assetId)
  if (!a?.width || !a.height || !assets.projectId) return
  try {
    const crop = coverCrop(a.width, a.height, item)
    const blob = await renderArea({ area: item, items: [item], scale: crop.w / item.w, format: 'png', asset: (id) => assets.get(id) })
    const name = `${a.name.replace(/\.[a-z0-9]{2,4}$/i, '')} – crop`
    const asset = await api.assets.upload(assets.projectId, new File([blob], `${name}.png`, { type: 'image/png' }), undefined, { parentIds: [a.id], label: name })
    assets.upsert(asset)
    addItems(canvas.board.id, [{ kind: 'asset', id: newItemId(), assetId: asset.id, x: item.x + item.w + 40, y: item.y, w: item.w, h: item.h }], 'Save crop')
    toast.success('Crop saved as a new image', { description: `${Math.round(crop.w)} × ${Math.round(crop.h)} px` })
  } catch (err) {
    toast.error('Could not save the crop', { description: errorMessage(err) })
  }
}
