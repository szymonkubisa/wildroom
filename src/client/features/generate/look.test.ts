import { describe, expect, it } from 'vitest'
import { LOOK_AXES, lookAxesFor, lookPhrases, withLook } from './look'

describe('look', () => {
  it('adds the picked phrases after the prompt, in axis order', () => {
    expect(withLook('A lighthouse on a cliff', { color: 'mono', lighting: 'golden' }, 'image')).toBe(
      'A lighthouse on a cliff. warm low golden-hour sunlight, long soft shadows. black-and-white, rich contrast.',
    )
  })

  it('leaves the prompt alone with everything on Auto', () => {
    expect(withLook('A lighthouse.', {}, 'image')).toBe('A lighthouse.')
  })

  it('does not say a phrase twice (a result reused with its prompt)', () => {
    const once = withLook('A lighthouse', { lighting: 'golden' }, 'image')
    expect(withLook(once, { lighting: 'golden' }, 'image')).toBe(once)
  })

  it('takes no camera framing for a clip: its move is in the move picker', () => {
    expect(lookAxesFor('video')).toEqual(['lens', 'lighting', 'color'])
    expect(lookPhrases({ camera: 'close', color: 'vivid' }, 'video')).toEqual(['vivid, saturated colours'])
    expect(lookPhrases({ camera: 'close' }, 'music')).toEqual([])
  })

  it('puts the lens after the framing and before the light', () => {
    expect(withLook('A fox', { lighting: 'blue', lens: 'portrait', camera: 'close' }, 'image')).toBe(
      'A fox. close-up on the face, the background soft. shot on an 85mm portrait lens at f/1.8, shallow depth of field, creamy bokeh. blue-hour dusk light, cool and soft.',
    )
    expect(lookPhrases({ camera: 'close', lens: 'anamorphic' }, 'video')).toEqual(['anamorphic lens, horizontal blue lens flares, oval bokeh, cinematic widescreen'])
  })

  it('has unique option ids per axis', () => {
    for (const axis of LOOK_AXES) expect(new Set(axis.options.map((o) => o.id)).size).toBe(axis.options.length)
  })
})
