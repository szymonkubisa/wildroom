import { describe, expect, it } from 'vitest'
import { joinFraming, splitFraming, withFraming } from './framing'

describe('a shot’s framing line', () => {
  it('takes the size, the lens and the rest apart', () => {
    expect(splitFraming('MEDIUM CLOSE-UP, eye level, 50mm')).toEqual({ size: 'MEDIUM CLOSE-UP', lens: '50mm', rest: ['eye level'] })
    expect(splitFraming('WIDE 24 mm lens, low angle')).toEqual({ size: 'WIDE', lens: '24mm', rest: ['low angle'] })
    expect(splitFraming('OVER-THE-SHOULDER CLOSE-UP')).toEqual({ size: 'OVER-THE-SHOULDER CLOSE-UP', lens: '', rest: [] })
    expect(splitFraming(undefined)).toEqual({ size: '', lens: '', rest: [] })
  })

  it('puts it back with the lens last, and changes one part only', () => {
    expect(joinFraming(splitFraming('MEDIUM CLOSE-UP, eye level, 50mm'))).toBe('MEDIUM CLOSE-UP, eye level, 50mm')
    expect(withFraming('MEDIUM CLOSE-UP, eye level, 50mm', { lens: '85mm' })).toBe('MEDIUM CLOSE-UP, eye level, 85mm')
    expect(withFraming('MEDIUM CLOSE-UP, eye level, 50mm', { size: 'Close-up' })).toBe('Close-up, eye level, 50mm')
    expect(withFraming(undefined, { size: 'Wide' })).toBe('Wide')
    expect(withFraming('Wide, 24mm', { size: '', lens: '' })).toBeUndefined()
  })
})
