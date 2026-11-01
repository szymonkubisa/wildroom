import { LINE_GAP, LINE_LEAD, LINE_TAIL, WORDS_PER_SECOND, countWords, linesSeconds, secondsForLines, speakableText } from '@shared/text/speech'
import type { StoryDoc, StoryLine, StoryShot } from '@shared/types/story'
import { MULTISHOT_MAX_SHOTS } from './multishot'

/**
 * Does a shot's dialogue fit its length? A rough speaking-time estimate: lines that run over the clip get cut off
 * mid-word (video models with their own audio) or spill over the next shot (ElevenLabs lines). The words, the pace and
 * how the lines sit in the shot are the Director's and the voice track's (shared/text/speech): a shot the Director
 * sized for its lines is never called tight here, and "Shorten lines" aims at the same budget this check warns about.
 */

/**
 * The last second of a multi-shot clip stays free of lines — Lightricks: "whatever you put in the last second tends to
 * arrive half-finished"; the clip ends on a settle.
 */
export const END_SETTLE_SECONDS = 1

/** The spoken words of a line: [audio tags] and [acting cues] — at the start or between phrases — aren't said. */
export const spokenText = speakableText

/** Seconds to say one line's words (0 for an empty line). */
export function lineSeconds(text: string): number {
  return countWords(text) / WORDS_PER_SECOND
}

/** Seconds a shot's lines take in it: their words, laid out with a lead-in, the gaps between them and a tail (linesSeconds). */
export function dialogueSeconds(lines: readonly Pick<StoryLine, 'text'>[]): number {
  return linesSeconds(lines.map((l) => l.text))
}

/** Seconds of words that fit in `available` seconds holding `count` lines: the rest is the lead-in, the gaps and the tail. */
export const speakingRoom = (available: number, count: number) => available - LINE_LEAD - LINE_TAIL - LINE_GAP * Math.max(0, count - 1)

export interface DialogueFit {
  spoken: number
  /** The clip the shot actually gets (see useStory). */
  available: number
  tight: boolean
  /** Whole seconds the lines need (secondsForLines). */
  needed: number
}

export function dialogueFit(lines: readonly Pick<StoryLine, 'text'>[], available: number): DialogueFit {
  const spoken = dialogueSeconds(lines)
  return { spoken, available, tight: spoken > available + 1e-9, needed: secondsForLines(lines.map((l) => l.text)) }
}

/**
 * The longest run of opening lines that fits `available` seconds (at least one, so a split always moves something
 * forward); the rest go to the next shot.
 */
export function splitLines<T extends Pick<StoryLine, 'text'>>(lines: readonly T[], available: number): { keep: T[]; move: T[] } {
  let k = 0
  while (k < lines.length && (k === 0 || dialogueSeconds(lines.slice(0, k + 1)) <= available + 1e-9)) k++
  return { keep: lines.slice(0, k), move: lines.slice(k) }
}

/**
 * Splits a shot whose dialogue doesn't fit: the lines past what fits move to a new shot right after it, with the same
 * picture (prompt, camera, framing, cast, sounds) and no media yet; it gets the length its lines need. A multi-shot
 * group with room takes the new shot in (its takes no longer match); a full one is broken up. Mutates `story` (call
 * inside an update). Returns the new shot's id, or undefined when nothing could move.
 */
export function splitShot(
  story: StoryDoc,
  shotId: string,
  available: number,
  maxSeconds: number,
  newId: () => string,
  /** The group's limit (its model's, workflowFor(model).multishot.maxShots). */
  maxShots = MULTISHOT_MAX_SHOTS,
): string | undefined {
  const i = story.shots.findIndex((s) => s.id === shotId)
  const shot = story.shots[i]
  if (!shot) return undefined
  const spoken = shot.dialogue.filter((l) => l.text.trim())
  const { move } = splitLines(spoken, available)
  if (!move.length) return undefined
  const moved = new Set(move.map((l) => l.id))
  const next: StoryShot = {
    id: newId(),
    sceneId: shot.sceneId,
    scene: shot.scene,
    description: shot.description,
    shotType: shot.shotType,
    ...(shot.view ? { view: shot.view } : {}),
    camera: shot.camera,
    prompt: shot.prompt,
    duration: Math.max(2, Math.min(maxSeconds, secondsForLines(move.map((l) => l.text)))),
    characterIds: [...shot.characterIds],
    ...(shot.partialIds?.length ? { partialIds: [...shot.partialIds] } : {}),
    ...(shot.placeId ? { placeId: shot.placeId } : {}),
    dialogue: move.map((l) => ({ ...l })),
    sfx: shot.sfx,
    videoGenerationIds: [],
  }
  shot.dialogue = shot.dialogue.filter((l) => !moved.has(l.id))
  story.shots.splice(i + 1, 0, next)
  const group = story.multishots?.find((g) => g.shotIds.includes(shotId))
  if (group) {
    if (group.shotIds.length < maxShots) {
      group.shotIds.splice(group.shotIds.indexOf(shotId) + 1, 0, next.id)
      group.videoGenerationIds = []
      group.chosenAssetId = undefined
      group.finalGenerationId = undefined
      group.takes = undefined
    } else story.multishots = story.multishots!.filter((g) => g !== group)
  }
  return next.id
}
