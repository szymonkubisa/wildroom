import { type PlanStep, type PlanStepOf, type StepProgress, TEXT_OPS } from '@shared/director/plan'
import { RUNPOD_WARMUP_SECONDS, runpodWarmupUsd } from '@shared/models/catalog/runpod'
import { formatDuration } from '@shared/models/catalog/local'
import { defaultValues, parseParams } from '@shared/models/params'
import { allModels } from '@shared/models/registry'
import type { ModelSpec, ParamValues } from '@shared/models/types'
import { diffScript } from '@shared/story/scriptDiff'
import { insertShot, sceneNumber, shotsOfScene } from '@shared/story/structure'
import type { StoryMultishot, StoryShot } from '@shared/types/story'
import { nanoid } from 'nanoid'
import { toRaw } from 'vue'
import { batchTimes, overBudgetBy } from '@/features/story/budget'
import { joinLook, lookDetails } from '@/features/story/design'
import { directorUsd } from '@/features/story/directorCost'
import { openPlanScene, openPlanStep } from '@/features/story/planStep'
import { type Planned, directorApi, isDead, useStory } from '@/features/story/useStory'
import { createBatchPlanners, okToReplaceStoryCut } from '@/features/story/useStoryBatch'
import { textModelName, useTextModels } from '@/features/director/textModels'
import { createExplainerTools } from './explainer'
import { errorMessage } from '@/lib/api'
import { formatUsd } from '@/lib/format'
import { useCanvasStore } from '@/stores/canvas'
import { useEditorStore } from '@/stores/editor'
import { useGpuStore } from '@/stores/gpu'
import { useJobsStore } from '@/stores/jobs'
import { useProjectStore } from '@/stores/project'
import { useSettingsStore } from '@/stores/settings'

/**
 * The Director's steps as the app's own buttons run them: each step priced the way its button prices it (the batch
 * planners, the models' own estimates, the Director's text calls) and run through the same code — Write script,
 * Create scenes, Write shots, Update scenes, Stills, Animate scene, Final render, Update timeline. Nothing here runs
 * anything paid unless `runStep` is called, which happens only for an approved plan.
 */

type Plan = Planned | string

/** What one step would cost and take, now. */
export interface StepQuote {
  /** USD; null: a generation that can't be priced (it depends on the provider's plan); undefined: the Director's few cents, unpriced. */
  usd: number | null | undefined
  free: boolean
  /** Wall-clock seconds, roughly. */
  seconds: number
  /** "11 × Demo Image", "Director · Claude Opus 5.5", "Free". */
  detail: string
  /** Generations (or Director calls) it starts. */
  count: number
  /** Why some of it can't run ("Pick a voice for Anna"). */
  problems: string[]
  /** What it replaces or overwrites (approving it agrees to that; Undo brings it back). */
  warn?: string
  /** It renders on the RunPod GPU (which starts first when off). */
  runpod: boolean
  /** Nothing to do — and why ("Every shot already has a still"). */
  nothing?: string
}

export interface PlanQuote {
  steps: StepQuote[]
  /** What runs now: USD, or null when a generation can't be priced. */
  usd: number | null
  /** Some Director text calls aren't priced (Anthropic's route, or the catalogue not loaded): a few cents more. */
  unpricedText: boolean
  seconds: number
  /** The RunPod GPU starts once first. */
  gpuStart?: { usd: number; seconds: number }
  /** Finals of the takes the user picks, later (not in the total). */
  later?: { usd: number | null; label: string }
  /** How far it goes past the story's budget. */
  over?: number
  /** Nothing in the plan has anything to do. */
  empty: boolean
}

/** Rough seconds of a Director text pass (they run in parallel where there are several). */
const TEXT_SECONDS: Partial<Record<PlanStep['op'], number>> = {
  'write-script': 45,
  outline: 60,
  'scene-shots': 60,
  'update-scenes': 60,
  'improve-look': 15,
  'place-view': 15,
  'create-explainer': 40,
}

/** A step is waiting for its renders this long at most (then it stops and points at Activity). */
const VIDEO_LIMIT_MS = 45 * 60_000
const STILL_LIMIT_MS = 20 * 60_000
/** Nothing in flight for this long and the step counts as settled (covers a render that couldn't start, or a staged one skipped). */
const QUIET_MS = 12_000

export interface RunContext {
  /** Live progress of the running step (shown on its card). */
  progress: (p: Omit<StepProgress, 'state'>) => void
  /** The user pressed Stop: finish waiting and stop after this step. */
  stopped: () => boolean
  /** Agreed when the plan was approved: replace a Story cut edited by hand. */
  replaceCut: boolean
}

export function createDirectorTools() {
  const s = useStory()
  const planners = createBatchPlanners(s)
  const project = useProjectStore()
  const jobs = useJobsStore()
  const settings = useSettingsStore()
  const gpu = useGpuStore()
  const text = useTextModels()
  const explainer = createExplainerTools(s)

  const story = () => s.story.value
  const shotsOf = (ids: readonly string[]) => ids.map((id) => story().shots.find((x) => x.id === id)).filter((x): x is StoryShot => Boolean(x))
  const valid = (plans: Plan[]) => plans.filter((p): p is Planned => typeof p !== 'string')
  const problemsOf = (plans: Plan[]) => [...new Set(plans.filter((p): p is string => typeof p === 'string'))]
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const demo = () => text.status.value?.via === 'demo'

  // ------------------------------------------------------------------------------------------------ what each step plans

  /** The stills the shots need (or all of them again), as a scene's Stills button plans them — without the lines. */
  function stillPlans(step: PlanStepOf<'stills'>): Plan[] {
    return planners.planPrepare(shotsOf(step.shotIds), { again: step.again }).filter((p) => typeof p === 'string' || p.model.kind === 'image')
  }

  /** ElevenLabs lines the shots need: where their model doesn't speak them, or LTX makes the shot to them. */
  function linePlans(step: PlanStepOf<'voices'>): Plan[] {
    return shotsOf(step.shotIds).flatMap((shot) =>
      planners.voicedByElevenLabs(shot) ? s.planLines({ ...shot, dialogue: shot.dialogue.filter((l) => planners.nothingComing([l.generationId])) }) : [],
    )
  }

  /** Scenes all of whose shots the step animates: those run as Animate scene does (in order, continuing shots after). */
  function wholeScenes(shots: StoryShot[]): string[] {
    const ids = new Set(shots.map((x) => x.id))
    const scenes = [...new Set(shots.flatMap((x) => (x.sceneId ? [x.sceneId] : [])))]
    return scenes.filter((id) => shotsOfScene(story(), id).every((x) => ids.has(x.id)))
  }

  /** Draft takes: whole scenes as Animate scene plans them, other shots as their own Animate. */
  function draftPlans(step: PlanStepOf<'animate'>): { plans: Plan[]; scenes: string[]; rest: StoryShot[] } {
    const shots = shotsOf(step.shotIds)
    const scenes = wholeScenes(shots)
    const rest = shots.filter((x) => !x.sceneId || !scenes.includes(x.sceneId))
    return { plans: [...scenes.flatMap((id) => s.planSceneAnimation(id).plans), ...(rest.length ? planners.planAnimate(rest) : [])], scenes, rest }
  }

  /** Finals of the chosen takes of these shots (a clip group's once), as Finals for chosen takes plans them. */
  function finalPlans(step: PlanStepOf<'animate'>): Plan[] {
    if (!s.finalModel()) return ['Pick a final model first (Plan › Models)']
    const plans: Plan[] = []
    const seen = new Set<string>()
    for (const shot of shotsOf(step.shotIds)) {
      const group = s.clipGroupOf(shot)
      if (group) {
        if (seen.has(group.id)) continue
        seen.add(group.id)
        const take = s.chosenGroupVideo(group)
        if (!take) plans.push(`Shot ${s.shotName(shot)} has no take to finish yet`)
        else if (!s.isFinalAsset(take)) plans.push(s.planGroupFinal(group))
      } else {
        const take = s.chosenVideoOf(shot)
        if (!take) plans.push(`Shot ${s.shotName(shot)} has no take to finish yet`)
        else if (!s.isFinalAsset(take)) plans.push(s.planShotFinal(shot))
      }
    }
    return plans
  }

  /** The model a music cue or a sound effect is made with: as the Composer picks it (this Mac's first, then the last used). */
  function audioModel(kind: 'music' | 'sfx'): ModelSpec | undefined {
    const ready = allModels().filter((m) => m.kind === kind && (!m.demoOnly || settings.app?.demoMode) && settings.modelReady(m))
    const local = ready.find((m) => m.provider === 'local')
    if (local) return local
    let saved: string | null = null
    try {
      saved = localStorage.getItem(`gen.model.${kind}`)
    } catch {
      // No storage: the first ready model.
    }
    return ready.find((m) => m.id === saved) ?? ready[0]
  }

  function audioPlan(step: PlanStepOf<'music' | 'sfx'>): { model: ModelSpec; params: ParamValues } | string {
    const model = audioModel(step.op)
    if (!model) return step.op === 'music' ? 'No music model is ready — add an ElevenLabs key or turn on demo mode' : 'No sound-effect model is ready — add an ElevenLabs key or turn on demo mode'
    const values: ParamValues = { ...defaultValues(model) }
    const prompt = model.params.find((p) => p.ui.control === 'prompt')
    if (prompt) values[prompt.key] = step.prompt
    const length = model.params.find((p) => /duration/i.test(p.key) && p.key !== 'autoDuration')
    if (length) values[length.key] = step.seconds
    if (model.params.some((p) => p.key === 'autoDuration')) values.autoDuration = false
    const parsed = parseParams(toRaw(model), values)
    return parsed.ok ? { model, params: parsed.values } : parsed.message
  }

  function placeViewPlan(step: PlanStepOf<'place-view'>): Plan {
    const place = story().places?.find((p) => p.id === step.placeId)
    if (!place) return 'The place was deleted'
    return s.planDesign('place', place.id, { angle: step.view, from: place.refAssetIds?.[0] })
  }

  // ------------------------------------------------------------------------------------------------ pricing

  const secondsOf = (plans: Planned[]) => {
    const t = batchTimes(plans.map((p) => ({ provider: p.model.provider, seconds: p.model.estimateSeconds?.(p.params) })))
    // A job without an estimate: about a minute, alongside the others.
    return (t.mac ?? 0) + Math.max(t.cloud ?? 0, t.unknown ? 60 : 0)
  }

  function generationQuote(plans: Plan[], what: string, extra: Partial<StepQuote> = {}): StepQuote {
    const ok = valid(plans)
    const byModel = new Map<string, { label: string; n: number }>()
    for (const p of ok) byModel.set(p.model.id, { label: p.model.label, n: (byModel.get(p.model.id)?.n ?? 0) + 1 })
    return {
      usd: ok.length ? s.estimate(ok) : 0,
      free: false,
      seconds: secondsOf(ok),
      detail: [...byModel.values()].map((m) => `${m.n} × ${m.label}`).join(' + ') || what,
      count: ok.length,
      problems: problemsOf(plans),
      runpod: ok.some((p) => p.model.provider === 'runpod'),
      ...extra,
    }
  }

  function textQuote(requests: object[], extra: Partial<StepQuote> = {}, op: PlanStep['op'] = 'outline'): StepQuote {
    const model = text.models.value.find((m) => m.id === text.status.value?.model)
    const usd = demo() ? 0 : directorUsd(requests, model)
    const name = demo() ? 'Demo rules (no AI)' : `Director · ${textModelName(text.status.value?.model, text.models.value)}`
    return {
      usd,
      free: demo(),
      seconds: demo() ? 2 : (TEXT_SECONDS[op] ?? 30),
      detail: name,
      count: requests.length,
      problems: text.status.value?.via === 'none' ? [text.status.value.reason ?? 'The Director needs an Anthropic, OpenRouter or fal.ai key (Settings → Providers)'] : [],
      runpod: false,
      ...extra,
    }
  }

  const freeQuote = (extra: Partial<StepQuote> = {}): StepQuote => ({ usd: 0, free: true, seconds: 0, detail: 'Free · Undo takes it back', count: 0, problems: [], runpod: false, ...extra })

  function quoteStep(step: PlanStep): StepQuote {
    const st = story()
    switch (step.op) {
      case 'write-script':
        return textQuote([{ idea: step.idea }], st.script.trim() ? { warn: 'Replaces the script in Plan › Script (Undo brings it back)' } : {}, step.op)
      case 'outline': {
        const scenes = st.scenes?.length ?? 0
        return textQuote(
          [{ script: st.script }],
          scenes ? { warn: `Replaces the ${plural(scenes, 'scene')} and ${plural(st.shots.length, 'shot')}; their stills and takes stay in the Library (Undo brings them back)` } : {},
          step.op,
        )
      }
      case 'scene-shots': {
        const requests = step.sceneIds.flatMap((id) => s.sceneShotsRequest(id) ?? [])
        const made = step.sceneIds.reduce((n, id) => n + s.sceneWork(id).shots, 0)
        return textQuote(requests, { ...(made ? { warn: `Writes ${plural(made, 'shot')} again (Undo brings them back)` } : {}), ...(requests.length ? {} : { nothing: 'Those scenes are gone' }) }, step.op)
      }
      case 'update-scenes': {
        const diff = diffScript(st.script, st.scenes ?? [])
        const changed = diff.changed.filter((c) => st.scenes?.some((x) => x.id === c.sceneId))
        const requests = changed.flatMap((c) => s.updateRequest(c) ?? [])
        return textQuote(requests, diff.problem ? { problems: [`${diff.problem} — rebuild all scenes instead`] } : requests.length ? {} : { nothing: 'No scene’s part of the script changed' }, step.op)
      }
      case 'improve-look': {
        const subject = step.kind === 'character' ? st.characters.find((c) => c.id === step.id) : st.places?.find((p) => p.id === step.id)
        return textQuote([{ description: subject?.description ?? '' }], subject ? {} : { nothing: 'It was deleted' }, step.op)
      }
      case 'place-view': {
        const place = st.places?.find((p) => p.id === step.placeId)
        const words = textQuote([{ description: place?.description ?? '' }], {}, step.op)
        const draw = generationQuote([placeViewPlan(step)], 'Picture')
        return {
          ...draw,
          usd: draw.usd == null ? draw.usd : draw.usd + (words.usd ?? 0),
          seconds: words.seconds + draw.seconds,
          detail: `${words.detail} + ${draw.detail}`,
          problems: [...words.problems, ...draw.problems],
        }
      }
      case 'asset-set':
        return freeQuote({ detail: 'Opens on the board — you plan and generate the images there' })
      case 'edit-scene':
      case 'shot-lengths':
      case 'add-shot':
        return freeQuote()
      case 'stills': {
        const plans = stillPlans(step)
        const q = generationQuote(plans, 'Stills')
        // The opening still first, the others from it: about twice one still's time.
        return { ...q, seconds: q.count > 1 ? q.seconds * 2 : q.seconds, ...(q.count || q.problems.length ? {} : { nothing: 'Every one of these shots has its still (or one on its way)' }) }
      }
      case 'voices': {
        const q = generationQuote(linePlans(step), 'Lines')
        return q.count || q.problems.length ? q : { ...q, nothing: 'No line to record: they’re recorded, or the video model speaks them itself' }
      }
      case 'animate': {
        const plans = step.quality === 'final' ? finalPlans(step) : draftPlans(step).plans
        const q = generationQuote(plans, 'Takes')
        return q.count || q.problems.length ? q : { ...q, nothing: step.quality === 'final' ? 'Their chosen takes are finals already' : 'Every one of these shots has a take (or one on its way)' }
      }
      case 'music':
      case 'sfx': {
        const plan = audioPlan(step)
        if (typeof plan === 'string') return { ...freeQuote(), free: false, usd: 0, detail: '—', problems: [plan] }
        const usd = plan.model.estimateCost(plan.params).usd
        return { usd, free: false, seconds: plan.model.estimateSeconds?.(plan.params) ?? 30, detail: `${plan.model.label} · ${step.seconds} s`, count: 1, problems: [], runpod: plan.model.provider === 'runpod' }
      }
      case 'update-timeline':
        return freeQuote({
          detail: 'Free · the Story cut timeline',
          ...(s.storyCutEdited() ? { warn: 'Replaces the hand edits on the Story cut (Undo brings them back)' } : {}),
        })
      case 'create-explainer':
        return explainer.quote(step, textQuote([{ topic: step.topic }], {}, step.op))
    }
  }

  /**
   * "Later": the finals of the takes a plan's drafts make, with the final model — what the user would pay once they
   * have picked their takes (not part of the plan's total).
   */
  function laterFinals(steps: PlanStep[]): PlanQuote['later'] {
    const final = s.finalModel()
    const drafts = steps.filter((x): x is PlanStepOf<'animate'> => x.op === 'animate' && x.quality === 'draft')
    if (!final || !drafts.length) return undefined
    const plans: Plan[] = []
    const seen = new Set<string>()
    for (const shot of shotsOf(drafts.flatMap((x) => x.shotIds))) {
      const group: StoryMultishot | undefined = s.clipGroupOf(shot)
      if (group) {
        if (seen.has(group.id)) continue
        seen.add(group.id)
        const model = s.finalModelForGroup(group)
        if (model) plans.push(s.planMultishot(group, { model, final: true }))
      } else if (!seen.has(shot.id)) {
        seen.add(shot.id)
        const model = s.finalModelForShot(shot)
        if (model) plans.push(s.planVideo(shot, { model, final: true }))
      }
    }
    const ok = valid(plans)
    if (!ok.length) return undefined
    // Each final renders with the final model when it is of the take's family, else with the take's own model.
    return { usd: s.estimate(ok), label: `Later: finals of the takes you pick · ${[...new Set(ok.map((p) => p.model.label))].join(', ')}` }
  }

  /** The whole plan, priced now: each step, the total of what runs now, the time, the GPU's start, finals for later, the budget. */
  function quote(steps: PlanStep[], spentUsd = 0): PlanQuote {
    const quoted = steps.map(quoteStep)
    let usd: number | null = 0
    let unpricedText = false
    for (const [i, q] of quoted.entries()) {
      if (q.usd === undefined) unpricedText ||= TEXT_OPS.has(steps[i]!.op)
      else if (q.usd === null) usd = null
      else if (usd !== null) usd += q.usd
    }
    const gpuStart = quoted.some((q) => q.runpod && q.count) && !gpu.running ? { usd: runpodWarmupUsd(), seconds: RUNPOD_WARMUP_SECONDS } : undefined
    if (gpuStart && usd !== null) usd += gpuStart.usd
    const seconds = quoted.reduce((n, q) => n + (q.nothing ? 0 : q.seconds), 0) + (gpuStart?.seconds ?? 0)
    const later = laterFinals(steps)
    const over = overBudgetBy(spentUsd, usd, story().budgetUsd)
    return {
      steps: quoted,
      usd,
      unpricedText,
      seconds,
      ...(gpuStart ? { gpuStart } : {}),
      ...(later ? { later } : {}),
      ...(over ? { over } : {}),
      empty: quoted.every((q) => q.nothing),
    }
  }

  // ------------------------------------------------------------------------------------------------ running

  const inFlightId = (id: string) => {
    const job = jobs.byId[id]
    return Boolean(job && !jobs.isTerminal(job))
  }
  const deadId = (id: string) => isDead(s.jobState(id))

  interface Unit {
    key: string
    id?: string
  }

  /**
   * Waits for the renders a step started: `units` are where their generation ids land (a shot's keyframe, its latest
   * take, a line…), compared with `before`. Settled once `expected` new ones are finished, or once nothing is in flight
   * (`busy` too) for QUIET_MS — a render that couldn't start, or a staged still that came another way. Stops waiting
   * at `limitMs`, on Stop, and when the project closes.
   */
  function follow(
    before: Map<string, string | undefined>,
    units: () => Unit[],
    opts: { expected: number; busy?: () => boolean; limitMs: number; ctx: RunContext; noun: (n: number) => string },
  ): Promise<{ done: number; failed: number; timedOut: boolean; left: boolean }> {
    const pid = project.id
    const started = Date.now()
    let quietSince = Date.now()
    return new Promise((resolve) => {
      const tick = () => {
        const changed = units().filter((u) => u.id && u.id !== before.get(u.key))
        const settled = changed.filter((u) => !inFlightId(u.id!))
        const failed = settled.filter((u) => deadId(u.id!)).length
        const moving = changed.length > settled.length || Boolean(opts.busy?.())
        if (moving) quietSince = Date.now()
        const total = Math.max(opts.expected, changed.length)
        opts.ctx.progress({ done: settled.length, total, note: `${settled.length - failed} of ${opts.noun(total)}${failed ? ` · ${failed} failed` : ''}` })
        const left = project.id !== pid
        const timedOut = Date.now() - started > opts.limitMs
        if (settled.length >= opts.expected || (!moving && Date.now() - quietSince > QUIET_MS) || opts.ctx.stopped() || timedOut || left) {
          clearInterval(timer)
          resolve({ done: settled.length - failed, failed, timedOut: timedOut && settled.length < opts.expected, left })
        }
      }
      const timer = setInterval(tick, 1000)
      tick()
    })
  }

  const snapshot = (units: Unit[]) => new Map(units.map((u) => [u.key, u.id]))

  /** The scene to show for these shots (the first one's). */
  const sceneOfShots = (ids: readonly string[]) => shotsOf(ids).find((x) => x.sceneId)?.sceneId

  /** A step's result from how its renders went. */
  function settledResult(r: Awaited<ReturnType<typeof follow>>, noun: (n: number) => string, show: StepProgress['show']): StepProgress {
    if (r.left) return { state: 'stopped', note: 'The project closed — renders that started went on in Activity' }
    if (r.timedOut) return { state: 'stopped', note: 'Still rendering — follow it in Activity, then ask again for what’s next', show }
    if (!r.done && r.failed) return { state: 'failed', note: `${r.failed === 1 ? 'It' : `All ${r.failed}`} failed — see Activity`, show }
    if (!r.done) return { state: 'failed', note: 'Nothing started — see the notes on the card', show }
    return { state: 'done', note: `${noun(r.done)} made${r.failed ? ` · ${r.failed} failed (see Activity)` : ''}`, show }
  }

  /**
   * Fresh plans for a generation step, checked against what was approved: more than about a fifth over the approved
   * price (plus a few cents), and it stops for the user to ask again.
   */
  function overApproved(plans: Plan[], approved: StepQuote | undefined): string | undefined {
    const usd = s.estimate(valid(plans))
    if (approved?.usd == null || usd == null) return undefined
    return usd > approved.usd * 1.2 + 0.05 ? `It now costs ${formatUsd(usd)}, more than the ${formatUsd(approved.usd)} approved — ask again to re-plan it` : undefined
  }

  const shotUnits = (ids: readonly string[], what: 'still' | 'take' | 'final'): Unit[] =>
    shotsOf(ids).flatMap((x) => {
      if (what === 'still') return [{ key: `k:${x.id}`, id: x.keyframeGenerationId }, { key: `e:${x.id}`, id: x.endKeyframeGenerationId }]
      const group = s.groupOf(x)
      if (what === 'final') return [{ key: `f:${x.id}`, id: x.finalGenerationId }, ...(group ? [{ key: `gf:${group.id}`, id: group.finalGenerationId }] : [])]
      return [{ key: `t:${x.id}`, id: x.videoGenerationIds.at(-1) }, ...(group ? [{ key: `g:${group.id}`, id: group.videoGenerationIds.at(-1) }] : [])]
    })

  /** Runs one approved step through the app's own code and waits for what it started; returns how it went. */
  async function runStep(step: PlanStep, approved: StepQuote | undefined, ctx: RunContext): Promise<StepProgress> {
    try {
      return await runOne(step, approved, ctx)
    } catch (err) {
      return { state: 'failed', note: errorMessage(err) }
    }
  }

  async function runOne(step: PlanStep, approved: StepQuote | undefined, ctx: RunContext): Promise<StepProgress> {
    const st = story()
    switch (step.op) {
      case 'write-script': {
        ctx.progress({ note: 'Writing the script…' })
        const res = await s.writeScript(step.idea)
        return { state: 'done', note: `${res.title && res.title !== 'Untitled' ? `“${res.title}” · ` : ''}${res.script.length} characters · ${res.via === 'demo' ? 'demo rules' : `by ${textModelName(res.model, text.models.value)}`}`, show: { step: 'story' } }
      }
      case 'outline': {
        if (!st.script.trim()) return { state: 'failed', note: 'There is no script to outline' }
        ctx.progress({ note: 'Reading the script into scenes…' })
        const res = await s.outlineStory()
        const scenes = res.outline.chapters.reduce((n, c) => n + c.scenes.length, 0)
        return {
          state: 'done',
          note: `${plural(scenes, 'scene')} · ${plural(res.outline.characters.length, 'character')} · ${plural(res.outline.places.length, 'place')}`,
          show: { step: 'story' },
        }
      }
      case 'scene-shots': {
        const ids = step.sceneIds.filter((id) => st.scenes?.some((x) => x.id === id))
        if (!ids.length) return { state: 'skipped', note: 'Those scenes are gone' }
        ctx.progress({ note: `Writing the shots of ${plural(ids.length, 'scene')}…`, done: 0, total: ids.length })
        let done = 0
        const results = await Promise.allSettled(
          ids.map((id) =>
            s.writeShotsForScene(id).then((n) => {
              ctx.progress({ note: `${++done} of ${plural(ids.length, 'scene')} written`, done, total: ids.length })
              return n
            }),
          ),
        )
        const shots = results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value : 0), 0)
        const failed = results.filter((r) => r.status === 'rejected')
        if (failed.length === results.length) return { state: 'failed', note: errorMessage((failed[0] as PromiseRejectedResult).reason) }
        return { state: 'done', note: `${plural(shots, 'shot')} written${failed.length ? ` · ${failed.length} scene${failed.length === 1 ? '' : 's'} failed` : ''}`, show: { sceneId: ids[0] } }
      }
      case 'update-scenes': {
        const diff = diffScript(st.script, st.scenes ?? [])
        if (diff.problem) return { state: 'failed', note: `${diff.problem} — rebuild all scenes instead (Plan › Script)` }
        const changed = diff.changed.filter((c) => st.scenes?.some((x) => x.id === c.sceneId))
        if (!changed.length) return { state: 'skipped', note: 'No scene’s part of the script changed' }
        ctx.progress({ note: `Rewriting ${plural(changed.length, 'scene')}…` })
        const res = await s.updateScenes(changed)
        if (!res.scenes) return { state: 'failed', note: res.error ?? 'The scenes couldn’t be written' }
        return { state: 'done', note: `${plural(res.scenes, 'scene')}: ${res.rewritten} rewritten, ${res.kept} kept${res.added ? `, ${res.added} new` : ''}${res.failed ? ` · ${res.failed} failed` : ''}`, show: { sceneId: changed[0]!.sceneId } }
      }
      case 'improve-look': {
        const subject = step.kind === 'character' ? st.characters.find((c) => c.id === step.id) : st.places?.find((p) => p.id === step.id)
        if (!subject) return { state: 'skipped', note: 'It was deleted' }
        ctx.progress({ note: `Rewriting ${subject.name}’s look…` })
        const res = await directorApi.improveLook({
          kind: step.kind,
          name: subject.name,
          description: step.note ? `${subject.description}\n\nWhat to change: ${step.note}` : subject.description,
          style: st.style,
          script: st.script,
        })
        const picks = subject.picks ?? {}
        s.update('Improve look', (d) => {
          const x = step.kind === 'character' ? d.characters.find((c) => c.id === step.id) : d.places?.find((p) => p.id === step.id)
          if (x) x.description = joinLook(step.kind, picks, lookDetails(step.kind, picks, res.description))
        })
        return { state: 'done', note: `${subject.name}’s look rewritten — draw its pictures in Cast & Places`, show: { step: 'cast' } }
      }
      case 'place-view': {
        const place = st.places?.find((p) => p.id === step.placeId)
        if (!place) return { state: 'skipped', note: 'The place was deleted' }
        const first = placeViewPlan(step)
        if (typeof first === 'string') return { state: 'failed', note: first }
        ctx.progress({ note: `Writing the ${step.view} view of ${place.name}…` })
        const written = await directorApi.placeView({ name: place.name, description: place.description, light: place.light, view: step.view, style: st.style })
        const plan = s.planDesign('place', place.id, { angle: step.view, from: place.refAssetIds?.[0], view: written.description })
        if (typeof plan === 'string') return { state: 'failed', note: plan }
        const units = () => [{ key: 'd', id: story().places?.find((p) => p.id === place.id)?.designTakes?.at(-1)?.generationId }]
        const before = snapshot(units())
        if (!(await s.run([plan]))) return { state: 'failed', note: 'The picture didn’t start' }
        const r = await follow(before, units, { expected: 1, limitMs: STILL_LIMIT_MS, ctx, noun: (n) => plural(n, 'picture') })
        const out = settledResult(r, (n) => plural(n, 'picture'), { step: 'cast' })
        return out.state === 'done' ? { ...out, note: `The ${step.view} view of ${place.name} is drawn — approve it in its look designer (Cast & Places)` } : out
      }
      case 'asset-set': {
        const canvas = useCanvasStore()
        canvas.briefDraft = step.brief
        canvas.dialog = 'asset-set'
        useEditorStore().workspace = 'canvas'
        return { state: 'done', note: 'The brief is in Plan assets on the board: check the list there, then generate', show: { workspace: 'canvas' } }
      }
      case 'edit-scene': {
        const scene = st.scenes?.find((x) => x.id === step.sceneId)
        if (!scene) return { state: 'skipped', note: 'The scene was deleted' }
        s.updateScene(scene.id, step.light ? 'Scene light' : 'Scene time', (sc) => {
          if (step.light) sc.light = step.light
          if (step.time) sc.time = step.time
        })
        return { state: 'done', note: `Scene ${sceneNumber(story(), scene.id)}: ${[step.time, step.light].filter(Boolean).join(' · ')}`, show: { sceneId: scene.id } }
      }
      case 'shot-lengths': {
        const known = step.lengths.filter((l) => st.shots.some((x) => x.id === l.shotId))
        if (!known.length) return { state: 'skipped', note: 'Those shots are gone' }
        s.update('Shot lengths', (d) => {
          for (const l of known) {
            const shot = d.shots.find((x) => x.id === l.shotId)
            if (shot) shot.duration = l.seconds
          }
        })
        const seconds = story().shots.reduce((n, x) => n + x.duration, 0)
        return { state: 'done', note: `${plural(known.length, 'shot')} retimed · the film runs ${Math.round(seconds)} s`, show: { sceneId: sceneOfShots(known.map((l) => l.shotId)) } }
      }
      case 'add-shot': {
        const scene = st.scenes?.find((x) => x.id === step.sceneId)
        if (!scene) return { state: 'skipped', note: 'The scene was deleted' }
        const id = nanoid(8)
        // Who it names, of the scene's cast (else everyone), is in the frame.
        const cast = (scene.castIds?.length ? st.characters.filter((c) => scene.castIds!.includes(c.id)) : st.characters).filter((c) =>
          new RegExp(`\\b${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(step.action),
        )
        const after = step.afterShotId && shotsOfScene(st, scene.id).some((x) => x.id === step.afterShotId) ? step.afterShotId : undefined
        s.update('Add shot', (d) =>
          insertShot(
            d,
            scene.id,
            {
              id,
              description: step.action,
              prompt: step.action,
              ...(step.shotType ? { shotType: step.shotType } : {}),
              duration: step.seconds,
              characterIds: cast.map((c) => c.id),
              dialogue: [],
              videoGenerationIds: [],
            },
            after,
          ),
        )
        const added = story().shots.find((x) => x.id === id)
        return { state: 'done', note: `Shot ${added ? s.shotName(added) : ''} added · ${step.seconds} s — it has no still yet`, show: { sceneId: scene.id } }
      }
      case 'stills': {
        const plans = stillPlans(step)
        const n = valid(plans).length
        if (!n) return { state: problemsOf(plans).length ? 'failed' : 'skipped', note: problemsOf(plans)[0] ?? 'Every one of these shots has its still' }
        const over = overApproved(plans, approved)
        if (over) return { state: 'stopped', note: over }
        const units = () => shotUnits(step.shotIds, 'still')
        const before = snapshot(units())
        ctx.progress({ note: `0 of ${plural(n, 'still')}`, done: 0, total: n })
        await s.runBatch(plans)
        const shots = shotsOf(step.shotIds)
        const noun = (k: number) => plural(k, 'still')
        const r = await follow(before, units, {
          expected: n,
          busy: () => shots.some((x) => s.preparingOf(x, 'keyframe') || s.preparingOf(x, 'end')),
          limitMs: STILL_LIMIT_MS,
          ctx,
          noun,
        })
        return settledResult(r, noun, { sceneId: sceneOfShots(step.shotIds) })
      }
      case 'voices': {
        const plans = linePlans(step)
        const n = valid(plans).length
        if (!n) return { state: problemsOf(plans).length ? 'failed' : 'skipped', note: problemsOf(plans)[0] ?? 'No line to record' }
        const over = overApproved(plans, approved)
        if (over) return { state: 'stopped', note: over }
        const units = () => shotsOf(step.shotIds).flatMap((x) => x.dialogue.map((l) => ({ key: l.id, id: l.generationId })))
        const before = snapshot(units())
        await s.run(plans)
        const noun = (k: number) => plural(k, 'line')
        const r = await follow(before, units, { expected: n, limitMs: STILL_LIMIT_MS, ctx, noun })
        return settledResult(r, noun, { sceneId: sceneOfShots(step.shotIds) })
      }
      case 'animate': {
        const final = step.quality === 'final'
        const draft = final ? undefined : draftPlans(step)
        const plans = final ? finalPlans(step) : draft!.plans
        const n = valid(plans).length
        if (!n) return { state: problemsOf(plans).length ? 'failed' : 'skipped', note: problemsOf(plans)[0] ?? 'Every one of these shots has a take' }
        const over = overApproved(plans, approved)
        if (over) return { state: 'stopped', note: over }
        const units = () => shotUnits(step.shotIds, final ? 'final' : 'take')
        const before = snapshot(units())
        ctx.progress({ note: `0 of ${plural(n, final ? 'final' : 'take')}`, done: 0, total: n })
        if (final) await s.run(plans)
        else {
          // Whole scenes as Animate scene runs them (in order, continuing shots after the take before); the rest one by one.
          for (const id of draft!.scenes) await s.animateScene(id)
          if (draft!.rest.length) await s.run(planners.planAnimate(draft!.rest))
        }
        const shots = shotsOf(step.shotIds)
        const noun = (k: number) => plural(k, final ? 'final' : 'take')
        const r = await follow(before, units, {
          expected: n,
          busy: () => shots.some((x) => s.preparingOf(x, 'take')) || Boolean(draft?.scenes.some((id) => s.sceneRunOf(id))),
          limitMs: VIDEO_LIMIT_MS,
          ctx,
          noun,
        })
        return settledResult(r, noun, { sceneId: sceneOfShots(step.shotIds) })
      }
      case 'music':
      case 'sfx': {
        const plan = audioPlan(step)
        if (typeof plan === 'string') return { state: 'failed', note: plan }
        const usd = plan.model.estimateCost(plan.params).usd
        if (approved?.usd != null && usd != null && usd > approved.usd * 1.2 + 0.05) return { state: 'stopped', note: `It now costs ${formatUsd(usd)}, more than the ${formatUsd(approved.usd)} approved — ask again` }
        const [job] = await jobs.create({ projectId: project.id!, modelId: plan.model.id, params: plan.params, label: step.title.slice(0, 80) })
        if (!job) return { state: 'failed', note: 'It didn’t start' }
        const noun = (k: number) => (step.op === 'music' ? plural(k, 'music cue') : plural(k, 'sound effect'))
        const r = await follow(new Map(), () => [{ key: job.id, id: job.id }], { expected: 1, limitMs: STILL_LIMIT_MS, ctx, noun })
        const out = settledResult(r, noun, undefined)
        return out.state === 'done' ? { ...out, note: `${step.op === 'music' ? 'The music' : 'The sound effect'} is in the Library (Media › Audio) · ${plan.model.label}` } : out
      }
      case 'update-timeline': {
        // Approved with the warning on the card: asked again only if the cut was edited by hand since.
        if (!ctx.replaceCut && !(await okToReplaceStoryCut(s))) return { state: 'skipped', note: 'The Story cut was kept as it is' }
        const done = await s.assemble()
        if (!done) return { state: 'failed', note: 'Nothing to lay out yet' }
        return { state: 'done', note: `${plural(done.count, 'shot')} · ${Math.round(done.seconds)} s on the Story cut`, show: { workspace: 'edit' } }
      }
      case 'create-explainer':
        return explainer.run(step, approved, ctx)
    }
  }

  /** Opens where a step's result is. */
  function show(where: StepProgress['show']) {
    if (!where) return
    if (where.sceneId && story().scenes?.some((x) => x.id === where.sceneId)) return openPlanScene(where.sceneId)
    if (where.step) return openPlanStep(where.step)
    if (where.workspace) useEditorStore().workspace = where.workspace
  }

  return { quote, quoteStep, runStep, show, storyCutEdited: () => s.storyCutEdited(), formatSeconds: (n: number) => formatDuration(n) }
}

export type DirectorTools = ReturnType<typeof createDirectorTools>
