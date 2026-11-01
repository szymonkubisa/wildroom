import { legacySceneKey } from '@shared/story/structure'
import type { ModelSpec } from '@shared/models/types'
import type { ProjectSpendDTO } from '@shared/types/api'
import type { StoryShot } from '@shared/types/story'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { confirmDialog } from '@/components/app/useConfirm'
import { api, errorMessage } from '@/lib/api'
import { formatUsd } from '@/lib/format'
import { useJobsStore } from '@/stores/jobs'
import { useProjectStore } from '@/stores/project'
import { batchTimes, overBudgetBy } from './budget'
import { continuing } from './sceneRun'
import { speaksAudio } from './soundtrack'
import { type Story, isDead, useStory } from './useStory'

/**
 * Before the Story cut is laid out again: when it was edited by hand since the last time, the app asks — those edits
 * are replaced (Undo brings them back). True to go on.
 */
export async function okToReplaceStoryCut(s: Story): Promise<boolean> {
  if (!s.storyCutEdited()) return true
  return confirmDialog({
    title: 'Replace the edited Story cut?',
    description:
      'The Story cut timeline was changed by hand since the story was last put on it. Updating it lays the story out again and replaces those edits — Undo brings them back. Your other timelines aren’t touched.',
    confirmText: 'Replace the Story cut',
    destructive: true,
  })
}

/**
 * The open project's spend (every generation in it, not only the story's), refreshed as its jobs finish and when another
 * project opens. Call in a component's setup: it follows the spend while mounted.
 */
export function useProjectSpend() {
  const project = useProjectStore()
  const jobs = useJobsStore()
  const spend = ref<ProjectSpendDTO>()
  async function refreshSpend() {
    const id = project.id
    if (!id) return
    try {
      const next = await api.projects.spend(id)
      // Not another project's figure, if one opened while this was asked.
      if (project.id === id) spend.value = next
    } catch {
      // The chip keeps the last figure; a missed refresh isn't worth a toast.
    }
  }
  let offFinished: (() => void) | undefined
  onMounted(() => {
    void refreshSpend()
    offFinished = jobs.onFinished(() => void refreshSpend())
  })
  onBeforeUnmount(() => offFinished?.())
  watch(
    () => project.id,
    (id, previous) => {
      if (!previous || id === previous) return
      spend.value = undefined
      void refreshSpend()
    },
  )
  return { spend, refreshSpend }
}

/**
 * What a batch of the storyboard would start — the stills and ElevenLabs lines some shots need, the takes they have
 * none of — planned the same way for a scene's buttons, the Film step and the Director's plans. Plain functions over
 * the story: no component needed.
 */
export function createBatchPlanners(s: Story) {
  type Plan = ReturnType<typeof s.planVideo>

  /**
   * The model a shot renders with (its group's, its own "Render with…", or the story's) speaks its dialogue itself (see
   * soundtrack.ts), so ElevenLabs lines would only double it.
   */
  function speaksFor(shot: StoryShot): boolean {
    const model = s.modelForShot(shot)
    return Boolean(model && speaksAudio(model, s.renderSettings(model, false)))
  }
  const hasLines = (shot: StoryShot) => shot.dialogue.some((l) => l.text.trim())
  /**
   * ElevenLabs voices the shot's lines: its model doesn't speak them, or — LTX, a shot rendered on its own (its group's
   * clip doesn't render it, clipGroupOf) — the shot is made to them (audio to follow, see planning.followsVoices).
   */
  const voicedByElevenLabs = (shot: StoryShot) => hasLines(shot) && (!speaksFor(shot) || (!s.clipGroupOf(shot) && s.followsVoices(shot)))
  /** "Stills & voices", or "Stills" when none of these shots needs ElevenLabs lines. */
  const prepareLabel = (shots: readonly StoryShot[]) => (shots.some(voicedByElevenLabs) ? 'Stills & voices' : 'Stills')
  const prepareTitle = (shots: readonly StoryShot[]) => {
    const n = shots.filter(voicedByElevenLabs).length
    return n
      ? `Stills, and ElevenLabs lines for ${n} shot${n === 1 ? '' : 's'} (LTX lip-syncs dialogue shots to them; other models that don’t speak get them on the timeline)`
      : 'Stills (every shot’s model speaks its own lines)'
  }

  /** Nothing is coming from these generations: none started, or every one failed or was canceled. */
  const nothingComing = (ids: (string | undefined)[]) => ids.every((id) => !id || isDead(s.jobState(id)))

  /**
   * Keyframes and ElevenLabs lines for these shots: the stills their renders use (stillsWanted — a multi-shot from
   * references uses none, one from a keyframe only its first shot's, a continuing shot starts from the take before it;
   * the scene's opening shot is everyone's layout) that aren't made or on their way. `again`: every one of those drawn
   * again, the ones made too (each keyframe goes into its shot's earlier keyframes) — lines only where missing.
   */
  function planPrepare(shots: readonly StoryShot[], opts: { again?: boolean } = {}): Plan[] {
    const plans: Plan[] = []
    const all = s.story.value.shots
    const sceneOf = (shot: StoryShot) => shot.sceneId ?? legacySceneKey(shot)
    const coming = (gid?: string) => {
      const state = s.jobState(gid)
      return Boolean(state && !isDead(state))
    }
    const rendering = (gid?: string) => coming(gid) && s.jobState(gid)!.status !== 'succeeded'
    // A still waiting for the picture it is drawn from (chained stills) has no job yet: it is on its way all the same —
    // planned again, it was drawn twice.
    // A still marked stale (the shot was written again by Update scenes) is drawn again too.
    const wantsKeyframe = (shot: StoryShot) =>
      !s.preparingOf(shot, 'keyframe') &&
      (opts.again || shot.stillStale ? !rendering(shot.keyframeGenerationId) : !s.keyframeOf(shot) && !coming(shot.keyframeGenerationId))
    const wantsEnd = (shot: StoryShot) =>
      !s.preparingOf(shot, 'end') && (opts.again ? !rendering(shot.endKeyframeGenerationId) : !s.endKeyframeOf(shot) && !coming(shot.endKeyframeGenerationId))
    const ctx = s.stillsContext()
    /** End frames drawn or on their way, so far in this batch: the shot after one waits for it (chained stills). */
    const endsComing = new Set<string>()
    const endOnItsWay = (x: StoryShot) => endsComing.has(x.id) || Boolean(s.preparingOf(x, 'end')) || (!s.endKeyframeOf(x) && coming(x.endKeyframeGenerationId))
    for (const shot of shots) {
      const at = all.findIndex((x) => x.id === shot.id)
      const before = all[at - 1]
      const chained = Boolean(before && sceneOf(before) === sceneOf(shot) && before.endFrame?.trim() && endOnItsWay(before))
      const wanted = s.stillsWanted(shot, ctx)
      const startPlanned = wanted.keyframe && wantsKeyframe(shot)
      // A shot after one with a set end opens on that moment: its keyframe waits for that end frame.
      if (startPlanned) plans.push(chained ? s.planKeyframeAfterPreviousEnd(shot, before!) : s.planKeyframe(shot))
      // A shot with a set end: its end frame, drawn from its keyframe (wanted too, so made, on its way or planned now) —
      // once that keyframe is there (the new one, when it is drawn again too).
      if (wanted.end && wantsEnd(shot)) {
        const startReady = s.keyframeOf(shot)?.status === 'ready'
        plans.push(startReady && !startPlanned ? s.planEndKeyframe(shot) : s.planEndKeyframeAfterStart(shot))
        endsComing.add(shot.id)
      } else if (shot.endFrame?.trim() && coming(shot.endKeyframeGenerationId) && s.endKeyframeOf(shot)?.status !== 'ready') endsComing.add(shot.id)
      // ElevenLabs lines where the shot's model doesn't speak them itself, or makes the shot to them.
      if (voicedByElevenLabs(shot)) plans.push(...s.planLines({ ...shot, dialogue: shot.dialogue.filter((l) => nothingComing([l.generationId])) }))
    }
    return plans
  }

  /**
   * Every shot and group among these that has no take (done or coming) from the model it renders with now: after
   * switching the video model (LTX → Kling), it makes a take of each with the new one; the old takes stay to compare.
   */
  function planAnimate(shots: readonly StoryShot[]): Plan[] {
    const plans: Plan[] = []
    const planned = new Set<string>()
    const withModel = (ids: string[], model: ModelSpec | undefined) => (model ? ids.filter((id) => s.takeModelId(id) === model.id) : ids)
    // A continuing shot starts where the take before it ends, once that is ready: rendered here from its keyframe, it
    // cut where it should run on. Animate scene (Steps) or its own Animate makes it.
    const left: string[] = []
    for (const shot of shots) {
      if (continuing(s.story.value, shot)) {
        left.push(s.shotName(shot))
        continue
      }
      const group = s.groupOf(shot)
      // A multi-shot group renders once, as one clip — unless it renders shot by shot (LTX, or its later shots have
      // keyframes of their own: groupShotByShot), each shot from its keyframe; a clip of it already chosen covers them
      // (groupCovered). A shot whose lines are being voiced first (no job yet) has its take on its way too.
      if (group && !s.groupShotByShot(group)) {
        if (!planned.has(group.id) && nothingComing(withModel(group.videoGenerationIds, s.modelForGroup(group)))) plans.push(s.planMultishot(group))
        planned.add(group.id)
      } else if (group && s.groupCovered(group)) continue
      else if (!s.preparingOf(shot, 'take') && nothingComing(withModel(shot.videoGenerationIds, s.modelForShot(shot)))) plans.push(s.planVideo(shot))
    }
    if (left.length) {
      plans.push(
        left.length === 1
          ? `Shot ${left[0]} continues the shot before — Animate it on its card once that shot’s take is ready`
          : `Shots ${left.join(', ')} continue the shots before them — Animate each on its card once the take before it is ready`,
      )
    }
    return plans
  }

  /** The confirm dialog's note for Animate scene's continuing shots (priced with the rest, started later). */
  const continuingNote = (n: number) =>
    n ? `${n === 1 ? 'The continuing shot starts' : `The ${n} continuing shots start`} where the take before ${n === 1 ? 'it' : 'each'} ends, once that take is ready.` : undefined

  return { planPrepare, planAnimate, continuingNote, prepareLabel, prepareTitle, voicedByElevenLabs, nothingComing }
}

export type BatchPlanners = ReturnType<typeof createBatchPlanners>

/**
 * The storyboard's batches — keyframes and voices, animating, finals — for any set of shots (a scene, or the scenes
 * ready to animate), each confirmed first with its cost, time and the budget; and the spend, the animatic and the
 * Story cut timeline. Call in a component's setup (it follows the spend while mounted).
 */
export function useStoryBatch(onAssembled?: () => void) {
  const s = useStory()

  // ---- spend (against the story's budget, which is set in the top bar's chip)
  const { spend, refreshSpend } = useProjectSpend()

  type Plan = ReturnType<typeof s.planVideo>
  // shallowRef: plans hold model specs with zod schemas, which must never be wrapped in Vue proxies.
  /** `inline`: asked in place (a card under the scene's header, keyed by the scene) instead of in the dialog. */
  const pending = shallowRef<{ title: string; plans: Plan[]; then?: () => void; note?: string; inline?: string }>()
  const running = ref(false)
  const valid = (plans: Plan[]) => plans.filter((p): p is Exclude<Plan, string> => typeof p !== 'string')
  const { planPrepare, planAnimate, continuingNote, prepareLabel, prepareTitle, voicedByElevenLabs, nothingComing } = createBatchPlanners(s)

  /**
   * Asks before these plans run — in the confirm dialog, or in place when `inline` names where (a scene's card); `then`
   * runs instead of starting them when confirmed; `note` says more.
   */
  function ask(title: string, plans: Plan[], then?: () => void, note?: string, inline?: string) {
    pending.value = { title, plans, ...(then ? { then } : {}), ...(note ? { note } : {}), ...(inline ? { inline } : {}) }
  }

  watch(pending, (v) => v && void refreshSpend())

  /** The confirm dialog's pre-flight: cost and render time per model, the batch's time, the budget. */
  const pendingSummary = computed(() => {
    if (!pending.value) return undefined
    const ok = valid(pending.value.plans)
    const usd = s.estimate(ok)
    const byModel = new Map<string, { model: ModelSpec; plans: typeof ok }>()
    for (const p of ok) byModel.set(p.model.id, { model: p.model, plans: [...(byModel.get(p.model.id)?.plans ?? []), p] })
    const timed = ok.map((p) => ({ provider: p.model.provider, seconds: p.model.estimateSeconds?.(p.params) }))
    const lines = [...byModel.values()].map(({ model, plans }) => {
      const seconds = plans.map((p) => model.estimateSeconds?.(p.params))
      return {
        model,
        count: plans.length,
        usd: s.estimate(plans),
        seconds: seconds.every((x) => x !== undefined) ? seconds.reduce((a, b) => a! + b!, 0) : undefined,
      }
    })
    return {
      count: ok.length,
      usd,
      lines,
      times: batchTimes(timed),
      runpod: ok.some((p) => p.model.provider === 'runpod'),
      over: overBudgetBy(spend.value?.totalUsd ?? 0, usd, s.story.value.budgetUsd),
      problems: [...new Set(pending.value.plans.filter((p) => typeof p === 'string') as string[])],
    }
  })
  const priceOf = (usd: number | null) => (usd == null ? 'price depends on your plan' : formatUsd(usd))

  async function confirmRun() {
    if (!pending.value) return
    running.value = true
    try {
      if (pending.value.then) pending.value.then()
      else await s.runBatch(pending.value.plans)
    } finally {
      running.value = false
      pending.value = undefined
    }
  }

  function cancel() {
    if (!running.value) pending.value = undefined
  }

  // ---- animatic and assembling
  const voicing = ref<{ done: number; total: number }>()
  async function animatic() {
    if (voicing.value) return
    if (!(await okToReplaceStoryCut(s))) return
    voicing.value = { done: 0, total: 0 }
    try {
      const result = await s.voiceAnimatic((done, total) => (voicing.value = { done, total }))
      if (result.unavailable) toast.warning('No temp voices on this machine', { description: `${result.unavailable} The animatic is timed by estimates.` })
      else if (result.failed) toast.warning(`${result.failed} temp voice${result.failed === 1 ? '' : 's'} failed`, { description: 'Those lines are timed by an estimate.' })
      const changes = await s.assembleAnimatic()
      if (!changes) return
      const n = changes.length
      const shots = s.story.value.shots.length
      toast.success(`Animatic on the Story cut · ${shots} shot${shots === 1 ? '' : 's'}`, {
        description: n ? `${n} shot${n === 1 ? ' needs' : 's need'} more time for ${n === 1 ? 'its' : 'their'} lines than planned.` : 'Every shot holds its lines.',
        duration: n ? 20_000 : undefined,
        ...(n ? { action: { label: `Apply animatic timing to ${n} shot${n === 1 ? '' : 's'}`, onClick: () => s.applyTiming(changes) } } : {}),
      })
      onAssembled?.()
    } catch (err) {
      toast.error('Animatic failed', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      voicing.value = undefined
    }
  }

  const assembling = ref(false)
  /** Update timeline: the Story cut laid out again (asked first when it was edited by hand). */
  async function assemble() {
    if (assembling.value || !(await okToReplaceStoryCut(s))) return
    assembling.value = true
    try {
      if (!(await s.assemble())) return
    } catch (err) {
      toast.error('Could not update the timeline', { description: errorMessage(err) })
      return
    } finally {
      assembling.value = false
    }
    onAssembled?.()
  }

  return {
    spend,
    refreshSpend,
    pending,
    running,
    pendingSummary,
    priceOf,
    confirmRun,
    cancel,
    ask,
    planPrepare,
    planAnimate,
    continuingNote,
    prepareLabel,
    prepareTitle,
    voicedByElevenLabs,
    nothingComing,
    voicing,
    animatic,
    assembling,
    assemble,
  }
}

export type StoryBatch = ReturnType<typeof useStoryBatch>
