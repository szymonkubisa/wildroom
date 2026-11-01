import { getModel } from '@shared/models/registry'
import type { ModelSpec, ParamValues } from '@shared/models/types'
import { type VideoWorkflow, workflowFor } from '@shared/models/workflow'
import { normalizeStory, shotLabel } from '@shared/story/structure'
import type { AssetDTO } from '@shared/types/assets'
import type { ProviderId } from '@shared/types/jobs'
import { type StoryChapter, type StoryDoc, type StoryMultishot, type StoryScene, type StoryShot, emptyStory } from '@shared/types/story'
import { computed } from 'vue'
import { toast } from 'vue-sonner'
import { errorMessage } from '@/lib/api'
import { useAssetsStore } from '@/stores/assets'
import { useJobsStore } from '@/stores/jobs'
import { useProjectStore } from '@/stores/project'
import { useSettingsStore } from '@/stores/settings'
import { shortModelLabel } from './modelInfo'
import { validGroups } from './multishot'
import * as planning from './planning'
import type { ContinuityContext } from './references'
import { generatedMedia } from './storyMedia'

/**
 * The storyboard's read model, which every other part of useStory builds on: the story and its edits, the models it
 * renders with, what each shot, group and take has (stills, takes, the model a take was made with) and its groups.
 * Reads and undoable edits only — nothing here starts a render.
 */

const PREFERRED: Record<'image' | 'video' | 'speech', string[]> = {
  image: ['local-flux-2', 'fal-nano-banana-pro', 'fal-nano-banana-2', 'fal-seedream-5-pro', 'fal-flux-2-pro', 'mock-image'],
  video: ['local-ltx-2.5', 'kling-3.0', 'fal-veo3.1-fast', 'fal-seedance-2.5', 'kling-2.6', 'fal-veo3.1', 'mock-video'],
  speech: ['eleven-v4-tts', 'eleven-v3-tts', 'mock-speech'],
}

/** The stores the parts read — as one named type: the stores' own types use names they don't export. */
export interface StoryStores {
  project: ReturnType<typeof useProjectStore>
  assets: ReturnType<typeof useAssetsStore>
  jobs: ReturnType<typeof useJobsStore>
  settings: ReturnType<typeof useSettingsStore>
}

export function createStoryCore() {
  const stores: StoryStores = { project: useProjectStore(), assets: useAssetsStore(), jobs: useJobsStore(), settings: useSettingsStore() }
  const { project, assets, jobs, settings } = stores

  const story = computed<StoryDoc>(() => project.doc.story ?? emptyStory())

  function update(label: string, mutate: (s: StoryDoc) => void) {
    project.apply((draft) => {
      draft.story ??= emptyStory()
      mutate(draft.story)
      // Scenes stay whole and in order whatever the edit did (a shot without a scene joins the one before it).
      normalizeStory(draft.story)
    }, label)
  }

  function updateShot(id: string, label: string, mutate: (shot: StoryShot) => void) {
    update(label, (s) => {
      const shot = s.shots.find((x) => x.id === id)
      if (shot) mutate(shot)
    })
  }

  /** Saves something the app found on its own (detected cuts, a cached temp voice): autosaved, not an undo step. */
  function fact(mutate: (s: StoryDoc) => void) {
    project.applyFact((draft) => {
      draft.story ??= emptyStory()
      mutate(draft.story)
    })
  }

  const aspect = computed(() => {
    const { width, height } = project.doc.settings
    const r = width / height
    return r > 1.2 ? '16:9' : r < 0.8 ? '9:16' : '1:1'
  })

  /** The model can render now: its provider is set up (a local one installed), and demo-only models only in demo mode. */
  const usable = (m: ModelSpec | undefined): m is ModelSpec => Boolean(m && settings.modelReady(m) && (!m.demoOnly || settings.app?.demoMode))

  function modelFor(kind: 'image' | 'video' | 'speech'): ModelSpec | undefined {
    const chosen = kind === 'image' ? story.value.imageModelId : kind === 'video' ? story.value.videoModelId : story.value.voiceModelId
    const candidate = chosen ? getModel(chosen) : undefined
    if (usable(candidate)) return candidate
    for (const id of PREFERRED[kind]) {
      const m = getModel(id)
      if (usable(m)) return m
    }
    return settings.availableModels.find((m) => m.kind === kind)
  }

  /** The video models that can render now: what a "Render with…" choice offers. */
  const readyVideoModels = () => settings.availableModels.filter((m) => m.kind === 'video' && usable(m))

  /** A video model by id, when it exists and can render now. */
  function usableVideoModel(id?: string): ModelSpec | undefined {
    const m = id ? getModel(id) : undefined
    return m?.kind === 'video' && usable(m) ? m : undefined
  }

  // ---- "Render with…": a model per group or shot
  /** The model a group renders with: its own choice (StoryMultishot.modelId) when that model can render now, else the story's video model. */
  const modelForGroup = (g: StoryMultishot): ModelSpec | undefined => usableVideoModel(g.modelId) ?? modelFor('video')
  /**
   * The model a shot renders with: a shot in a multi-shot group renders with the group's (see modelForGroup); else its
   * own choice (StoryShot.modelId) when that model can render now, else the story's video model.
   */
  function modelForShot(shot: StoryShot): ModelSpec | undefined {
    const group = groupOf(shot)
    return group ? modelForGroup(group) : (usableVideoModel(shot.modelId) ?? modelFor('video'))
  }
  /** The storyboard workflow (shot limits, identity sources, cast, speech) of a model, or of the model a group or shot renders with. */
  function workflowOf(x?: ModelSpec | StoryMultishot | StoryShot): VideoWorkflow {
    if (!x) return workflowFor(modelFor('video'))
    if ('shotIds' in x) return workflowFor(modelForGroup(x))
    if ('dialogue' in x) return workflowFor(modelForShot(x))
    return workflowFor(x)
  }
  /** Most shots one clip of the model takes (LTX 4, Kling 6): the limit for joining shots into a group. */
  const maxShotsOf = (model?: ModelSpec) => workflowFor(model).multishot.maxShots

  /** "Render with…" for a group: a video model id, or undefined for the story's video model. Undoable. */
  const setGroupModel = (g: StoryMultishot, modelId: string | undefined) =>
    updateGroup(g.id, 'Render with', (x) => {
      if (modelId) x.modelId = modelId
      else delete x.modelId
    })
  /** "Render with…" for a shot (used while it isn't in a group): a video model id, or undefined for the story's. Undoable. */
  const setShotModel = (shot: StoryShot, modelId: string | undefined) =>
    updateShot(shot.id, 'Render with', (x) => {
      if (modelId) x.modelId = modelId
      else delete x.modelId
    })

  const { outputOf, jobState } = generatedMedia(jobs, assets)

  const keyframeOf = (shot: StoryShot) => (shot.keyframeAssetId ? assets.get(shot.keyframeAssetId) : outputOf(shot.keyframeGenerationId))
  /** The shot's end keyframe (StoryShot.endFrame drawn), if it has one. */
  const endKeyframeOf = (shot: StoryShot) => (shot.endKeyframeAssetId ? assets.get(shot.endKeyframeAssetId) : outputOf(shot.endKeyframeGenerationId))
  const takesOf = (shot: StoryShot) => shot.videoGenerationIds.map((id) => ({ id, asset: outputOf(id), state: jobState(id) }))
  /** A ready final render wins over the picked take, which wins over the newest take. */
  const chosenVideoOf = (shot: StoryShot) =>
    outputOf(shot.finalGenerationId) ??
    (shot.chosenAssetId ? assets.get(shot.chosenAssetId) : undefined) ??
    takesOf(shot)
      .map((t) => t.asset)
      .filter(Boolean)
      .at(-1)
  const chooseTake = (shot: StoryShot, assetId: string) =>
    updateShot(shot.id, 'Choose take', (s) => {
      s.chosenAssetId = assetId
      s.finalGenerationId = undefined
    })
  const characterName = (id?: string) => story.value.characters.find((c) => c.id === id)?.name

  // ---- draft → final
  /** The final video model, when one is set and usable. */
  function finalModel(): ModelSpec | undefined {
    const id = story.value.finalVideoModelId
    const m = id ? getModel(id) : undefined
    return usable(m) ? m : undefined
  }

  // ---- takes: what each was rendered with
  /** Takes recorded with their model when they were started (group and shot take records), by generation id. */
  const takeRecords = computed(() => planning.takeRecords(story.value))
  /**
   * The video model a take (generation id) was rendered with: its take record, else its job, else the asset that
   * records its generation. For model badges and side-by-side comparison.
   */
  const takeModelId = (generationId: string): string | undefined =>
    takeRecords.value.get(generationId)?.modelId ??
    jobs.byId[generationId]?.modelId ??
    assets.byGeneration.get(generationId)?.generation?.modelId
  /** What a take was made from (keyframe, references, both), when its record says. */
  const takeSourceOf = (generationId: string) => takeRecords.value.get(generationId)?.source
  /** A take's model for its badge: a short name ("LTX", "Kling 3.0") and the full label, when the model is known. */
  function takeModelLabel(generationId: string): { short: string; label: string } | undefined {
    const id = takeModelId(generationId)
    if (!id) return undefined
    const known = getModel(id)
    if (known) return { short: shortModelLabel(known), label: known.label }
    const recorded = (outputOf(generationId) ?? assets.byGeneration.get(generationId))?.generation
    return recorded ? { short: shortModelLabel({ id, label: recorded.modelLabel, provider: recorded.provider as ProviderId }), label: recorded.modelLabel } : undefined
  }
  /** What a take cost (or was estimated to), when its job or asset says. */
  function takeCostUsd(generationId: string): number | undefined {
    const job = jobs.byId[generationId]
    return job?.costUsd ?? job?.costEstimateUsd ?? outputOf(generationId)?.generation?.costUsd
  }

  /**
   * A take rendered as a final: recorded in finalTakeIds when it was started. Only takes without a take record (from
   * before them) are still judged by their model: made with the final model, when that isn't the draft one.
   */
  const isFinalTake = (generationId: string) =>
    planning.isFinalTake(story.value, generationId, { modelId: jobs.byId[generationId]?.modelId, draftModelId: modelFor('video')?.id }, takeRecords.value)
  const isFinalAsset = (asset?: AssetDTO) =>
    Boolean(
      asset?.generation &&
        planning.isFinalTake(story.value, asset.generation.generationId, { modelId: asset.generation.modelId, draftModelId: modelFor('video')?.id }, takeRecords.value),
    )

  /**
   * The story's settings for a video render (resolution, fps, audio…): the draft model's, or the final model's when
   * `final`. Only what the model has, without the storyboard's own keys (see planning.storySettings).
   */
  function renderSettings(model: ModelSpec, final: boolean): ParamValues {
    return planning.storySettings(story.value, model, final)
  }
  const rememberFinal = (s: StoryDoc, generationId: string) => {
    s.finalTakeIds = [...(s.finalTakeIds ?? []), generationId]
  }
  /** A final render is queued or running for this shot or group. */
  const finalComing = (x: { finalGenerationId?: string }) => {
    const job = x.finalGenerationId ? jobs.byId[x.finalGenerationId] : undefined
    return Boolean(job && !jobs.isTerminal(job))
  }

  // ---- multi-shot groups (see multishot.ts)
  const groups = computed(() => validGroups(story.value))
  const groupOf = (shot: StoryShot) => groups.value.find((g) => g.shotIds.includes(shot.id))
  const groupShots = (g: StoryMultishot) => planning.groupShots(story.value, g)
  const groupTakes = (g: StoryMultishot) => g.videoGenerationIds.map((id) => ({ id, asset: outputOf(id), state: jobState(id) }))
  const chosenGroupVideo = (g: StoryMultishot) =>
    outputOf(g.finalGenerationId) ??
    (g.chosenAssetId ? assets.get(g.chosenAssetId) : undefined) ??
    groupTakes(g)
      .map((t) => t.asset)
      .filter(Boolean)
      .at(-1)
  function updateGroup(id: string, label: string, mutate: (g: StoryMultishot) => void) {
    update(label, (s) => {
      const g = s.multishots?.find((x) => x.id === id)
      if (g) mutate(g)
    })
  }
  const chooseGroupTake = (g: StoryMultishot, assetId: string) =>
    updateGroup(g.id, 'Choose take', (x) => {
      x.chosenAssetId = assetId
      x.finalGenerationId = undefined
    })
  /** Why the group is too big for `model` (its own by default): more shots or seconds than one clip takes, if it is. */
  const groupLimitProblem = (g: StoryMultishot, model = modelForGroup(g)) => planning.groupLimitProblem(story.value, g, model)

  /** The generation that rendered a group take (its asset records it; older assets are looked up among the takes). */
  const takeIdOf = (g: StoryMultishot, take: AssetDTO) =>
    take.generation?.generationId ?? g.videoGenerationIds.find((id) => outputOf(id)?.id === take.id)

  const placeOf = (shot: StoryShot) => planning.placeOf(story.value, shot)

  /** What the keyframe rules (references.ts) read: the story, its stills, and what each keyframe render was made from. */
  const continuityContext = (): ContinuityContext => ({
    story: story.value,
    keyframeOf,
    endKeyframeOf,
    madeFrom: (generationId) => jobs.byId[generationId]?.params.referenceImages,
  })

  const shotNumber = (shot: StoryShot) => planning.shotNumber(story.value, shot)
  /** "2.3" (scene 2, its third shot): how labels name a shot. */
  const shotName = (shot: StoryShot) => shotLabel(story.value, shot)
  const freshShot = (id: string) => story.value.shots.find((x) => x.id === id)

  /** Cancels a render (a keyframe by default) still queued or rendering: removing it means the result isn't wanted. */
  function cancelIfRendering(id?: string, what = 'the still') {
    const job = id ? jobs.byId[id] : undefined
    if (job && !jobs.isTerminal(job)) void jobs.cancel(job.id).catch((err) => toast.error(`Couldn’t cancel ${what}`, { description: errorMessage(err) }))
  }

  /**
   * Cancels a shot's renders still queued or rendering — keyframe, end frame, takes: deleting it means they aren't
   * wanted (they rendered on, paid for, into a shot that was gone).
   */
  function cancelShotRenders(shot: StoryShot) {
    cancelIfRendering(shot.keyframeGenerationId)
    cancelIfRendering(shot.endKeyframeGenerationId, 'the end frame')
    for (const id of shot.videoGenerationIds) cancelIfRendering(id, 'a take')
  }

  function updateScene(sceneId: string, label: string, mutate: (scene: StoryScene, s: StoryDoc) => void) {
    update(label, (s) => {
      const scene = s.scenes?.find((x) => x.id === sceneId)
      if (scene) mutate(scene, s)
    })
  }

  function updateChapter(chapterId: string, label: string, mutate: (chapter: StoryChapter) => void) {
    update(label, (s) => {
      const chapter = s.chapters?.find((x) => x.id === chapterId)
      if (chapter) mutate(chapter)
    })
  }

  return {
    stores,
    story,
    update,
    updateShot,
    updateGroup,
    updateScene,
    updateChapter,
    fact,
    aspect,
    usable,
    modelFor,
    readyVideoModels,
    usableVideoModel,
    modelForGroup,
    modelForShot,
    workflowOf,
    maxShotsOf,
    setGroupModel,
    setShotModel,
    outputOf,
    jobState,
    keyframeOf,
    endKeyframeOf,
    takesOf,
    chosenVideoOf,
    chooseTake,
    characterName,
    finalModel,
    takeRecords,
    takeModelId,
    takeSourceOf,
    takeModelLabel,
    takeCostUsd,
    isFinalTake,
    isFinalAsset,
    renderSettings,
    rememberFinal,
    finalComing,
    groups,
    groupOf,
    groupShots,
    groupTakes,
    chosenGroupVideo,
    chooseGroupTake,
    groupLimitProblem,
    takeIdOf,
    placeOf,
    continuityContext,
    shotNumber,
    shotName,
    freshShot,
    cancelIfRendering,
    cancelShotRenders,
  }
}

export type StoryCore = ReturnType<typeof createStoryCore>
