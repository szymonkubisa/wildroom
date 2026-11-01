import type { StoryDoc, StoryLine, StoryShot } from '@shared/types/story'
import { describe, expect, it } from 'vitest'
import { dialogueFit, dialogueSeconds, lineSeconds, speakingRoom, splitLines, splitShot, spokenText } from './dialogueFit'

const line = (id: string, text: string, characterId?: string): StoryLine => ({ id, text, characterId })
/** A line of `n` words: n / 2.5 s, plus its share of the layout (0.3 s in, 0.25 s between lines, 0.6 s after). */
const words = (id: string, n: number) => line(id, Array.from({ length: n }, (_, i) => `w${i}`).join(' '))
const shot = (id: string, duration: number, dialogue: StoryLine[] = [], extra: Partial<StoryShot> = {}): StoryShot => ({
  id,
  description: `Shot ${id}`,
  prompt: `Prompt ${id}.`,
  duration,
  characterIds: [],
  dialogue,
  videoGenerationIds: [],
  ...extra,
})
const story = (shots: StoryShot[], multishots: StoryDoc['multishots'] = []): StoryDoc => ({ script: '', style: '', characters: [], shots, multishots })

describe('speaking time', () => {
  it('skips audio tags and acting cues and lays the lines out as the voice track does', () => {
    expect(spokenText('[whispering] [slowly]  Hello there')).toBe('Hello there')
    // A cue between phrases is direction, not words.
    expect(spokenText('Keep [looks away] going')).toBe('Keep going')
    expect(lineSeconds('[sighs] one two three four five')).toBeCloseTo(5 / 2.5)
    expect(lineSeconds('[sighs]  ')).toBe(0)
    // 15 words, a lead-in, one gap, a tail; the empty line is no line.
    expect(dialogueSeconds([words('a', 10), words('b', 5), line('c', '')])).toBeCloseTo(0.3 + 6 + 0.25 + 0.6)
    expect(dialogueSeconds([])).toBe(0)
    expect(speakingRoom(10, 2)).toBeCloseTo(10 - 0.3 - 0.6 - 0.25)
  })

  it('is tight once the lines run past the shot, and knows the whole seconds that fit', () => {
    expect(dialogueFit([words('a', 20)], 10)).toMatchObject({ tight: false, needed: 9 }) // 8.9 s of 10
    const tight = dialogueFit([words('a', 24)], 10) // 10.5 s
    expect(tight.tight).toBe(true)
    expect(tight.needed).toBe(11)
    expect(dialogueFit([], 5)).toMatchObject({ tight: false, needed: 0 })
  })

  it('a shot the Director sized for its lines is never tight (two lines of 9 words: 9 s, as the voice track needs)', () => {
    const nine = 'We have to leave before the smoke reaches us.'
    const lines = [line('a', nine), line('b', `[quietly] ${nine}`)]
    expect(dialogueFit(lines, 9)).toMatchObject({ tight: false, needed: 9 })
    // The Director's old 8 s was short of it.
    expect(dialogueFit(lines, 8).tight).toBe(true)
  })
})

describe('splitLines', () => {
  it('keeps the opening lines that fit and moves the rest', () => {
    const lines = [words('a', 10), words('b', 10), words('c', 10)] // 4 s of words each
    const { keep, move } = splitLines(lines, 8) // a and b need 9.15 s
    expect(keep.map((l) => l.id)).toEqual(['a'])
    expect(move.map((l) => l.id)).toEqual(['b', 'c'])
    expect(splitLines(lines, 10).keep.map((l) => l.id)).toEqual(['a', 'b'])
  })

  it('always keeps the first line, even when it alone is too long', () => {
    const { keep, move } = splitLines([words('a', 40), words('b', 2)], 5)
    expect(keep.map((l) => l.id)).toEqual(['a'])
    expect(move.map((l) => l.id)).toEqual(['b'])
  })
})

describe('splitShot', () => {
  const dialogue = () => [words('a', 10), words('b', 10), words('c', 10)].map((l, i) => ({ ...l, characterId: `c${i}`, generationId: `g${i}` }))

  it('moves the lines that don’t fit into a copy of the shot right after it', () => {
    const s = story([
      shot('x', 10, dialogue(), { camera: 'dolly in', shotType: 'CU', characterIds: ['c0', 'c1'], partialIds: ['c2'], placeId: 'p', sfx: 'rain', keyframeAssetId: 'k', videoGenerationIds: ['v'] }),
      shot('y', 5),
    ])
    const id = splitShot(s, 'x', 8, 8, () => 'new')
    expect(id).toBe('new')
    expect(s.shots.map((x) => x.id)).toEqual(['x', 'new', 'y'])
    expect(s.shots[0]!.dialogue.map((l) => l.id)).toEqual(['a'])
    const next = s.shots[1]!
    expect(next).toMatchObject({ prompt: 'Prompt x.', camera: 'dolly in', shotType: 'CU', characterIds: ['c0', 'c1'], partialIds: ['c2'], placeId: 'p', sfx: 'rain', videoGenerationIds: [] })
    expect(next.keyframeAssetId).toBeUndefined()
    expect(next.dialogue.map((l) => [l.id, l.characterId, l.generationId])).toEqual([['b', 'c1', 'g1'], ['c', 'c2', 'g2']])
    // 9.15 s of lines want 10 s; the model caps it at 8.
    expect(next.duration).toBe(8)
    expect(s.shots[0]!.duration).toBe(10)
  })

  it('gives the new shot what its lines need, at least 2 s', () => {
    const s = story([shot('x', 4, [words('a', 6), words('b', 2)])])
    splitShot(s, 'x', 4, 10, () => 'n')
    expect(s.shots[1]!.duration).toBe(2)
  })

  it('does nothing when every line fits or there is only one', () => {
    expect(splitShot(story([shot('x', 10, [words('a', 5), words('b', 5)])]), 'x', 10, 10, () => 'n')).toBeUndefined()
    expect(splitShot(story([shot('x', 3, [words('a', 30)])]), 'x', 3, 10, () => 'n')).toBeUndefined()
  })

  it('takes the new shot into a multi-shot group with room, and breaks up a full one', () => {
    const roomy = story([shot('x', 10, dialogue()), shot('y', 5)], [{ id: 'g', shotIds: ['x', 'y'], videoGenerationIds: ['t'], chosenAssetId: 'a', takes: { t: { planned: [5] } } }])
    splitShot(roomy, 'x', 10, 10, () => 'n')
    expect(roomy.multishots![0]).toMatchObject({ shotIds: ['x', 'n', 'y'], videoGenerationIds: [], chosenAssetId: undefined, takes: undefined })

    const full = story(
      [shot('a', 3), shot('b', 3), shot('x', 10, dialogue()), shot('d', 3)],
      [{ id: 'g', shotIds: ['a', 'b', 'x', 'd'], videoGenerationIds: [] }],
    )
    splitShot(full, 'x', 10, 10, () => 'n')
    expect(full.multishots).toEqual([])
  })

  it('a group on a model with more shots per clip (Kling: 6) still has room at four', () => {
    const four = story(
      [shot('a', 3), shot('b', 3), shot('x', 10, dialogue()), shot('d', 3)],
      [{ id: 'g', shotIds: ['a', 'b', 'x', 'd'], videoGenerationIds: [] }],
    )
    splitShot(four, 'x', 10, 10, () => 'n', 6)
    expect(four.multishots![0]!.shotIds).toEqual(['a', 'b', 'x', 'n', 'd'])
  })
})
