import { z } from 'zod'
import { EXPLAINER_STYLE_IDS } from '../motion/explainerStyles'

/**
 * The Director's chat: the user asks, the Director answers with a plan — steps the app runs only once the user
 * approves them, each one an operation the app already runs from its own buttons (Write script, Create scenes, Write
 * shots, Stills, Animate…). The client prices every step before it is approved and runs approved steps through the
 * same code those buttons use.
 */

// ------------------------------------------------------------------------------------------------ what the Director knows

/** A shot as the Director sees it: what it shows, how long it is, and how far it is made. */
export const contextShotSchema = z.object({
  id: z.string().max(40),
  /** "1.2": scene 1, shot 2. */
  n: z.string().max(12),
  what: z.string().max(240),
  seconds: z.number().min(0).max(600),
  lines: z.number().int().min(0).max(99),
  /** none · ready · redo (the shot was rewritten since its still was drawn) · coming (being drawn). */
  still: z.enum(['none', 'ready', 'redo', 'coming']),
  /** none · draft · final · coming (being rendered). */
  take: z.enum(['none', 'draft', 'final', 'coming']),
})

export const contextSceneSchema = z.object({
  id: z.string().max(40),
  n: z.number().int().min(1).max(999),
  title: z.string().max(160),
  summary: z.string().max(400).optional(),
  place: z.string().max(120).optional(),
  time: z.string().max(80).optional(),
  light: z.string().max(240).optional(),
  shots: z.array(contextShotSchema).max(80),
})

/** The open project, compactly: what the Director plans from (built by the client from the story). */
export const directorContextSchema = z.object({
  name: z.string().max(160).optional(),
  kind: z.enum(['film', 'ad', 'social', 'edit']).optional(),
  title: z.string().max(160).optional(),
  logline: z.string().max(400).optional(),
  style: z.string().max(400).optional(),
  script: z.object({
    length: z.number().int().min(0),
    /** The start of the script (the client cuts it). */
    excerpt: z.string().max(6000),
    /** Edited since the scenes were made from it: Update scenes has work to do. */
    edited: z.boolean(),
  }),
  brandOn: z.boolean(),
  budgetUsd: z.number().min(0).optional(),
  spentUsd: z.number().min(0).optional(),
  models: z.object({
    image: z.string().max(120).optional(),
    video: z.string().max(120).optional(),
    finalVideo: z.string().max(120).optional(),
    voice: z.string().max(120).optional(),
  }),
  cast: z.array(z.object({ id: z.string().max(40), name: z.string().max(120), picture: z.boolean(), voice: z.boolean() })).max(40),
  places: z.array(z.object({ id: z.string().max(40), name: z.string().max(120), picture: z.boolean(), views: z.array(z.string().max(12)).max(4) })).max(40),
  scenes: z.array(contextSceneSchema).max(60),
  storyCut: z.boolean(),
})
export type DirectorContext = z.infer<typeof directorContextSchema>
export type ContextShot = z.infer<typeof contextShotSchema>

export const directorTurnSchema = z.object({ role: z.enum(['user', 'director']), text: z.string().max(2000) })
export type DirectorTurn = z.infer<typeof directorTurnSchema>

export const directorPlanRequestSchema = z.object({
  message: z.string().trim().min(1, 'Write a message first').max(4000),
  /** The last turns of the conversation, oldest first. */
  history: z.array(directorTurnSchema).max(12).default([]),
  project: directorContextSchema,
})
export type DirectorPlanRequest = z.input<typeof directorPlanRequestSchema>

// ------------------------------------------------------------------------------------------------ the plan

export const PLAN_OPS = [
  'write-script',
  'outline',
  'scene-shots',
  'update-scenes',
  'improve-look',
  'place-view',
  'asset-set',
  'edit-scene',
  'shot-lengths',
  'add-shot',
  'stills',
  'voices',
  'animate',
  'music',
  'sfx',
  'update-timeline',
  'create-explainer',
] as const
export type PlanOp = (typeof PLAN_OPS)[number]

const title = z.string().trim().min(1).max(200)
const id = z.string().min(1).max(40)
const ids = z.array(id).min(1).max(300)

/**
 * One step of a plan. Ids are the project's (scenes, shots, characters, places); `title` is the line the plan card
 * shows. Generation steps (stills, voices, animate, place-view, music, sfx) cost money; edits and the timeline are free;
 * the text passes (write-script, outline, scene-shots, update-scenes, improve-look, asset-set) cost a few cents of the
 * Director's own model.
 */
export const planStepSchema = z.discriminatedUnion('op', [
  /** A new screenplay from an idea, in place of the script (Write script from idea). */
  z.object({ op: z.literal('write-script'), title, idea: z.string().trim().min(1).max(4000) }),
  /** The script read into cast, places, chapters and scenes — replaces the scenes and their shots (Create scenes). */
  z.object({ op: z.literal('outline'), title }),
  /** These scenes' shots written (again) from their part of the script (Write shots). */
  z.object({ op: z.literal('scene-shots'), title, sceneIds: ids }),
  /** Only the scenes whose part of the script changed, written again (Update scenes). */
  z.object({ op: z.literal('update-scenes'), title }),
  /** A character's or a place's look rewritten (the look designer's Improve with AI); `note`: what to change. */
  z.object({ op: z.literal('improve-look'), title, kind: z.enum(['character', 'place']), id, note: z.string().max(400).optional() }),
  /** A place seen from another side, written out and drawn (the look designer's angles): approve it there. */
  z.object({ op: z.literal('place-view'), title, placeId: id, view: z.enum(['reverse', 'left', 'right']) }),
  /** A set of brand, web or social images planned on the board from a brief (Plan assets from a brief). */
  z.object({ op: z.literal('asset-set'), title, brief: z.string().trim().min(1).max(4000) }),
  /** A scene's light or time of day changed (free, undoable). */
  z.object({ op: z.literal('edit-scene'), title, sceneId: id, light: z.string().max(240).optional(), time: z.string().max(80).optional() }),
  /** Shots' lengths changed (free, undoable). */
  z.object({ op: z.literal('shot-lengths'), title, lengths: z.array(z.object({ shotId: id, seconds: z.number().min(1).max(30) })).min(1).max(300) }),
  /** One shot added to a scene, after `afterShotId` (else at its end) — free, undoable. */
  z.object({
    op: z.literal('add-shot'),
    title,
    sceneId: id,
    afterShotId: id.optional(),
    action: z.string().trim().min(1).max(600),
    shotType: z.string().max(120).optional(),
    seconds: z.number().min(1).max(30),
  }),
  /** Shots' stills (keyframes) drawn — `again`: drawn again even where there is one (Stills / Stills again). */
  z.object({ op: z.literal('stills'), title, shotIds: ids, again: z.boolean().optional() }),
  /** Shots' dialogue lines voiced with ElevenLabs. */
  z.object({ op: z.literal('voices'), title, shotIds: ids }),
  /** Video takes of shots: cheap drafts, or finals of their chosen takes (Animate / Final render). */
  z.object({ op: z.literal('animate'), title, shotIds: ids, quality: z.enum(['draft', 'final']) }),
  /** A music cue, into the Library. */
  z.object({ op: z.literal('music'), title, prompt: z.string().trim().min(1).max(600), seconds: z.number().min(5).max(180) }),
  /** A sound effect, into the Library. */
  z.object({ op: z.literal('sfx'), title, prompt: z.string().trim().min(1).max(600), seconds: z.number().min(0.5).max(30) }),
  /** The story laid out again on its Story cut timeline (Update timeline). */
  z.object({ op: z.literal('update-timeline'), title }),
  /**
   * An animated explainer from a topic or a script: scenes written, laid out as frames on a new board, their pictures
   * drawn and the voice-over recorded, then motion clips timed to the voice at the end of the timeline.
   */
  z.object({
    op: z.literal('create-explainer'),
    title,
    topic: z.string().trim().min(1).max(4000),
    seconds: z.number().min(10).max(600),
    /** The look (shared/motion/explainerStyles); unset, the plain one. */
    style: z.enum(EXPLAINER_STYLE_IDS).optional(),
  }),
])
export type PlanStep = z.infer<typeof planStepSchema>
export type PlanStepOf<O extends PlanOp> = Extract<PlanStep, { op: O }>

/** At most this many steps in one plan. */
export const PLAN_STEPS_MAX = 12

export interface DirectorPlanResponse {
  /** What the Director says: what it plans and why (never that anything is done). */
  reply: string
  steps: PlanStep[]
  via: 'anthropic' | 'openrouter' | 'fal' | 'demo'
  model: string
}

/** Steps that spend money on generations (images, video, voices, music) — the others are edits or a few cents of text. */
export const GENERATION_OPS: ReadonlySet<PlanOp> = new Set(['stills', 'voices', 'animate', 'place-view', 'music', 'sfx', 'create-explainer'])
/** Steps that call the Director's text model. */
export const TEXT_OPS: ReadonlySet<PlanOp> = new Set(['write-script', 'outline', 'scene-shots', 'update-scenes', 'improve-look', 'place-view', 'asset-set', 'create-explainer'])

// ------------------------------------------------------------------------------------------------ the conversation

/** How far one step of an approved plan has got. */
export type StepState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped' | 'stopped'

export interface StepProgress {
  state: StepState
  /** What came of it, or why it stopped ("3 of 4 stills drawn, 1 failed"). */
  note?: string
  done?: number
  total?: number
  /** Where to see the result: a scene in Plan › Shots, or a workspace. */
  show?: { sceneId?: string; step?: 'story' | 'cast' | 'scenes' | 'render'; workspace?: 'story' | 'canvas' | 'edit' }
}

/** A plan card's state: waiting for approval, running, finished, stopped, or turned down (Not now). */
export type PlanState = 'ready' | 'running' | 'done' | 'stopped' | 'declined'

export interface DirectorMessage {
  id: string
  role: 'user' | 'director'
  text: string
  at: string
  /** A Director's plan: its steps, and how far each got once approved. */
  plan?: {
    steps: PlanStep[]
    state: PlanState
    progress?: StepProgress[]
    /** The total that was approved (USD), when it could be priced. */
    approvedUsd?: number
  }
  /** A note of the Director's own (progress of a brief, an error): shown muted. */
  tone?: 'note' | 'error'
  /** A button under the message: open Settings › Providers to add a key. */
  action?: 'providers'
}

/** The conversation, in the project document (it travels with the project; not in the undo history). */
export interface DirectorDoc {
  messages: DirectorMessage[]
}

/** Only the last messages are kept. */
export const DIRECTOR_MESSAGES_MAX = 50

const STEP_STATES: readonly StepState[] = ['waiting', 'running', 'done', 'failed', 'skipped', 'stopped']
const PLAN_STATES: readonly PlanState[] = ['ready', 'running', 'done', 'stopped', 'declined']

function sanitizeProgress(raw: unknown): StepProgress | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const p = raw as Record<string, unknown>
  const state = STEP_STATES.includes(p.state as StepState) ? (p.state as StepState) : 'waiting'
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
  const show = p.show && typeof p.show === 'object' ? (p.show as StepProgress['show']) : undefined
  // A run doesn't outlive the window: a step that was running when the project closed stopped there.
  const interrupted = state === 'running'
  const note = interrupted ? 'Stopped when the project closed — renders it started went on in Activity' : typeof p.note === 'string' ? p.note.slice(0, 400) : undefined
  return {
    state: interrupted ? 'stopped' : state,
    ...(note ? { note } : {}),
    ...(num(p.done) !== undefined ? { done: num(p.done) } : {}),
    ...(num(p.total) !== undefined ? { total: num(p.total) } : {}),
    ...(show
      ? {
          show: {
            ...(typeof show.sceneId === 'string' ? { sceneId: show.sceneId } : {}),
            ...(['story', 'cast', 'scenes', 'render'].includes(show.step as string) ? { step: show.step } : {}),
            ...(['story', 'canvas', 'edit'].includes(show.workspace as string) ? { workspace: show.workspace } : {}),
          },
        }
      : {}),
  }
}

/**
 * The conversation as loaded: messages that aren't messages dropped, plans with a step the app doesn't know dropped
 * (an older or newer build), a run interrupted by closing the project marked stopped — and only the last
 * DIRECTOR_MESSAGES_MAX kept. Undefined when there is nothing to keep.
 */
export function sanitizeDirector(raw: unknown): DirectorDoc | undefined {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as DirectorDoc).messages)) return undefined
  const messages: DirectorMessage[] = []
  for (const m of (raw as DirectorDoc).messages.slice(-DIRECTOR_MESSAGES_MAX)) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || typeof m.text !== 'string') continue
    if (m.role !== 'user' && m.role !== 'director') continue
    const out: DirectorMessage = { id: m.id, role: m.role, text: m.text.slice(0, 8000), at: typeof m.at === 'string' ? m.at : '' }
    if (m.tone === 'note' || m.tone === 'error') out.tone = m.tone
    if (m.action === 'providers') out.action = m.action
    if (m.plan && typeof m.plan === 'object' && Array.isArray(m.plan.steps)) {
      const steps = m.plan.steps.map((s) => planStepSchema.safeParse(s))
      if (steps.length && steps.every((s) => s.success)) {
        const state = PLAN_STATES.includes(m.plan.state) ? m.plan.state : 'ready'
        const progress = Array.isArray(m.plan.progress) ? m.plan.progress.map(sanitizeProgress) : undefined
        out.plan = {
          steps: steps.map((s) => s.data!),
          state: state === 'running' ? 'stopped' : state,
          ...(progress && progress.length === steps.length && progress.every(Boolean) ? { progress: progress as StepProgress[] } : {}),
          ...(typeof m.plan.approvedUsd === 'number' && Number.isFinite(m.plan.approvedUsd) ? { approvedUsd: m.plan.approvedUsd } : {}),
        }
      }
    }
    messages.push(out)
  }
  return messages.length ? { messages } : undefined
}
