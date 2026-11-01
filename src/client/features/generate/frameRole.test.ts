import { describe, expect, it } from 'vitest'
import { swapFrameRole } from './frameRole'

describe('swapFrameRole', () => {
  it('one reference becomes the start frame for a clip, and back', () => {
    const video = swapFrameRole({ prompt: 'p', referenceImages: ['a'] }, 'image', 'video')
    expect(video).toEqual({ prompt: 'p', firstFrame: 'a' })
    expect(swapFrameRole(video, 'video', 'image')).toEqual({ prompt: 'p', referenceImages: ['a'] })
  })

  it('leaves several references, a start frame already set, and an end frame alone', () => {
    expect(swapFrameRole({ referenceImages: ['a', 'b'] }, 'image', 'video')).toEqual({ referenceImages: ['a', 'b'] })
    expect(swapFrameRole({ referenceImages: ['a'], firstFrame: 'f' }, 'image', 'video')).toEqual({ referenceImages: ['a'], firstFrame: 'f' })
    expect(swapFrameRole({ firstFrame: 'f', lastFrame: 'l' }, 'video', 'image')).toEqual({ firstFrame: 'f', lastFrame: 'l' })
    expect(swapFrameRole({ referenceImages: ['a'] }, 'image', 'upscale')).toEqual({ referenceImages: ['a'] })
  })
})
