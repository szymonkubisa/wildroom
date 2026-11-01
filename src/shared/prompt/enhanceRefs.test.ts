import { describe, expect, it } from 'vitest'
import { visibleParams } from '../models/params'
import { getModel } from '../models/registry'
import type { ModelSpec, ParamValues } from '../models/types'
import { ENHANCE_MAX_REFERENCES, enhanceReferences } from './enhanceRefs'

const model = (id: string) => getModel(id) as ModelSpec
const refsFor = (id: string, values: ParamValues) => enhanceReferences(model(id), values, visibleParams(model(id), values))

describe('the pictures the Director reads when it rewrites a prompt', () => {
  it('names an image model’s references image 1, image 2…', () => {
    expect(refsFor('fal-seedream-5-pro', { referenceImages: ['alley', 'car'] })).toEqual([
      { assetId: 'alley', role: 'reference', token: 'image 1' },
      { assetId: 'car', role: 'reference', token: 'image 2' },
    ])
  })

  it('names a video model’s references as its prompt does (Seedance: @Image1)', () => {
    expect(refsFor('fal-seedance-2.5', { referenceImages: ['kuba'] })).toEqual([{ assetId: 'kuba', role: 'reference', token: '@Image1' }])
  })

  it('gives the start and end frames their roles', () => {
    expect(refsFor('fal-wan-3.0', { firstFrame: 'a', lastFrame: 'b' }).map((r) => r.role)).toEqual(['start', 'end'])
  })

  it('takes nothing when the slots are empty, and at most a few pictures', () => {
    expect(refsFor('fal-seedream-5-pro', {})).toEqual([])
    const many = Array.from({ length: 10 }, (_, i) => `r${i}`)
    expect(refsFor('fal-seedance-2.5', { referenceImages: many })).toHaveLength(ENHANCE_MAX_REFERENCES)
  })
})
