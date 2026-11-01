import type { AssetDTO } from '@shared/types/assets'
import type { GenerationDTO } from '@shared/types/jobs'
import { describe, expect, it } from 'vitest'
import { clock, downloadName, failureNote, filterFeed, groupBatches, pendingState, totalCost } from './feed'

function asset(p: Partial<AssetDTO>): AssetDTO {
  return {
    id: 'a',
    kind: 'image',
    name: 'Result',
    status: 'ready',
    source: 'generation',
    hasVideo: false,
    hasAudio: false,
    variants: {},
    parentIds: [],
    rating: 0,
    keywords: [],
    projectIds: [],
    createdAt: '2026-10-27T10:00:00Z',
    ...p,
  }
}
const gen = (generationId: string, prompt = 'a fish', costUsd?: number) => ({ generationId, modelId: 'm', modelLabel: 'Model', provider: 'mock', prompt, params: {}, costUsd })
const job = (p: Partial<GenerationDTO>) => p as GenerationDTO

describe('Create feed', () => {
  it('shows generated results only, newest first, without hidden ones', () => {
    const list = [
      asset({ id: 'old', createdAt: '2026-10-27T09:00:00Z' }),
      asset({ id: 'new', createdAt: '2026-10-27T11:00:00Z' }),
      asset({ id: 'imported', source: 'import' }),
      asset({ id: 'hidden', rating: -1 }),
      asset({ id: 'gone', status: 'missing' }),
    ]
    expect(filterFeed(list, { kind: 'all' }).map((a) => a.id)).toEqual(['new', 'old'])
  })

  it('filters by kind, favourites and words of the prompt', () => {
    const list = [
      asset({ id: 'fish', generation: gen('g1', 'a silver fish at dawn'), rating: 1 }),
      asset({ id: 'boat', generation: gen('g2', 'a wooden boat') }),
      asset({ id: 'clip', kind: 'video', generation: gen('g3', 'fish jumping') }),
    ]
    expect(filterFeed(list, { kind: 'video' }).map((a) => a.id)).toEqual(['clip'])
    expect(filterFeed(list, { kind: 'all', favourites: true }).map((a) => a.id)).toEqual(['fish'])
    expect(filterFeed(list, { kind: 'all', search: 'fish' }).map((a) => a.id).sort()).toEqual(['clip', 'fish'])
  })

  it('groups takes of one Generate by the job batch and sums their cost', () => {
    const jobs: Record<string, GenerationDTO> = { g1: job({ batchId: 'b' }), g2: job({ batchId: 'b' }), g3: job({}) }
    const list = [
      asset({ id: 'one', generation: gen('g1', 'fish', 0.02) }),
      asset({ id: 'two', generation: gen('g2', 'fish', 0.03) }),
      asset({ id: 'solo', generation: gen('g3', 'boat') }),
      asset({ id: 'unknown', generation: gen('g4', 'lake') }),
    ]
    const batches = groupBatches(list, (id) => jobs[id])
    expect(batches.map((b) => b.assets.map((a) => a.id))).toEqual([['one', 'two'], ['solo'], ['unknown']])
    expect(batches[0]!.costUsd).toBeCloseTo(0.05)
    expect(batches[1]!.costUsd).toBeUndefined()
    expect(batches[2]!.key).toBe('g4')
  })

  it('counts a render once when it returned several results', () => {
    const list = [
      asset({ id: 'a', generation: gen('g1', 'fish', 0.08) }),
      asset({ id: 'b', generation: gen('g1', 'fish', 0.08) }),
      asset({ id: 'c', generation: gen('g2', 'fish', 0.02) }),
    ]
    expect(totalCost(list)).toBeCloseTo(0.1)
    expect(groupBatches(list, () => undefined).map((b) => b.costUsd)).toEqual([0.08, 0.02])
    expect(totalCost([asset({ id: 'free' })])).toBeUndefined()
  })

  it('says how long a render has run against the usual time, and when it is slow', () => {
    const now = Date.parse('2026-10-27T10:05:00Z')
    expect(pendingState({ status: 'queued', createdAt: '2026-10-27T10:00:00Z' }, now, 60).phase).toBe('queued')
    expect(pendingState({ status: 'running', createdAt: '2026-10-27T10:00:00Z', startedAt: '2026-10-27T10:04:00Z' }, now, 90)).toEqual({ phase: 'running', text: '1:00 · usually ~1:30' })
    expect(pendingState({ status: 'running', createdAt: '2026-10-27T10:00:00Z' }, now, 90).phase).toBe('slow')
    expect(pendingState({ status: 'running', createdAt: '2026-10-27T10:00:00Z' }, now).text).toBe('5:00')
    expect(clock(3725)).toBe('1:02:05')
  })

  it('downloads as a safe file name with its extension', () => {
    expect(downloadName({ name: 'Demo image — a fish: at dawn/dusk', mime: 'image/jpeg', kind: 'image' })).toBe('Demo image — a fish- at dawn-dusk.jpg')
    expect(downloadName({ name: 'clip.mp4', mime: 'video/mp4', kind: 'video' })).toBe('clip.mp4')
    expect(downloadName({ name: 'Theme', mime: 'audio/mpeg', kind: 'audio' })).toBe('Theme.mp3')
    expect(downloadName({ name: '  ', kind: 'image' })).toBe('result.png')
    expect(downloadName({ name: 'x'.repeat(200), mime: 'image/png', kind: 'image' })).toHaveLength(84)
  })

  it('tells whether a failure may have been charged', () => {
    expect(failureNote({ error: { code: 'provider', message: 'Boom', retryable: true, maybeCharged: false } })).toEqual({ message: 'Boom', charge: 'Not charged', retryable: true })
    expect(failureNote({ error: { code: 'timeout', message: 'Late', retryable: true, maybeCharged: true } }).charge).toBe('May have been charged')
    expect(failureNote({ costUsd: 0.4 }).charge).toBe('May have been charged')
  })
})
