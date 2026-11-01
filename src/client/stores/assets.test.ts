import type { AssetDTO, AssetStatus } from '@shared/types/assets'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAssetsStore } from './assets'

let source: FakeEventSource | undefined

class FakeEventSource {
  onopen: (() => void) | null = null
  onmessage: ((msg: { data: string }) => void) | null = null
  constructor() {
    source = this
  }
  close() {}
}

function image(status: AssetStatus): AssetDTO {
  return {
    id: 'img',
    kind: 'image',
    name: 'warsaw.jpg',
    status,
    source: 'import',
    hasVideo: false,
    hasAudio: false,
    variants: { original: true, poster: status === 'ready' },
    parentIds: [],
    rating: 0,
    keywords: [],
    projectIds: ['p1'],
    createdAt: '2026-10-01T10:00:00.000Z',
  } as AssetDTO
}

/** A live server update, as the SSE stream delivers it. */
function live(asset: AssetDTO) {
  source!.onmessage!({ data: JSON.stringify({ type: 'asset.upserted', asset }) })
}

describe('assets store', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
  })
  afterEach(() => vi.unstubAllGlobals())

  it('keeps an asset ready when the upload response arrives after the live "ready" update', () => {
    const assets = useAssetsStore()
    assets.projectId = 'p1'
    live(image('processing'))
    live(image('ready'))
    assets.upsert(image('processing')) // the upload response, sent before ingest finished
    expect(assets.get('img')?.status).toBe('ready')
  })

  it('still takes a response that brings a newer state, and live updates always win', () => {
    const assets = useAssetsStore()
    assets.projectId = 'p1'
    assets.upsert(image('processing'))
    assets.upsert(image('ready'))
    expect(assets.get('img')?.status).toBe('ready')
    live(image('processing')) // e.g. the server re-processes it
    expect(assets.get('img')?.status).toBe('processing')
  })
})

describe('assets store — list load', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps a "ready" update that arrived while the list was loading', async () => {
    const { api } = await import('@/lib/api')
    let resolve!: (list: AssetDTO[]) => void
    vi.spyOn(api.assets, 'list').mockReturnValue(new Promise((r) => (resolve = r)))
    const assets = useAssetsStore()
    const loading = assets.load('p1')
    live(image('ready')) // ingest finished while the request was in flight
    resolve([image('processing')]) // the list was read before that
    await loading
    expect(assets.get('img')?.status).toBe('ready')
  })
})
