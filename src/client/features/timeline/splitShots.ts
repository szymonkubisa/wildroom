import { expectedCuts, parseMultiShot } from '@shared/models/multishot'
import { secondsToFlicks } from '@shared/time/flicks'
import { type ClipLayoutItem, blade, localFrameAt } from '@shared/timeline'
import type { SceneCutsResponse } from '@shared/types/scenes'
import { type Clip, type MediaClip, activeTake } from '@shared/types/project-doc'
import { toast } from 'vue-sonner'
import { api, errorMessage } from '@/lib/api'
import { useAssetsStore } from '@/stores/assets'
import { useJobsStore } from '@/stores/jobs'
import { useProjectStore } from '@/stores/project'

/**
 * "Split into shots": blades a clip where its picture cuts to a new shot — for Kling multi-shot generations the
 * planned shot boundaries (from the generation's prompt) refined by scene detection, otherwise scene detection.
 */

/** Planned cut times (seconds from the take's t=0) of a multi-shot generation, from its params. */
export function expectedCutsFromParams(params: Record<string, unknown> | undefined): number[] {
  if (!params || params.multiShot !== true || typeof params.prompt !== 'string') return []
  const plan = parseMultiShot(params.prompt)
  const duration = Number(params.duration)
  return plan && Number.isFinite(duration) && duration > 0 ? expectedCuts(plan.shots, duration) : []
}

/**
 * Absolute timeline frames (descending) at which to blade `clip` so each source cut time starts a new piece.
 * Only cuts inside the clip's visible source range count (sourceIn, speed and fps via `localFrameAt`); cuts closer
 * than `minGapSeconds` to the clip edges or to each other are dropped so a detected flash or a boundary rounding
 * never leaves a sliver of a few frames.
 */
export function cutFrames(clip: Clip, clipStart: number, cutSeconds: readonly number[], fps: number, minGapSeconds = 0.25): number[] {
  const minGap = Math.max(1, Math.round(minGapSeconds * fps))
  const locals = [...new Set(cutSeconds.map((seconds) => localFrameAt(clip, secondsToFlicks(seconds), fps)))]
    .filter((local) => local >= minGap && local <= clip.duration - minGap)
    .sort((a, b) => a - b)
  const kept: number[] = []
  for (const local of locals) if (!kept.length || local - kept.at(-1)! >= minGap) kept.push(local)
  return kept.map((local) => clipStart + local).sort((a, b) => b - a)
}

function mediaClipOf(entry: ClipLayoutItem): MediaClip | undefined {
  const clip = entry.type === 'spine' ? entry.item : entry.item.clip
  return clip.kind === 'media' ? clip : undefined
}

const SOURCE_NOTE: Record<SceneCutsResponse['source'], string> = {
  refined: 'Planned shot boundaries, aligned to the detected cuts.',
  expected: 'Planned shot boundaries (no matching cuts detected in the picture).',
  detected: 'Cuts detected in the picture.',
}

export function useSplitShots() {
  const project = useProjectStore()
  const assets = useAssetsStore()
  const jobs = useJobsStore()

  function clipEntry(clipId: string): ClipLayoutItem | undefined {
    const entry = project.layout.byId.get(clipId)
    return entry && entry.type !== 'marker' ? entry : undefined
  }

  /** Blades the clip (spine or connected) at every shot change of its active take; returns the number of cuts. */
  async function splitIntoShots(clipId: string): Promise<number> {
    const entry = clipEntry(clipId)
    const clip = entry && mediaClipOf(entry)
    const take = clip && activeTake(clip)
    const asset = assets.get(take?.assetId)
    if (!clip || !take || !asset || asset.kind !== 'video') {
      toast.warning('Split into shots works on video clips', { description: take && !take.assetId ? 'This clip is still generating.' : undefined })
      return 0
    }
    const params = (take.generationId ? jobs.byId[take.generationId]?.params : undefined) ?? asset.generation?.params
    const expected = expectedCutsFromParams(params)

    const toastId = toast.loading('Finding shot changes…')
    let result: SceneCutsResponse
    try {
      // Without planned cuts the server still uses the plan stored with the asset, if any.
      result = await api.assets.sceneCuts(asset.id, expected.length ? { expected } : {})
    } catch (err) {
      toast.error('Could not find the shot changes', { id: toastId, description: errorMessage(err) })
      return 0
    }

    // The timeline may have changed while waiting: map against the current layout.
    const current = clipEntry(clipId)
    const currentClip = current && mediaClipOf(current)
    if (!current || !currentClip || activeTake(currentClip)?.assetId !== asset.id) {
      toast.dismiss(toastId)
      return 0
    }
    const frames = cutFrames(currentClip, current.start, result.cuts, project.fps)
    if (!frames.length) {
      toast.info(result.cuts.length ? 'No shot changes inside the visible part of this clip' : 'No shot changes found in this clip', {
        id: toastId,
      })
      return 0
    }
    const shots = frames.length + 1
    // Descending frames: blading keeps the left piece's id, so every cut lands in the untouched remainder.
    const changed = project.apply((draft, ctx) => {
      for (const frame of frames) blade(clipId, frame)(draft, ctx)
    }, `Split into ${shots} shots`)
    if (!changed) {
      toast.dismiss(toastId)
      return 0
    }
    toast.success(`Split into ${shots} shots`, { id: toastId, description: SOURCE_NOTE[result.source] })
    // A storyboard take's pieces are named after the shots they show (storyNaming reads the stores alone, not the rest
    // of the storyboard; loaded lazily: the timeline doesn't build on the story).
    void import('@/features/story/storyNaming').then(({ nameStoryTakes }) => nameStoryTakes({ force: true })).catch(() => undefined)
    return frames.length
  }

  return { splitIntoShots }
}
