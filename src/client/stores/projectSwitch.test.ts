import type { AssetDTO } from '@shared/types/assets'
import type { GenerationDTO } from '@shared/types/jobs'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useAssetsStore } from './assets'
import { useJobsStore } from './jobs'

class FakeEventSource {
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  close() {}
}

function image(id: string, projectId: string, createdAt = '2026-10-16T10:00:00.000Z', generationId?: string): AssetDTO {
  return {
    id,
    kind: 'image',
    name: id,
    status: 'ready',
    source: generationId ? 'generation' : 'import',
    hasVideo: false,
    hasAudio: false,
    variants: { original: true },
    parentIds: [],
    rating: 0,
    keywords: [],
    projectIds: [projectId],
    createdAt,
    ...(generationId ? { generation: { generationId, modelId: 'mock-image', modelLabel: 'Mock', provider: 'mock' } } : {}),
  } as AssetDTO
}

function job(id: string, projectId: string): GenerationDTO {
  return {
    id,
    projectId,
    modelId: 'mock-image',
    provider: 'mock',
    kind: 'image',
    status: 'queued',
    progress: null,
    label: 'harbour',
    params: { prompt: 'harbour' },
    outputAssetIds: [],
    variant: 0,
    createdAt: '2026-10-16T10:00:00.000Z',
    updatedAt: '2026-10-16T10:00:00.000Z',
  }
}

describe('switching projects', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('Notification', undefined)
    vi.stubGlobal('window', {})
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps out an upload or a description that answers after another project opened', () => {
    const assets = useAssetsStore()
    assets.projectId = 'p2'
    assets.upsert(image('from-p1', 'p1'))
    assets.upsert(image('own', 'p2'))
    expect(assets.list.map((a) => a.id)).toEqual(['own'])
  })

  it("shows only the open project's uploads", async () => {
    const assets = useAssetsStore()
    assets.projectId = 'p1'
    let finish!: (a: AssetDTO) => void
    vi.spyOn(api.assets, 'upload').mockReturnValue(new Promise((r) => (finish = r)))
    const importing = assets.importFiles([new File(['x'], 'harbour.jpg')])
    expect(assets.uploads.map((u) => u.name)).toEqual(['harbour.jpg'])
    assets.projectId = 'p2'
    expect(assets.uploads).toEqual([])
    finish(image('harbour', 'p1'))
    await importing
    expect(assets.get('harbour')).toBeUndefined()
  })

  it("does not let a slow asset list of the last project replace the open one's", async () => {
    let answerA!: (list: AssetDTO[]) => void
    vi.spyOn(api.assets, 'list').mockImplementation((id) => (id === 'pA' ? new Promise((r) => (answerA = r)) : Promise.resolve([image('b', 'pB')])))
    const assets = useAssetsStore()
    const loadingA = assets.load('pA')
    await assets.load('pB')
    answerA([image('a', 'pA')])
    await loadingA
    expect(assets.list.map((a) => a.id)).toEqual(['b'])
    expect(assets.loading).toBe(false)
  })

  it("does not let a slow job list of the last project replace the open one's", async () => {
    let answerA!: (list: GenerationDTO[]) => void
    vi.spyOn(api.generations, 'list').mockImplementation((id) => (id === 'pA' ? new Promise((r) => (answerA = r)) : Promise.resolve([job('gb', 'pB')])))
    vi.spyOn(api.generations, 'active').mockResolvedValue([])
    vi.spyOn(api.generations, 'recent').mockResolvedValue([])
    const jobs = useJobsStore()
    const loadingA = jobs.load('pA')
    await jobs.load('pB')
    answerA([job('ga', 'pA')])
    await loadingA
    expect(Object.keys(jobs.byId)).toEqual(['gb'])
  })

  it("finds each generation's first output without its job", () => {
    const assets = useAssetsStore()
    assets.upsert(image('second', 'p1', '2026-10-16T10:00:02.000Z', 'g1'))
    assets.upsert(image('first', 'p1', '2026-10-16T10:00:01.000Z', 'g1'))
    assets.upsert(image('other', 'p1', '2026-10-16T10:00:03.000Z', 'g2'))
    assets.upsert(image('imported', 'p1'))
    expect([...assets.byGeneration].map(([gid, a]) => [gid, a.id])).toEqual([
      ['g1', 'first'],
      ['g2', 'other'],
    ])
  })
})
