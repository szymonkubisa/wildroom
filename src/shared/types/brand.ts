/**
 * Brand kit of a project: identity, palette, type, logos and the visual style every generation can follow. Lives on
 * the project document (undoable, autosaved) next to the timeline, story and canvas.
 */

import type { ModelSpec, ParamDef, ParamValues } from '../models/types'

export const COLOR_ROLES = ['primary', 'secondary', 'accent', 'neutral', 'background', 'text'] as const
export type ColorRole = (typeof COLOR_ROLES)[number]

export interface BrandColor {
  hex: string
  name?: string
  role?: ColorRole
}

export const FONT_ROLES = ['heading', 'body', 'accent'] as const
export type FontRole = (typeof FONT_ROLES)[number]

export interface BrandFont {
  family: string
  role: FontRole
}

export interface BrandKit {
  name: string
  tagline: string
  /** What the brand is and who it's for (the brief planner and prompt enhancer read it). */
  description: string
  colors: BrandColor[]
  fonts: BrandFont[]
  /** Primary logo first, then variants (mark, monochrome, …). */
  logoAssetIds: string[]
  /** Images that define the look: used as style references when "Apply brand" is on. */
  refAssetIds: string[]
  /** Visual style in words: "flat, warm, hand-drawn textures, lots of white space". */
  styleText: string
  /** What generations should avoid: "no gradients, no stock-photo people". */
  avoidText: string
  /** Voice for copy: "friendly, direct, a little playful". */
  tone: string
}

export function emptyBrand(): BrandKit {
  return { name: '', tagline: '', description: '', colors: [], fonts: [], logoAssetIds: [], refAssetIds: [], styleText: '', avoidText: '', tone: '' }
}

export function hasBrand(b: BrandKit | undefined): b is BrandKit {
  return Boolean(b && (b.name || b.styleText || b.colors.length || b.refAssetIds.length || b.logoAssetIds.length || b.description))
}

/** The main colour: the one marked primary, else the first. */
export function primaryColor(b: BrandKit | undefined): string | undefined {
  return b?.colors.find((c) => c.role === 'primary')?.hex ?? b?.colors[0]?.hex
}

const HEX = /^#[0-9a-f]{6}$/i
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const text = (v: unknown) => (typeof v === 'string' ? v : '')

/** Repairs a brand kit read from disk. */
export function sanitizeBrand(raw: unknown): BrandKit | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Partial<BrandKit>
  return {
    name: text(r.name),
    tagline: text(r.tagline),
    description: text(r.description),
    colors: (Array.isArray(r.colors) ? r.colors : [])
      .filter((c): c is BrandColor => Boolean(c) && typeof c.hex === 'string' && HEX.test(c.hex))
      .map((c) => ({ hex: c.hex.toLowerCase(), ...(c.name ? { name: String(c.name) } : {}), ...(COLOR_ROLES.includes(c.role as ColorRole) ? { role: c.role } : {}) })),
    fonts: (Array.isArray(r.fonts) ? r.fonts : [])
      .filter((f): f is BrandFont => Boolean(f) && typeof f.family === 'string' && f.family.trim() !== '')
      .map((f) => ({ family: f.family.trim(), role: FONT_ROLES.includes(f.role) ? f.role : 'body' })),
    logoAssetIds: ids(r.logoAssetIds),
    refAssetIds: ids(r.refAssetIds),
    styleText: text(r.styleText),
    avoidText: text(r.avoidText),
    tone: text(r.tone),
  }
}

/**
 * Words appended to a prompt so the result follows the brand: style, palette (names and hex) and what to avoid.
 * Empty when the kit has nothing visual to say.
 */
export function brandPromptSuffix(b: BrandKit | undefined): string {
  if (!b) return ''
  const parts: string[] = []
  if (b.styleText.trim()) parts.push(`Style: ${b.styleText.trim().replace(/\.$/, '')}.`)
  if (b.colors.length) {
    const palette = b.colors.slice(0, 6).map((c) => (c.name ? `${c.name} ${c.hex}` : c.hex))
    parts.push(`Brand colour palette: ${palette.join(', ')}.`)
  }
  if (b.avoidText.trim()) parts.push(`Avoid: ${b.avoidText.trim().replace(/\.$/, '')}.`)
  return parts.join(' ')
}

/**
 * The image model's slot for references to follow (brand style images, a set's style anchor). Never a slot that holds
 * the picture being edited or restyled, and none for video models, whose references are characters to keep.
 */
export function styleRefSlot(model: ModelSpec): ParamDef | undefined {
  if (model.kind !== 'image') return undefined
  return model.params.find((p) => p.key === 'referenceImages' && p.ui.control === 'images' && !p.ui.source)
}

/**
 * Adds style references to a generation's values: after the ones already chosen, up to what the slot takes (and
 * `maxRefs`, e.g. what the OpenRouter model picked at run time accepts). Unchanged when the model has no such slot or
 * would reject the request with them (e.g. a tier without style references).
 */
export function withStyleRefs(model: ModelSpec, values: ParamValues, ids: string[], maxRefs = Infinity): ParamValues {
  const slot = styleRefSlot(model)
  if (!slot || !ids.length || (slot.ui.visibleIf && !slot.ui.visibleIf(values))) return values
  const current = Array.isArray(values[slot.key]) ? (values[slot.key] as string[]) : []
  const refs = [...new Set([...current, ...ids])].slice(0, Math.max(current.length, Math.min(slot.ui.maxItems ?? 4, maxRefs)))
  if (refs.length === current.length) return values
  const out = { ...values, [slot.key]: refs }
  return model.validate?.(out) && !model.validate(values) ? values : out
}

/** Adds the brand suffix to a prompt once (applying twice doesn't repeat it). */
export function withBrand(prompt: string, b: BrandKit | undefined): string {
  const suffix = brandPromptSuffix(b)
  if (!suffix || prompt.includes(suffix)) return prompt
  return prompt.trim() ? `${prompt.trim()}\n\n${suffix}` : suffix
}
