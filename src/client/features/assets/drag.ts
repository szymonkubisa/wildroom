import type { AssetDTO } from '@shared/types/assets'

/** Payload type for media dragged out of the Assets panel. */
export const ASSET_DRAG_TYPE = 'application/x-studio-asset'
/** Extra type set when every dragged asset is audio: types are readable during dragover, the payload is not. */
export const AUDIO_DRAG_TYPE = 'application/x-studio-asset-audio'

/** Fills the drag with the assets in the given order (the order they were selected in). */
export function setAssetDrag(dt: DataTransfer, list: readonly AssetDTO[]) {
  dt.effectAllowed = 'copy'
  // `assetId` stays for drop targets that take a single asset.
  dt.setData(ASSET_DRAG_TYPE, JSON.stringify({ assetId: list[0]!.id, assetIds: list.map((a) => a.id) }))
  dt.setData('text/plain', list.map((a) => a.name).join('\n'))
  if (list.every((a) => a.kind === 'audio')) dt.setData(AUDIO_DRAG_TYPE, '1')
  if (list.length > 1) setCountImage(dt, list.length)
}

/** The dragged asset ids in order, or undefined when the drag is not ours. */
export function readAssetDrag(dt: DataTransfer | null | undefined): string[] | undefined {
  const raw = dt?.getData(ASSET_DRAG_TYPE)
  if (!raw) return undefined
  try {
    const data = JSON.parse(raw) as { assetId?: string; assetIds?: string[] }
    const ids = data.assetIds?.length ? data.assetIds : data.assetId ? [data.assetId] : []
    return ids.length ? ids : undefined
  } catch {
    return undefined
  }
}

/** A small "3 items" chip as the drag image, so a multi-asset drag reads as one. */
function setCountImage(dt: DataTransfer, count: number) {
  const chip = document.createElement('div')
  chip.textContent = `${count} items`
  Object.assign(chip.style, {
    position: 'fixed',
    top: '-100px',
    left: '0',
    padding: '4px 10px',
    borderRadius: '999px',
    font: '500 12px system-ui, sans-serif',
    // The brand pair, not white: in dark mode --brand is near-white and white text vanished.
    color: 'var(--brand-foreground)',
    background: 'var(--brand)',
    whiteSpace: 'nowrap',
  })
  document.body.appendChild(chip)
  dt.setDragImage(chip, 12, 12)
  // The browser snapshots the image synchronously; the element can go on the next frame.
  requestAnimationFrame(() => chip.remove())
}
