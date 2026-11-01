import { shotsOfScene } from '@shared/story/structure'
import type { StoryShot } from '@shared/types/story'
import { shallowReactive } from 'vue'
import { toast } from 'vue-sonner'
import * as planning from './planning'
import { type RunUnit, planSceneRun, sceneUnits } from './sceneRun'
import type { StoryCore } from './storyCore'
import { inFlight, isDead } from './storyMedia'
import type { Planned, StoryRunner } from './storyRunner'
import type { StoryVideo } from './storyVideo'
import type { StoryVoice } from './storyVoice'

/**
 * Animate scene: a scene's takes in story order, its continuing shots each once the take before it is ready, Stop,
 * and how far a scene is.
 */

/**
 * Scenes being animated (Animate scene), by scene id: the run (a number of its own), the takes it started, and its
 * continuing shots still waiting for the take before them. Lives with the page: after a reload Animate scene picks up
 * what is left.
 */
const sceneRuns = shallowReactive(new Map<string, { run: number; jobIds: string[]; waiting: string[]; stopped: boolean }>())
let sceneRunCount = 0

export function createSceneRun(core: StoryCore, runner: StoryRunner, video: StoryVideo, voice: StoryVoice) {
  const {
    story,
    modelForGroup,
    modelForShot,
    keyframeOf,
    endKeyframeOf,
    chosenVideoOf,
    chosenGroupVideo,
    takeModelId,
    jobState,
    outputOf,
    groups,
    groupOf,
    shotNumber,
    shotName,
    cancelIfRendering,
    cancelShotRenders,
  } = core
  const { project, assets, jobs } = core.stores
  const { run, settled, preparingOf } = runner
  const { planContext, planVideo, planMultishot, planContinued, groupShotByShot, groupCovered, stillsContext, stillsWanted } = video
  const { followsVoices } = voice

  /** The same for a whole scene before it is deleted: its shots', its groups' takes, and its run (Animate scene) stops. */
  function cancelSceneRenders(sceneId: string) {
    const shots = shotsOfScene(story.value, sceneId)
    const ids = new Set(shots.map((x) => x.id))
    for (const shot of shots) cancelShotRenders(shot)
    for (const g of groups.value) if (g.shotIds.some((id) => ids.has(id))) for (const id of g.videoGenerationIds) cancelIfRendering(id, 'a take')
    const r = sceneRuns.get(sceneId)
    if (r) sceneRuns.set(sceneId, { ...r, stopped: true, waiting: [] })
  }

  // ---- scene runs
  /**
   * A take is done or on its way from the model the unit renders with now — or a shot's own waits for its lines to be
   * voiced (no job yet): Animate scene leaves the unit be.
   */
  function unitBusy(unit: RunUnit): boolean {
    if (!unit.group && preparingOf(unit.first, 'take')) return true
    const model = unit.group ? modelForGroup(unit.group) : modelForShot(unit.first)
    const ids = unit.group ? unit.group.videoGenerationIds : unit.first.videoGenerationIds
    return ids.some((id) => (!model || takeModelId(id) === model.id) && !isDead(jobState(id)))
  }

  /** The scene is being animated: its continuing shots wait for the takes before them. */
  function sceneAnimating(sceneId: string): boolean {
    const r = sceneRuns.get(sceneId)
    return Boolean(r && !r.stopped && r.waiting.length)
  }

  /** A unit's take as Animate scene starts it: one clip for a group, else the shot's own. */
  const planUnit = (u: RunUnit) => (u.group ? planMultishot(u.group) : planVideo(u.first))

  /**
   * A continuing shot's take as planContinued will make it once the take before it is ready — continuing that take's
   * clip, or from its last frame as the keyframe — priced before the run: neither is there yet, so a stand-in goes in
   * where it will (from references instead, some models price another length: Veo's ingredients are 8 s). For the cost
   * dialog only, never started: its apply does nothing.
   */
  function planContinuedPrice(shot: StoryShot): Planned | string {
    const prev = story.value.shots[shotNumber(shot) - 2]
    if (!prev) return 'The first shot has nothing to continue from'
    const model = modelForShot(shot)
    if (!model) return 'No video model available — add a Kling or fal.ai key or enable demo mode'
    const STAND_IN = 'the-take-before'
    const ctx = planContext()
    const plan =
      model.params.some((p) => p.key === 'continueFrom') && !groupOf(prev) && !followsVoices(shot, model)
        ? planning.planVideo(ctx, shot, model, { continueFrom: STAND_IN })
        : planning.planVideo({ ...ctx, keyframeOf: (x) => (x.id === shot.id ? { id: STAND_IN } : ctx.keyframeOf(x)) }, shot, model)
    return { ...plan, label: `${plan.label}, after the take before it`, apply: () => {} }
  }

  /**
   * What Animate scene would start now, for its cost dialog: the takes it starts at once, then its continuing shots,
   * priced as they will render (planContinuedPrice); `continuing` says how many of those wait for the take before them.
   */
  function planSceneAnimation(sceneId: string): { plans: (Planned | string)[]; continuing: number } {
    if (sceneAnimating(sceneId)) return { plans: ['This scene is already animating — its continuing shots start as the takes before them are ready'], continuing: 0 }
    const { now, waiting } = planSceneRun(sceneUnits(story.value, sceneId, groupShotByShot, groupCovered), unitBusy)
    return { plans: [...now.map(planUnit), ...waiting.map((u) => planContinuedPrice(u.first))], continuing: waiting.length }
  }

  /**
   * Animates a scene: its shots and groups that have no take from their model yet, in story order — the queue renders
   * in the order jobs are made, so the first shot comes back first. A continuing shot waits for the take before it and
   * then starts from it (planContinued). Pressing it again picks up what is left. Returns how many started now.
   */
  async function animateScene(sceneId: string): Promise<number> {
    if (sceneAnimating(sceneId)) {
      toast('This scene is already animating', { description: 'Its continuing shots start as the takes before them are ready.' })
      return 0
    }
    const { now, waiting } = planSceneRun(sceneUnits(story.value, sceneId, groupShotByShot, groupCovered), unitBusy)
    if (!now.length && !waiting.length) {
      toast('Every shot of this scene has a take', { description: 'Use Another take on a shot for more.' })
      return 0
    }
    // A run of its own: the loop of a run stopped before, still waiting for a take, took the new run for its own and
    // started its continuing shot as well — two paid takes. The earlier runs' takes still queued stay with it, for Stop.
    const runId = ++sceneRunCount
    // Left or switched project: its job list is emptied, so every take the run waits for looks finished — it would
    // plan the continuing shots from whatever take is chosen then, as paid renders in the project open now.
    const pid = project.id
    const gone = () => project.id !== pid
    const earlier = (sceneRuns.get(sceneId)?.jobIds ?? []).filter((id) => inFlight(jobState(id)))
    sceneRuns.set(sceneId, { run: runId, jobIds: earlier, waiting: waiting.map((u) => u.id), stopped: false })
    const track = (p: Planned | string): Planned | string =>
      typeof p === 'string'
        ? p
        : {
            ...p,
            apply: (gid: string) => {
              p.apply(gid)
              const r = sceneRuns.get(sceneId)
              if (r) sceneRuns.set(sceneId, { ...r, jobIds: [...r.jobIds, gid] })
            },
            // A dialogue shot's lines take a while to voice: stopped meanwhile, its take doesn't start (animated again
            // since, the new run left the shot to this one).
            ...(p.prepare
              ? {
                  prepare: async () => {
                    const plan = await p.prepare!()
                    if (gone()) return `${p.label}: not started — its project was closed`
                    return sceneRuns.get(sceneId)?.stopped !== false ? `${p.label}: not started — the scene was stopped` : track(plan)
                  },
                }
              : {}),
          }
    const started = await run(now.map((u) => track(planUnit(u))))
    if (waiting.length) {
      toast(`${waiting.length} continuing shot${waiting.length === 1 ? ' waits' : 's wait'} for the take before ${waiting.length === 1 ? 'it' : 'each'}`, {
        description: 'Each picks up where the previous take ends.',
      })
      void continueScene(sceneId, runId, waiting, track, gone)
    }
    return started
  }

  /** The continuing shots of a scene run, one after another: each once the take it starts from is ready. */
  async function continueScene(sceneId: string, runId: number, waiting: RunUnit[], track: (p: Planned | string) => Planned | string, gone: () => boolean) {
    // Its own run only: animated again, the new run waits for these shots itself. Nor once its project is closed.
    const stopped = () => {
      const r = sceneRuns.get(sceneId)
      return !r || r.run !== runId || r.stopped || gone()
    }
    const unwait = (id: string) => {
      const r = sceneRuns.get(sceneId)
      if (r?.run === runId) sceneRuns.set(sceneId, { ...r, waiting: r.waiting.filter((x) => x !== id) })
    }
    for (const unit of waiting) {
      if (stopped()) return
      const current = story.value.shots.find((x) => x.id === unit.first.id)
      const prev = current && story.value.shots[shotNumber(current) - 2]
      if (prev) {
        // Whatever of the previous shot (or its group) is still rendering, then its picture ready to be read.
        const group = groupOf(prev)
        const rendering = [...prev.videoGenerationIds, ...(group?.videoGenerationIds ?? [])].filter((id) => {
          const job = jobs.byId[id]
          return job && !jobs.isTerminal(job)
        })
        await settled(rendering, 3 * 60 * 60_000)
        const video = group ? chosenGroupVideo(group) : chosenVideoOf(prev)
        if (video) await assets.whenReady(video.id).catch(() => undefined)
      }
      if (stopped()) return
      const now = story.value.shots.find((x) => x.id === unit.first.id)
      const plan = now ? await planContinued(now) : 'A continuing shot was deleted'
      unwait(unit.id)
      if (stopped()) return
      await run([track(plan)])
    }
  }

  /**
   * Stops a scene run: its continuing shots don't start, and its takes still waiting in the queue are canceled. Takes
   * already rendering finish — a cloud render may already be paid for.
   */
  async function stopScene(sceneId: string) {
    const r = sceneRuns.get(sceneId)
    if (!r) return
    sceneRuns.set(sceneId, { ...r, stopped: true, waiting: [] })
    const queued = r.jobIds.filter((id) => jobs.byId[id]?.status === 'queued')
    await Promise.allSettled(queued.map((id) => jobs.cancel(id)))
    toast(queued.length ? `Stopped — ${queued.length} queued take${queued.length === 1 ? '' : 's'} canceled` : 'Stopped', {
      description: 'Takes already rendering will finish.',
    })
  }

  /** What a scene run is doing now (undefined: nothing): takes rendering, and the shots waiting for the take before them. */
  function sceneRunOf(sceneId: string): { rendering: number; waiting: string[] } | undefined {
    const r = sceneRuns.get(sceneId)
    if (!r) return undefined
    const rendering = r.jobIds.filter((id) => {
      const job = jobs.byId[id]
      return job && !jobs.isTerminal(job)
    }).length
    return rendering || r.waiting.length ? { rendering, waiting: r.waiting } : undefined
  }

  /**
   * How far a scene is: its shots, how many of the stills they need are made (planning.stillsWanted: what Stills
   * draws), its renders (shots and groups), how many of them have a take and how many are rendering, and finals.
   */
  function sceneProgress(sceneId: string) {
    const shots = shotsOfScene(story.value, sceneId)
    const units = sceneUnits(story.value, sceneId, groupShotByShot, groupCovered)
    const ids = (u: RunUnit) => (u.group ? u.group.videoGenerationIds : u.first.videoGenerationIds)
    const ctx = stillsContext()
    const wanted = shots.map((x) => stillsWanted(x, ctx))
    const needsKeyframe = shots.filter((_, i) => wanted[i]!.keyframe)
    const needsEnd = shots.filter((_, i) => wanted[i]!.end)
    return {
      shots: shots.length,
      seconds: shots.reduce((n, x) => n + x.duration, 0),
      // A still marked "redo" (its shot was written again since) still has to be drawn: it isn't counted as made.
      stills: needsKeyframe.filter((x) => keyframeOf(x) && !x.stillStale).length + needsEnd.filter((x) => endKeyframeOf(x)).length,
      stillsNeeded: needsKeyframe.length + needsEnd.length,
      renders: units.length,
      animated: units.filter((u) => (u.group ? chosenGroupVideo(u.group) : chosenVideoOf(u.first))).length,
      rendering: units.filter((u) =>
        ids(u).some((id) => {
          const job = jobs.byId[id]
          return job && !jobs.isTerminal(job)
        }),
      ).length,
      finals: units.filter((u) => outputOf((u.group ?? u.first).finalGenerationId)).length,
    }
  }

  /** The shot a continuing shot is waiting for in a scene run ("2.2"), if it is waiting. */
  function waitingFor(shot: StoryShot): string | undefined {
    if (![...sceneRuns.values()].some((r) => r.waiting.includes(shot.id))) return undefined
    const prev = story.value.shots[shotNumber(shot) - 2]
    return prev && shotName(prev)
  }

  return { cancelSceneRenders, planSceneAnimation, animateScene, stopScene, sceneRunOf, sceneProgress, waitingFor }
}
