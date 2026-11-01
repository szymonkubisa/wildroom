import { describe, expect, it } from 'vitest'
import { LINE_GAP, LINE_LEAD, LINE_TAIL, animaticSeconds, tempVoiceFresh, timingChanges, voicesSeconds } from './animatic'

describe('animatic timing', () => {
  it('lays the voices out with a lead-in, gaps between lines and a tail', () => {
    expect(voicesSeconds([])).toBe(0)
    expect(voicesSeconds([2, 3])).toBeCloseTo(LINE_LEAD + 5 + LINE_GAP + LINE_TAIL)
  })

  it('keeps the shot length when the voices fit, else rounds what they need up to whole seconds', () => {
    expect(animaticSeconds(5, [])).toBe(5)
    expect(animaticSeconds(5, [2])).toBe(5) // 2.9 s of 5
    expect(animaticSeconds(5, [3, 2.5])).toBe(7) // 0.3 + 5.5 + 0.25 + 0.6 = 6.65
    expect(animaticSeconds(4.5, [3.7])).toBe(5) // 4.6 s needed → whole 5
  })

  it('lists only the shots whose length would change', () => {
    const shots = [
      { id: 'a', duration: 5 },
      { id: 'b', duration: 4 },
      { id: 'c', duration: 6 },
    ]
    expect(timingChanges(shots, new Map([['a', 5], ['b', 7]]))).toEqual([{ id: 'b', seconds: 7 }])
  })

  it('reuses a temp voice only while it says the line and its asset exists', () => {
    const exists = (id: string) => id === 'v1'
    expect(tempVoiceFresh({ text: 'Hi', tempVoice: { assetId: 'v1', text: 'Hi' } }, exists)).toBe(true)
    expect(tempVoiceFresh({ text: 'Hello', tempVoice: { assetId: 'v1', text: 'Hi' } }, exists)).toBe(false)
    expect(tempVoiceFresh({ text: 'Hi', tempVoice: { assetId: 'gone', text: 'Hi' } }, exists)).toBe(false)
    expect(tempVoiceFresh({ text: 'Hi' }, exists)).toBe(false)
  })
})
