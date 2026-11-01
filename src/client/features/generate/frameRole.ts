import type { ParamValues } from '@shared/models/types'
import type { GenKind } from '@shared/types/jobs'

/**
 * What is attached, moved to its role in the other kind: one reference picture becomes a clip's start frame (Generate
 * from this, then Video), and a clip's start frame the picture's reference on the way back. Several references stay
 * references (a cast); a start frame already there is kept.
 */
export function swapFrameRole(values: ParamValues, from: GenKind | undefined, to: GenKind): ParamValues {
  const refs = Array.isArray(values.referenceImages) ? (values.referenceImages as string[]) : []
  const frame = typeof values.firstFrame === 'string' && values.firstFrame ? values.firstFrame : undefined
  if (from === 'image' && to === 'video' && refs.length === 1 && !frame) {
    const { referenceImages: _, ...rest } = values
    return { ...rest, firstFrame: refs[0] }
  }
  if (from === 'video' && to === 'image' && frame && !refs.length && !values.lastFrame) {
    const { firstFrame: _, ...rest } = values
    return { ...rest, referenceImages: [frame] }
  }
  return values
}
