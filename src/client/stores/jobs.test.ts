import type { GenerationDTO, JobStatus } from '@shared/types/jobs'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useJobsStore } from './jobs'

let source: { onmessage: ((msg: { data: string }) => void) | null } | undefined

class FakeEventSource {
  onopen: (() => void) | null = null
  onmessage: ((msg: { data: string }) => void) | null = null
  constructor() {
    source = this
  }
  close() {}
}

function job(status: JobStatus, updatedAt: string, projectId = 'p1'): GenerationDTO {
  return {
    id: 'g1',
    projectId,
    modelId: 'mock-image',
    provider: 'mock',
    kind: 'image',
    status,
    progress: null,
    label: 'harbour',
    params: { prompt: 'harbour' },
    outputAssetIds: [],
    variant: 0,
    createdAt: '2026-10-02T10:00:00.000Z',
    updatedAt,
  }
}

const live = (g: GenerationDTO) => source!.onmessage!({ data: JSON.stringify({ type: 'generation.upserted', generation: g }) })

describe('jobs store', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('Notification', undefined)
    vi.stubGlobal('document', { hidden: false })
    vi.stubGlobal('window', {})
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps a job finished when the create response arrives after the live "succeeded" update', async () => {
    const jobs = useJobsStore()
    jobs.projectId = 'p1'
    let resolve!: (created: GenerationDTO[]) => void
    vi.spyOn(api.generations, 'create').mockReturnValue(new Promise((r) => (resolve = r)))
    const creating = jobs.create({ projectId: 'p1', modelId: 'mock-image', params: { prompt: 'harbour' } })
    live(job('running', '2026-10-02T10:00:00.400Z'))
    live(job('succeeded', '2026-10-02T10:00:01.000Z'))
    resolve([job('queued', '2026-10-02T10:00:00.000Z')])
    await creating
    expect(jobs.byId.g1?.status).toBe('succeeded')
    expect(jobs.sharedRunning).toEqual([])
  })

  it('does not bring back a job that finished while the shared queue was loading', async () => {
    const jobs = useJobsStore()
    let resolveActive!: (list: GenerationDTO[]) => void
    vi.spyOn(api.generations, 'list').mockResolvedValue([])
    vi.spyOn(api.generations, 'active').mockReturnValue(new Promise((r) => (resolveActive = r)))
    vi.spyOn(api.generations, 'recent').mockResolvedValue([])
    const loading = jobs.load('p2')
    live(job('succeeded', '2026-10-02T10:00:05.000Z')) // a job of another project finishes
    resolveActive([job('running', '2026-10-02T10:00:02.000Z')]) // snapshot taken before that
    await loading
    expect(jobs.sharedRunning).toEqual([])
    expect(jobs.sharedHistory.map((j) => j.status)).toEqual(['succeeded'])
  })

  it('keeps every project\'s queue and finished jobs without an open project', async () => {
    const jobs = useJobsStore()
    vi.spyOn(api.generations, 'active').mockResolvedValue([{ ...job('queued', '2026-10-02T10:00:01.000Z', 'p2'), id: 'g2', projectName: 'Dare' }])
    vi.spyOn(api.generations, 'recent').mockResolvedValue([{ ...job('succeeded', '2026-10-02T10:00:03.000Z', 'p3'), projectName: 'Kolejka' }])
    await jobs.loadShared()
    expect(jobs.sharedQueued.map((j) => j.id)).toEqual(['g2'])
    expect(jobs.sharedHistory.map((j) => j.id)).toEqual(['g1'])
    expect(jobs.projectNames).toEqual({ p2: 'Dare', p3: 'Kolejka' })
    // The queued job starts, then finishes: it moves from the queue to the history.
    live({ ...job('running', '2026-10-02T10:00:04.000Z', 'p2'), id: 'g2' })
    expect(jobs.sharedRunning.map((j) => j.id)).toEqual(['g2'])
    live({ ...job('succeeded', '2026-10-02T10:00:09.000Z', 'p2'), id: 'g2' })
    expect(jobs.sharedRunning).toEqual([])
    expect(jobs.sharedHistory.map((j) => j.id)).toEqual(['g2', 'g1'])
    expect(jobs.list).toEqual([])
  })

  it('keeps the history to the newest 100 finished jobs, plus every one that needs attention', async () => {
    const jobs = useJobsStore()
    const at = (i: number) => new Date(Date.parse('2026-10-02T10:00:00Z') + i * 1000).toISOString()
    live({ ...job('needs_attention', at(0), 'p2'), id: 'old-attention' })
    for (let i = 1; i <= 120; i++) live({ ...job('succeeded', at(i), 'p2'), id: `g${i}` })
    expect(jobs.sharedHistory).toHaveLength(101)
    expect(jobs.sharedHistory[0]!.id).toBe('g120')
    expect(jobs.sharedHistory.some((j) => j.id === 'g20')).toBe(false)
    expect(jobs.sharedAttention.map((j) => j.id)).toEqual(['old-attention'])
  })
})
