import type { GradientFill } from '@shared/types/canvas'

/**
 * A frame's background as CSS, drawn like `paintOf` draws it: CSS measures linear angles from "to top" (ours from
 * "to the right"), and a radial gradient reaches the farthest corner in both.
 */
export function fillToCss(fill: string | GradientFill): string {
  if (typeof fill === 'string') return fill
  const stops = fill.stops.map((s) => `${s.color} ${Math.round(s.at * 1000) / 10}%`).join(', ')
  if (fill.type === 'linear') return `linear-gradient(${(fill.angle ?? 90) + 90}deg, ${stops})`
  return `radial-gradient(circle farthest-corner at ${(fill.cx ?? 0.5) * 100}% ${(fill.cy ?? 0.5) * 100}%, ${stops})`
}
