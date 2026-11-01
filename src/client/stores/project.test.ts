import { appendToSpine, applyOp, makeMediaClip, setProps } from '@shared/timeline'
import type { ProjectDetail } from '@shared/types/api'
import type { AssetDTO } from '@shared/types/assets'
import type { GenerationDTO } from '@shared/types/jobs'
import { type MediaClip, createEmptyDoc } from '@shared/types/project-doc'
import { createPinia, setActivePinia } from 'pinia'
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError, api } from '@/lib/api'
import { useAssetsStore } from './assets'
import { useJobsStore } from './jobs'
import { useProjectStore } from './project'

const toasts = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: toasts }))

class FakeEventSource {
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onerror: (() => void) | null = null
  close() {}
}

const STILL = { kind: 'image', hasVideo: true, hasAudio: false } as const

/** "Harbour" with one still on the timeline (`take`: a finished one, or one waiting for its generation). */
function detail(revision = 1, take: { assetId?: string; generationId?: string } = { assetId: 'a0' }, id = 'p1'): ProjectDetail {
  let n = 0
  const ctx = { newId: () => `id${++n}`, media: () => STILL }
  const doc = applyOp(createEmptyDoc(), appendToSpine([makeMediaClip({ ...take, media: STILL, fps: 24, name: 'harbour', newId: ctx.newId })]), ctx).doc
  return { id, name: 'Harbour', path: '/Projects/Harbour.wildroom', doc, revision } as ProjectDetail
}

function still(id: string): AssetDTO {
  return {
    id,
    kind: 'image',
    name: id,
    status: 'ready',
    source: 'generation',
    hasVideo: true,
    hasAudio: false,
    variants: { original: true },
    parentIds: [],
    rating: 0,
    keywords: [],
    projectIds: ['p1'],
    createdAt: '2026-10-16T10:00:00.000Z',
  } as AssetDTO
}

function succeeded(id: string, assetId: string): GenerationDTO {
  return {
    id,
    projectId: 'p1',
    modelId: 'mock-image',
    provider: 'mock',
    kind: 'image',
    status: 'succeeded',
    progress: 1,
    label: 'harbour',
    params: { prompt: 'harbour' },
    outputAssetIds: [assetId],
    variant: 0,
    createdAt: '2026-10-16T10:00:00.000Z',
    updatedAt: '2026-10-16T10:00:05.000Z',
  }
}

async function open(d = detail()) {
  vi.spyOn(api.projects, 'get').mockResolvedValue(d)
  const project = useProjectStore()
  await project.load(d.id, 'page-1')
  return project
}

type Project = ReturnType<typeof useProjectStore>
const clip = (project: Project) => project.doc.spine[0] as MediaClip
const rename = (project: Project, name: string) => project.apply(setProps(clip(project).id, { name }), 'Rename')
const preview = (project: Project, name: string) => project.previewDrag(setProps(clip(project).id, { name }))
const conflictToast = () =>
  toasts.error.mock.calls.at(-1)![1] as { id: string; action: { onClick: () => void }; cancel: { onClick: () => void } }

describe('project store — saving', () => {
  let saveDoc: MockInstance<typeof api.projects.saveDoc>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.clearAllMocks()
    setActivePinia(createPinia())
    saveDoc = vi.spyOn(api.projects, 'saveDoc').mockImplementation(async (_id, _doc, base) => ({ revision: base + 1, updatedAt: '' }))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('saves once on leaving, and nothing reaches the project after that (a late autosave would re-open it)', async () => {
    const project = await open()
    rename(project, 'pier')
    await project.release('p1')
    expect(saveDoc).toHaveBeenCalledTimes(1)
    expect(project.id).toBeUndefined()
    rename(project, 'jetty') // e.g. a story run still going
    await vi.advanceTimersByTimeAsync(2000)
    expect(saveDoc).toHaveBeenCalledTimes(1)
  })

  it('does not rewrite an unchanged project when asked to save (an export, Back)', async () => {
    const project = await open()
    await project.save()
    await project.release('p1')
    expect(saveDoc).not.toHaveBeenCalled()
  })

  it('queues a save behind the one in flight, on the revision that one got back', async () => {
    const project = await open()
    let finish!: () => void
    saveDoc.mockImplementationOnce((_id, _doc, base) => new Promise((r) => (finish = () => r({ revision: base + 1, updatedAt: '' }))))
    rename(project, 'pier')
    await vi.advanceTimersByTimeAsync(600) // the autosave is on its way
    rename(project, 'jetty')
    const exporting = project.save()
    const leaving = project.save()
    finish()
    await Promise.all([exporting, leaving])
    await vi.advanceTimersByTimeAsync(2000)
    expect(saveDoc.mock.calls.map((c) => c[2])).toEqual([1, 2])
    expect(clip({ doc: saveDoc.mock.calls[1]![1] } as Project).name).toBe('jetty')
    expect(project.saveState).toBe('saved')
  })

  it('stops at a conflict and asks once; "Keep mine" saves over the newer revision', async () => {
    const project = await open()
    saveDoc.mockRejectedValueOnce(new ApiRequestError(409, 'Project was changed elsewhere', { revision: 4 }))
    rename(project, 'pier')
    await vi.advanceTimersByTimeAsync(600)
    rename(project, 'jetty')
    rename(project, 'quay')
    await vi.advanceTimersByTimeAsync(2000)
    expect(saveDoc).toHaveBeenCalledTimes(1)
    expect(project.saveState).toBe('error')
    expect(toasts.error.mock.calls.every(([, opts]) => opts?.id === 'project-conflict')).toBe(true)

    vi.spyOn(api.projects, 'get').mockResolvedValue(detail(5))
    conflictToast().cancel.onClick()
    await vi.advanceTimersByTimeAsync(0)
    expect(saveDoc).toHaveBeenCalledTimes(2)
    expect(saveDoc.mock.calls[1]![2]).toBe(5)
    expect(clip({ doc: saveDoc.mock.calls[1]![1] } as Project).name).toBe('quay')
    expect(project.saveState).toBe('saved')
    rename(project, 'wharf')
    await vi.advanceTimersByTimeAsync(600)
    expect(saveDoc.mock.calls[2]![2]).toBe(6)
  })

  it('"Reload" after a conflict takes the version on disk', async () => {
    const project = await open()
    saveDoc.mockRejectedValueOnce(new ApiRequestError(409, 'Project was changed elsewhere', { revision: 4 }))
    rename(project, 'pier')
    await vi.advanceTimersByTimeAsync(600)
    vi.spyOn(api.projects, 'get').mockResolvedValue(detail(5))
    conflictToast().action.onClick()
    await vi.advanceTimersByTimeAsync(0)
    expect(clip(project).name).toBe('harbour')
    expect(project.revision).toBe(5)
    expect(project.canUndo).toBe(false)
    rename(project, 'jetty')
    await vi.advanceTimersByTimeAsync(600)
    expect(saveDoc.mock.calls.at(-1)![2]).toBe(5)
  })

  it('never saves a drag\'s preview: Escape after an autosave finds the project on disk as it was', async () => {
    const project = await open()
    rename(project, 'pier')
    project.beginDrag('Rename')
    preview(project, 'half-dragged')
    await vi.advanceTimersByTimeAsync(600) // the edit before the drag autosaves meanwhile
    expect(clip({ doc: saveDoc.mock.calls[0]![1] } as Project).name).toBe('pier')
    project.cancelDrag()
    expect(project.saveState).toBe('saved')
    expect(clip(project).name).toBe('pier')
  })

  it('takes back only the drag on ⌘Z mid-drag', async () => {
    const project = await open()
    rename(project, 'pier')
    project.beginDrag('Rename')
    preview(project, 'half-dragged')
    project.undo()
    expect(clip(project).name).toBe('pier')
    expect(project.undoStack).toHaveLength(1)
    expect(project.dragging()).toBe(false)
  })

  it('fills in a take whose generation finished during a drag', async () => {
    const project = await open(detail(1, { generationId: 'g1' }))
    useAssetsStore().upsert(still('a1'))
    const jobs = useJobsStore()
    project.beginDrag('Rename')
    preview(project, 'pier')
    jobs.byId = { g1: succeeded('g1', 'a1') }
    project.resolvePendingTakes() // the editor's "a job finished" listener
    preview(project, 'jetty')
    project.commitDrag()
    expect(clip(project).takes[0]!.assetId).toBe('a1')
    expect(clip(project).name).toBe('jetty')
  })

  it('fills it in when the drag is cancelled too', async () => {
    const project = await open(detail(1, { generationId: 'g1' }))
    useAssetsStore().upsert(still('a1'))
    project.beginDrag('Rename')
    preview(project, 'pier')
    useJobsStore().byId = { g1: succeeded('g1', 'a1') }
    project.resolvePendingTakes()
    project.cancelDrag()
    expect(clip(project).takes[0]!.assetId).toBe('a1')
    expect(clip(project).name).toBe('harbour')
  })

  it('sends a big project without keepalive when the tab closes (Chromium refuses those over 64 KiB)', async () => {
    const project = await open()
    const fetch = vi.fn().mockResolvedValue(new Response(null))
    vi.stubGlobal('fetch', fetch)
    rename(project, 'pier')
    project.flushOnUnload()
    rename(project, 'x'.repeat(70_000))
    project.flushOnUnload()
    expect(fetch.mock.calls.map(([, init]) => (init as RequestInit).keepalive)).toEqual([true, false])
  })
})

describe('project store — opening', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('does not let a slow load of the last project replace the one opened after it', async () => {
    let answerA!: (d: ProjectDetail) => void
    vi.spyOn(api.projects, 'get').mockImplementation((id) => (id === 'pA' ? new Promise((r) => (answerA = r)) : Promise.resolve(detail(3, undefined, 'pB'))))
    const project = useProjectStore()
    const loadingA = project.load('pA')
    await project.load('pB')
    answerA(detail(1, undefined, 'pA'))
    await loadingA
    expect(project.id).toBe('pB')
    expect(project.revision).toBe(3)
  })

  it('drops an opening the editor left before it answered', async () => {
    let answer!: (d: ProjectDetail) => void
    vi.spyOn(api.projects, 'get').mockReturnValue(new Promise((r) => (answer = r)))
    const project = useProjectStore()
    const loading = project.load('p1', 'page-1')
    await project.release('p1')
    answer(detail())
    await loading
    expect(project.id).toBeUndefined()
  })
})
