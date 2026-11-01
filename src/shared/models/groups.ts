import type { VideoMultishot } from './workflow'

/**
 * The AI Director's multi-shot groups kept within a model's clip: each run of consecutive shots with the same group
 * number above 0 is cut into clips of 2–`maxShots` shots lasting at most `maxSeconds` together (the sum of their
 * durationSeconds). A shot that fits no clip (a leftover, or one too long to share) gets group 0, a shot of its own.
 *
 * Within a run the cut leaves as few shots on their own as it can, then makes as few clips as it can, then makes them
 * as even as it can (6 shots of a 4-shot model: 3 + 3, not 4 + 2). Returns the new group numbers, one per shot: every
 * clip numbered afresh (1, 2, 3… in order), so neighbouring clips never run together.
 */
export function splitGroups(
  shots: readonly { group?: number; durationSeconds: number }[],
  limits: Pick<VideoMultishot, 'maxShots' | 'maxSeconds'>,
): number[] {
  const maxShots = Math.max(2, Math.floor(limits.maxShots))
  const seconds = shots.map((s) => Math.max(0, Number(s.durationSeconds) || 0))
  const numbers = shots.map((s) => (Number.isFinite(s.group) && s.group! > 0 ? s.group! : 0))
  const out = new Array<number>(shots.length).fill(0)
  let next = 1
  for (let i = 0; i < shots.length; ) {
    let j = i
    while (numbers[i]! > 0 && j + 1 < shots.length && numbers[j + 1] === numbers[i]) j++
    if (j > i) {
      for (const [from, to] of cutRun(seconds.slice(i, j + 1), maxShots, limits.maxSeconds)) {
        if (to - from >= 2) out.fill(next++, i + from, i + to)
      }
    }
    i = j + 1
  }
  return out
}

/** Best cut of one run into [from, to) pieces: fewest shots alone, then fewest pieces, then the most even sizes. */
function cutRun(seconds: readonly number[], maxShots: number, maxSeconds: number): [number, number][] {
  const n = seconds.length
  type Score = [alone: number, pieces: number, squares: number]
  const better = (a: Score, b: Score) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  // best[k]: the best cut of the first k shots; from[k]: where its last piece starts.
  const best: (Score | undefined)[] = [[0, 0, 0]]
  const from: number[] = [0]
  for (let k = 1; k <= n; k++) {
    let total = 0
    // Shortest last piece first: a tie goes to the bigger clips earlier (5 shots: 3 + 2, as breakdownGroups cuts them).
    const sizes: number[] = []
    for (let size = 1; size <= Math.min(maxShots, k); size++) {
      total += seconds[k - size]!
      if (size === 1 || total <= maxSeconds) sizes.push(size)
    }
    for (const size of sizes) {
      const prev = best[k - size]!
      const score: Score = [prev[0] + (size === 1 ? 1 : 0), prev[1] + 1, prev[2] + size * size]
      if (!best[k] || better(score, best[k]!) < 0) {
        best[k] = score
        from[k] = k - size
      }
    }
  }
  const pieces: [number, number][] = []
  for (let k = n; k > 0; k = from[k]!) pieces.unshift([from[k]!, k])
  return pieces
}

/**
 * Shots where someone speaks leave their multi-shot group (group 0): LTX renders each on its own from its keyframe,
 * made to the line's recorded voice (audio to follow) — exact words and lip sync, which a multi-shot clip can't give.
 * Multi-shot stays for the runs without dialogue; run splitGroups after this to drop what is left alone.
 */
export function soloSpeakingShots<T extends { group?: number; dialogue: readonly { text: string }[] }>(shots: readonly T[]): T[] {
  return shots.map((s) => (s.dialogue.some((d) => d.text.trim()) && s.group ? { ...s, group: 0 } : s))
}

/**
 * Shots with a set end frame render on their own: one clip ends once, and an end picture placed mid-clip is morphed
 * toward rather than cut to.
 */
export function soloEndFrameShots<T extends { group?: number; endFrame?: string }>(shots: readonly T[]): T[] {
  return shots.map((s) => (s.endFrame?.trim() && s.group ? { ...s, group: 0 } : s))
}
