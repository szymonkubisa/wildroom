import { nanoid } from 'nanoid'
import { z } from 'zod'
import * as ops from '../../shared/timeline'
import { layoutTimeline } from '../../shared/timeline/layout'
import type { ClipPropsPatch, TimelineRecipe } from '../../shared/timeline/types'
import type { ProjectDoc } from '../../shared/types/project-doc'
import { badRequest } from '../http'
import type { MediaStore } from './mediaStore'

/**
 * Timeline edits by clip id, for scripts and Claude (`POST /api/projects/:id/timeline-ops`, the MCP `edit_timeline`
 * tool): the editor's own ops, applied in order to the saved document. Adding clips is the motion import's job.
 */

const frame = z.number().int().nonnegative()

export const timelineOpSchema = z.discriminatedUnion('op', [
  /** `ripple` closes the hole (and removes what is connected to a removed storyline clip); `gap` leaves a gap. */
  z.object({ op: z.literal('remove'), ids: z.array(z.string().min(1)).min(1), mode: z.enum(['ripple', 'gap']).default('ripple') }),
  /** Without `lane`, a plain move (storyline clips reorder); with it, across storyline (0) and lanes like a drag. */
  z.object({ op: z.literal('move'), id: z.string().min(1), frame, lane: z.number().int().optional() }),
  /** Moves the clip's start or end edge by `delta` frames (a storyline clip ripples what follows). */
  z.object({ op: z.literal('trim'), id: z.string().min(1), edge: z.enum(['start', 'end']), delta: z.number().int() }),
  /** Cuts the clips under `frame` (only `ids` when given). */
  z.object({ op: z.literal('blade'), frame, ids: z.array(z.string().min(1)).optional() }),
  z.object({ op: z.literal('speed'), id: z.string().min(1), speed: z.number().positive() }),
  /** Clip properties as the editor sets them: name, enabled, video/audio settings, a title's text, a motion clip's tracks… */
  z.object({ op: z.literal('set'), id: z.string().min(1), patch: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal('marker'), frame, name: z.string().default(''), kind: z.enum(['standard', 'todo', 'chapter']).default('standard') }),
  z.object({ op: z.literal('remove_marker'), id: z.string().min(1) }),
])

export const timelineOpsSchema = z.object({ ops: z.array(timelineOpSchema).min(1).max(200) })

export type TimelineOp = z.infer<typeof timelineOpSchema>

const PATCH_KEYS = new Set<keyof ClipPropsPatch>(['name', 'enabled', 'video', 'audio', 'template', 'text', 'subtitle', 'style', 'animation', 'tracks', 'camera', 'span'])

function recipeFor(op: TimelineOp): TimelineRecipe {
  switch (op.op) {
    case 'remove':
      return op.mode === 'gap' ? ops.replaceWithGap(op.ids) : ops.rippleDelete(op.ids)
    case 'move':
      return op.lane === undefined ? ops.move(op.id, op.frame) : ops.moveAcross(op.id, op.frame, op.lane)
    case 'trim':
      return ops.trimEdge(op.id, op.edge, op.delta)
    case 'blade':
      return ops.bladeAt(op.frame, op.ids)
    case 'speed':
      return ops.setSpeed(op.id, op.speed)
    case 'set': {
      const unknown = Object.keys(op.patch).filter((k) => !PATCH_KEYS.has(k as keyof ClipPropsPatch))
      if (unknown.length) throw badRequest(`"set" can't change ${unknown.join(', ')}`)
      return ops.setProps(op.id, op.patch as ClipPropsPatch)
    }
    case 'marker':
      return ops.addMarker(op.frame, op.kind, op.name)
    case 'remove_marker':
      return ops.removeMarker(op.id)
  }
}

/** The ids an op works on, which must be on the timeline before it runs. */
function idsOf(op: TimelineOp): string[] {
  if (op.op === 'remove') return op.ids
  if (op.op === 'blade') return op.ids ?? []
  if (op.op === 'marker') return []
  return [op.id]
}

/** The document with `list` applied in order; an op naming a clip that isn't there stops it (400) before anything is saved. */
export function applyTimelineOps(doc: ProjectDoc, list: readonly TimelineOp[], media: Pick<MediaStore, 'getDTO'>, projectId: string): ProjectDoc {
  const ctx = {
    newId: () => nanoid(10),
    media: (id: string) => {
      const a = media.getDTO(id)
      if (!a || a.kind === 'font' || !a.projectIds.includes(projectId)) return undefined
      return { kind: a.kind, durationFlicks: a.durationFlicks, hasVideo: a.hasVideo, hasAudio: a.hasAudio, fps: a.fps }
    },
  }
  let current = doc
  list.forEach((op, i) => {
    const byId = layoutTimeline(current).byId
    const missing = idsOf(op).filter((id) => !byId.has(id))
    if (missing.length) throw badRequest(`Op ${i + 1} (${op.op}): nothing on the timeline has the id ${missing.join(', ')}`)
    current = ops.applyOp(current, recipeFor(op), ctx).doc
  })
  return current
}
