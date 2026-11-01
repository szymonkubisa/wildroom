import { fmtNum, runFfmpeg } from './ffmpeg'

/**
 * Shot boundaries inside a rendered clip (e.g. a Kling multi-shot generation, whose task result reports no cut
 * points). Detection uses ffmpeg's scene score (`select='gt(scene,T)'` — mean absolute luma difference between
 * consecutive frames, 0–1) and prints the selected frames with `metadata=print`.
 */

export interface DetectSceneCutsOptions {
  /** Scene score a frame must exceed to count as a cut (0–1, default 0.3). Luma-based: same-brightness cuts score low. */
  threshold?: number
  /** Cuts closer than this (seconds) are merged; the higher-scoring one wins (default 0.4). */
  minGap?: number
  /** Native timestamp of the file's t=0: 0 for proxies, the asset's `timeOffset` for originals. */
  origin?: number
  /** Frames are downscaled to this width before scoring (speed; default 480). */
  analyzeWidth?: number
  signal?: AbortSignal
}

export interface SceneScore {
  /** Seconds (the file's native timeline, as ffmpeg sees it with -copyts). */
  time: number
  score: number
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** Frames reported by `metadata=print` after the scene `select`: time + `lavfi.scene_score`. */
export function parseSceneScores(stderr: string): SceneScore[] {
  const out: SceneScore[] = []
  let current: SceneScore | undefined
  for (const line of stderr.split(/\r\n|\r|\n/)) {
    const frame = /Parsed_metadata_\d+.*\bpts_time:\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/i.exec(line)
    if (frame) {
      current = { time: Number(frame[1]), score: Number.NaN }
      out.push(current)
      continue
    }
    const score = /lavfi\.scene_score=(\d+(?:\.\d+)?)/.exec(line)
    if (score && current && Number.isNaN(current.score)) current.score = Number(score[1])
  }
  return out.filter((s) => Number.isFinite(s.time))
}

/** Sorted cut times with neighbours closer than `minGap` merged (the stronger cut is kept). */
export function mergeCuts(scores: readonly SceneScore[], minGap: number): number[] {
  const kept: SceneScore[] = []
  for (const s of [...scores].sort((a, b) => a.time - b.time)) {
    const last = kept.at(-1)
    if (last && s.time - last.time < minGap) {
      if ((Number.isNaN(last.score) ? 0 : last.score) < (Number.isNaN(s.score) ? 0 : s.score)) kept[kept.length - 1] = s
      continue
    }
    kept.push(s)
  }
  return kept.map((s) => round3(s.time))
}

/**
 * Cut times (seconds from the file's t=0, sorted) where a new shot starts. The first frame never counts as a cut.
 */
export async function detectSceneCuts(videoPath: string, opts: DetectSceneCutsOptions = {}): Promise<number[]> {
  const threshold = Math.min(1, Math.max(0.01, opts.threshold ?? 0.3))
  const minGap = Math.max(0, opts.minGap ?? 0.4)
  const origin = opts.origin ?? 0
  const width = Math.max(64, Math.round(opts.analyzeWidth ?? 480))
  const filter = `scale=w='min(${width},iw)':h=-2,select='gt(scene,${fmtNum(threshold, 4)})',metadata=print`
  const { stderr } = await runFfmpeg(
    ['-nostats', '-copyts', '-i', videoPath, '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', filter, '-f', 'null', '-'],
    { signal: opts.signal },
  )
  const scores = parseSceneScores(stderr)
    .map((s) => ({ ...s, time: s.time - origin }))
    .filter((s) => s.time > 0.001)
  return mergeCuts(scores, minGap)
}

/**
 * Snaps each expected cut to the nearest detected cut within `tolerance` seconds (else keeps the expected time).
 * `snapped` counts the expected cuts that found a detected one.
 */
export function snapCuts(
  expected: readonly number[],
  detected: readonly number[],
  tolerance = 0.5,
): { cuts: number[]; snapped: number } {
  let snapped = 0
  const cuts = expected.map((e) => {
    let best: number | undefined
    for (const d of detected) {
      if (Math.abs(d - e) <= tolerance && (best === undefined || Math.abs(d - e) < Math.abs(best - e))) best = d
    }
    if (best !== undefined) snapped++
    return round3(best ?? e)
  })
  return { cuts: [...new Set(cuts)].sort((a, b) => a - b), snapped }
}

/** `snapCuts` without the statistics: expected cuts moved onto nearby detected cuts, sorted. */
export function refineCuts(expected: readonly number[], detected: readonly number[], tolerance = 0.5): number[] {
  return snapCuts(expected, detected, tolerance).cuts
}
