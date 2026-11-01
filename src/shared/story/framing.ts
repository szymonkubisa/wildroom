/**
 * A shot's framing as the Director writes it — scale, angle and lens in one line ("MEDIUM CLOSE-UP, eye level, 50mm",
 * StoryShot.shotType) — taken apart for the shot's Size and Lens fields, and put back together. The line stays the one
 * stored field: every prompt reads it as it always has.
 */

/** Sizes offered in the Size field (any other wording can be typed). */
export const SHOT_SIZES = ['Extreme wide', 'Wide', 'Full', 'Medium wide', 'Medium', 'Medium close-up', 'Close-up', 'Extreme close-up', 'Over-the-shoulder', 'Insert'] as const

/** Lenses offered in the Lens field. */
export const LENSES = ['18mm', '24mm', '28mm', '35mm', '50mm', '85mm', '100mm', '135mm'] as const

export interface Framing {
  /** The scale ("MEDIUM CLOSE-UP"): the line's first part. */
  size: string
  /** The focal length ("50mm"), wherever the line has it. */
  lens: string
  /** Everything else, in order ("eye level", "low angle"). */
  rest: string[]
}

const LENS = /\b(\d{2,3})\s?mm\b(?:\s+lens)?/i

/** "MEDIUM CLOSE-UP, eye level, 50mm" → size "MEDIUM CLOSE-UP", lens "50mm", rest ["eye level"]. */
export function splitFraming(shotType?: string): Framing {
  const text = shotType?.trim() ?? ''
  const found = LENS.exec(text)
  const lens = found ? `${found[1]}mm` : ''
  const without = found ? `${text.slice(0, found.index)}${text.slice(found.index + found[0].length)}` : text
  const parts = without
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  return { size: parts[0] ?? '', lens, rest: parts.slice(1) }
}

/** The line again: size, the rest, then the lens; undefined when empty (the field is then unset). */
export function joinFraming(f: Framing): string | undefined {
  const line = [f.size.trim(), ...f.rest.map((r) => r.trim()), f.lens.trim()].filter(Boolean).join(', ')
  return line || undefined
}

/** The line with a new size or lens, the rest kept. */
export function withFraming(shotType: string | undefined, change: Partial<Pick<Framing, 'size' | 'lens'>>): string | undefined {
  return joinFraming({ ...splitFraming(shotType), ...change })
}
