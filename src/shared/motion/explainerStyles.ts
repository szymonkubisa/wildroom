import type { GradientFill } from '../types/canvas'
import type { PresetId } from './edit'

/**
 * How an explainer looks: colours and fonts for its frames, what its pictures are like (the image prompt's style,
 * cut out of their background, a duotone, a mask), the decoration it adds to every frame, and which moves it prefers.
 * Three come from the reference reels; `default` is the plain one.
 */

export const EXPLAINER_STYLE_IDS = ['default', 'minimal-duotone', 'mono-3d', 'dark-editorial'] as const
export type ExplainerStyleId = (typeof EXPLAINER_STYLE_IDS)[number]

export interface ExplainerTheme {
  id: ExplainerStyleId
  label: string
  /** One line for the Director and the style picker. */
  description: string
  background: string | GradientFill
  text: string
  muted: string
  accent: string
  /** Body text. */
  font: string
  /** Titles (often a serif against a sans body). */
  headingFont: string
  headingWeight: number
  /** A title's last word set in italic, in the accent colour (a serif-italic accent in a sans line). */
  accentLastWord?: boolean
  /** Added to every image prompt. */
  imageStyle: string
  picture: {
    /** Cut out of its background (Remove background) once drawn. */
    cutout?: boolean
    duotone?: { dark: string; light: string }
    /** In layouts that frame pictures (not full-bleed or split). */
    mask?: 'ellipse' | 'rounded'
    shadow?: boolean
    /** Black and white, with this much contrast. */
    mono?: number
  }
  /** Decoration on every frame. */
  decor: ('dots' | 'grid' | 'barcode' | 'arc' | 'sphere' | 'neon-rings')[]
  /** The moves it prefers for titles, text and pictures (the Director's choice wins when it made one). */
  motion: { title: PresetId; text: PresetId; picture: PresetId }
  /** Pictures float gently while they are on screen. */
  floatPictures?: boolean
}

export const EXPLAINER_STYLES: Record<ExplainerStyleId, ExplainerTheme> = {
  default: {
    id: 'default',
    label: 'Clean',
    description: 'navy background, white sans titles, flat illustrations on the right',
    background: '#0b1020',
    text: '#ffffff',
    muted: '#c4cce0',
    accent: '#ff4466',
    font: 'Helvetica Neue',
    headingFont: 'Helvetica Neue',
    headingWeight: 700,
    imageStyle: 'flat vector illustration, soft gradients, friendly',
    picture: {},
    decor: [],
    motion: { title: 'slide-up-in', text: 'words', picture: 'pop' },
  },
  'minimal-duotone': {
    id: 'minimal-duotone',
    label: 'Minimal duotone reel',
    description: 'pale paper background, cut-out photos in a blue duotone, serif-italic accents in sans titles, arcs, dots and a barcode',
    background: '#eef0f4',
    text: '#0c1a3a',
    muted: '#4f5f80',
    accent: '#2f55ff',
    font: 'Helvetica Neue',
    headingFont: 'Helvetica Neue',
    headingWeight: 800,
    accentLastWord: true,
    imageStyle: 'a single subject photographed on a plain white background, classical sculpture or object, high detail',
    picture: { cutout: true, duotone: { dark: '#0c1a3a', light: '#9db4ff' } },
    decor: ['dots', 'arc', 'barcode'],
    motion: { title: 'words-rise', text: 'words-rise', picture: 'slide-up-in' },
    floatPictures: true,
  },
  'mono-3d': {
    id: 'mono-3d',
    label: 'Monochrome 3D tech',
    description: 'dark grey gradient, grey 3D renders in rounded tiles with soft shadows, huge type behind the subject, glossy spheres',
    background: { type: 'radial', stops: [{ at: 0, color: '#2a2b2f' }, { at: 1, color: '#08080a' }], cx: 0.5, cy: 0.4 },
    text: '#f4f4f5',
    muted: '#9a9ca3',
    accent: '#e5e7eb',
    font: 'Helvetica Neue',
    headingFont: 'Helvetica Neue',
    headingWeight: 800,
    imageStyle: 'monochrome 3D render, matte grey materials, soft studio lighting, minimal, no colour',
    picture: { mask: 'rounded', shadow: true, mono: 1.15 },
    decor: ['sphere'],
    motion: { title: 'words-blur', text: 'words-blur', picture: 'rack-focus' },
  },
  'dark-editorial': {
    id: 'dark-editorial',
    label: 'Dark editorial',
    description: 'near-black background, serif titles, neon rings that draw themselves, a highlighter under key words, counters, portraits in circles',
    background: '#0c0c10',
    text: '#ffffff',
    muted: '#a3a8b5',
    accent: '#ffd400',
    font: 'Helvetica Neue',
    headingFont: 'Georgia',
    headingWeight: 700,
    imageStyle: 'editorial photograph, high contrast, cinematic, dark background',
    picture: { mask: 'ellipse' },
    decor: ['neon-rings'],
    motion: { title: 'words-pop', text: 'highlight', picture: 'pop' },
  },
}

export const explainerStyle = (id: string | undefined): ExplainerTheme => EXPLAINER_STYLES[(EXPLAINER_STYLE_IDS as readonly string[]).includes(id ?? '') ? (id as ExplainerStyleId) : 'default']
