import type { AssetDTO } from '@shared/types/assets'
import { describe, expect, it } from 'vitest'
import { ASSET_DRAG_TYPE, AUDIO_DRAG_TYPE, readAssetDrag, setAssetDrag } from './drag'

function asset(id: string, kind: AssetDTO['kind'] = 'video'): AssetDTO {
  return {
    id,
    kind,
    name: `Clip ${id}`,
    status: 'ready',
    source: 'generation',
    hasVideo: kind !== 'audio',
    hasAudio: kind === 'audio',
    variants: {},
    parentIds: [],
    rating: 0,
    keywords: [],
    projectIds: [],
    createdAt: '',
  }
}

/** Enough of DataTransfer for the helpers (node has none). */
function transfer(): DataTransfer {
  const data = new Map<string, string>()
  return {
    effectAllowed: 'none',
    get types() {
      return [...data.keys()]
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
  } as unknown as DataTransfer
}

describe('asset drag payload', () => {
  it('round-trips a single asset', () => {
    const dt = transfer()
    setAssetDrag(dt, [asset('c')])
    expect(readAssetDrag(dt)).toEqual(['c'])
    expect(dt.types).not.toContain(AUDIO_DRAG_TYPE)
  })

  it('marks an all-audio drag so dragover can route it to audio lanes', () => {
    const dt = transfer()
    setAssetDrag(dt, [asset('v', 'audio')])
    expect(dt.types).toContain(AUDIO_DRAG_TYPE)
  })

  it('reads a multi-asset payload in order', () => {
    const dt = transfer()
    dt.setData(ASSET_DRAG_TYPE, JSON.stringify({ assetId: 'c', assetIds: ['c', 'a', 'b'] }))
    expect(readAssetDrag(dt)).toEqual(['c', 'a', 'b'])
  })

  it('reads the older single-asset payload', () => {
    const dt = transfer()
    dt.setData(ASSET_DRAG_TYPE, JSON.stringify({ assetId: 'x' }))
    expect(readAssetDrag(dt)).toEqual(['x'])
  })

  it('ignores drags that are not ours', () => {
    const dt = transfer()
    expect(readAssetDrag(dt)).toBeUndefined()
    dt.setData(ASSET_DRAG_TYPE, 'not json')
    expect(readAssetDrag(dt)).toBeUndefined()
  })
})
