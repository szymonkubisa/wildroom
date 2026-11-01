/** Kling element library (characters/props reused across generations) — API between browser and server. */

/** `POST /api/kling/elements` */
export interface CreateKlingElementRequest {
  /** Element name (Kling keeps ≤ 20 characters). */
  name: string
  /** Look description (Kling keeps ≤ 100 characters); the name is used when empty. */
  description?: string
  /** Front-facing reference image asset (ready image). */
  frontalAssetId: string
  /** 1–3 more reference images (other angles, close-ups). */
  referenceAssetIds?: string[]
  /** Element this one replaces (re-sync): deleted from Kling's library once the new one exists (best effort). */
  replaceElementId?: string
}

export interface CreateKlingElementResponse {
  elementId: string
  /** Kling's creation task id. */
  taskId?: string
  /** Asset ids actually sent, frontal first (store as `StoryCharacter.kling.sourceAssetIds`). */
  sourceAssetIds: string[]
  /** True when `replaceElementId` was deleted. */
  replaced?: boolean
}

export interface KlingElementInfo {
  elementId: string
  name: string
  description?: string
  /** `image_refer` / `video_refer` (or the new-format `multi_image_elements` / `video_character_elements`). */
  referenceType?: string
  /** `succeed` normally, `deleted` when removed. */
  status?: string
  /** `kling` for official presets, a creator id otherwise. */
  ownedBy?: string
  frontalImageUrl?: string
  createdAt?: string
}

/** `GET /api/kling/elements[?scope=presets]` */
export interface ListKlingElementsResponse {
  elements: KlingElementInfo[]
}
