import { describe, expect, it } from 'vitest'
import { type TimelineWord, cutRanges, isFiller, paragraphs, pauseRanges } from './transcript'

const w = (text: string, start: number, end: number, clipId = 'c'): TimelineWord => ({ text, start, end, clipId })

describe('transcript editing', () => {
  const words = [w('So', 0, 5), w('um,', 8, 12), w('this', 14, 20), w('works', 22, 30), w('fine', 70, 80)]

  it('recognises filler words with punctuation', () => {
    expect(isFiller('um,')).toBe(true)
    expect(isFiller('Uh.')).toBe(true)
    expect(isFiller('this')).toBe(false)
  })

  it('cuts a word through to the next kept word, merging neighbours, latest first', () => {
    expect(cutRanges(words, new Set([1]))).toEqual([{ start: 8, end: 14, clipIds: ['c'] }])
    const merged = cutRanges(words, new Set([1, 2, 4]))
    expect(merged).toEqual([
      { start: 70, end: 80, clipIds: ['c'] },
      { start: 8, end: 22, clipIds: ['c'] },
    ])
  })

  it('keeps a long silence (or silent shot) that follows a deleted word', () => {
    const list = [w('okay', 0, 10), w('um', 12, 16, 'a'), w('next', 160, 170, 'c')]
    expect(cutRanges(list, new Set([1]), 7)).toEqual([{ start: 12, end: 23, clipIds: ['a'] }])
  })

  it('shortens long pauses but keeps a little air', () => {
    const r = pauseRanges(words, 24, 1, 0.25)
    expect(r).toHaveLength(1)
    expect(r[0]!.start).toBeGreaterThan(30)
    expect(r[0]!.end).toBeLessThan(70)
  })

  it('starts a new paragraph after a long pause', () => {
    expect(paragraphs(words, 24).map((p) => p.words.length)).toEqual([4, 1])
  })
})
