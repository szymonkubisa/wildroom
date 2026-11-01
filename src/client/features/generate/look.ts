/**
 * The look tiles above the Composer's prompt — Camera (an image's framing and its lens; a clip's camera move is in its
 * own picker, with the lens beside it), Lighting and Color — each Auto until picked. A pick goes with the prompt as sent (not into the text the user
 * edits), once: a prompt that already says it (a result reused with its prompt) doesn't get it twice.
 */
export type LookAxis = 'camera' | 'lens' | 'lighting' | 'color'
export type Look = Partial<Record<LookAxis, string>>

/** How a tile's miniature draws an option (LookPreview): the same small scene, framed, lit or graded. */
export interface LookPreviewSpec {
  /** Camera: how close (1 = the scene as drawn), the point zoomed into, tilt, roll, a shoulder in front. */
  zoom?: number
  focus?: [number, number]
  tilt?: number
  roll?: number
  shoulder?: boolean
  /** Lighting: the sky (top → horizon), the sun (or lamp) and where it is, how dark the ground and the figure are. */
  sky?: [string, string]
  sun?: { color: string; x: number; y: number; r: number; glow?: number }
  ground?: string
  figure?: string
  /** A plain backdrop instead of the landscape (studio). */
  backdrop?: string
  /** A coloured light falling on the figure from one side. */
  rim?: { color: string; side: 'left' | 'right' | 'back' }
  /** Lens: the background out of focus (how much), lights in it as bokeh, the background brought closer (a long
   * lens), darker corners, a horizontal flare (anamorphic) with bars top and bottom, glowing highlights (vintage), a
   * band in focus with the top and bottom soft (tilt-shift). */
  dof?: number
  bokeh?: boolean
  bgScale?: number
  vignette?: number
  flare?: string
  letterbox?: boolean
  halation?: boolean
  tiltShift?: boolean
  /** Color: a CSS filter on the whole picture, and a tint blended over it. */
  filter?: string
  tint?: { color: string; blend: 'soft-light' | 'overlay' | 'multiply' | 'screen' | 'color' }
}

export interface LookOption {
  id: string
  label: string
  /** On the tile, when the label is long (with another axis's beside it). */
  short?: string
  /** What goes with the prompt. */
  phrase: string
  preview: LookPreviewSpec
}

export interface LookAxisInfo {
  id: LookAxis
  label: string
  options: LookOption[]
}

export const LOOK_AXES: LookAxisInfo[] = [
  {
    id: 'camera',
    label: 'Camera',
    options: [
      { id: 'wide', label: 'Wide', phrase: 'wide shot, the whole figure with plenty of the place around them', preview: { zoom: 0.8 } },
      { id: 'medium', label: 'Medium', phrase: 'medium shot, framed from the waist up', preview: { zoom: 1.7, focus: [32, 21] } },
      { id: 'close', label: 'Close-up', phrase: 'close-up on the face, the background soft', preview: { zoom: 3.2, focus: [32, 16] } },
      { id: 'extreme', label: 'Extreme close-up', phrase: 'extreme close-up, the eyes fill the frame', preview: { zoom: 6, focus: [32, 15] } },
      { id: 'low', label: 'Low angle', phrase: 'low-angle shot looking up at the subject', preview: { zoom: 1.4, focus: [32, 24], tilt: -28 } },
      { id: 'high', label: 'High angle', phrase: 'high-angle shot looking down on the subject', preview: { zoom: 1.3, focus: [32, 22], tilt: 28 } },
      { id: 'shoulder', label: 'Over the shoulder', phrase: 'over-the-shoulder framing, a soft shoulder in the foreground', preview: { zoom: 1.8, focus: [36, 19], shoulder: true } },
      { id: 'dutch', label: 'Dutch angle', phrase: 'dutch angle, the horizon tilted', preview: { zoom: 1.3, focus: [32, 20], roll: -14 } },
    ],
  },
  {
    id: 'lens',
    label: 'Lens',
    options: [
      { id: 'wide', label: '24 mm wide', short: '24 mm', phrase: 'shot on a 24mm wide-angle lens, deep perspective', preview: { zoom: 0.72, vignette: 0.35 } },
      { id: 'normal', label: '50 mm', phrase: 'shot on a 50mm lens, natural perspective', preview: { zoom: 1.2, focus: [32, 20] } },
      {
        id: 'portrait',
        label: '85 mm portrait', short: '85 mm',
        phrase: 'shot on an 85mm portrait lens at f/1.8, shallow depth of field, creamy bokeh',
        preview: { zoom: 1.7, focus: [32, 19], dof: 1.6, bokeh: true },
      },
      {
        id: 'tele',
        label: 'Telephoto',
        phrase: 'long telephoto lens, compressed perspective, the background large behind the subject',
        preview: { zoom: 1.3, focus: [32, 20], bgScale: 1.9, dof: 0.7 },
      },
      {
        id: 'anamorphic',
        label: 'Anamorphic',
        phrase: 'anamorphic lens, horizontal blue lens flares, oval bokeh, cinematic widescreen',
        preview: { dof: 0.6, flare: '#93c5fd', letterbox: true },
      },
      {
        id: 'vintage',
        label: 'Vintage',
        phrase: 'vintage lens, soft halation around the highlights, gentle falloff at the edges',
        preview: { halation: true, vignette: 0.7, filter: 'sepia(0.3) contrast(0.85) saturate(0.85) brightness(1.08)' },
      },
      { id: 'macro', label: 'Macro', phrase: 'macro lens, extreme detail, razor-thin focus', preview: { zoom: 5.5, focus: [32, 14], dof: 2.2 } },
      { id: 'tiltshift', label: 'Tilt-shift', phrase: 'tilt-shift lens, a narrow band in focus, miniature look', preview: { zoom: 0.75, tiltShift: true } },
    ],
  },
  {
    id: 'lighting',
    label: 'Lighting',
    options: [
      {
        id: 'golden',
        label: 'Golden hour',
        phrase: 'warm low golden-hour sunlight, long soft shadows',
        preview: { sky: ['#f59e0b', '#fde68a'], sun: { color: '#fff7d6', x: 50, y: 18, r: 3.6, glow: 9 }, ground: '#7c5a2a', figure: '#3b2614', rim: { color: '#fbbf24', side: 'right' } },
      },
      {
        id: 'blue',
        label: 'Blue hour',
        phrase: 'blue-hour dusk light, cool and soft',
        preview: { sky: ['#1e3a8a', '#818cf8'], sun: { color: '#e0e7ff', x: 50, y: 7, r: 1.4 }, ground: '#1e293b', figure: '#0f172a' },
      },
      {
        id: 'overcast',
        label: 'Overcast',
        phrase: 'soft overcast daylight, no hard shadows',
        preview: { sky: ['#9ca3af', '#d1d5db'], ground: '#4b5563', figure: '#374151' },
      },
      {
        id: 'noon',
        label: 'Hard sun',
        phrase: 'hard midday sun, crisp dark shadows',
        preview: { sky: ['#0284c7', '#7dd3fc'], sun: { color: '#ffffff', x: 32, y: 4, r: 3.2, glow: 6 }, ground: '#65a30d', figure: '#1f2937' },
      },
      {
        id: 'neon',
        label: 'Neon night',
        phrase: 'night lit by neon signs, magenta and cyan light with reflections',
        preview: { sky: ['#0b0420', '#3b0764'], ground: '#0f0a1e', figure: '#140b2a', rim: { color: '#22d3ee', side: 'left' }, tint: { color: '#d946ef', blend: 'soft-light' } },
      },
      {
        id: 'candle',
        label: 'Candlelight',
        phrase: 'warm candlelight in the dark, deep shadows',
        preview: { sky: ['#0c0a09', '#1c1917'], sun: { color: '#fdba74', x: 40, y: 24, r: 1.2, glow: 10 }, ground: '#1c1917', figure: '#292524', rim: { color: '#fb923c', side: 'right' } },
      },
      {
        id: 'studio',
        label: 'Studio',
        phrase: 'clean studio softbox lighting on a seamless backdrop',
        preview: { backdrop: '#d4d4d8', figure: '#3f3f46', rim: { color: '#ffffff', side: 'left' } },
      },
      {
        id: 'backlit',
        label: 'Backlit',
        phrase: 'backlit, the sun behind the subject, a bright rim of light around them',
        preview: { sky: ['#fb923c', '#fef3c7'], sun: { color: '#ffffff', x: 32, y: 17, r: 4, glow: 12 }, ground: '#44403c', figure: '#0c0a09', rim: { color: '#fff7ed', side: 'back' } },
      },
      {
        id: 'lowkey',
        label: 'Low-key',
        phrase: 'low-key chiaroscuro lighting, one hard side light, deep blacks',
        preview: { sky: ['#000000', '#0a0a0a'], ground: '#050505', figure: '#0a0a0a', rim: { color: '#e5e5e5', side: 'left' } },
      },
    ],
  },
  {
    id: 'color',
    label: 'Color',
    options: [
      { id: 'teal', label: 'Teal & orange', phrase: 'teal-and-orange colour grade', preview: { filter: 'saturate(1.35) contrast(1.1)', tint: { color: '#0d9488', blend: 'soft-light' } } },
      { id: 'warm', label: 'Warm film', phrase: 'warm film-stock colours, soft grain, creamy highlights', preview: { filter: 'sepia(0.4) saturate(1.15) contrast(0.95)' } },
      { id: 'cool', label: 'Cool', phrase: 'cool, slightly desaturated colour grade', preview: { filter: 'saturate(0.7) brightness(0.95)', tint: { color: '#3b82f6', blend: 'soft-light' } } },
      { id: 'mono', label: 'Black & white', phrase: 'black-and-white, rich contrast', preview: { filter: 'grayscale(1) contrast(1.25)' } },
      { id: 'bleach', label: 'Bleach bypass', phrase: 'bleach-bypass look: low saturation, hard contrast, silvery', preview: { filter: 'saturate(0.4) contrast(1.4) brightness(1.05)' } },
      { id: 'pastel', label: 'Pastel', phrase: 'soft pastel colours, airy and light', preview: { filter: 'saturate(0.65) brightness(1.18) contrast(0.82)', tint: { color: '#f9a8d4', blend: 'soft-light' } } },
      { id: 'vivid', label: 'Vivid', phrase: 'vivid, saturated colours', preview: { filter: 'saturate(1.8) contrast(1.08)' } },
      { id: 'faded', label: 'Faded', phrase: 'faded matte look, lifted blacks, muted colours', preview: { filter: 'contrast(0.75) brightness(1.1) saturate(0.8)' } },
    ],
  },
]

export const lookAxis = (id: LookAxis) => LOOK_AXES.find((a) => a.id === id)!
export const lookOption = (axis: LookAxis, id: string | undefined) => (id ? lookAxis(axis).options.find((o) => o.id === id) : undefined)

/** The axes a kind takes: an image all of them; a clip all but the framing (its camera move is in the move picker). */
export function lookAxesFor(kind: string): LookAxis[] {
  if (kind === 'image') return ['camera', 'lens', 'lighting', 'color']
  if (kind === 'video') return ['lens', 'lighting', 'color']
  return []
}

/** The tiles the axes are in: the lens is a tab of the Camera tile (of the move picker for a clip), not a tile of its own. */
export const LOOK_TILES: { axis: LookAxis; tabs: LookAxis[] }[] = [
  { axis: 'camera', tabs: ['camera', 'lens'] },
  { axis: 'lighting', tabs: ['lighting'] },
  { axis: 'color', tabs: ['color'] },
]

/** The phrases the look adds for this kind, in axis order. */
export function lookPhrases(look: Look, kind: string): string[] {
  return lookAxesFor(kind)
    .map((axis) => lookOption(axis, look[axis])?.phrase)
    .filter((p): p is string => Boolean(p))
}

/** The prompt with the look's phrases after it — each only if the prompt doesn't say it already. */
export function withLook(prompt: string, look: Look, kind: string): string {
  const lower = prompt.toLowerCase()
  const add = lookPhrases(look, kind).filter((p) => !lower.includes(p.toLowerCase()))
  if (!add.length) return prompt
  const base = prompt.trim().replace(/[.,;\s]+$/, '')
  return base ? `${base}. ${add.join('. ')}.` : `${add.join('. ')}.`
}
