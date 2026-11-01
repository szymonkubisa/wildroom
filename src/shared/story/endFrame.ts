import type { StoryShot } from '../types/story'

/**
 * Is a shot's end keyframe worth sending as the clip's last frame? Measured by how alike the two stills are (SSIM of
 * small grey copies, the server's frame-similarity). LTX lands on the end picture whatever it is: an end nearly the
 * same as the start froze the clip (0.97 and 0.94, The Last Road 4 and 5), one from another composition cut in the
 * middle of the shot (0.14, Impossible Worlds 4), and only the same camera with the world changed played well (0.43
 * and 0.41, Impossible Worlds 5 and 6).
 */

export type EndVerdict = 'same' | 'changed' | 'recomposed'

/** From here up the two stills are the same picture: the clip would freeze. */
export const END_SAME_SSIM = 0.9
/** From here down the end is another composition: the clip would cut to it. */
export const END_RECOMPOSED_SSIM = 0.35

/** The verdict for a measured pair; undefined until it is measured. */
export function endVerdict(ssim: number | undefined): EndVerdict | undefined {
  if (ssim === undefined || !Number.isFinite(ssim)) return undefined
  if (ssim >= END_SAME_SSIM) return 'same'
  if (ssim <= END_RECOMPOSED_SSIM) return 'recomposed'
  return 'changed'
}

/** Whether the shot's check was measured on these stills: redrawing either one makes it stale. */
export function endCheckFresh(shot: Pick<StoryShot, 'endCheck'>, startId: string | undefined, endId: string | undefined): boolean {
  const check = shot.endCheck
  return Boolean(check && startId && endId && check.startId === startId && check.endId === endId)
}
