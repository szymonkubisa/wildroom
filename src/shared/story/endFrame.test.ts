import { describe, expect, it } from 'vitest'
import { END_RECOMPOSED_SSIM, END_SAME_SSIM, endCheckFresh, endVerdict } from './endFrame'

describe('the end frame’s verdict', () => {
  it('same at the top, recomposed at the bottom, a visible change in between', () => {
    // As measured: The Last Road 4 and 5 froze; Impossible Worlds 4 cut mid-shot; 5 and 6 played well.
    expect(endVerdict(0.974)).toBe('same')
    expect(endVerdict(0.945)).toBe('same')
    expect(endVerdict(0.142)).toBe('recomposed')
    expect(endVerdict(0.43)).toBe('changed')
    expect(endVerdict(0.413)).toBe('changed')
    expect(endVerdict(END_SAME_SSIM)).toBe('same')
    expect(endVerdict(END_RECOMPOSED_SSIM)).toBe('recomposed')
  })

  it('nothing until measured', () => {
    expect(endVerdict(undefined)).toBeUndefined()
    expect(endVerdict(Number.NaN)).toBeUndefined()
  })

  it('a check holds only for the stills it measured', () => {
    const shot = { endCheck: { startId: 'k1', endId: 'e1', ssim: 0.5 } }
    expect(endCheckFresh(shot, 'k1', 'e1')).toBe(true)
    expect(endCheckFresh(shot, 'k2', 'e1')).toBe(false)
    expect(endCheckFresh(shot, 'k1', 'e2')).toBe(false)
    expect(endCheckFresh(shot, 'k1', undefined)).toBe(false)
    expect(endCheckFresh({}, 'k1', 'e1')).toBe(false)
  })
})
