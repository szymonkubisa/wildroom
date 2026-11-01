/**
 * The story put onto the timeline, pure: the clip each shot becomes, the lines under it and the markers where its
 * chapters (else scenes) start. No Vue, no stores — useStory resolves the takes and stills and applies the recipe.
 */
import { assemblyMarks, shotLabel } from '@shared/story/structure'
import { flicksToSeconds, secondsToFlicks } from '@shared/time/flicks'
import {
  type MediaInfo,
  type MediaInfoLookup,
  type TimelineRecipe,
  addMarker,
  appendToSpine,
  connectAt,
  layoutTimeline,
  makeGap,
  makeMediaClip,
  makeTitle,
  normalize,
} from '@shared/timeline'
import { createTimeline, currentTimelineId, openTimeline } from '@shared/timeline/timelines'
import type { Clip, ConnectedItem, Marker, MarkerKind, ProjectDoc, SpineItem } from '@shared/types/project-doc'
import type { MultishotTakeCuts, StoryDoc, StoryMultishot, StoryShot } from '@shared/types/story'
import { LINE_GAP, LINE_LEAD } from './animatic'
import { takeCuts, validGroups } from './multishot'
import { groupShots } from './planning'

/** A shot's piece of a multi-shot take, in seconds of the take. */
export interface TakePiece {
  shotId: string
  start: number
  end: number
}

/**
 * Each shot's piece of a group take `seconds` long, cut where the take changes shot (see takeCuts; `rec` is the take's
 * cut record). A stray opening shot (LTX from references) is left out: the first shot starts after it.
 */
export function takePieces(shots: StoryShot[], seconds: number, rec?: MultishotTakeCuts): TakePiece[] {
  const { cuts, start } = takeCuts(shots, seconds, rec)
  const bounds = [start ?? 0, ...cuts, seconds]
  return shots.map((shot, i) => ({ shotId: shot.id, start: bounds[i]!, end: bounds[i + 1]! }))
}

/** What the assembly reads besides the story: the project's timeline and the media the stores have. */
export interface AssemblySources {
  /** The project's frame rate as the clips are made (an fps auto-lock may change it once they are in). */
  fps: number
  /** What the timeline knows of an asset: media it doesn't know is left out (a shot gets its title card). */
  media: MediaInfoLookup
  newId: () => string
  /** A group's chosen take, and the generation that rendered it (its cut record is kept under it), if it has one. */
  groupTake(g: StoryMultishot): { asset: { id: string; durationFlicks?: number }; generationId?: string } | undefined
  /** What a shot shows when its group's take doesn't cover it: its chosen take, else its keyframe still. */
  shotMedia(shot: StoryShot): { id: string } | undefined
  /** The group renders shot by shot now (Separate shots, see planning.rendersShotByShot): its one clip is an older take. */
  separate?(g: StoryMultishot): boolean
  /** The shot's own chosen take (not its still), if it has one. */
  shotTake?(shot: StoryShot): { id: string } | undefined
}

/** How the shots go onto the timeline: their lengths and the audio under each. */
export interface AssemblyOptions {
  /** Seconds each shot gets (default: its own length; a multi-shot piece keeps the length it really has). */
  seconds?: (shot: StoryShot) => number
  /** The audio under each shot, in order. */
  lines: (shot: StoryShot) => { id: string; name: string }[]
}

export interface AssemblyPlan {
  /** The shots' clips in story order, a gap after footage that runs out before its fixed length. */
  spineClips: Clip[]
  /** The audio connected under each shot's clip, in order (only media the timeline knows). */
  lines: { clipId: string; lines: { assetId: string; name: string; media: MediaInfo }[] }[]
  /** A marker at the clip of the first shot of each chapter (else scene). */
  marks: { clipId: string; kind: MarkerKind; name: string }[]
  /** Shots without media yet: they went in as title cards. */
  missing: number
}

/**
 * The shots as clips: the chosen take (a multi-shot group's take cut back into its shots where the picture cuts, see
 * takePieces), else the keyframe still, else a title card; the lines to connect under each shot. A group that renders
 * shot by shot now keeps its older clip only for the shots without a take of their own: theirs wins. With fixed
 * `seconds`, footage that runs out early is followed by a gap so the next shot still starts on time.
 */
export function planAssembly(story: StoryDoc, src: AssemblySources, opts: AssemblyOptions): AssemblyPlan {
  const frames = (seconds: number) => Math.max(1, Math.round(seconds * src.fps))
  const spineClips: Clip[] = []
  const lines: AssemblyPlan['lines'] = []
  let missing = 0
  const segments = new Map<string, { assetId: string; start: number; end: number }>()
  for (const g of validGroups(story)) {
    const take = src.groupTake(g)
    if (!take?.asset.durationFlicks || !src.media(take.asset.id)) continue
    const shots = groupShots(story, g)
    const pieces = takePieces(shots, flicksToSeconds(take.asset.durationFlicks), take.generationId ? g.takes?.[take.generationId] : undefined)
    // Rendered shot by shot (LTX): a shot animated on its own since is assembled from its own take.
    const own = (shotId: string) => {
      const shot = src.separate?.(g) ? shots.find((x) => x.id === shotId) : undefined
      const mine = shot && src.shotTake?.(shot)
      return Boolean(mine && src.media(mine.id))
    }
    for (const p of pieces) if (!own(p.shotId)) segments.set(p.shotId, { assetId: take.asset.id, start: p.start, end: p.end })
  }
  const clipOfShot = new Map<string, string>()
  for (const shot of story.shots) {
    const want = opts.seconds?.(shot)
    const segment = segments.get(shot.id)
    const media = src.shotMedia(shot)
    const name = `Shot ${shotLabel(story, shot)}`
    let clip: Clip
    if (segment) {
      const piece = segment.end - segment.start
      clip = makeMediaClip({
        assetId: segment.assetId,
        media: src.media(segment.assetId)!,
        fps: src.fps,
        // Never past the piece: that would show the next shot's picture.
        durationFrames: frames(Math.min(want ?? piece, piece)),
        sourceIn: secondsToFlicks(segment.start),
        role: 'effects',
        name,
        newId: src.newId,
      })
    } else if (media && src.media(media.id)) {
      clip = makeMediaClip({ assetId: media.id, media: src.media(media.id)!, fps: src.fps, durationFrames: frames(want ?? shot.duration), role: 'effects', name, newId: src.newId })
    } else {
      missing++
      clip = makeTitle({ template: 'centered', text: name, subtitle: shot.description, duration: frames(want ?? shot.duration), newId: src.newId, name: `${name} (placeholder)` })
    }
    spineClips.push(clip)
    clipOfShot.set(shot.id, clip.id)
    if (want !== undefined && clip.duration < frames(want)) spineClips.push(makeGap(frames(want) - clip.duration, src.newId))
    lines.push({
      clipId: clip.id,
      lines: opts.lines(shot).flatMap((line) => {
        const media = src.media(line.id)
        return media ? [{ assetId: line.id, name: line.name, media }] : []
      }),
    })
  }
  const marks = assemblyMarks(story).flatMap((mark) => {
    const clipId = clipOfShot.get(mark.shotId)
    return clipId ? [{ clipId, kind: mark.kind, name: mark.name }] : []
  })
  return { spineClips, lines, marks, missing }
}

/** Appends the plan's clips to the spine, connects the lines under them and marks where chapters (else scenes) start. */
export const applyAssembly =
  (plan: AssemblyPlan): TimelineRecipe =>
  (draft, rctx) => {
    appendToSpine(plan.spineClips)(draft, rctx)
    // Read positions after the append (an fps auto-lock may have rescaled frames).
    const layout = layoutTimeline(draft)
    const fps = draft.settings.fps
    for (const p of plan.lines) {
      const item = layout.spine.find((x) => x.id === p.clipId)
      if (!item || !p.lines.length) continue
      let at = item.start + Math.round(LINE_LEAD * fps)
      for (const line of p.lines) {
        const lineClip = makeMediaClip({ assetId: line.assetId, media: line.media, fps, role: 'dialogue', name: line.name, newId: rctx.newId })
        connectAt(at, [lineClip], -1)(draft, rctx)
        at += lineClip.duration + Math.round(LINE_GAP * fps)
      }
    }
    // Chapters (else scenes) marked where they start: the ruler and an FCPXML export show the film's structure.
    for (const mark of plan.marks) {
      const item = layout.spine.find((x) => x.id === mark.clipId)
      if (item) addMarker(item.start, mark.kind, mark.name)(draft, rctx)
    }
  }

// ---- the Story cut: the story's own timeline, laid out again as a whole

/** What the story's timeline is called (made unique when the project has one by that name already). */
export const STORY_CUT_NAME = 'Story cut'

interface CutContent {
  spine: readonly SpineItem[]
  connected: readonly ConnectedItem[]
  markers: readonly Marker[]
}

/**
 * A fingerprint of a timeline's clips, connected clips and markers (FNV-1a over their JSON): laying the cut out again
 * gives another, and so does any edit to it — a trim, a move, a volume, a deleted marker.
 */
export function cutSignature(content: CutContent): string {
  const text = JSON.stringify([content.spine, content.connected, content.markers])
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16).padStart(8, '0')}:${text.length}`
}

/** The Story cut's content as it is now — the open timeline's, or its stashed entry's — or nothing when there is none. */
export function cutContent(doc: ProjectDoc): CutContent | undefined {
  const id = doc.story?.cutTimelineId
  if (!id) return undefined
  if (id === currentTimelineId(doc)) return doc
  const entry = doc.timelines?.find((t) => t.id === id)
  return entry && { spine: entry.spine ?? [], connected: entry.connected ?? [], markers: entry.markers ?? [] }
}

/**
 * The Story cut was changed by hand since the story was last laid out on it (its fingerprint differs): laying it out
 * again would replace those edits.
 */
export function cutEdited(doc: ProjectDoc): boolean {
  const content = cutContent(doc)
  if (!content || !content.spine.length) return false
  return cutSignature(content) !== doc.story?.cutSignature
}

/**
 * The story on its own timeline as one recipe (one undo step): the Story cut made the first time (or again, if it was
 * deleted), opened, emptied and filled with the plan — the other timelines untouched — and its id and fingerprint
 * kept on the story.
 */
export const layOutStoryCut =
  (plan: AssemblyPlan, cutId: string): TimelineRecipe =>
  (draft, rctx) => {
    createTimeline({ id: cutId, name: STORY_CUT_NAME })(draft, rctx)
    openTimeline(cutId)(draft, rctx)
    draft.spine = []
    draft.connected = []
    draft.markers = []
    applyAssembly(plan)(draft, rctx)
    // As the op will leave it (normalize runs after every recipe, and changes nothing a second time): the fingerprint
    // is of what is saved.
    normalize(draft, rctx.prevAbs, rctx.newId)
    if (!draft.story) return
    draft.story.cutTimelineId = cutId
    draft.story.cutSignature = cutSignature(draft)
  }
