import { z } from 'zod'

/**
 * The motion-import file: everything an explainer needs, in one JSON a script (or Claude Code) can write — media
 * and fonts by local path, boards with their frames and elements, motion clips with their tracks, voice-overs with
 * their word timings, markers and the brand kit. `POST /api/projects/:id/motion-import` (see docs/motion-import.md).
 *
 * Media and fonts get a `key`; anywhere in the file the string `"@@key"` stands for that asset's id (a font's: its
 * family name), e.g. `"assetId": "@@statue"` or `"fontFamily": "@@serif"`. Frames are the project's unless `fps`
 * says otherwise (then they are converted).
 */

const key = z.string().regex(/^[\w.-]{1,64}$/, 'keys are letters, digits, "_", "-" and "."')

const word = z.object({ text: z.string(), start: z.number().nonnegative(), end: z.number().nonnegative() })

/** Where a clip starts: a timeline frame, `"end"` (after everything on the storyline), or another clip of this file. */
const at = z.union([z.literal('end'), z.number().int().nonnegative(), z.object({ clip: key, offset: z.number().int().default(0) })])

const media = z.object({
  key,
  /** An absolute path on this Mac (in your home folders or the projects folder). */
  path: z.string().min(1),
  name: z.string().optional(),
  /** Audio: its role in the mix (dialogue, music, effects, …). */
  role: z.string().optional(),
  /** A voice-over's word timings (seconds from its start), for captions and keys timed to words. */
  words: z.array(word).optional(),
})

const font = z.object({ key, path: z.string().min(1) })

const board = z.object({
  /** An existing board's id with `replace: true` replaces its contents; otherwise a new board. */
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  replace: z.boolean().optional(),
  /** Board elements as the project stores them (frames, text, shapes, pictures, groups…); repaired like a saved board. */
  items: z.array(z.record(z.string(), z.unknown())),
})

const motionClip = z.object({
  type: z.literal('motion'),
  key: key.optional(),
  name: z.string().optional(),
  /** The board (id or name) and the frame on it (id or name) the clip plays. */
  board: z.string().min(1),
  frame: z.string().min(1),
  duration: z.number().int().positive(),
  /** Element tracks by element id, as stored (keys, reveal, behaviours, anchors…); repaired like a saved clip. */
  tracks: z.record(z.string(), z.unknown()).default({}),
  camera: z.array(z.unknown()).optional(),
  at: at.default('end'),
  /** Above (>0) or below (<0) the storyline; unset with `at: "end"`, on the storyline itself. */
  lane: z.number().int().optional(),
  /** An overlay over the whole timeline. */
  span: z.literal('timeline').optional(),
})

const mediaClip = z.object({
  type: z.enum(['audio', 'video', 'image']),
  key: key.optional(),
  name: z.string().optional(),
  /** `"@@key"` of a media entry, or an asset id already in the project. */
  media: z.string().min(1),
  at: at.default('end'),
  lane: z.number().int().optional(),
  /** Frames (a picture's length, or a shorter cut of a sound or video). */
  duration: z.number().int().positive().optional(),
  role: z.string().optional(),
})

const marker = z.object({ at, name: z.string().default(''), kind: z.enum(['standard', 'todo', 'chapter']).default('standard') })

/**
 * A Blender previs for a story shot (docs/blender-previs.md): the shot by id, by its label ("2.3") or by its number in
 * story order (1-based); the renders as `"@@key"` of media entries (or asset ids already in the project).
 */
const shotPrevis = z.object({
  shot: z.union([z.string().min(1), z.number().int().positive()]),
  previs: z.object({
    layout: z.string().min(1),
    depth: z.string().min(1).optional(),
    firstFrame: z.string().min(1).optional(),
    frames: z.number().int().positive().optional(),
    source: z.string().max(200).optional(),
    /** Who each coloured figure is: named when the shot's keyframe is drawn over the render. */
    figures: z.array(z.object({ color: z.string().min(1).max(30), name: z.string().min(1).max(80) })).max(12).optional(),
  }),
})

export const motionImportSchema = z.object({
  version: z.literal(1).default(1),
  fps: z.number().min(1).max(240).optional(),
  media: z.array(media).default([]),
  fonts: z.array(font).default([]),
  boards: z.array(board).default([]),
  timeline: z.array(z.discriminatedUnion('type', [motionClip, mediaClip])).default([]),
  markers: z.array(marker).default([]),
  /** Blender previs renders attached to story shots (their camera guides). */
  shots: z.array(shotPrevis).default([]),
  /** Merged into the project's brand kit (colours, fonts, logo asset ids…). */
  brand: z.record(z.string(), z.unknown()).optional(),
})

export type MotionImport = z.infer<typeof motionImportSchema>
export type MotionImportTimelineEntry = MotionImport['timeline'][number]

export interface MotionImportResult {
  revision: number
  /** Media keys → asset ids, font keys → family names. */
  assets: Record<string, string>
  fonts: Record<string, string>
  boards: string[]
  /** Timeline entry keys (or their index) → clip ids. */
  clips: Record<string, string>
  /** Ids of the story shots that got a previs. */
  shots: string[]
  warnings: string[]
}

/** Every `"@@key"` string in `value` swapped for `names[key]`; unknown keys are listed in `missing`. */
export function fillPlaceholders<T>(value: T, names: Record<string, string>, missing: Set<string>): T {
  if (typeof value === 'string') {
    const m = /^@@([\w.-]+)$/.exec(value)
    if (!m) return value
    // Own keys only: "@@constructor" is not Object's.
    const name = Object.hasOwn(names, m[1]!) ? names[m[1]!] : undefined
    if (name === undefined) missing.add(m[1]!)
    return (name ?? value) as T
  }
  if (Array.isArray(value)) return value.map((v) => fillPlaceholders(v, names, missing)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillPlaceholders(v, names, missing)])) as T
  return value
}
