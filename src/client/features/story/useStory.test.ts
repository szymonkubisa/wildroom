import type { AppSettings, ProviderStatus } from '@shared/types/api'
import type { AssetDTO } from '@shared/types/assets'
import type { GenerationDTO } from '@shared/types/jobs'
import { createEmptyDoc } from '@shared/types/project-doc'
import { secondsToFlicks } from '@shared/time/flicks'
import type { BreakdownShot, StoryDoc } from '@shared/types/story'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { toast } from 'vue-sonner'
import { useAssetsStore } from '@/stores/assets'
import { useJobsStore } from '@/stores/jobs'
import { useProjectStore } from '@/stores/project'
import { useSettingsStore } from '@/stores/settings'
import { api } from '@/lib/api'
import { nameStoryTakes } from './storyNaming'
import { type Planned, createStory, useStory } from './useStory'

// "Render with…": what the composable resolves and records around the pure planners (planning.ts).

// The settings store applies the theme through window.matchMedia, which the node test environment hasn't got.
vi.mock('@/lib/theme', () => ({ applyTheme: () => {} }))
// toast() itself is followed too, not only its methods: what a run tells the user ("2 more keyframes start…") is
// part of what it does.
vi.mock('vue-sonner', async (importOriginal) => {
  const real = await importOriginal<typeof import('vue-sonner')>()
  return { ...real, toast: Object.assign(vi.fn(), real.toast) }
})

class FakeEventSource {
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onerror: (() => void) | null = null
  close() {}
}

const DRAFT = 'local-ltx-2.5'
const FINAL = 'runpod-ltx-2.5'

function asset(id: string, extra: Partial<AssetDTO> = {}): AssetDTO {
  return {
    id,
    kind: 'image',
    name: id,
    status: 'ready',
    source: 'import',
    hasVideo: false,
    hasAudio: false,
    variants: {},
    parentIds: [],
    rating: 0,
    keywords: [],
    projectIds: ['p1'],
    createdAt: '2026-10-09T00:00:00.000Z',
    ...extra,
  } as AssetDTO
}

/** A finished video take: its job and its asset. */
function take(jobs: ReturnType<typeof useJobsStore>, assets: ReturnType<typeof useAssetsStore>, id: string, modelId: string) {
  const job: GenerationDTO = {
    id,
    projectId: 'p1',
    modelId,
    provider: 'fal',
    kind: 'video',
    status: 'succeeded',
    progress: 1,
    label: id,
    params: {},
    outputAssetIds: [`${id}-out`],
    variant: 0,
    createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:00.000Z',
  }
  jobs.byId[id] = job
  assets.upsert(
    asset(`${id}-out`, {
      kind: 'video',
      source: 'generation',
      hasVideo: true,
      durationFlicks: secondsToFlicks(7),
      fps: 24,
      generation: { generationId: id, modelId, modelLabel: modelId, provider: 'fal', params: {} },
    } as Partial<AssetDTO>),
  )
}

function story(): StoryDoc {
  return {
    script: '',
    style: 'Cinematic',
    characters: [
      { id: 'maja', name: 'Maja', description: 'a woman in a green raincoat', refAssetId: 'maja-front' },
      { id: 'tymon', name: 'Tymon', description: 'a tall man in a navy coat', refAssetId: 'tymon-front' },
    ],
    shots: [
      { id: 's1', description: '', shotType: 'wide', prompt: 'Maja waits.', duration: 4, characterIds: ['maja'], dialogue: [], keyframeAssetId: 'kf1', videoGenerationIds: [] },
      { id: 's2', description: '', shotType: 'close-up', prompt: 'Tymon smiles.', duration: 3, characterIds: ['tymon'], dialogue: [], keyframeAssetId: 'kf2', videoGenerationIds: [] },
      { id: 's3', description: '', shotType: 'close-up', prompt: 'Maja sighs.', duration: 5, characterIds: ['maja'], dialogue: [], keyframeAssetId: 'kf3', videoGenerationIds: [] },
    ],
    multishots: [{ id: 'g1', shotIds: ['s1', 's2'], videoGenerationIds: [] }],
    videoModelId: DRAFT,
    finalVideoModelId: FINAL,
    videoSettings: { audio: true },
    finalVideoSettings: { resolution: '1080p', fps: 25 },
  }
}

function setup(configured: string[] = ['local', 'runpod', 'fal', 'kling']) {
  const settings = useSettingsStore()
  settings.app = { demoMode: false } as AppSettings
  settings.providers = configured.map((id) => ({ id, label: id, configured: true, fields: {}, enabled: true }) as ProviderStatus)
  const assets = useAssetsStore()
  for (const id of ['maja-front', 'tymon-front', 'kf1', 'kf2', 'kf3']) assets.upsert(asset(id))
  const project = useProjectStore()
  project.doc = { ...createEmptyDoc(), story: story() }
  return { st: useStory(), project, jobs: useJobsStore(), assets }
}

const doc = (project: ReturnType<typeof useProjectStore>) => project.doc.story!
const planned = <T,>(plan: T | string): T => {
  if (typeof plan === 'string') throw new Error(plan)
  return plan
}

describe('useStory — Render with…', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
  })
  afterEach(() => vi.unstubAllGlobals())

  it('a group renders with its own model, its shots with it, other shots with the story’s', () => {
    const { st, project } = setup()
    st.setGroupModel(doc(project).multishots![0]!, 'fal-veo3.1')
    const g = doc(project).multishots![0]!
    expect(g.modelId).toBe('fal-veo3.1')
    expect(st.modelForGroup(g)?.id).toBe('fal-veo3.1')
    expect(st.modelForShot(doc(project).shots[1]!)?.id).toBe('fal-veo3.1')
    expect(st.modelForShot(doc(project).shots[2]!)?.id).toBe(DRAFT)
    expect(st.groupCuts(g).total).toBe(8)
    expect(st.workflowOf(g).multishot.maxSeconds).toBe(8)
    expect(planned(st.planMultishot(g)).model.id).toBe('fal-veo3.1')
    // opts.model still wins.
    expect(planned(st.planMultishot(g, { model: st.finalModel() })).model.id).toBe(FINAL)
    st.setShotModel(doc(project).shots[2]!, 'kling-3.0')
    expect(st.modelForShot(doc(project).shots[2]!)?.id).toBe('kling-3.0')
    expect(st.canJoin(doc(project).shots[1]!)).toBe(true)
    st.setGroupModel(doc(project).multishots![0]!, undefined)
    expect(doc(project).multishots![0]!.modelId).toBeUndefined()
  })

  it('a choice whose model can’t render now falls back to the story’s video model', () => {
    const { st, project } = setup(['local', 'runpod'])
    st.setGroupModel(doc(project).multishots![0]!, 'fal-veo3.1')
    expect(st.modelForGroup(doc(project).multishots![0]!)?.id).toBe(DRAFT)
    st.setGroupModel(doc(project).multishots![0]!, 'no-such-model')
    expect(st.modelForGroup(doc(project).multishots![0]!)?.id).toBe(DRAFT)
  })

  it('takes record their model and source; one made with the final model as a draft isn’t labelled final', () => {
    const { st, project, jobs, assets } = setup()
    st.setGroupModel(doc(project).multishots![0]!, FINAL)
    // Picked: Auto now renders from the keyframe (13.10).
    st.setGroupSource(doc(project).multishots![0]!, 'references')
    planned(st.planMultishot(doc(project).multishots![0]!)).apply('gen-g')
    take(jobs, assets, 'gen-g', FINAL)
    expect(doc(project).multishots![0]!.takes!['gen-g']).toEqual({ planned: [4], total: 7, modelId: FINAL, source: 'references' })
    expect(st.takeModelId('gen-g')).toBe(FINAL)
    expect(st.takeSourceOf('gen-g')).toBe('references')
    expect(st.isFinalTake('gen-g')).toBe(false)
    expect(st.isFinalAsset(assets.get('gen-g-out'))).toBe(false)

    planned(st.planVideo(doc(project).shots[2]!)).apply('gen-s')
    expect(doc(project).shots[2]!.takes!['gen-s']).toEqual({ modelId: DRAFT, source: 'keyframe' })

    // A final render is final by its record.
    planned(st.planMultishot(doc(project).multishots![0]!, { model: st.finalModel(), final: true })).apply('gen-f')
    expect(st.isFinalTake('gen-f')).toBe(true)

    // An older take, from before take records: judged by its model.
    take(jobs, assets, 'gen-old', FINAL)
    expect(st.takeModelId('gen-old')).toBe(FINAL)
    expect(st.isFinalTake('gen-old')).toBe(true)
  })

  it('final renders: the final model for a take of its family, the take’s own model (final settings) for another', () => {
    const { st, project, jobs, assets } = setup()
    // The group's chosen take came from Veo, shot 3's from the draft LTX.
    st.setGroupModel(doc(project).multishots![0]!, 'fal-veo3.1')
    planned(st.planMultishot(doc(project).multishots![0]!)).apply('gen-veo')
    take(jobs, assets, 'gen-veo', 'fal-veo3.1')
    planned(st.planVideo(doc(project).shots[2]!)).apply('gen-ltx')
    take(jobs, assets, 'gen-ltx', DRAFT)

    expect(st.finalModelForGroup(doc(project).multishots![0]!)?.id).toBe('fal-veo3.1')
    expect(st.finalModelForShot(doc(project).shots[0]!)?.id).toBe('fal-veo3.1')
    expect(st.finalModelForShot(doc(project).shots[2]!)?.id).toBe(FINAL)
    const plans = st.planFinals().map((p) => planned(p))
    expect(plans.map((p) => [p.model.id, p.label])).toEqual([
      ['fal-veo3.1', 'Final multi-shot · shots 1–2'],
      [FINAL, 'Final · shot 3'],
    ])
    expect(plans[0]!.params).toMatchObject({ resolution: '1080p', duration: 8 })
    expect(plans[0]!.params.fps).toBeUndefined()
    expect(plans[1]!.params).toMatchObject({ resolution: '1080p', fps: 25 })

    // Once rendered, the finals are final and nothing is planned again.
    plans[0]!.apply('gen-veo-final')
    take(jobs, assets, 'gen-veo-final', 'fal-veo3.1')
    plans[1]!.apply('gen-ltx-final')
    take(jobs, assets, 'gen-ltx-final', FINAL)
    expect(st.planFinals()).toEqual([])
  })

  it('final blockers say what the final model is missing; plans return the same reason', () => {
    const { st, project } = setup()
    const shot3 = () => doc(project).shots[2]!
    expect(st.groupFinalBlocker(doc(project).multishots![0]!)).toBeUndefined()
    expect(st.shotFinalBlocker(shot3())).toBeUndefined()
    st.removeKeyframe(shot3())
    expect(st.shotFinalBlocker(shot3())).toBe('Shot 3 has no still — LTX-2.5 (RunPod GPU) renders the final from the draft’s still')
    expect(st.planShotFinal(shot3())).toBe(st.shotFinalBlocker(shot3()))
    // A final model that starts only from a keyframe, and no keyframe for the group's first shot.
    st.update('Final model', (s) => (s.finalVideoModelId = DRAFT))
    st.removeKeyframe(doc(project).shots[0]!)
    expect(st.groupFinalBlocker(doc(project).multishots![0]!)).toBe('The final render with LTX-2.5 (this Mac) needs shot 1’s still')
    expect(st.planGroupFinal(doc(project).multishots![0]!)).toBe(st.groupFinalBlocker(doc(project).multishots![0]!))
    st.update('Final model', (s) => (s.finalVideoModelId = undefined))
    expect(st.groupFinalBlocker(doc(project).multishots![0]!)).toBe('Pick a final model first')
  })

  it('take badges name the take’s model, from the catalog or the asset’s record; costs come from the job', () => {
    const { st, jobs, assets } = setup()
    take(jobs, assets, 'gen-k', 'fal-kling-3.0')
    expect(st.takeModelLabel('gen-k')).toEqual({ short: 'Kling 3.0', label: 'Kling 3.0 (fal)' })
    take(jobs, assets, 'gen-gone', 'retired-model')
    expect(st.takeModelLabel('gen-gone')).toEqual({ short: 'retired-model', label: 'retired-model' })
    expect(st.takeModelLabel('gen-none')).toBeUndefined()
    expect(st.takeCostUsd('gen-k')).toBeUndefined()
    jobs.byId['gen-k']!.costUsd = 1.68
    expect(st.takeCostUsd('gen-k')).toBe(1.68)
  })

  it('a take older than the jobs the client is sent still shows: found by the generation its asset records', () => {
    const { st, project, jobs, assets } = setup()
    take(jobs, assets, 'gen-old', 'fal-kling-3.0')
    doc(project).shots[2]!.videoGenerationIds = ['gen-old']
    // The server sends only the newest 300 jobs: this one isn't among them.
    delete jobs.byId['gen-old']
    expect(st.chosenVideoOf(doc(project).shots[2]!)?.id).toBe('gen-old-out')
    expect(st.jobState('gen-old')?.status).toBe('succeeded')
    expect(st.takeModelId('gen-old')).toBe('fal-kling-3.0')
    expect(st.jobState('gen-unknown')).toBeUndefined()
  })
})

describe('useStory — take names', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renames older takes and their timeline pieces after the shots they show; typed names stay', async () => {
    const { st, project, jobs, assets } = setup()
    project.id = 'p1'
    const s = doc(project)
    s.shots[0]!.description = 'Maja waits for the train.'
    s.shots[1]!.description = 'Tymon smiles at her.'
    const prompt = 'A multi-shot sequence of 2 shots joined by hard cuts, about 7 seconds in total. Image 1: Maja'
    take(jobs, assets, 'gen-g', FINAL)
    jobs.byId['gen-g']!.params = { prompt }
    const auto = 'A multi-shot sequence of 2 shots joined by hard…'
    assets.upsert({ ...assets.get('gen-g-out')!, name: auto })
    s.multishots![0]!.videoGenerationIds = ['gen-g']
    s.multishots![0]!.takes = { 'gen-g': { planned: [4], total: 7, detected: [4] } }
    const fps = project.doc.settings.fps
    const piece = (id: string, from: number, seconds: number, name: string) => ({
      kind: 'media' as const,
      id,
      name,
      duration: Math.round(seconds * fps),
      enabled: true,
      speed: 1,
      active: 0,
      takes: [{ id: `${id}-t`, assetId: 'gen-g-out', sourceIn: secondsToFlicks(from) }],
    })
    project.doc.spine = [piece('a', 0, 4, auto), piece('b', 4, 3, auto), piece('whole', 0, 7, auto), piece('mine', 0, 4, 'My favourite bit')]
    const update = vi.spyOn(api.assets, 'update').mockImplementation(async (id, patch) => ({ ...assets.get(id)!, ...patch }) as AssetDTO)

    expect(await st.nameStoryTakes()).toBe(4)
    expect(update).toHaveBeenCalledWith('gen-g-out', { name: 'Maja waits for the train.' })
    expect(assets.get('gen-g-out')!.name).toBe('Maja waits for the train.')
    expect(project.doc.spine.map((c) => c.name)).toEqual(['Maja waits for the train.', 'Tymon smiles at her.', 'Maja waits for the train.', 'My favourite bit'])
    // Once per session; forced (after a split) it names pieces still called after the whole take.
    expect(await st.nameStoryTakes()).toBe(0)
    project.applyFact((d) => {
      d.spine.push(piece('c', 4, 3, 'Maja waits for the train.'))
    })
    expect(await st.nameStoryTakes({ force: true })).toBe(1)
    expect(project.doc.spine.at(-1)!.name).toBe('Tymon smiles at her.')
  })
})

describe('useStory — dialogue shots made to their ElevenLabs lines', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
  })
  afterEach(() => vi.unstubAllGlobals())

  /** Shot 3 on LTX (GPU) with Maja's line, voiced by ElevenLabs (a 2 s line). */
  function voicedShot() {
    const ctx = setup()
    const s = doc(ctx.project)
    s.videoModelId = FINAL
    s.characters[0]!.voiceId = 'el-maja'
    s.shots[2]!.dialogue = [{ id: 'l1', characterId: 'maja', text: 'Twenty more minutes.', generationId: 'gen-line' }]
    ctx.jobs.byId['gen-line'] = {
      id: 'gen-line', projectId: 'p1', modelId: 'elevenlabs-v3', provider: 'elevenlabs', kind: 'speech', status: 'succeeded', progress: 1,
      label: 'line', params: {}, outputAssetIds: ['line-out'], variant: 0, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z',
    } as GenerationDTO
    ctx.assets.upsert(asset('line-out', { kind: 'audio', hasAudio: true, durationFlicks: secondsToFlicks(2) } as Partial<AssetDTO>))
    return ctx
  }

  it('plans the voice track first when it isn’t made yet', () => {
    const { st, project } = voicedShot()
    const shot = doc(project).shots[2]!
    expect(st.followsVoices(shot)).toBe(true)
    expect(st.voiceTrackOf(shot)).toBeUndefined()
    const plan = planned(st.planVideo(shot))
    expect(plan.prepare).toBeTypeOf('function')
    expect(plan.params.audioClip).toBeUndefined()
  })

  it('renders to a ready voice track and records it on the take; a changed line makes it stale', () => {
    const { st, project, assets } = voicedShot()
    assets.upsert(asset('track', { kind: 'audio', hasAudio: true }))
    doc(project).shots[2]!.voiceTrack = { assetId: 'track', key: 'line-out@5' }
    const shot = doc(project).shots[2]!
    expect(st.voiceTrackOf(shot)).toEqual({ id: 'track', seconds: 5 })
    const plan = planned(st.planVideo(shot))
    expect(plan.prepare).toBeUndefined()
    expect(plan.params).toMatchObject({ firstFrame: 'kf3', audioClip: 'track', duration: 5 })
    plan.apply('gen-v')
    expect(doc(project).shots[2]!.takes!['gen-v']).toMatchObject({ modelId: FINAL, voiceTrackAssetId: 'track' })

    st.updateShot('s3', 'Edit line', (x) => (x.dialogue[0]!.generationId = undefined))
    expect(st.voiceTrackOf(doc(project).shots[2]!)).toBeUndefined()
  })
})

describe('useStory — a shot with a Blender previs', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
  })
  afterEach(() => vi.unstubAllGlobals())

  it('won’t render from the grey previs frame as the still (the clip would come out grey)', () => {
    const { st, project } = setup()
    // Shot 3's still is kf3: as the previs's own first frame it is refused, a still drawn over the previs is not.
    doc(project).shots[2]!.previs = { assetId: 'layout', firstFrameAssetId: 'kf3' }
    expect(st.planVideo(doc(project).shots[2]!)).toMatch(/grey previs frame/)
    doc(project).shots[2]!.previs = { assetId: 'layout', firstFrameAssetId: 'grey' }
    expect(typeof st.planVideo(doc(project).shots[2]!)).toBe('object')
  })
})

/** Lets watchers, store updates and the awaits after them run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

/** Jobs made by `create` start queued, as the server makes them; cancel cancels. */
function fakeQueue(ctx: ReturnType<typeof setup>) {
  let n = 0
  const create = vi.spyOn(ctx.jobs, 'create').mockImplementation(async (req) => {
    const id = `job-${++n}`
    ctx.jobs.byId[id] = {
      id, projectId: 'p1', modelId: req.modelId, provider: 'local', kind: 'video', status: 'queued', progress: 0, label: id,
      params: req.params, outputAssetIds: [], variant: 0, createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z',
    } as GenerationDTO
    return [ctx.jobs.byId[id]!]
  })
  vi.spyOn(ctx.jobs, 'cancel').mockImplementation(async (id) => void (ctx.jobs.byId[id]!.status = 'canceled'))
  return create
}

describe('useStory — Animate scene', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /**
   * One scene: shot 1 on its own, then shot 2 continuing it. Scene runs live with the page (module state), so each
   * test animates a scene of its own.
   */
  function scene(id = 'sc') {
    const ctx = setup()
    const s = doc(ctx.project)
    s.multishots = []
    s.scenes = [{ id, title: 'Station' }]
    s.shots = [s.shots[0]!, { ...s.shots[2]!, continues: true, keyframeAssetId: undefined }]
    for (const x of s.shots) x.sceneId = id
    return ctx
  }

  /** Shot 1's take (job-1) is done: its clip ready, 4 s. */
  function firstTakeDone(ctx: ReturnType<typeof setup>) {
    Object.assign(ctx.jobs.byId['job-1']!, { status: 'succeeded', outputAssetIds: ['take-1'] })
    ctx.assets.upsert(asset('take-1', { kind: 'video', hasVideo: true, durationFlicks: secondsToFlicks(4), fps: 24 } as Partial<AssetDTO>))
  }

  beforeEach(() => vi.mocked(toast).mockClear())

  it('starts the shots that can start, the continuing one waits for the take before it; it says what it waits for', async () => {
    const ctx = scene('sc-wait')
    const { st, project } = ctx
    const create = fakeQueue(ctx)
    vi.spyOn(api.assets, 'frame').mockImplementation(async () => asset('last-frame'))
    expect(await st.animateScene('sc-wait')).toBe(1)
    expect(create).toHaveBeenCalledTimes(1)
    expect(doc(project).shots[0]!.videoGenerationIds).toEqual(['job-1'])
    expect(toast).toHaveBeenCalledWith('1 continuing shot waits for the take before it', { description: 'Each picks up where the previous take ends.' })
    expect(st.sceneRunOf('sc-wait')).toEqual({ rendering: 1, waiting: ['s3'] })
    expect(st.waitingFor(doc(project).shots[1]!)).toBe('1')
    expect(st.waitingFor(doc(project).shots[0]!)).toBeUndefined()
    // Pressed again meanwhile: nothing more starts.
    expect(await st.animateScene('sc-wait')).toBe(0)
    expect(toast).toHaveBeenCalledWith('This scene is already animating', { description: 'Its continuing shots start as the takes before them are ready.' })
    expect(st.planSceneAnimation('sc-wait')).toEqual({ plans: ['This scene is already animating — its continuing shots start as the takes before them are ready'], continuing: 0 })
    firstTakeDone(ctx)
    await settle()
    // Shot 2 starts from the last frame of shot 1's take (local LTX doesn't continue clips), which became its keyframe.
    expect(create).toHaveBeenCalledTimes(2)
    expect(doc(project).shots[1]!.keyframeAssetId).toBe('last-frame')
    expect(doc(project).shots[1]!.takes!['job-2']).toMatchObject({ modelId: DRAFT, startFrom: { shotId: 's1', assetId: 'last-frame', via: 'frame' } })
    expect(st.sceneRunOf('sc-wait')).toEqual({ rendering: 1, waiting: [] })
    expect(st.waitingFor(doc(project).shots[1]!)).toBeUndefined()
  })

  it('every shot has a take from its model: it says so and starts nothing', async () => {
    const ctx = scene('sc-done')
    const { st, project, jobs, assets } = ctx
    const create = fakeQueue(ctx)
    for (const [i, shot] of doc(project).shots.entries()) {
      planned(st.planVideo(shot)).apply(`gen-${i}`)
      take(jobs, assets, `gen-${i}`, DRAFT)
    }
    expect(await st.animateScene('sc-done')).toBe(0)
    expect(toast).toHaveBeenCalledWith('Every shot of this scene has a take', { description: 'Use Another take on a shot for more.' })
    expect(create).not.toHaveBeenCalled()
    expect(st.sceneRunOf('sc-done')).toBeUndefined()
  })

  it('Stop cancels the run’s queued takes, and its continuing shot doesn’t start', async () => {
    const ctx = scene('sc-stop')
    const { st, jobs } = ctx
    const create = fakeQueue(ctx)
    expect(await st.animateScene('sc-stop')).toBe(1)
    await st.stopScene('sc-stop')
    expect(jobs.cancel).toHaveBeenCalledWith('job-1')
    expect(toast).toHaveBeenCalledWith('Stopped — 1 queued take canceled', { description: 'Takes already rendering will finish.' })
    expect(st.sceneRunOf('sc-stop')).toBeUndefined()
    await settle()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('…a take already rendering finishes (it may be paid for), and the continuing shot still doesn’t start', async () => {
    const ctx = scene('sc-stop-running')
    const { st, jobs, project } = ctx
    const create = fakeQueue(ctx)
    vi.spyOn(api.assets, 'frame').mockImplementation(async () => asset('last-frame'))
    await st.animateScene('sc-stop-running')
    jobs.byId['job-1']!.status = 'running'
    await st.stopScene('sc-stop-running')
    expect(jobs.cancel).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('Stopped', { description: 'Takes already rendering will finish.' })
    expect(st.sceneRunOf('sc-stop-running')).toEqual({ rendering: 1, waiting: [] })
    firstTakeDone(ctx)
    await settle()
    expect(create).toHaveBeenCalledTimes(1)
    expect(doc(project).shots[1]!.videoGenerationIds).toEqual([])
    // Stopping a scene that isn't animating does nothing.
    vi.mocked(toast).mockClear()
    await st.stopScene('no-such-scene')
    expect(toast).not.toHaveBeenCalled()
  })

  it('its project closed while the continuing shot waits: it isn’t started (it would be paid for in the project open then)', async () => {
    const ctx = scene('sc-closed')
    ctx.project.id = 'p1'
    const create = fakeQueue(ctx)
    const frame = vi.spyOn(api.assets, 'frame').mockImplementation(async () => asset('last-frame'))
    expect(await ctx.st.animateScene('sc-closed')).toBe(1)
    ctx.project.id = 'p2'
    firstTakeDone(ctx)
    await settle()
    expect(create).toHaveBeenCalledTimes(1)
    expect(frame).not.toHaveBeenCalled()
  })

  it('prices the continuing shot as it will render — from the take before it — before anything starts', () => {
    const { st, project } = scene()
    const { plans, continuing } = st.planSceneAnimation('sc')
    expect(continuing).toBe(1)
    const [first, next] = plans.map((p) => planned(p))
    expect(first!.params.firstFrame).toBe('kf1')
    // Local LTX starts it from the last frame of the take before; LTX on the GPU continues that take's clip (priced
    // with the frames it adds).
    expect(next!.params.firstFrame).toBe('the-take-before')
    expect(next!.label).toMatch(/after the take before it/)
    doc(project).shots[1]!.modelId = FINAL
    const gpu = planned(st.planSceneAnimation('sc').plans[1]!)
    expect(gpu.params).toMatchObject({ continueFrom: 'the-take-before' })
    expect(gpu.params.firstFrame).toBeUndefined()
  })

  it('animated again after Stop, the stopped run’s loop doesn’t start the continuing shot too; Stop keeps the earlier takes', async () => {
    const ctx = scene()
    const { st, jobs, assets, project } = ctx
    const create = fakeQueue(ctx)
    vi.spyOn(api.assets, 'frame').mockImplementation(async () => asset('last-frame'))
    expect(await st.animateScene('sc')).toBe(1)
    jobs.byId['job-1']!.status = 'running'
    await st.stopScene('sc')
    // Animated again while shot 1's take renders on: shot 2 waits for it in the new run.
    await st.animateScene('sc')
    expect(st.sceneRunOf('sc')).toEqual({ rendering: 1, waiting: ['s3'] })
    // Shot 1's take is done: both runs' loops wake.
    Object.assign(jobs.byId['job-1']!, { status: 'succeeded', outputAssetIds: ['take-1'] })
    assets.upsert(asset('take-1', { kind: 'video', hasVideo: true, durationFlicks: secondsToFlicks(4), fps: 24 } as Partial<AssetDTO>))
    await settle()
    expect(create).toHaveBeenCalledTimes(2)
    expect(doc(project).shots[1]!.videoGenerationIds).toEqual(['job-2'])
    expect(doc(project).shots[1]!.takes!['job-2']!.startFrom).toMatchObject({ shotId: 's1', via: 'frame' })
  })
})

describe('useStory — chained stills and inputs', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Shot 3's end frame, drawn once its keyframe — a render that is `status` — is there. */
  function waitingEnd(status: GenerationDTO['status']) {
    const ctx = setup()
    const s = doc(ctx.project).shots[2]!
    s.endFrame = 'Maja looks up at the departures board.'
    s.keyframeAssetId = undefined
    s.keyframeGenerationId = 'kf-job'
    ctx.jobs.byId['kf-job'] = { ...ctx.jobs.byId['kf-job'], id: 'kf-job', projectId: 'p1', modelId: 'fal-nano-banana-pro', provider: 'fal', kind: 'image', status, progress: 0, label: 'kf', params: {}, outputAssetIds: [], variant: 0, createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z' } as GenerationDTO
    return { ...ctx, plan: planned(ctx.st.planEndKeyframeAfterStart(doc(ctx.project).shots[2]!)) }
  }

  it('an end frame waiting for a keyframe that fails says so at once (it waited 20 minutes) — and is on its way meanwhile', async () => {
    const ctx = waitingEnd('running')
    const create = fakeQueue(ctx)
    await ctx.st.run([ctx.plan])
    // No job while it waits: Stills again must see it coming, not draw it again.
    expect(ctx.st.preparingOf(doc(ctx.project).shots[2]!, 'end')).toBe('its still')
    ctx.jobs.byId['kf-job']!.status = 'failed'
    await settle()
    expect(ctx.st.preparingOf(doc(ctx.project).shots[2]!, 'end')).toBeUndefined()
    expect(create).not.toHaveBeenCalled()
  })

  it('…but a keyframe that failed before the batch is an old one: it waits for the new one', async () => {
    const ctx = waitingEnd('failed')
    let result: unknown = 'pending'
    void ctx.plan.prepare!().then((r) => (result = r))
    await settle()
    expect(result).toBe('pending')
    // The batch's keyframe is done.
    ctx.jobs.byId['kf-new'] = { ...ctx.jobs.byId['kf-job']!, id: 'kf-new', status: 'succeeded', outputAssetIds: ['kf-new-out'] }
    ctx.assets.upsert(asset('kf-new-out'))
    ctx.st.updateShot('s3', 'Keyframe', (x) => (x.keyframeGenerationId = 'kf-new'))
    await settle()
    expect(planned(result as Planned | string).params.referenceImages).toContain('kf-new-out')
  })

  it('the shot deleted meanwhile: given up at once', async () => {
    const { st, plan } = waitingEnd('running')
    const out = plan.prepare!()
    st.update('Delete shot', (s) => (s.shots = s.shots.filter((x) => x.id !== 's3')))
    expect(await out).toMatch(/not drawn — the shot was deleted/)
  })

  it('a take waits for a keyframe still processing instead of sending it (the server refused it)', async () => {
    const ctx = setup()
    // Its job just done, the picture still being processed.
    ctx.assets.upsert(asset('kf-new', { status: 'processing' }))
    doc(ctx.project).shots[2]!.keyframeAssetId = 'kf-new'
    const create = fakeQueue(ctx)
    const started = ctx.st.run([ctx.st.planVideo(doc(ctx.project).shots[2]!)])
    await settle()
    expect(create).not.toHaveBeenCalled()
    ctx.assets.upsert(asset('kf-new'))
    expect(await started).toBe(1)
    expect(create.mock.calls[0]![0].params.firstFrame).toBe('kf-new')
  })
})

describe('useStory — a new hero look', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
  })
  afterEach(() => vi.unstubAllGlobals())

  it('drops the LTX video reference drawn from the old pictures; the same front view keeps it', () => {
    const { st, project } = setup()
    const maja = () => doc(project).characters[0]!
    maja().videoRefAssetId = 'maja-grey'
    st.approveDesign('character', 'maja', 'maja-front', [{ assetId: 'maja-side' }])
    expect(maja().videoRefAssetId).toBe('maja-grey')
    st.approveDesign('character', 'maja', 'maja-new', [])
    expect(maja()).toMatchObject({ refAssetId: 'maja-new', videoRefAssetId: undefined, videoRefGenerationId: undefined })
  })
})

describe('useStory — quick looks', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
  })
  afterEach(() => vi.unstubAllGlobals())

  /** A finished design picture: its job and its asset. */
  function drawn(jobs: ReturnType<typeof useJobsStore>, assets: ReturnType<typeof useAssetsStore>, id: string) {
    jobs.byId[id] = { id, projectId: 'p1', modelId: 'x', provider: 'fal', kind: 'image', status: 'succeeded', progress: 1, label: id, params: {}, outputAssetIds: [`${id}-out`], variant: 0, createdAt: '', updatedAt: '' } as GenerationDTO
    assets.upsert(asset(`${id}-out`, { source: 'generation' }))
  }

  it('plans one for each hero and place without a main picture, and uses it once drawn', async () => {
    const { st, project, jobs, assets } = setup()
    project.applyFact((d) => {
      d.story!.characters[1]!.refAssetId = undefined
      d.story!.places = [{ id: 'cafe', name: 'Cafe', description: 'a small corner cafe' }]
    })
    const plans = st.planQuickLooks()
    expect(plans).toHaveLength(2)
    planned(plans[0]!).apply('g-tymon')
    planned(plans[1]!).apply('g-cafe')
    expect(st.quickLooking('character', 'tymon')).toBe(true)
    // On its way: not planned again.
    expect(st.planQuickLooks()).toHaveLength(0)

    drawn(jobs, assets, 'g-tymon')
    drawn(jobs, assets, 'g-cafe')
    await Promise.resolve()
    await new Promise((r) => setTimeout(r))
    expect(doc(project).characters[1]!.refAssetId).toBe('g-tymon-out')
    expect(doc(project).places![0]!.refAssetIds).toEqual(['g-cafe-out'])
    expect(st.quickLooking('character', 'tymon')).toBe(false)

    // Removed later, the front view isn't put back.
    project.applyFact((d) => (d.story!.characters[1]!.refAssetId = undefined))
    await new Promise((r) => setTimeout(r))
    expect(doc(project).characters[1]!.refAssetId).toBeUndefined()
  })

  it('draws with the designer’s own model when one is set', () => {
    const { st } = setup()
    const other = useSettingsStore().availableModels.find((m) => m.kind === 'image' && m.id !== st.modelFor('image')?.id && useSettingsStore().modelReady(m) && !m.demoOnly)
    expect(other).toBeDefined()
    st.setDesignModel(other!.id)
    expect(st.designModel()?.id).toBe(other!.id)
    expect(st.modelFor('image')?.id).not.toBe(other!.id)
    expect(planned(st.planDesign('character', 'maja')).model.id).toBe(other!.id)
  })
})

describe('useStory — run: starting plans', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
    vi.mocked(toast).mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('problems are toasted — the first, and how many more — and the plans start, each applied with its job', async () => {
    const ctx = setup()
    const create = fakeQueue(ctx)
    const warning = vi.spyOn(toast, 'warning')
    const started = await ctx.st.run(['Pick a voice for Maja in the cast panel', ctx.st.planVideo(doc(ctx.project).shots[2]!), 'Pick a voice for Tymon in the cast panel'])
    expect(started).toBe(1)
    expect(warning).toHaveBeenCalledWith('Pick a voice for Maja in the cast panel', { description: '+1 more' })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![0]).toMatchObject({ modelId: DRAFT, params: { firstFrame: 'kf3' } })
    expect(doc(ctx.project).shots[2]!.videoGenerationIds).toEqual(['job-1'])
    // One problem alone: no "+ more".
    await ctx.st.run(['No voice model available — add an ElevenLabs key or enable demo mode'])
    expect(warning).toHaveBeenLastCalledWith('No voice model available — add an ElevenLabs key or enable demo mode', { description: undefined })
  })

  it('a plan whose params don’t parse, or whose job isn’t made, is toasted and not counted; the others start', async () => {
    const ctx = setup()
    const create = fakeQueue(ctx)
    const error = vi.spyOn(toast, 'error')
    const plan = planned(ctx.st.planVideo(doc(ctx.project).shots[2]!))
    const broken: Planned = { ...plan, label: 'Broken', params: { ...plan.params, prompt: 42 as unknown as string } }
    expect(await ctx.st.run([broken, plan])).toBe(1)
    expect(error.mock.calls[0]![0]).toMatch(/^Broken: /)
    expect(create).toHaveBeenCalledTimes(1)
    create.mockRejectedValueOnce(new Error('The queue is full'))
    expect(await ctx.st.run([plan])).toBe(0)
    expect(error).toHaveBeenLastCalledWith(`${plan.label} failed`, { description: 'The queue is full' })
  })

  it('a plan with work to do first starts once that is done, in the background: counted now, on its way meanwhile', async () => {
    const ctx = setup()
    const create = fakeQueue(ctx)
    const shot = () => doc(ctx.project).shots[2]!
    const base = planned(ctx.st.planVideo(shot()))
    let ready!: (p: Planned | string) => void
    const voiced: Planned = { ...base, prepare: () => new Promise((r) => (ready = r)), makes: { shotId: 's3', what: 'take', waitsFor: 'its lines' } }
    expect(await ctx.st.run([voiced])).toBe(1)
    expect(create).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('Voicing the lines of 1 shot first', {
      description: 'ElevenLabs speaks them, then the shot is made to that audio — exact words and lip sync.',
    })
    // No job yet: Animate and the cards must see it coming, not start it again.
    expect(ctx.st.preparingOf(shot(), 'take')).toBe('its lines')
    ready(base)
    await settle()
    expect(create).toHaveBeenCalledTimes(1)
    expect(shot().videoGenerationIds).toEqual(['job-1'])
    expect(ctx.st.preparingOf(shot(), 'take')).toBeUndefined()
  })

  it('…one that fails is toasted and doesn’t hold back the others; one ready after its project closed doesn’t start', async () => {
    const ctx = setup()
    ctx.project.id = 'p1'
    const create = fakeQueue(ctx)
    const error = vi.spyOn(toast, 'error')
    const base = planned(ctx.st.planVideo(doc(ctx.project).shots[2]!))
    let late!: (p: Planned | string) => void
    const failing: Planned = {
      ...base,
      waitNote: 'waits for its keyframe',
      prepare: () => Promise.reject(new Error('The upload failed')),
      makes: { shotId: 's1', what: 'end', waitsFor: 'its keyframe' },
    }
    const ok: Planned = { ...base, waitNote: 'waits for its keyframe', prepare: async () => base }
    const closing: Planned = { ...base, prepare: () => new Promise((r) => (late = r)) }
    expect(await ctx.st.run([failing, ok, closing])).toBe(3)
    expect(toast).toHaveBeenCalledWith('Voicing the lines of 1 shot first', expect.anything())
    expect(toast).toHaveBeenCalledWith('2 stills wait for the one before', {
      description: 'An end frame is drawn from its shot’s still, and the next still from that end frame — one after another.',
    })
    await settle()
    expect(error).toHaveBeenCalledWith('A shot couldn’t be prepared', { description: 'The upload failed' })
    expect(ctx.st.preparingOf(doc(ctx.project).shots[0]!, 'end')).toBeUndefined()
    expect(create).toHaveBeenCalledTimes(1)
    ctx.project.id = 'p2'
    late(base)
    await settle()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('estimates a batch’s cost; unknown when any plan’s price is', () => {
    const { st, project } = setup()
    const plan = planned(st.planVideo(doc(project).shots[2]!))
    const priced = (usd: number | null): Planned => ({ ...plan, model: { ...plan.model, estimateCost: () => ({ usd, detail: '', asOf: '2026-10-17' }) } })
    expect(st.estimate([])).toBe(0)
    expect(st.estimate([priced(0.5), priced(1.25)])).toBe(1.75)
    expect(st.estimate([priced(0.5), priced(null)])).toBeNull()
  })
})

describe('useStory — batches: keyframes scene by scene', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
    vi.mocked(toast).mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** One scene of three wides, none with a keyframe yet. */
  function bare() {
    const ctx = setup()
    const s = doc(ctx.project)
    s.multishots = []
    s.scenes = [{ id: 'sc', title: 'Platform' }]
    for (const x of s.shots) Object.assign(x, { sceneId: 'sc', shotType: 'wide', keyframeAssetId: undefined })
    return { ...ctx, shots: () => doc(ctx.project).shots, create: fakeQueue(ctx) }
  }
  /** A still's job is done and its picture is `status`. */
  function finish(ctx: ReturnType<typeof setup>, jobId: string, out: string, status: AssetDTO['status'] = 'ready') {
    Object.assign(ctx.jobs.byId[jobId]!, { status: 'succeeded', outputAssetIds: [out] })
    ctx.assets.upsert(asset(out, { status }))
  }

  it('the opening keyframe starts first; the scene’s others once its picture is ready, with it as their layout reference', async () => {
    const ctx = bare()
    const { st, shots, create } = ctx
    expect(await st.runBatch(shots().map((x) => st.planKeyframe(x)))).toBe(1)
    expect(create).toHaveBeenCalledTimes(1)
    expect(shots().map((x) => x.keyframeGenerationId)).toEqual(['job-1', undefined, undefined])
    expect(toast).toHaveBeenCalledWith('2 more stills start when the opening shot is done', {
      description: 'They get it as a layout reference, so the set stays the same from shot to shot.',
    })
    // The job is done a moment before its picture is: planned in that gap, they went out without it.
    finish(ctx, 'job-1', 'kf-open', 'processing')
    await settle()
    expect(create).toHaveBeenCalledTimes(1)
    ctx.assets.upsert(asset('kf-open'))
    await settle()
    expect(create).toHaveBeenCalledTimes(3)
    expect(create.mock.calls[0]![0].params.referenceImages).not.toContain('kf-open')
    for (const [req] of create.mock.calls.slice(1)) expect(req.params.referenceImages).toContain('kf-open')
    expect(shots().map((x) => x.keyframeGenerationId)).toEqual(['job-1', 'job-2', 'job-3'])
  })

  it('a later shot that got a keyframe some other way meanwhile is left be', async () => {
    const ctx = bare()
    const { st, shots, create } = ctx
    await st.runBatch(shots().map((x) => st.planKeyframe(x)))
    st.setKeyframe(shots()[2]!, 'kf3')
    finish(ctx, 'job-1', 'kf-open')
    await settle()
    expect(create).toHaveBeenCalledTimes(2)
    expect(shots()[1]!.keyframeGenerationId).toBe('job-2')
    expect(shots()[2]).toMatchObject({ keyframeAssetId: 'kf3', keyframeGenerationId: undefined })
  })

  it('a scene that has a keyframe already, and other plans, start at once', async () => {
    const ctx = bare()
    const { st, shots, create } = ctx
    st.setKeyframe(shots()[0]!, 'kf1')
    expect(await st.runBatch([st.planKeyframe(shots()[1]!), st.planKeyframe(shots()[2]!), st.planVideo(shots()[0]!)])).toBe(3)
    expect(create).toHaveBeenCalledTimes(3)
    for (const [req] of create.mock.calls.slice(0, 2)) expect(req.params.referenceImages).toContain('kf1')
    expect(toast).not.toHaveBeenCalled()
  })

  it('chained stills aren’t staged: an end frame waits for its keyframe, the next keyframe for that end frame', async () => {
    const ctx = bare()
    const { st, shots, create } = ctx
    st.updateShot('s2', 'End frame', (x) => (x.endFrame = 'Tymon turns to the window.'))
    const similarity = vi.spyOn(api.analysis, 'frameSimilarity').mockResolvedValue({ ssim: 0.5 })
    const [s1, s2, s3] = shots()
    const plans = [st.planKeyframe(s1!), st.planKeyframe(s2!), st.planEndKeyframeAfterStart(s2!), st.planKeyframeAfterPreviousEnd(s3!, s2!)]
    // Now: shot 1's keyframe; shot 2's waits for it (staged), its end frame and shot 3's keyframe in their prepare.
    expect(await st.runBatch(plans)).toBe(3)
    expect(create).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith('1 more still starts when the opening shot is done', expect.anything())
    expect(toast).toHaveBeenCalledWith('2 stills wait for the one before', expect.anything())
    expect(st.preparingOf(shots()[1]!, 'end')).toBe('its still')
    expect(st.preparingOf(shots()[2]!, 'keyframe')).toBe('shot 2’s end frame')
    finish(ctx, 'job-1', 'kf-1')
    await settle()
    // Shot 2's keyframe, with shot 1's as its layout.
    expect(create).toHaveBeenCalledTimes(2)
    expect(shots()[1]!.keyframeGenerationId).toBe('job-2')
    expect(create.mock.calls[1]![0].params.referenceImages).toContain('kf-1')
    finish(ctx, 'job-2', 'kf-2')
    await settle()
    // Its end frame, drawn from it.
    expect(create).toHaveBeenCalledTimes(3)
    expect(shots()[1]!.endKeyframeGenerationId).toBe('job-3')
    expect(create.mock.calls[2]![0].params.referenceImages).toContain('kf-2')
    expect(st.preparingOf(shots()[1]!, 'end')).toBeUndefined()
    finish(ctx, 'job-3', 'end-2')
    await settle()
    // Shot 3 opens on that last moment — compared with its start first: a visible change.
    expect(similarity).toHaveBeenCalledWith('kf-2', 'end-2')
    expect(shots()[1]!.endCheck).toEqual({ startId: 'kf-2', endId: 'end-2', ssim: 0.5 })
    expect(create).toHaveBeenCalledTimes(4)
    expect(shots()[2]!.keyframeGenerationId).toBe('job-4')
    expect(create.mock.calls[3]![0].params.referenceImages).toEqual(expect.arrayContaining(['kf-1', 'end-2']))
    expect(st.preparingOf(shots()[2]!, 'keyframe')).toBeUndefined()
  })
})

describe('useStory — scene progress', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
  })
  afterEach(() => vi.unstubAllGlobals())

  it('counts the scene’s shots and seconds, the stills they need and have, its renders, takes, renders on their way and finals', () => {
    const { st, project, jobs, assets } = setup()
    const s = doc(project)
    s.scenes = [{ id: 'sc', title: 'Platform' }, { id: 'other', title: 'Elsewhere' }]
    for (const x of s.shots) x.sceneId = 'sc'
    s.shots[2]!.endFrame = 'Maja looks up at the board.'
    const progress = () => st.sceneProgress('sc')
    // On LTX the group renders shot by shot: three renders, a keyframe each.
    expect(progress()).toEqual({ shots: 3, seconds: 12, stills: 3, stillsNeeded: 4, renders: 3, animated: 0, rendering: 0, finals: 0 })
    // A still marked "redo" (its shot was written again by Update scenes) is one to draw again, not one made.
    st.updateShot('s1', 'Update scenes', (x) => (x.stillStale = true))
    expect(progress()).toMatchObject({ stills: 2, stillsNeeded: 4 })
    st.updateShot('s1', 'Keep the still', (x) => delete x.stillStale)
    // So even before its later shot has a keyframe: that one still wants it.
    st.updateShot('s2', 'Remove keyframe', (x) => (x.keyframeAssetId = undefined))
    expect(progress()).toEqual({ shots: 3, seconds: 12, stills: 2, stillsNeeded: 4, renders: 3, animated: 0, rendering: 0, finals: 0 })
    // Set to one clip from the first keyframe: two renders, and the later shot needs no keyframe.
    st.setGroupSource(doc(project).multishots![0]!, 'keyframe')
    expect(progress()).toEqual({ shots: 3, seconds: 12, stills: 2, stillsNeeded: 3, renders: 2, animated: 0, rendering: 0, finals: 0 })
    // Shot 3's end frame drawn; a take of it on its way.
    st.setEndKeyframe(s.shots[2]!, 'kf1')
    planned(st.planVideo(doc(project).shots[2]!)).apply('gen-3')
    jobs.byId['gen-3'] = { ...jobs.byId['gen-3']!, id: 'gen-3', projectId: 'p1', modelId: DRAFT, provider: 'local', kind: 'video', status: 'running', progress: 0.5, label: 'gen-3', params: {}, outputAssetIds: [], variant: 0, createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z' } as GenerationDTO
    expect(progress()).toMatchObject({ stills: 3, stillsNeeded: 3, animated: 0, rendering: 1 })
    // It's done, the group has a take, and shot 3 a final render.
    take(jobs, assets, 'gen-3', DRAFT)
    planned(st.planMultishot(doc(project).multishots![0]!)).apply('gen-g')
    take(jobs, assets, 'gen-g', DRAFT)
    planned(st.planShotFinal(doc(project).shots[2]!)).apply('gen-f')
    take(jobs, assets, 'gen-f', FINAL)
    expect(progress()).toMatchObject({ animated: 2, rendering: 0, finals: 1 })
    // Back to Separate shots: the one clip, chosen and ready, still covers its shots — nothing new to render there.
    st.setGroupSource(doc(project).multishots![0]!, undefined)
    expect(st.groupShotByShot(doc(project).multishots![0]!)).toBe(true)
    expect(st.groupCovered(doc(project).multishots![0]!)).toBe(true)
    expect(progress()).toMatchObject({ renders: 2, animated: 2 })
    expect(st.planSceneAnimation('sc').plans).toEqual([])
    expect(st.sceneProgress('other')).toEqual({ shots: 0, seconds: 0, stills: 0, stillsNeeded: 0, renders: 0, animated: 0, rendering: 0, finals: 0 })
  })

  it('a shot of a group rendered shot by shot renders and finals as a shot of its own once it has a take', () => {
    const { st, project, jobs, assets } = setup()
    const g = () => doc(project).multishots![0]!
    // An older one-clip take of the group covers shot 1: its final is the group's.
    planned(st.planMultishot(g())).apply('gen-g')
    take(jobs, assets, 'gen-g', DRAFT)
    expect(st.clipGroupOf(doc(project).shots[0]!)?.id).toBe('g1')
    expect(planned(st.planShotFinal(doc(project).shots[0]!)).label).toBe('Final multi-shot · shots 1–2')
    // Animated on its own since: its own take, its own final.
    planned(st.planVideo(doc(project).shots[0]!)).apply('gen-1')
    take(jobs, assets, 'gen-1', DRAFT)
    expect(st.clipGroupOf(doc(project).shots[0]!)).toBeUndefined()
    expect(planned(st.planShotFinal(doc(project).shots[0]!)).label).toBe('Final · shot 1')
    // Set to one clip, the group renders it again.
    st.setGroupSource(g(), 'keyframe')
    expect(st.clipGroupOf(doc(project).shots[0]!)?.id).toBe('g1')
  })
})

describe('useStory — the Director’s shots applied', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
  })
  afterEach(() => vi.unstubAllGlobals())

  const written = (group: number, extra: Partial<BreakdownShot> = {}): BreakdownShot => ({
    scene: 'Platform',
    description: 'x',
    shotType: 'WIDE',
    camera: 'static',
    prompt: 'Maja waits.',
    durationSeconds: 3,
    characters: ['maja'],
    dialogue: [],
    sfx: '',
    group,
    ...extra,
  })

  it('maps the hidden by name, any case, never also with their face; no groups on a model that renders shot by shot', () => {
    const { st, project } = setup()
    const s = doc(project)
    s.scenes = [{ id: 'sc', title: 'Platform' }]
    for (const x of s.shots) x.sceneId = 'sc'
    s.multishots = []
    // The Chase: the man waiting in the dark got a studio face reference and came out lit.
    st.applySceneShots('sc', [written(1, { hidden: ['TYMON', 'tymon', 'Maja'] }), written(1), written(1, { characters: ['MAJA', 'Tymon'] })])
    const shots = doc(project).shots
    expect(shots[0]!.hiddenIds).toEqual(['tymon'])
    expect(shots[0]!.characterIds).toEqual(['maja'])
    expect(shots[1]!.hiddenIds).toBeUndefined()
    expect(shots[2]!.characterIds).toEqual(['maja', 'tymon'])
    // LTX (the story's model) renders shot by shot: whatever the reply numbered, no group.
    expect(doc(project).multishots).toEqual([])
    // Kling keeps the Director's groups.
    st.update('Video model', (x) => (x.videoModelId = 'kling-3.0'))
    st.applySceneShots('sc', [written(1), written(1), written(0)])
    expect(doc(project).multishots!.map((g) => g.shotIds.length)).toEqual([2])
  })
})

describe('useStory — the end frame check', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Shot 3 with an end frame drawn (`end`, a ready image). */
  function ended(end: string) {
    const base = setup()
    base.assets.upsert(asset(end))
    base.st.updateShot('s3', 'End frame', (x) => {
      x.endFrame = 'The phone lies face down on the bench.'
      x.endKeyframeAssetId = end
    })
    return { ...base, s3: () => doc(base.project).shots[2]! }
  }

  it('a take waits (quietly) for the two stills to be compared, then sends the end picture only as a visible change', async () => {
    const { st, project, s3 } = ended('end-changed')
    const similarity = vi.spyOn(api.analysis, 'frameSimilarity').mockResolvedValue({ ssim: 0.43 })
    expect(st.endCheckDue(s3())).toBe('kf3 end-changed')
    const plan = planned(st.planVideo(s3()))
    expect(plan).toMatchObject({ quiet: true, makes: { shotId: 's3', what: 'take', waitsFor: 'its end frame check' } })
    expect(plan.params.lastFrame).toBeUndefined()
    const steps = project.undoStack.length
    const ready = planned(await plan.prepare!())
    expect(similarity).toHaveBeenCalledWith('kf3', 'end-changed')
    // Found by the app, not an undo step.
    expect(s3().endCheck).toEqual({ startId: 'kf3', endId: 'end-changed', ssim: 0.43 })
    expect(project.undoStack.length).toBe(steps)
    expect(ready.params).toMatchObject({ firstFrame: 'kf3', lastFrame: 'end-changed' })
    expect(ready.prepare).toBeUndefined()
    // Once per pair of stills; checked, a take plans at once.
    await st.checkEndFrame(s3())
    expect(similarity).toHaveBeenCalledTimes(1)
    expect(st.endCheckDue(s3())).toBeUndefined()
    expect(planned(st.planVideo(s3())).prepare).toBeUndefined()
  })

  it('barely different: held back unless sent anyway; the user’s call needs no check', async () => {
    const { st, s3 } = ended('end-same')
    vi.spyOn(api.analysis, 'frameSimilarity').mockResolvedValue({ ssim: 0.96 })
    await st.checkEndFrame(s3())
    expect(planned(st.planVideo(s3())).params.lastFrame).toBeUndefined()
    st.setEndUse(s3(), 'image')
    expect(planned(st.planVideo(s3())).params.lastFrame).toBe('end-same')
    st.setEndUse(s3(), undefined)
    expect(s3().endUse).toBeUndefined()
  })

  it('splits a recomposed shot at its end picture', async () => {
    const { st, project, s3 } = ended('end-recomposed')
    vi.spyOn(api.analysis, 'frameSimilarity').mockResolvedValue({ ssim: 0.14 })
    await st.checkEndFrame(s3())
    st.splitAtEnd(s3())
    const shots = doc(project).shots
    expect(shots.map((x) => x.id).slice(0, 3)).toEqual(['s1', 's2', 's3'])
    expect(shots[3]).toMatchObject({ keyframeAssetId: 'end-recomposed', frame: 'The phone lies face down on the bench.' })
    expect(s3().endFrame).toBeUndefined()
    expect(s3().endCheck).toBeUndefined()
  })
})

describe('useStory — cut detection', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('detects at 0.2, and again when an older detection found fewer cuts than the group has', async () => {
    const { st, project, jobs, assets } = setup()
    take(jobs, assets, 'gen-cuts', DRAFT)
    const g = () => doc(project).multishots![0]!
    st.updateGroup('g1', 'Take', (x) => {
      x.videoGenerationIds = ['gen-cuts']
      // Found at 0.3 (no threshold recorded): none, for two shots.
      x.takes = { 'gen-cuts': { planned: [4], detected: [] } }
    })
    const cuts = vi.spyOn(api.assets, 'sceneCuts').mockResolvedValue({ cuts: [4.38], source: 'detected', detected: [4.38] })
    expect(st.cutsWanted(g(), 'gen-cuts')).toBe(true)
    await st.detectTakeCuts(g(), 'gen-cuts')
    expect(cuts).toHaveBeenCalledWith('gen-cuts-out', { expected: [], threshold: 0.2 })
    expect(g().takes!['gen-cuts']).toMatchObject({ detected: [4.38], threshold: 0.2 })
    // Enough now, or too few at 0.2 already: not again.
    expect(st.cutsWanted(g(), 'gen-cuts')).toBe(false)
    st.updateGroup('g1', 'Take', (x) => (x.takes!['gen-cuts'] = { planned: [4], detected: [], threshold: 0.2 }))
    expect(st.cutsWanted(g(), 'gen-cuts')).toBe(false)
  })
})

describe('useStory — one storyboard per Pinia', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('every caller shares one — a card’s, a handler’s — and a new Pinia (each test’s) gets its own', () => {
    const { st } = setup()
    expect(useStory()).toBe(st)
    expect(createStory()).not.toBe(st)
    setActivePinia(createPinia())
    expect(useStory()).not.toBe(st)
  })

  it('outlives the component that asked first: its scope stopped, the shared one still follows the story', () => {
    const { project } = setup()
    const scope = effectScope()
    const st = scope.run(() => useStory())!
    scope.stop()
    expect(useStory()).toBe(st)
    expect(st.groups.value.map((g) => g.id)).toEqual(['g1'])
    st.breakUp(doc(project).multishots![0]!)
    expect(st.groups.value).toEqual([])
    expect(st.story.value).toBe(doc(project))
  })

  it('the timeline’s naming (storyNaming, without the storyboard) renames a take as the storyboard does', async () => {
    const { project, jobs, assets } = setup()
    project.id = 'p-timeline'
    doc(project).shots[2]!.description = 'Maja sighs at the board.'
    take(jobs, assets, 'gen-3', DRAFT)
    jobs.byId['gen-3']!.params = { prompt: 'Maja sighs. The camera holds on her face as the train pulls out.' }
    assets.upsert({ ...assets.get('gen-3-out')!, name: 'Maja sighs. The camera holds on…' })
    doc(project).shots[2]!.videoGenerationIds = ['gen-3']
    const update = vi.spyOn(api.assets, 'update').mockImplementation(async (id, patch) => ({ ...assets.get(id)!, ...patch }) as AssetDTO)
    expect(await nameStoryTakes()).toBe(1)
    expect(update).toHaveBeenCalledWith('gen-3-out', { name: 'Maja sighs at the board.' })
    // Once per project and session, whichever asked first.
    expect(await useStory().nameStoryTakes()).toBe(0)
  })
})
