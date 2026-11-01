import type { StoryShot } from '@shared/types/story'
import { describe, expect, it } from 'vitest'
import { voiceSampleBed, voiceSampleText } from './voiceSample'

const shot = (id: string, extra: Partial<StoryShot> = {}): StoryShot => ({
  id,
  description: '',
  prompt: '',
  duration: 4,
  characterIds: [],
  dialogue: [],
  videoGenerationIds: [],
  ...extra,
})
const line = (characterId: string, text: string) => ({ id: text.slice(0, 6), characterId, text })

// Bajo la lluvia: Valentina's lines, cues in brackets, the scene's ambience on its first shot.
const story = {
  shots: [
    shot('a', { scene: 'S01', sfx: 'steady rain strikes terracotta tiles; muffled bolero guitar drifts through the glass doors', characterIds: ['m'] }),
    shot('b', { scene: 'S01', sfx: 'the courtyard ambience continues', characterIds: ['v'], dialogue: [line('v', '[barely a breath] Mateo…')] }),
    shot('c', { scene: 'S01', characterIds: ['v'], dialogue: [line('v', "[voice held steady] I'm getting married tomorrow.")] }),
    shot('d', { scene: 'S01', characterIds: ['v'], dialogue: [line('v', 'You left me. [her eyes search his face] Without a word.')] }),
  ],
}

describe('voiceSampleText', () => {
  it('says the character’s own lines, without the acting cues', () => {
    expect(voiceSampleText(story, { id: 'v' })).toBe("Mateo… I'm getting married tomorrow. You left me. Without a word.")
  })

  it('stops at a sentence end past the halfway point when the lines run long', () => {
    expect(voiceSampleText(story, { id: 'v' }, 8)).toBe("Mateo… I'm getting married tomorrow. You left me.")
    expect(voiceSampleText({ shots: [shot('x', { dialogue: [line('v', 'one two three four five six seven eight nine ten')] })] }, { id: 'v' }, 4)).toBe('one two three four…')
  })

  it('falls back to a neutral line in the story’s language', () => {
    expect(voiceSampleText(story, { id: 'm' })).toBe('It has been a long day. Tell me what really happened.')
    expect(voiceSampleText({ shots: [shot('x', { dialogue: [line('a', 'Cześć.')] })] }, { id: 'b' })).toBe('To był długi dzień. Powiedz mi, co się naprawdę stało.')
  })
})

describe('voiceSampleBed', () => {
  it('takes the scene’s first sounds, under soft music', () => {
    expect(voiceSampleBed(story, { id: 'v' })).toBe(
      'steady rain strikes terracotta tiles; muffled bolero guitar drifts through the glass doors, with soft distant music underneath, quiet and steady, no voices',
    )
    expect(voiceSampleBed({ shots: [] }, { id: 'v' })).toBe('a quiet room, with soft distant music underneath, quiet and steady, no voices')
  })
})
