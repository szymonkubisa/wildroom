/**
 * Coverage: more shots of the same moment from one picture — a wide, a close-up, the reverse… — each drawn by an image
 * model that takes the picture as its reference, so the people, the place and the light stay. Plan makes them new
 * shots after the shot (each with its still); Create puts the pictures beside the image on the board.
 */
export interface CoverageAngle {
  id: string
  label: string
  /** The shot's type in Plan (StoryShot.shotType). */
  shotType: string
  /** Where the camera goes, for the image model. */
  instruction: string
  /** Where the camera stands, for the new shot (StoryShot.view), when the angle says. */
  view?: string
  /** How the picker's miniature shows it on the picture itself: how close and where, mirrored, tilted, pulled back. */
  preview: { zoom?: number; focus?: [number, number]; flip?: boolean; tilt?: number; wide?: boolean; shoulder?: boolean }
}

export const COVERAGE_ANGLES: CoverageAngle[] = [
  {
    id: 'wide',
    label: 'Wide',
    shotType: 'WIDE',
    instruction: 'a wide shot from further back — everyone full figure, much more of the place around them',
    preview: { wide: true },
  },
  {
    id: 'medium',
    label: 'Medium',
    shotType: 'MEDIUM',
    instruction: 'a medium shot of the main person, framed from the waist up',
    preview: { zoom: 1.6, focus: [50, 40] },
  },
  {
    id: 'close',
    label: 'Close-up',
    shotType: 'CLOSE-UP',
    instruction: 'a close-up on the main person’s face, the background soft',
    preview: { zoom: 2.4, focus: [50, 32] },
  },
  {
    id: 'extreme',
    label: 'Extreme close-up',
    shotType: 'EXTREME CLOSE-UP',
    instruction: 'an extreme close-up — the eyes, or the hands, fill the frame',
    preview: { zoom: 4, focus: [50, 30] },
  },
  {
    id: 'reverse',
    label: 'Reverse',
    shotType: 'REVERSE ANGLE',
    instruction: 'the reverse angle — the camera turned round to face the other way: what the people are looking at, with them from behind or from the other side',
    view: 'the reverse angle: facing back the way the shot before looked',
    preview: { flip: true, zoom: 1.15 },
  },
  {
    id: 'shoulder',
    label: 'Over the shoulder',
    shotType: 'OVER THE SHOULDER',
    instruction: 'over the shoulder of one person onto the other (or onto what they see), the near shoulder soft in the foreground',
    preview: { zoom: 1.5, focus: [60, 40], shoulder: true },
  },
  {
    id: 'low',
    label: 'Low angle',
    shotType: 'LOW ANGLE',
    instruction: 'a low angle from near the ground, looking up at the main person',
    preview: { tilt: -22, zoom: 1.2, focus: [50, 60] },
  },
  {
    id: 'high',
    label: 'High angle',
    shotType: 'HIGH ANGLE',
    instruction: 'a high angle from above, looking down on the scene',
    preview: { tilt: 22, zoom: 1.2, focus: [50, 45] },
  },
  {
    id: 'insert',
    label: 'Insert',
    shotType: 'INSERT',
    instruction: 'an insert — a detail of the action filling the frame: hands, or the thing they hold or look at',
    preview: { zoom: 3, focus: [50, 75] },
  },
]

/** What the picker starts with: the classic three. */
export const DEFAULT_COVERAGE = ['wide', 'close', 'reverse']

export const coverageAngle = (id: string) => COVERAGE_ANGLES.find((a) => a.id === id)

/** The image prompt for one angle: the same moment, only the camera moved. `context`: what happens (the shot's description). */
export function coveragePrompt(angle: CoverageAngle, context?: string): string {
  const what = context?.trim().replace(/[.\s]+$/, '')
  return [
    `The same moment as in the reference picture, seen from another camera: ${angle.instruction}.`,
    'The same people in the same clothes, the same place, props, light and time of day — only the camera has moved.',
    what ? `What happens: ${what}.` : '',
  ]
    .filter(Boolean)
    .join(' ')
}
