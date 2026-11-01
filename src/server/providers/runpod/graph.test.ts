import { describe, expect, it } from 'vitest'
import { graphFrames, guideFrameIndices, guideFrameIndicesAt } from './graph'

describe('guideFrameIndicesAt', () => {
  const fps = 24
  const frames = graphFrames(fps, 10) // 241

  it('puts each in-between still at its cut when the times are given', () => {
    expect(guideFrameIndicesAt(frames, fps, [3.4, 6.1], 2)).toEqual([82, 146])
  })

  it('keeps the stills inside the clip and in order', () => {
    expect(guideFrameIndicesAt(frames, fps, [0, 0, 12], 3)).toEqual([1, 2, frames - 2])
  })

  it('spreads them evenly without times, or when the times do not match the stills', () => {
    expect(guideFrameIndicesAt(frames, fps, undefined, 2)).toEqual(guideFrameIndices(frames, 2))
    expect(guideFrameIndicesAt(frames, fps, [3], 2)).toEqual(guideFrameIndices(frames, 2))
  })
})
