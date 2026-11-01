import type { StoryCharacter, StoryDoc, StoryShot } from '@shared/types/story'
import { linePhrases, storyLanguage } from './soundtrack'

/**
 * A character's voice sample for LTX's subject references (Licon MSR V2: "Audio 1" belongs to "Image 1"): a few
 * seconds of their ElevenLabs voice saying their own words, over a quiet bed of the scene's sound with soft music —
 * Licon: without music under the voice sample the clip's ambience doesn't come through.
 */

/** About 5 s of speech (ElevenLabs speaks ~2.5–3 words a second); LTX encodes the whole sample. */
export const VOICE_SAMPLE_WORDS = 14

/** Said when the character has no lines of their own: neutral, in the story's language. */
const NEUTRAL: Record<string, string> = {
  English: 'It has been a long day. Tell me what really happened.',
  Polish: 'To był długi dzień. Powiedz mi, co się naprawdę stało.',
}

/**
 * What the character says in their sample: their own lines from the story, in order, without the acting cues, cut to
 * about VOICE_SAMPLE_WORDS words at a sentence end when there is one past the halfway point.
 */
export function voiceSampleText(story: Pick<StoryDoc, 'shots'>, c: Pick<StoryCharacter, 'id'>, maxWords = VOICE_SAMPLE_WORDS): string {
  const spoken = story.shots
    .flatMap((s) => s.dialogue)
    .filter((l) => l.characterId === c.id && l.text.trim())
    .map((l) =>
      linePhrases(l.text)
        .parts.map((p) => p.words)
        .filter(Boolean)
        .join(' '),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!spoken) return NEUTRAL[storyLanguage(story) ?? 'English']!
  const words = spoken.split(' ')
  if (words.length <= maxWords) return spoken
  const cut = words.slice(0, maxWords)
  // The last sentence end after the halfway point, so the sample doesn't stop mid-thought.
  const end = cut.findLastIndex((w, i) => i >= maxWords / 2 && /[.!?…]["”’']?$/.test(w))
  return end >= 0 ? cut.slice(0, end + 1).join(' ') : `${cut.join(' ').replace(/[,;:]+$/, '')}…`
}

/**
 * The bed under the sample: the sound of the scene where the character first speaks (its first shot with sounds, which
 * usually carries the scene's whole ambience), with soft distant music.
 */
export function voiceSampleBed(story: Pick<StoryDoc, 'shots'>, c: Pick<StoryCharacter, 'id'>): string {
  const first =
    story.shots.find((s) => s.dialogue.some((l) => l.characterId === c.id && l.text.trim())) ??
    story.shots.find((s) => s.characterIds.includes(c.id) || s.partialIds?.includes(c.id))
  const sameScene = (s: StoryShot) => (first?.sceneId ? s.sceneId === first.sceneId : Boolean(first?.scene) && s.scene === first?.scene)
  const sound = (first ? story.shots.filter((s) => s === first || sameScene(s)) : []).map((s) => s.sfx?.trim()).find(Boolean)
  const ambience = sound ? sound.replace(/[.\s]+$/, '').slice(0, 300) : 'a quiet room'
  return `${ambience}, with soft distant music underneath, quiet and steady, no voices`
}
