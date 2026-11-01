import { describe, expect, it } from 'vitest'
import { soloSpeakingShots, splitGroups } from './groups'

const shots = (groups: number[], seconds = 2) => groups.map((group) => ({ group, durationSeconds: seconds }))
const LTX = { maxShots: 4, maxSeconds: 10 }

describe('splitGroups', () => {
  it('keeps groups that fit, numbered afresh in order', () => {
    expect(splitGroups(shots([0, 7, 7, 0, 3, 3, 3]), LTX)).toEqual([0, 1, 1, 0, 2, 2, 2])
    expect(splitGroups([], LTX)).toEqual([])
  })

  it('leaves a lone shot (or a group of one) on its own', () => {
    expect(splitGroups(shots([0, 5, 0, 6]), LTX)).toEqual([0, 0, 0, 0])
    expect(splitGroups([{ durationSeconds: 3 }, { durationSeconds: 3 }], LTX)).toEqual([0, 0])
  })

  it('splits by shot count, as evenly as breakdownGroups does', () => {
    expect(splitGroups(shots([1, 1, 1, 1, 1, 1]), LTX)).toEqual([1, 1, 1, 2, 2, 2])
    expect(splitGroups(shots([1, 1, 1, 1, 1]), LTX)).toEqual([1, 1, 1, 2, 2])
    // Kling's native shot list takes six.
    expect(splitGroups(shots([1, 1, 1, 1, 1, 1], 2), { maxShots: 6, maxSeconds: 15 })).toEqual([1, 1, 1, 1, 1, 1])
  })

  it('splits by the clip length', () => {
    // 4 × 4 s = 16 s > 10 s: two clips of 8 s.
    expect(splitGroups(shots([2, 2, 2, 2], 4), LTX)).toEqual([1, 1, 2, 2])
    // Veo: 8 s clips.
    expect(splitGroups(shots([1, 1, 1], 3), { maxShots: 4, maxSeconds: 8 })).toEqual([1, 1, 0])
    const mixed = [6, 3, 5, 4].map((durationSeconds) => ({ group: 9, durationSeconds }))
    expect(splitGroups(mixed, LTX)).toEqual([1, 1, 2, 2])
  })

  it('gives a leftover shot group 0', () => {
    // Two-shot clips: three shots make one clip and one shot alone.
    expect(splitGroups(shots([4, 4, 4]), { maxShots: 2, maxSeconds: 10 })).toEqual([1, 1, 0])
    // Too long to share a clip with anyone.
    expect(splitGroups([{ group: 1, durationSeconds: 9 }, { group: 1, durationSeconds: 3 }, { group: 1, durationSeconds: 3 }], LTX)).toEqual([0, 1, 1])
  })

  it('leaves as few shots alone as it can before making fewer clips', () => {
    // 4 + 1 would leave one alone; 3 + 2 leaves none.
    expect(splitGroups(shots([1, 1, 1, 1, 1], 2), { maxShots: 4, maxSeconds: 30 })).toEqual([1, 1, 1, 2, 2])
  })

  it('treats junk group numbers as no group', () => {
    expect(splitGroups([{ group: -1, durationSeconds: 2 }, { group: -1, durationSeconds: 2 }, { group: Number.NaN, durationSeconds: 2 }], LTX)).toEqual([0, 0, 0])
  })
})

describe('soloSpeakingShots', () => {
  it('takes shots with a spoken line out of their group; what is left alone plays on its own', () => {
    const line = [{ text: 'Mateo…' }]
    const run = [
      { group: 1, durationSeconds: 3, dialogue: [] },
      { group: 1, durationSeconds: 2, dialogue: [] },
      { group: 1, durationSeconds: 3, dialogue: line },
      { group: 2, durationSeconds: 3, dialogue: [{ text: '  ' }] },
      { group: 2, durationSeconds: 3, dialogue: line },
    ]
    const solo = soloSpeakingShots(run)
    expect(solo.map((s) => s.group)).toEqual([1, 1, 0, 2, 0])
    expect(splitGroups(solo, LTX)).toEqual([1, 1, 0, 0, 0])
  })
})
