/**
 * The Composer's "Auto" model: which job preset fits what is attached — a start frame (animate a still), a start and
 * an end frame (move between them), a clip (extend it), reference images (edit with them) — and, for Draft, the cheap
 * draft presets first. The preset's best ready model is the pick (resolvePreset); without a preset, the caller's usual
 * model for the kind. Pure: readiness and the fallback come in from the app.
 */
import { allModels } from '../models/registry'
import type { ModelSpec, ParamValues } from '../models/types'
import type { GenKind } from '../types/jobs'
import { PRESETS } from './catalog'
import { resolvePreset } from './resolve'
import type { GenPreset, PresetInput } from './types'

export type Quality = 'draft' | 'final'

/** What the form has attached, by role. */
export interface Attached {
  start?: boolean
  end?: boolean
  clip?: boolean
  /** Reference images. */
  refs?: number
}

/** The roles in a form's values (firstFrame → start, lastFrame → end, video → clip, referenceImages → refs). */
export function attachedOf(values: ParamValues): Attached {
  const one = (v: unknown) => typeof v === 'string' && v.length > 0
  const refs = Array.isArray(values.referenceImages) ? values.referenceImages.filter(one).length : 0
  return {
    ...(one(values.firstFrame) ? { start: true } : {}),
    ...(one(values.lastFrame) ? { end: true } : {}),
    ...(one(values.video) ? { clip: true } : {}),
    ...(refs ? { refs } : {}),
  }
}

export interface AutoChoice {
  model: ModelSpec
  /** The preset it came from (its settings go on the model), if any. */
  preset?: GenPreset
  /** The preset's values for this model. */
  params: ParamValues
  /** One line on why: what is attached, and what that asks for. */
  reason: string
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const presetById = (id: string) => PRESETS.find((p) => p.id === id)

/** The job the attachments ask for, with why: undefined when nothing attached decides it. */
export function attachedJob(kind: GenKind, attached: Attached): { presetId: string; reason: string } | undefined {
  if (kind === 'video') {
    if (attached.start && attached.end) return { presetId: 'start-end', reason: 'Start and end frame — the model makes the move between them' }
    if (attached.start) return { presetId: 'animate-still', reason: 'A start frame is attached — the still gets animated' }
    if (attached.clip) return { presetId: 'extend-clip', reason: 'A clip is attached — it gets extended' }
  }
  if (kind === 'image' && attached.refs) {
    return { presetId: 'edit-image', reason: `${plural(attached.refs, 'reference')} attached — editing with them keeps faces and places the same` }
  }
  return undefined
}

export interface AutoOptions {
  kind: GenKind
  attached: Attached
  quality: Quality
  /** The model can run now (its provider is connected, demo models only in demo mode). */
  isReady: (model: ModelSpec) => boolean
  /** Demo mode is on: a free demo model that takes the inputs comes first. */
  demo?: boolean
  /** The kind's usual model when no preset decides (last used, or the first ready one). */
  fallback: (kind: GenKind, needs: PresetInput[]) => ModelSpec | undefined
}

/**
 * Auto's pick. Draft: the kind's draft preset limited to models that take the attached inputs, else the job's own
 * preset. Final: the job's preset. A preset with no ready model gives way to the fallback (a ready model beats a
 * better one that needs a key); with nothing attached in Final, the fallback is the pick.
 */
export function chooseAuto(opts: AutoOptions): AutoChoice | undefined {
  const { kind, attached, quality, isReady } = opts
  const job = attachedJob(kind, attached)
  const needs = (job ? presetById(job.presetId)?.needs : undefined) ?? []
  const takes = (m: ModelSpec) => needs.every((k) => m.params.some((p) => p.key === k))

  if (opts.demo) {
    const demo = allModels().find((m) => m.kind === kind && m.demoOnly && isReady(m) && takes(m))
    if (demo) return { model: demo, params: {}, reason: 'Demo mode — free, made on this Mac' }
  }

  const tries: { preset: GenPreset; reason: string }[] = []
  const draftId = kind === 'image' ? 'image-draft' : kind === 'video' ? 'video-draft' : undefined
  const draft = quality === 'draft' && draftId ? presetById(draftId) : undefined
  if (draft) {
    // The draft preset's cheap models, only those that take what is attached.
    tries.push({ preset: { ...draft, needs }, reason: job ? `Draft · ${lower(job.reason)}` : 'Draft — cheap and quick, before the final' })
  }
  const jobPreset = job && presetById(job.presetId)
  if (jobPreset) tries.push({ preset: jobPreset, reason: job.reason })

  for (const t of tries) {
    const resolved = resolvePreset(t.preset, isReady)
    if (resolved?.ready) return { model: resolved.model, preset: t.preset, params: resolved.params, reason: t.reason }
  }
  const usual = opts.fallback(kind, needs)
  if (usual) {
    const reason = job ? `${job.reason} (no model for it is connected — your usual one)` : nothing(kind)
    return { model: usual, params: {}, reason }
  }
  // Nothing is ready: the best of the job's models, so the picker can ask for its key.
  for (const t of tries) {
    const resolved = resolvePreset(t.preset, isReady)
    if (resolved) return { model: resolved.model, preset: t.preset, params: resolved.params, reason: t.reason }
  }
  return undefined
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

/** Why the usual model, when nothing is attached. */
function nothing(kind: GenKind): string {
  switch (kind) {
    case 'video':
      return 'No frames attached — text to video with your usual model'
    case 'image':
      return 'Nothing attached — text to image with your usual model'
    default:
      return 'Your usual model for this'
  }
}
