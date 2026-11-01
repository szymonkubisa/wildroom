import type { GenKind } from '@shared/types/jobs'
import { effectScope } from 'vue'
import { useProjectStore } from '@/stores/project'
import { sceneKey } from './references'
import { createAssemble } from './storyAssemble'
import { createStoryCore } from './storyCore'
import { createCuts } from './storyCuts'
import { createDesign } from './storyDesign'
import { createDirector } from './storyDirector'
import { createNaming } from './storyNaming'
import { createRunner } from './storyRunner'
import { createSceneRun } from './storySceneRun'
import { createStills } from './storyStills'
import { createVideo } from './storyVideo'
import { createVoice } from './storyVoice'

/**
 * The storyboard as the story's components (and the editor) use it: one object built from its parts, each a module of
 * its own that takes the parts below it, never the whole —
 *
 *   storyCore (the story, its models, stills, takes, groups) < storyCuts, storyRunner (starting plans, batches)
 *   < storyStills, storyVoice < storyVideo (takes, finals, dialogue length) < storySceneRun (Animate scene)
 *
 * storyDesign and storyDirector take the core, storyAssemble the core, the cuts and how groups render (the
 * video's), storyNaming (and
 * storyMedia, under the core) only the jobs and assets. Built once per Pinia and shared: every card and row of a long
 * story built its own, every computed and closure again, and redid the work on each edit.
 */

export { directorApi } from './storyDirector'
export { DEAD_JOB_STATUSES, inFlight, isDead } from './storyMedia'
export type { Makes, Planned } from './storyRunner'
export type { KeyframeOptions } from './storyStills'
export type { VideoOptions } from './storyVideo'

/** The storyboard, built from its parts (useStory shares one; tests can build their own). */
export function createStory() {
  const core = createStoryCore()
  // The cuts are below the video, but a shot's last frame follows how its group renders now: the video's rule, looked
  // up when asked.
  const cuts = createCuts(core, { shotByShot: (g) => video.groupShotByShot(g) })
  // The engine is below the stills, but a batch plans its scenes' later keyframes again (runBatch): the stills' own
  // planKeyframe, looked up when a batch runs.
  const runner = createRunner(core, { planKeyframe: (shot) => stills.planKeyframe(shot) })
  const stills = createStills(core, runner, cuts)
  const design = createDesign(core)
  const naming = createNaming(core)
  const voice = createVoice(core, runner)
  const video = createVideo(core, cuts, stills, voice)
  const scenes = createSceneRun(core, runner, video, voice)
  const director = createDirector(core)
  const assembly = createAssemble(core, cuts, video)

  return {
    story: core.story,
    aspect: core.aspect,
    update: core.update,
    updateShot: core.updateShot,
    modelFor: core.modelFor,
    readyVideoModels: core.readyVideoModels,
    modelForGroup: core.modelForGroup,
    modelForShot: core.modelForShot,
    workflowOf: core.workflowOf,
    setGroupModel: core.setGroupModel,
    setShotModel: core.setShotModel,
    takeModelId: core.takeModelId,
    takeSourceOf: core.takeSourceOf,
    takeModelLabel: core.takeModelLabel,
    takeCostUsd: core.takeCostUsd,
    outputOf: core.outputOf,
    jobState: core.jobState,
    keyframeOf: core.keyframeOf,
    keyframeHistoryOf: stills.keyframeHistoryOf,
    restoreKeyframe: stills.restoreKeyframe,
    setKeyframe: stills.setKeyframe,
    removeKeyframe: stills.removeKeyframe,
    forgetKeyframe: stills.forgetKeyframe,
    cancelShotRenders: core.cancelShotRenders,
    cancelSceneRenders: scenes.cancelSceneRenders,
    takesOf: core.takesOf,
    chosenVideoOf: core.chosenVideoOf,
    chooseTake: core.chooseTake,
    characterName: core.characterName,
    placeOf: core.placeOf,
    finalModel: core.finalModel,
    finalModelForGroup: video.finalModelForGroup,
    finalModelForShot: video.finalModelForShot,
    isFinalTake: core.isFinalTake,
    isFinalAsset: core.isFinalAsset,
    planKeyframe: stills.planKeyframe,
    planKeyframeEdit: stills.planKeyframeEdit,
    planShotsFromStill: stills.planShotsFromStill,
    shotsFromStill: stills.shotsFromStill,
    planVideoRef: stills.planVideoRef,
    videoRefOf: stills.videoRefOf,
    nameStoryTakes: naming.nameStoryTakes,
    makeVoiceSample: voice.makeVoiceSample,
    makingVoiceSample: voice.makingVoiceSample,
    imageEditBlocker: stills.imageEditBlocker,
    previousEnd: cuts.previousEnd,
    keyframeFromPrevious: stills.keyframeFromPrevious,
    planVideo: video.planVideo,
    planMultishot: video.planMultishot,
    groupSource: video.groupSource,
    canUseSource: video.canUseSource,
    setGroupSource: video.setGroupSource,
    groupShotByShot: video.groupShotByShot,
    groupCovered: video.groupCovered,
    clipGroupOf: video.clipGroupOf,
    renderSettings: core.renderSettings,
    groupFinalBlocker: video.groupFinalBlocker,
    shotFinalBlocker: video.shotFinalBlocker,
    planGroupFinal: video.planGroupFinal,
    planShotFinal: video.planShotFinal,
    planFinals: video.planFinals,
    planLines: voice.planLines,
    followsVoices: voice.followsVoices,
    voiceTrackOf: voice.voiceTrackOf,
    prepareVoiceTrack: voice.prepareVoiceTrack,
    dialogueFitOf: video.dialogueFitOf,
    lengthenForDialogue: video.lengthenForDialogue,
    splitForDialogue: video.splitForDialogue,
    shortenLines: video.shortenLines,
    groups: core.groups,
    groupOf: core.groupOf,
    groupShots: core.groupShots,
    groupTakes: core.groupTakes,
    groupCuts: video.groupCuts,
    groupLimitProblem: core.groupLimitProblem,
    takeCutsOf: cuts.takeCutsOf,
    detectTakeCuts: cuts.detectTakeCuts,
    cutsWanted: cuts.cutsWanted,
    chosenGroupVideo: core.chosenGroupVideo,
    chooseGroupTake: core.chooseGroupTake,
    canJoin: cuts.canJoin,
    joinWithNext: cuts.joinWithNext,
    breakUp: cuts.breakUp,
    endKeyframeOf: core.endKeyframeOf,
    planEndKeyframe: stills.planEndKeyframe,
    planEndKeyframeAfterStart: stills.planEndKeyframeAfterStart,
    planKeyframeAfterPreviousEnd: stills.planKeyframeAfterPreviousEnd,
    removeEndKeyframe: stills.removeEndKeyframe,
    setEndKeyframe: stills.setEndKeyframe,
    endCheckDue: stills.endCheckDue,
    checkingEnd: stills.checkingEnd,
    checkEndFrame: stills.checkEndFrame,
    setEndUse: stills.setEndUse,
    splitAtEnd: stills.splitAtEnd,
    updateGroup: core.updateGroup,
    estimate: runner.estimate,
    run: runner.run,
    runBatch: runner.runBatch,
    writeScript: director.writeScript,
    outlineStory: director.outlineStory,
    applyOutline: director.applyOutline,
    sceneWork: director.sceneWork,
    sceneShotsRequest: director.sceneShotsRequest,
    writeShotsForScene: director.writeShotsForScene,
    writingShots: director.writingShots,
    applySceneShots: director.applySceneShots,
    updateRequest: director.updateRequest,
    updateScenes: director.updateScenes,
    updateScene: core.updateScene,
    updateChapter: core.updateChapter,
    shotName: core.shotName,
    sceneKey,
    planContinued: video.planContinued,
    designModel: design.designModel,
    setDesignModel: design.setDesignModel,
    planDesign: design.planDesign,
    approveDesign: design.approveDesign,
    quickLooking: design.quickLooking,
    planQuickLooks: design.planQuickLooks,
    openingFromPrevious: stills.openingFromPrevious,
    planSceneAnimation: scenes.planSceneAnimation,
    animateScene: scenes.animateScene,
    stopScene: scenes.stopScene,
    sceneRunOf: scenes.sceneRunOf,
    stillsContext: video.stillsContext,
    stillsWanted: video.stillsWanted,
    sceneProgress: scenes.sceneProgress,
    waitingFor: scenes.waitingFor,
    preparingOf: runner.preparingOf,
    assemble: assembly.assemble,
    storyCutEdited: assembly.storyCutEdited,
    linesToVoice: assembly.linesToVoice,
    voiceAnimatic: assembly.voiceAnimatic,
    assembleAnimatic: assembly.assembleAnimatic,
    applyTiming: assembly.applyTiming,
  }
}

export type Story = ReturnType<typeof createStory>

/**
 * The storyboard, one per Pinia — the app's one, a fresh one per test — keyed by its project store (which every Pinia
 * has one of). What it holds is the stores' and the parts' module state, so sharing it changes nothing but the cost.
 */
const shared = new WeakMap<object, Story>()

export function useStory(): Story {
  // In a component the store comes from its app's Pinia; elsewhere (a handler, a lazy import) from the active one.
  const project = useProjectStore()
  let story = shared.get(project)
  if (!story) {
    // A scope of its own: not stopped with whichever component happened to ask first (a scene run outlives its card).
    story = effectScope(true).run(createStory)!
    shared.set(project, story)
  }
  return story
}

export type StoryKind = Extract<GenKind, 'image' | 'video' | 'speech'>
