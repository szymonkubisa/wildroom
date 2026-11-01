import { LINE_GAP, LINE_LEAD, LINE_TAIL } from '@shared/text/speech'
import type { StoryLine } from '@shared/types/story'

/**
 * Animatic timing: shots laid out with free temp voices (or the real lines where they exist) so the pacing shows
 * before anything is paid for. The lines sit under a shot the way assemble() places them: a short lead-in, a gap
 * between lines, a tail before the cut.
 */

// The first line starts LINE_LEAD after the shot, LINE_GAP between two, LINE_TAIL before the cut — the layout the
// Director sizes a speaking shot by and the dialogue check measures (shared/text/speech).
export { LINE_GAP, LINE_LEAD, LINE_TAIL }

/** Seconds a shot needs to hold its voice clips (0 without any). */
export function voicesSeconds(lengths: readonly number[]): number {
  if (!lengths.length) return 0
  return LINE_LEAD + lengths.reduce((a, b) => a + b, 0) + LINE_GAP * (lengths.length - 1) + LINE_TAIL
}

/**
 * A shot's length in the animatic: its own, or — when its voices need more — the whole seconds they need (video
 * models render whole seconds, so that's a length the shot can actually get).
 */
export function animaticSeconds(duration: number, lengths: readonly number[]): number {
  const need = voicesSeconds(lengths)
  return need > duration ? Math.ceil(need - 1e-9) : duration
}

/** Shots whose animatic length differs from their own: what "Apply animatic timing" would set. */
export function timingChanges(shots: readonly { id: string; duration: number }[], timing: ReadonlyMap<string, number>): { id: string; seconds: number }[] {
  return shots.flatMap((s) => {
    const seconds = timing.get(s.id)
    return seconds !== undefined && seconds !== s.duration ? [{ id: s.id, seconds }] : []
  })
}

/** The cached temp voice still says the line and its asset still exists. */
export function tempVoiceFresh(line: Pick<StoryLine, 'text' | 'tempVoice'>, exists: (assetId: string) => boolean): boolean {
  return Boolean(line.tempVoice && line.tempVoice.text === line.text && exists(line.tempVoice.assetId))
}
