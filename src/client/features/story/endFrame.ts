import { endCheckFresh, endVerdict } from '@shared/story/endFrame'
import { insertShot } from '@shared/story/structure'
import type { StoryDoc, StoryShot } from '@shared/types/story'
import { endingOf } from './dialects'
import { validGroups } from './multishot'

/**
 * A shot's end keyframe in the clip, pure: whether the picture goes as the clip's last frame or only its description
 * (the ending is in the prompt either way, endingOf), and splitting a shot whose end is another composition in two.
 */

/**
 * What becomes of the end keyframe: sent as the last frame ('image'), only its description ('text' — the user's call,
 * or no end picture drawn), or held back by the check — barely different from the start ('same': the clip froze, The
 * Last Road 4 and 5) or another composition ('recomposed': it cut in the middle, Impossible Worlds 4). 'unchecked'
 * until the two stills are measured. Undefined for a shot with no end frame.
 */
export type EndState = 'image' | 'text' | 'same' | 'recomposed' | 'unchecked'

export function endState(shot: Pick<StoryShot, 'endFrame' | 'endCheck' | 'endUse'>, startId: string | undefined, endId: string | undefined): EndState | undefined {
  if (!endId) return shot.endFrame?.trim() ? 'text' : undefined
  if (shot.endUse) return shot.endUse
  if (!startId || !endCheckFresh(shot, startId, endId)) return 'unchecked'
  const verdict = endVerdict(shot.endCheck!.ssim)
  return verdict === 'changed' ? 'image' : (verdict ?? 'unchecked')
}

/** How the card and the row say it: one line. `lipSync`: made to its voice track, the picture never goes. */
export function endStateText(state: EndState, ssim?: number, opts: { lipSync?: boolean; userCall?: boolean } = {}): string {
  const measured = ssim === undefined ? '' : ` (${Math.round(ssim * 100)}% alike)`
  if (opts.lipSync) return 'Lip-synced to its lines: the end picture never goes, only its description'
  switch (state) {
    case 'image':
      return opts.userCall ? 'Sent as the clip’s last frame — your call' : `Same camera, a visible change${measured}: sent as the clip’s last frame`
    case 'text':
      return opts.userCall ? 'Only its description goes — your call' : 'Only its description goes: no end picture yet'
    case 'same':
      return `Barely differs from the still${measured}: the clip would freeze — only its description goes`
    case 'recomposed':
      return `Another composition than the still${measured}: the clip would cut to it — only its description goes`
    case 'unchecked':
      return 'Not compared with the still yet'
  }
}

/**
 * A shot whose end keyframe is another composition, split there: the next shot starts from that picture — its
 * keyframe, with the end's description as its first frame and action — and this one ends where it will. One clip
 * cut in the middle (Impossible Worlds 4) as two shots that cut on purpose. The length is shared out; the new shot
 * goes right after it — after its whole multi-shot group when it has one (as insertShot does), which would break up
 * otherwise. Mutates `story` (call inside an update). Returns the new shot's id, or undefined with no end frame.
 */
export function splitAtEndFrame(story: StoryDoc, shotId: string, newId: () => string): string | undefined {
  const shot = story.shots.find((s) => s.id === shotId)
  const endFrame = shot?.endFrame?.trim()
  if (!shot || !endFrame) return undefined
  const first = Math.max(1, Math.ceil(shot.duration / 2))
  const next: StoryShot = {
    id: newId(),
    ...(shot.sceneId ? { sceneId: shot.sceneId } : {}),
    ...(shot.scene ? { scene: shot.scene } : {}),
    // What it shows, in a few words: the ending's first clause ("The ring is free in his raised hands").
    description: endingOf(shot)?.split(/;\s*/)[0]!.replace(/[.\s]+$/, '') || shot.description,
    ...(shot.shotType ? { shotType: shot.shotType } : {}),
    frame: endFrame,
    prompt: endFrame,
    // Another camera than the start's: where it stands and how it moves are for the user to say.
    duration: Math.max(1, shot.duration - first),
    characterIds: [...shot.characterIds],
    ...(shot.partialIds?.length ? { partialIds: [...shot.partialIds] } : {}),
    ...(shot.hiddenIds?.length ? { hiddenIds: [...shot.hiddenIds] } : {}),
    ...(shot.placeId ? { placeId: shot.placeId } : {}),
    ...(shot.background ? { background: shot.background } : {}),
    ...(shot.blocking ? { blocking: shot.blocking } : {}),
    dialogue: [],
    ...(shot.sfx ? { sfx: shot.sfx } : {}),
    ...(shot.endKeyframeAssetId ? { keyframeAssetId: shot.endKeyframeAssetId } : {}),
    ...(shot.endKeyframeGenerationId ? { keyframeGenerationId: shot.endKeyframeGenerationId } : {}),
    videoGenerationIds: [],
  }
  shot.duration = first
  delete shot.endFrame
  delete shot.endKeyframeAssetId
  delete shot.endKeyframeGenerationId
  delete shot.endCheck
  delete shot.endUse
  if (shot.sceneId && story.scenes?.some((s) => s.id === shot.sceneId)) insertShot(story, shot.sceneId, next, shot.id)
  else {
    const group = validGroups(story).find((g) => g.shotIds.includes(shot.id))
    const after = story.shots.findIndex((s) => s.id === (group?.shotIds.at(-1) ?? shot.id))
    story.shots.splice(after + 1, 0, next)
  }
  return next.id
}
