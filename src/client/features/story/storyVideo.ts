import type { ModelSpec } from '@shared/models/types'
import { workflowFor } from '@shared/models/workflow'
import type { AssetDTO } from '@shared/types/assets'
import type { ShotTake, StoryMultishot, StoryShot } from '@shared/types/story'
import { nanoid } from 'nanoid'
import { toast } from 'vue-sonner'
import { ApiRequestError, api, errorMessage } from '@/lib/api'
import { END_SETTLE_SECONDS, dialogueFit, speakingRoom, splitShot } from './dialogueFit'
import { sourceBlocker } from './modelInfo'
import { clipAtLeast, clipSeconds, maxClipSeconds } from './multishot'
import * as planning from './planning'
import { continuing } from './sceneRun'
import type { StoryCore } from './storyCore'
import type { StoryCuts } from './storyCuts'
import { takeName } from './storyNaming'
import type { Planned } from './storyRunner'
import type { StoryStills } from './storyStills'
import type { StoryVoice } from './storyVoice'

/**
 * Video: what the pure planners (planning.ts) read, how each group is made, a shot's and a group's takes — drafts,
 * continuing shots and finals with what blocks them — and a dialogue shot's length against its lines.
 */

/** Which model renders a shot or group, and whether as its final render (draft → final). */
export interface VideoOptions {
  /** Default: the story's video model. */
  model?: ModelSpec
  /** Renders with the story's final settings and records the take as the final one. */
  final?: boolean
  /**
   * A continuing shot's start (see planContinued): the previous take's clip to continue (`via: 'clip'`), or its last
   * frame, already the shot's keyframe (`via: 'frame'`). The take records it.
   */
  startFrom?: NonNullable<ShotTake['startFrom']>
}

export function createVideo(core: StoryCore, cuts: StoryCuts, stills: StoryStills, voice: StoryVoice) {
  const {
    story,
    aspect,
    update,
    updateShot,
    updateGroup,
    modelForGroup,
    modelForShot,
    usableVideoModel,
    workflowOf,
    maxShotsOf,
    keyframeOf,
    endKeyframeOf,
    chosenVideoOf,
    chosenGroupVideo,
    characterName,
    finalModel,
    takeModelId,
    isFinalAsset,
    renderSettings,
    rememberFinal,
    finalComing,
    groupOf,
    groupShots,
    takeIdOf,
    outputOf,
    shotNumber,
    shotName,
  } = core
  const { project, assets } = core.stores
  const { previousEnd } = cuts
  const { rememberKeyframe, withVideoRefs, endCheckDue, checkEndFrame } = stills
  const { followsVoices, voiceTrackOf, prepareVoiceTrack } = voice

  /** What the pure planners (planning.ts) read: the story now, and the assets as the stores have them. */
  const planContext = (): planning.PlanContext => ({
    story: withVideoRefs(story.value),
    aspect: aspect.value,
    assetReady: (id) => Boolean(id && assets.get(id)?.status === 'ready'),
    keyframeOf,
    endKeyframeOf: (shot) => {
      const end = endKeyframeOf(shot)
      return end?.status === 'ready' ? end : undefined
    },
    settingsFor: renderSettings,
    voiceTrackOf,
  })

  /** The cuts the group's model would render (on a clip length it takes, see planning.groupCutPlan). */
  function groupCuts(g: StoryMultishot) {
    return planning.groupCutPlan(planContext(), g, modelForGroup(g))
  }

  /** How a group's clip is made with `model` (the group's model by default, see modelForGroup): see planning.groupSource. */
  const groupSource = (g: StoryMultishot, model = modelForGroup(g)) => planning.groupSource(planContext(), g, model)
  /** A group rendered shot by shot, each from its own keyframe — on LTX unless it is set to one clip (see planning). */
  const groupShotByShot = (g: StoryMultishot) => planning.rendersShotByShot(planContext(), g, modelForGroup(g))
  /**
   * A group rendered shot by shot whose one clip — an older take — is chosen and ready: it covers its shots, which
   * Animate and Animate scene then leave be (a shot's own Animate still makes a take of it).
   */
  const groupCovered = (g: StoryMultishot) => groupShotByShot(g) && chosenGroupVideo(g)?.status === 'ready'
  /**
   * The group whose one clip renders the shot — its final too: none once the group renders shot by shot and the shot
   * has a take of its own (that take is what the film is assembled from), or the group has no clip.
   */
  function clipGroupOf(shot: StoryShot): StoryMultishot | undefined {
    const group = groupOf(shot)
    if (!group || !groupShotByShot(group)) return group
    return chosenVideoOf(shot) || !chosenGroupVideo(group) ? undefined : group
  }
  /** Whether the group can be made from `source` with `model` (the group's model by default): see planning.canUseSource. */
  const canUseSource = (g: StoryMultishot, source: NonNullable<StoryMultishot['source']>, model = modelForGroup(g)) =>
    planning.canUseSource(planContext(), g, model, source)

  const setGroupSource = (g: StoryMultishot, source: StoryMultishot['source']) =>
    updateGroup(g.id, 'Multi-shot source', (x) => {
      if (source) x.source = source
      else delete x.source
    })

  /** Renders a shot (see planning.planVideo) with `opts.model`, else the shot's model (modelForShot); the take records it. */
  function planVideo(shot: StoryShot, opts: VideoOptions = {}): Planned | string {
    const model = opts.model ?? modelForShot(shot)
    if (!model) return 'No video model available — add a Kling or fal.ai key or enable demo mode'
    const final = Boolean(opts.final)
    const startFrom = opts.startFrom
    // Rendered from the grey previs frame itself, the clip comes out grey (live test, 2026-10-26): the still is drawn
    // over the previs first. A shot continuing a clip doesn't start from its still.
    const still = startFrom?.via === 'clip' ? undefined : keyframeOf(shot)?.id
    if (still && shot.previs && (still === shot.previs.firstFrameAssetId || still === shot.previs.assetId)) {
      return `Shot ${shotName(shot)}’s still is its grey previs frame — make the still first (it is drawn over the previs), then render`
    }
    const plan = planning.planVideo(planContext(), shot, model, { final, continueFrom: startFrom?.via === 'clip' ? startFrom.assetId : undefined })
    const source = planning.sourceOfParams(plan.params)
    const voiceTrack = typeof plan.params.audioClip === 'string' ? plan.params.audioClip : undefined
    // A dialogue shot from its keyframe whose voice track isn't made yet: made first, then the shot planned again with it.
    const voicing = !voiceTrack && keyframeOf(shot) && followsVoices(shot, model)
    // Its end keyframe not compared with its keyframe yet (normally done as soon as both are drawn): compared first —
    // whether the end picture goes with the clip depends on it (planning's endState), unless the user decided (endUse).
    const checking = !voicing && !voiceTrack && !shot.endUse && opts.startFrom?.via !== 'clip' && model.params.some((p) => p.key === 'lastFrame') && Boolean(endCheckDue(shot))
    const prepare =
      voicing || checking
        ? async (): Promise<Planned | string> => {
            const ready = voicing ? await prepareVoiceTrack(shot.id) : await checkEndFrame(shot).then(() => true)
            const now = story.value.shots.find((x) => x.id === shot.id)
            // Deleted while its lines were voiced: the take went on rendering, paid for, into a shot that was gone.
            if (!now) return `Shot ${shotName(shot)} was deleted — its take wasn’t started`
            if (!ready) return { ...planned, prepare: undefined }
            const again = planVideo(now, opts)
            return typeof again === 'string' ? again : { ...again, prepare: undefined }
          }
        : undefined
    const planned: Planned = {
      ...plan,
      name: takeName([shot]),
      ...(prepare
        ? { prepare, makes: { shotId: shot.id, what: 'take' as const, waitsFor: voicing ? 'its lines' : 'its end frame check' }, ...(checking ? { quiet: true } : {}) }
        : {}),
      apply: (gid) =>
        update(final ? 'Final render' : 'Animate shot', (story) => {
          const s = story.shots.find((x) => x.id === shot.id)
          if (!s) return
          s.videoGenerationIds.push(gid)
          s.takes = {
            ...s.takes,
            [gid]: { modelId: model.id, ...(source ? { source } : {}), ...(voiceTrack ? { voiceTrackAssetId: voiceTrack } : {}), ...(startFrom ? { startFrom } : {}) },
          }
          if (final) {
            s.finalGenerationId = gid
            rememberFinal(story, gid)
          }
        }),
    }
    return planned
  }

  /**
   * A continuing shot (StoryShot.continues) starts where the previous shot's chosen take ends: with a model that
   * continues clips (LTX on the GPU) from that clip's ending — its motion and framing carry over — else from its last
   * frame, which becomes the shot's keyframe (the old one goes into the history). A dialogue shot made to its recorded
   * lines always takes the frame.
   */
  async function planContinued(shot: StoryShot, opts: VideoOptions = {}): Promise<Planned | string> {
    const prev = story.value.shots[shotNumber(shot) - 2]
    if (!prev) return 'The first shot has nothing to continue from'
    const model = opts.model ?? modelForShot(shot)
    if (!model) return 'No video model available — add a Kling or fal.ai key or enable demo mode'
    const clip = chosenVideoOf(prev)
    if (model.params.some((p) => p.key === 'continueFrom') && !groupOf(prev) && !followsVoices(shot, model)) {
      if (!clip) return `Shot ${shotName(prev)} has no take to continue from yet`
      return planVideo(shot, { ...opts, model, startFrom: { shotId: prev.id, assetId: clip.id, via: 'clip' } })
    }
    const end = previousEnd(shot)
    if (!end) return `Shot ${shotName(prev)} has no take to continue from yet`
    let frame: AssetDTO
    try {
      frame = await api.assets.frame(project.id!, end.asset.id, end.seconds, `Shot ${shotName(prev)} · last frame`)
      assets.upsert(frame)
      await assets.whenReady(frame.id)
    } catch (err) {
      return `Couldn’t grab the last frame of shot ${shotName(prev)}: ${errorMessage(err)}`
    }
    updateShot(shot.id, `Start frame from shot ${shotName(prev)}`, (s) => {
      rememberKeyframe(s)
      s.keyframeHistory = (s.keyframeHistory ?? []).filter((x) => x !== frame.id)
      s.keyframeAssetId = frame.id
      s.keyframeGenerationId = undefined
    })
    const now = story.value.shots.find((x) => x.id === shot.id)
    if (!now) return 'The shot was deleted'
    return planVideo(now, { ...opts, model, startFrom: { shotId: prev.id, assetId: frame.id, via: 'frame' } })
  }

  /**
   * One clip for a whole multi-shot group (see planning.planMultishot) with `opts.model`, else the group's model
   * (modelForGroup); the take remembers where it was told to cut, the model and what it was made from.
   */
  function planMultishot(g: StoryMultishot, opts: VideoOptions = {}): Planned | string {
    const model = opts.model ?? modelForGroup(g)
    if (!model) return 'No video model available — add a Kling or fal.ai key or enable demo mode'
    const final = Boolean(opts.final)
    const plan = planning.planMultishot(planContext(), g, model, { final })
    if (typeof plan === 'string') return plan
    const { planned, total, ...rest } = plan
    const source = planning.sourceOfParams(rest.params)
    return {
      ...rest,
      name: takeName(groupShots(g)),
      apply: (gid) =>
        update(final ? 'Final render multi-shot' : 'Animate multi-shot', (story) => {
          const x = story.multishots?.find((m) => m.id === g.id)
          if (!x) return
          x.videoGenerationIds.push(gid)
          x.takes = { ...x.takes, [gid]: { planned, total, modelId: model.id, ...(source ? { source } : {}) } }
          if (final) {
            x.finalGenerationId = gid
            rememberFinal(story, gid)
          }
        }),
    }
  }

  /** The take's model, when it is known and can render now (see takeModelId). */
  const usableTakeModel = (generationId?: string) => usableVideoModel(generationId ? takeModelId(generationId) : undefined)
  /** The generation that rendered a shot take (its asset records it; older assets are looked up among the takes). */
  const shotTakeIdOf = (shot: StoryShot, take: AssetDTO) =>
    take.generation?.generationId ?? shot.videoGenerationIds.find((id) => outputOf(id)?.id === take.id)

  /**
   * The model a group's final render uses (planning.finalModelFor): the final model when it is of the chosen take's
   * family, else the take's own model with the final settings. Without a take (or one of no known model) the group's
   * model stands for it. Undefined without a usable final model.
   */
  function finalModelForGroup(g: StoryMultishot): ModelSpec | undefined {
    const final = finalModel()
    if (!final) return undefined
    const take = chosenGroupVideo(g)
    const id = take && takeIdOf(g, take)
    return planning.finalModelFor(usableTakeModel(id) ?? modelForGroup(g), final)
  }
  /** The same for a shot (a shot whose group's clip renders it: the group's, see clipGroupOf). */
  function finalModelForShot(shot: StoryShot): ModelSpec | undefined {
    const group = clipGroupOf(shot)
    if (group) return finalModelForGroup(group)
    const final = finalModel()
    if (!final) return undefined
    const take = chosenVideoOf(shot)
    const id = take && shotTakeIdOf(shot, take)
    return planning.finalModelFor(usableTakeModel(id) ?? modelForShot(shot), final)
  }

  /**
   * Why the group's final render can't start, if it can't: no final model, or nothing to make it from with that model
   * (a scene from references needs no keyframe if the model takes the cast's pictures; one from a keyframe does).
   */
  function groupFinalBlocker(g: StoryMultishot): string | undefined {
    const model = finalModelForGroup(g)
    if (!model) return 'Pick a final model first'
    if (finalComing(g)) return 'A final render of this group is already on its way'
    const source = groupSource(g, model)
    if (canUseSource(g, source, model)) return undefined
    const first = groupShots(g)[0]
    const blocker = sourceBlocker(source, workflowFor(model), { first: first ? shotName(first) : 1, hasKeyframe: Boolean(first && keyframeOf(first)) })
    return `The final render with ${model.label} ${blocker}`
  }
  /** Why the shot's final render can't start (one its group's clip renders: the group's), if it can't: it starts from the draft's keyframe. */
  function shotFinalBlocker(shot: StoryShot): string | undefined {
    const group = clipGroupOf(shot)
    if (group) return groupFinalBlocker(group)
    const model = finalModelForShot(shot)
    if (!model) return 'Pick a final model first'
    if (finalComing(shot)) return 'A final render of this shot is already on its way'
    // A continuing shot's final starts where the shot before ends, as its draft did (planContinued): no keyframe needed.
    if (continuing(story.value, shot)) return undefined
    return keyframeOf(shot) ? undefined : `Shot ${shotName(shot)} has no still — ${model.label} renders the final from the draft’s still`
  }

  /** The group's final render: with finalModelForGroup's model and the final settings, recorded as a final. */
  function planGroupFinal(g: StoryMultishot): Planned | string {
    const model = finalModelForGroup(g)
    return groupFinalBlocker(g) ?? planMultishot(g, { model: model!, final: true })
  }
  /**
   * A shot's final render (one its group's clip renders: the group's), from the draft's keyframe. A continuing shot's
   * starts where the shot before ends, which is only known as it starts (planContinued, the Final render on its card):
   * from the keyframe — another start than its draft's — it would cut where the draft runs on.
   */
  function planShotFinal(shot: StoryShot): Planned | string {
    const group = clipGroupOf(shot)
    if (group) return planGroupFinal(group)
    const blocker = shotFinalBlocker(shot)
    if (blocker) return blocker
    if (continuing(story.value, shot)) return `Shot ${shotName(shot)} continues the shot before: its final starts where that one’s take ends — use Final render on its card`
    return planVideo(shot, { model: finalModelForShot(shot)!, final: true })
  }

  /** Final renders for every shot and group whose chosen take isn't final yet and has no final render on the way. */
  function planFinals(): (Planned | string)[] {
    if (!finalModel()) return ['Pick a final model first']
    const plans: (Planned | string)[] = []
    const seen = new Set<string>()
    for (const shot of story.value.shots) {
      const group = clipGroupOf(shot)
      if (group) {
        if (seen.has(group.id)) continue
        seen.add(group.id)
        const take = chosenGroupVideo(group)
        if (!take || isFinalAsset(take) || finalComing(group)) continue
        plans.push(planGroupFinal(group))
      } else {
        const take = chosenVideoOf(shot)
        if (!take || isFinalAsset(take) || finalComing(shot)) continue
        plans.push(planShotFinal(shot))
      }
    }
    return plans
  }

  // ---- dialogue length
  /** The group that renders the shot as part of one clip now (not one rendered shot by shot). */
  const oneClipOf = (shot: StoryShot) => {
    const group = groupOf(shot)
    return group && !groupShotByShot(group) ? group : undefined
  }
  /** The clip a shot really gets: its piece of the multi-shot plan, or its length as the video model renders it. */
  function shotSeconds(shot: StoryShot): number {
    const group = oneClipOf(shot)
    const cut = group ? groupCuts(group).cuts.find((c) => c.shot.id === shot.id) : undefined
    if (cut) return cut.end - cut.start
    const model = modelForShot(shot)
    return model ? clipSeconds(model, shot.duration) : shot.duration
  }

  /** Spoken time vs. the shot, plus the length that would fit it (`target`, capped by the shot's model's longest clip, `cap`). */
  function dialogueFitOf(shot: StoryShot) {
    // The shot that ends a multi-shot clip written in prose (LTX) keeps its last second for the settle
    // (END_SETTLE_SECONDS); a model's own shot list (Kling) times each shot itself. Rendered shot by shot, it is a
    // clip of its own.
    const group = oneClipOf(shot)
    const settle = group && group.shotIds.at(-1) === shot.id && workflowOf(group).multishot.method === 'prose' ? END_SETTLE_SECONDS : 0
    const fit = dialogueFit(shot.dialogue, shotSeconds(shot) - settle)
    const model = modelForShot(shot)
    const cap = Math.min(15, model ? maxClipSeconds(model) : 15)
    const target = Math.min(cap, model ? clipAtLeast(model, fit.needed + settle) : fit.needed + settle)
    return { ...fit, cap, target }
  }

  const lengthenForDialogue = (shot: StoryShot) => {
    const { target } = dialogueFitOf(shot)
    updateShot(shot.id, 'Shot length', (s) => (s.duration = target))
  }

  const splitForDialogue = (shot: StoryShot) => {
    const { available, cap } = dialogueFitOf(shot)
    const maxShots = maxShotsOf(modelForShot(shot))
    update('Split shot', (s) => void splitShot(s, shot.id, available, cap, () => nanoid(8), maxShots))
  }

  /** Has the Director shorten the shot's lines to fit it; all of them change in one undoable step. */
  async function shortenLines(shot: StoryShot): Promise<void> {
    const lines = shot.dialogue.filter((l) => l.text.trim())
    if (!lines.length) return
    const { available } = dialogueFitOf(shot)
    try {
      const res = await api.director.trimDialogue({
        lines: lines.map((l) => ({ speaker: characterName(l.characterId) ?? 'Narrator', text: l.text })),
        // The shot also holds a lead-in, the gaps between lines and a tail (dialogueFit): the budget is for the words.
        maxSeconds: Math.max(1, Math.round(speakingRoom(available, lines.length) * 10) / 10),
      })
      if (!Array.isArray(res.lines) || res.lines.length !== lines.length || res.lines.some((t) => typeof t !== 'string' || !t.trim()))
        throw new Error('The Director returned a different set of lines')
      const next = new Map(lines.map((l, i) => [l.id, res.lines[i]!.trim()]))
      updateShot(shot.id, 'Shorten lines', (s) => {
        for (const l of s.dialogue) {
          const text = next.get(l.id)
          if (text === undefined || text === l.text) continue
          l.text = text
          l.generationId = undefined
        }
      })
    } catch (err) {
      const missing = err instanceof ApiRequestError && err.status === 404
      toast.error('Couldn’t shorten the lines', { description: missing ? 'This server has no trim-dialogue endpoint yet — update and restart it.' : errorMessage(err) })
    }
  }

  /** What planning.stillsWanted reads: the story, and how each group renders with its model now. */
  function stillsContext(): planning.StillsContext {
    const ctx = planContext()
    return {
      story: story.value,
      shotByShot: (g) => planning.rendersShotByShot(ctx, g, modelForGroup(g)),
      sourceOf: (g) => planning.groupSource(ctx, g, modelForGroup(g)),
    }
  }
  /** The stills a shot needs — its keyframe, its end frame: what Stills draws and the scene's progress counts. */
  const stillsWanted = (shot: StoryShot, ctx = stillsContext()) => planning.stillsWanted(ctx, shot)

  return {
    planContext,
    groupCuts,
    groupSource,
    groupShotByShot,
    groupCovered,
    clipGroupOf,
    canUseSource,
    setGroupSource,
    planVideo,
    planContinued,
    planMultishot,
    finalModelForGroup,
    finalModelForShot,
    groupFinalBlocker,
    shotFinalBlocker,
    planGroupFinal,
    planShotFinal,
    planFinals,
    dialogueFitOf,
    lengthenForDialogue,
    splitForDialogue,
    shortenLines,
    stillsContext,
    stillsWanted,
  }
}

export type StoryVideo = ReturnType<typeof createVideo>
