import { describe, expect, it } from 'vitest'
import { firstFavorite, toggled } from './favorites'

describe('favourite models', () => {
  it('stars at the end and unstars in place', () => {
    expect(toggled(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggled(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })

  it('defaults to the first starred model of the kind that can run, skipping other kinds, unready and unknown ones', () => {
    const list = ['no-such-model', 'fal-seedance-2.5', 'fal-seedream-5-pro', 'fal-nano-banana-pro']
    expect(firstFavorite(list, 'image', () => true)?.id).toBe('fal-seedream-5-pro')
    expect(firstFavorite(list, 'image', (m) => m.id !== 'fal-seedream-5-pro')?.id).toBe('fal-nano-banana-pro')
    expect(firstFavorite(list, 'video', () => true)?.id).toBe('fal-seedance-2.5')
    expect(firstFavorite(['no-such-model'], 'image', () => true)).toBeUndefined()
  })
})
