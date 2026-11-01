/**
 * Brief → asset set: Claude plans a cohesive set of brand / web / social images from a short brief; the canvas turns
 * each planned item into a frame of the right size with a generation inside and the copy on top as editable text.
 */

export interface Deliverable {
  id: string
  label: string
  /** Frame size (see shared/canvas/framePresets). */
  framePresetId: string
  /** Generation preset that picks the model and settings (see shared/presets/catalog). */
  presetId: string
  /** Gets a headline / subline as text over the image. */
  copy: boolean
  defaultCount: number
  maxCount: number
  hint: string
}

export const DELIVERABLES: Deliverable[] = [
  { id: 'logo', label: 'Logo concepts', framePresetId: 'logo', presetId: 'logo', copy: false, defaultCount: 3, maxCount: 6, hint: 'Different directions for the mark' },
  { id: 'hero', label: 'Website hero', framePresetId: 'hero', presetId: 'illustration', copy: true, defaultCount: 1, maxCount: 3, hint: 'Main image for the home page' },
  { id: 'og', label: 'Link preview (OG)', framePresetId: 'og', presetId: 'social-ad', copy: true, defaultCount: 1, maxCount: 3, hint: 'Shown when the site is shared' },
  { id: 'social', label: 'Social posts', framePresetId: 'ig-post', presetId: 'social-ad', copy: true, defaultCount: 3, maxCount: 9, hint: 'Instagram / LinkedIn feed' },
  { id: 'story', label: 'Stories / Reels covers', framePresetId: 'story', presetId: 'social-ad', copy: true, defaultCount: 2, maxCount: 6, hint: 'Vertical 9:16' },
  { id: 'ad', label: 'Ad banners', framePresetId: 'fb-link', presetId: 'social-ad', copy: true, defaultCount: 2, maxCount: 6, hint: 'Meta / LinkedIn link ads' },
  { id: 'icons', label: 'Feature icons', framePresetId: 'avatar', presetId: 'icons-vector', copy: false, defaultCount: 4, maxCount: 8, hint: 'One consistent icon set' },
  { id: 'background', label: 'Backgrounds & patterns', framePresetId: 'hero', presetId: 'backgrounds', copy: false, defaultCount: 2, maxCount: 4, hint: 'Section backgrounds, textures' },
  { id: 'yt-thumb', label: 'YouTube thumbnail', framePresetId: 'yt-thumb', presetId: 'social-ad', copy: true, defaultCount: 1, maxCount: 4, hint: '16:9 with a bold headline' },
]

export function deliverable(id: string): Deliverable | undefined {
  return DELIVERABLES.find((d) => d.id === id)
}

export interface AssetSetRequest {
  brief: string
  deliverables: { id: string; count: number }[]
  /** What the brand kit says (when "use brand kit" is on). */
  brand?: { name?: string; description?: string; style?: string; avoid?: string; tone?: string; colors?: string[] }
  /** Reply language for the copy (headlines); prompts stay in English. */
  language?: string
}

export interface AssetPlanItem {
  deliverable: string
  title: string
  /** For the image model: subject, composition, light, style. No text in the picture (except wordmarks). */
  prompt: string
  /** Copy placed over the image as text (empty when none). */
  headline: string
  subline: string
  /** Where the prompt leaves calm space for the copy. */
  textArea: TextArea
}

export const TEXT_AREAS = ['top', 'bottom', 'left', 'right', 'center'] as const
export type TextArea = (typeof TEXT_AREAS)[number]

export interface AssetPlan {
  title: string
  /** The shared look, added to every prompt so the set belongs together. */
  style: string
  items: AssetPlanItem[]
}

export interface AssetSetResponse {
  plan: AssetPlan
  via: 'anthropic' | 'openrouter' | 'fal' | 'demo'
  model: string
}
