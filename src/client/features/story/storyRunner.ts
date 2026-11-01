import { parseParams } from '@shared/models/params'
import type { ModelSpec, ParamValues } from '@shared/models/types'
import type { StoryShot } from '@shared/types/story'
import { shallowReactive, toRaw, watch } from 'vue'
import { toast } from 'vue-sonner'
import { errorMessage } from '@/lib/api'
import { continuityRefs, keyframeStages, layoutKey } from './references'
import type { StoryCore } from './storyCore'

/**
 * The storyboard's engine: what a planned render is (Planned), starting plans — the ones with work to do first once
 * that is done — batches with their keyframes staged scene by scene, and waiting for jobs.
 */

/** What a render waiting in its prepare makes (Planned.makes): a shot's keyframe, end frame or take. */
export type Makes = 'keyframe' | 'end' | 'take'
/**
 * Renders waiting in their prepare, by `${shotId}:${what}`, with what they wait for ("its keyframe", "its lines"): a
 * still for the picture it is drawn from, a dialogue shot's take for its lines to be voiced. They have no job yet —
 * this is what tells Stills again, Animate and the cards that they are on their way (pressed again, they were made
 * twice).
 */
const preparing = shallowReactive(new Map<string, string>())

export interface Planned {
  model: ModelSpec
  params: ParamValues
  apply: (generationId: string) => void
  label: string
  /** What the render and its media are called (CreateGenerationRequest.label); default: the start of the prompt. */
  name?: string
  /** A shot's keyframe: batches start each scene's opening keyframe before the rest (see runBatch). */
  keyframeFor?: string
  /**
   * Work before this render can start — a dialogue shot's lines voiced and mixed into its voice track (see
   * prepareVoiceTrack) — and the plan as it then stands: run() starts it once that is done.
   */
  prepare?: () => Promise<Planned | string>
  /** What a prepare waits for, when it waits for another picture (afterPicture) rather than for lines being voiced. */
  waitNote?: string
  /** A prepare too short to announce: the end frame check (a local comparison of two stills, under a second). */
  quiet?: boolean
  /** What a plan with a prepare makes, and what it waits for: kept in `preparing` until its job is made (see run). */
  makes?: { shotId: string; what: Makes; waitsFor: string }
}

/** What the engine takes from the parts built on it (see useStory). */
export interface RunnerDeps {
  /** A shot's keyframe as Stills plans it (storyStills): runBatch plans the scene's later keyframes again with it. */
  planKeyframe: (shot: StoryShot) => Planned | string
}

export function createRunner(core: StoryCore, deps: RunnerDeps) {
  const { story, keyframeOf, outputOf, continuityContext } = core
  const { project, assets, jobs } = core.stores
  const { planKeyframe } = deps

  /** Resolves once `ok()` holds, or after `limitMs`. */
  function until(ok: () => boolean, limitMs = 20 * 60_000): Promise<void> {
    if (ok()) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(finish, limitMs)
      const stop = watch(ok, (yes) => yes && finish())
      function finish() {
        clearTimeout(timer)
        stop()
        resolve()
      }
    })
  }

  /** What the shot's keyframe, end frame or take waits for while it waits in its prepare (see `preparing`), if it does. */
  const preparingOf = (shot: StoryShot, what: Makes) => preparing.get(`${shot.id}:${what}`)

  /** Starts one render and returns its job id (throws when it can't). */
  async function startJob(model: ModelSpec, params: ParamValues): Promise<string> {
    const parsed = parseParams(toRaw(model), params)
    if (!parsed.ok) throw new Error(parsed.message)
    const [job] = await jobs.create({ projectId: project.id!, modelId: model.id, params: parsed.values })
    if (!job) throw new Error('The render did not start')
    return job.id
  }

  function estimate(plans: Planned[]): number | null {
    let total = 0
    for (const p of plans) {
      const usd = p.model.estimateCost(p.params).usd
      if (usd == null) return null
      total += usd
    }
    return total
  }

  /**
   * Starts the planned generations; returns how many started. Plans with work to do first (`prepare`: a dialogue shot's
   * voice track) start once it is done, in the background — they are counted as started.
   */
  async function run(plans: (Planned | string)[]): Promise<number> {
    const later = plans.filter((p): p is Planned => typeof p !== 'string' && Boolean(p.prepare))
    const started = await start(plans.filter((p) => typeof p === 'string' || !p.prepare))
    if (later.length) {
      const voiced = later.filter((p) => !p.waitNote && !p.quiet).length
      const chained = later.filter((p) => p.waitNote).length
      if (voiced) {
        toast(`Voicing the lines of ${voiced} shot${voiced === 1 ? '' : 's'} first`, {
          description: 'ElevenLabs speaks them, then the shot is made to that audio — exact words and lip sync.',
        })
      }
      if (chained) {
        toast(`${chained} still${chained === 1 ? ' waits' : 's wait'} for the one before`, {
          description: 'An end frame is drawn from its shot’s still, and the next still from that end frame — one after another.',
        })
      }
      // One that fails (an upload, a re-plan) must not hold back the others: each starts as it is ready. Waiting for all
      // of them first deadlocked chained stills — an end frame held back until the next keyframe, which waits for it.
      // Ready after its project was closed, it doesn't start: it would be made in whichever project is open then.
      const pid = project.id
      for (const p of later) {
        // No job yet while it waits: on its way (see `preparing`) until it has one, or won't get one.
        const key = p.makes && `${p.makes.shotId}:${p.makes.what}`
        if (key) preparing.set(key, p.makes!.waitsFor)
        void p
          .prepare!()
          .then(
            (plan) => (project.id === pid ? start([plan]) : 0),
            (err) => toast.error('A shot couldn’t be prepared', { description: errorMessage(err) }),
          )
          .finally(() => key && preparing.delete(key))
      }
    }
    return started + later.length
  }

  async function start(plans: (Planned | string)[]): Promise<number> {
    const problems = plans.filter((p): p is string => typeof p === 'string')
    if (problems.length) toast.warning(problems[0]!, { description: problems.length > 1 ? `+${problems.length - 1} more` : undefined })
    let started = 0
    for (const plan of plans) {
      if (typeof plan === 'string') continue
      const model = toRaw(plan.model)
      const parsed = parseParams(model, toRaw(plan.params))
      if (!parsed.ok) {
        toast.error(`${plan.label}: ${parsed.message}`)
        continue
      }
      try {
        // A render can't take an input that is still processing (the server refuses it): a keyframe's job is done a
        // moment before its picture is, and Animate pressed in between sent it unfinished.
        const inputs = ['firstFrame', 'lastFrame', 'continueFrom'].map((key) => parsed.values[key])
        await Promise.all(inputs.map((id) => (typeof id === 'string' && assets.get(id) && assets.get(id)!.status !== 'ready' ? assets.whenReady(id) : undefined)))
        const [job] = await jobs.create({ projectId: project.id!, modelId: model.id, params: parsed.values, ...(plan.name ? { label: plan.name } : {}) })
        if (job) {
          plan.apply(job.id)
          started++
        }
      } catch (err) {
        toast.error(`${plan.label} failed`, { description: errorMessage(err) })
      }
    }
    return started
  }

  /** Resolves once none of these jobs is still queued or rendering (or after `limitMs`, so a stuck job can't hold a batch). */
  function settled(ids: string[], limitMs = 15 * 60_000): Promise<void> {
    return until(
      () =>
        ids.every((id) => {
          const job = jobs.byId[id]
          return !job || jobs.isTerminal(job)
        }),
      limitMs,
    )
  }

  /**
   * Runs a batch, with keyframes scene by scene: a scene whose shots have no keyframe yet gets its opening keyframe
   * first, and the scene's other keyframes start once it is done, with it as their layout reference (see
   * continuityRefs). Everything else starts at once. Returns how many jobs started now.
   */
  async function runBatch(plans: (Planned | string)[]): Promise<number> {
    // A keyframe that waits for the end frame before it (afterPicture) isn't staged here: it opens on that picture.
    const batch = new Set(plans.flatMap((p) => (typeof p !== 'string' && p.keyframeFor && !p.waitNote ? [p.keyframeFor] : [])))
    const ctx = continuityContext()
    const { opening, waiting } = keyframeStages(story.value.shots, batch, (shot) => layoutKey(ctx.story, shot), (shot) => continuityRefs(ctx, shot).length > 0)
    const later = new Set(waiting)
    // What they have now — none, or the keyframe being made again (Stills again): anything else that comes meanwhile wins.
    const had = new Map(waiting.map((id) => [id, keyframeOf(story.value.shots.find((x) => x.id === id)!)?.id]))
    const started = await run(plans.filter((p) => typeof p === 'string' || !p.keyframeFor || p.waitNote || !later.has(p.keyframeFor)))
    if (!waiting.length) return started
    const openingJobs = opening.flatMap((id) => {
      const gid = story.value.shots.find((x) => x.id === id)?.keyframeGenerationId
      return gid ? [gid] : []
    })
    toast(`${waiting.length} more still${waiting.length === 1 ? ' starts' : 's start'} when the opening shot${opening.length === 1 ? ' is' : 's are'} done`, {
      description: 'They get it as a layout reference, so the set stays the same from shot to shot.',
    })
    void settled(openingJobs).then(async () => {
      // The job is done before its picture is: continuity only takes a keyframe whose asset is ready, and planned in
      // that gap the shots went out without their layout reference (10.10, Transport – scena).
      await Promise.all(
        openingJobs.map((gid) => {
          const out = outputOf(gid)
          return out ? assets.whenReady(out.id).catch(() => undefined) : undefined
        }),
      )
      // Re-planned now, so the finished opening keyframe goes in; skipped if a keyframe came some other way meanwhile.
      const rendering = (gid?: string) => {
        const job = gid ? jobs.byId[gid] : undefined
        return Boolean(job && !jobs.isTerminal(job))
      }
      const shots = waiting
        .map((id) => story.value.shots.find((x) => x.id === id))
        .filter((x): x is StoryShot => Boolean(x) && keyframeOf(x!)?.id === had.get(x!.id) && !rendering(x!.keyframeGenerationId))
      if (shots.length) void run(shots.map((x) => planKeyframe(x)))
    })
    return started
  }

  return { until, settled, preparingOf, startJob, estimate, run, start, runBatch }
}

export type StoryRunner = ReturnType<typeof createRunner>
