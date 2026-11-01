import type { Patch } from 'immer'
import type { Flicks } from '../time/flicks'
import type {
  AudioProps,
  ConnectedItem,
  GeneratorClip,
  Marker,
  MarkerKind,
  MotionClip,
  ProjectDoc,
  SpineItem,
  Take,
  TitleAnimation,
  TitleStyle,
  TitleTemplate,
  VideoProps,
} from '../types/project-doc'

/** What the timeline needs to know about an asset. */
export interface MediaInfo {
  kind: 'video' | 'image' | 'audio'
  durationFlicks?: Flicks
  hasVideo: boolean
  hasAudio: boolean
  fps?: number
}

export type MediaInfoLookup = (assetId: string) => MediaInfo | undefined

export interface OpContext {
  media?: MediaInfoLookup
  newId: () => string
}

/** Context a recipe receives inside `applyOp`. */
export interface RecipeContext extends OpContext {
  /**
   * Last known absolute frame of connected items and markers, keyed by item id. Filled by `applyOp` from the doc
   * before the op; recipes may update it for items whose anchor they are about to remove, so that `normalize`
   * can put orphans back where they were.
   */
  prevAbs: Map<string, number>
}

/** An immer recipe over the project document. Every exported op is a factory returning one. */
export type TimelineRecipe = (draft: ProjectDoc, ctx: RecipeContext) => void

export interface OpResult {
  doc: ProjectDoc
  patches: Patch[]
  inversePatches: Patch[]
}

export type RemoveMode = 'ripple' | 'gap'
export type TransitionEdge = 'in' | 'out'
export type TrimEdge = 'start' | 'end'

export interface RangePatch {
  sourceIn?: Flicks
  duration?: number
}

export type AuditionAction =
  | { type: 'add'; take: Take; select?: boolean }
  | { type: 'select'; index: number }
  | { type: 'finalize' }
  | { type: 'resolve'; generationId: string; assetId: string }
  | { type: 'remove'; index: number }

/**
 * Clip-level props for `setProps`. Keys that do not apply to the clip's kind are ignored; `null` removes an
 * optional prop. `video`, `audio`, `style` and `params` are merged one level deep.
 */
export interface ClipPropsPatch {
  name?: string | null
  enabled?: boolean
  speed?: number
  video?: Partial<VideoProps> | null
  audio?: Partial<AudioProps> | null
  template?: TitleTemplate
  text?: string
  subtitle?: string | null
  style?: Partial<TitleStyle>
  animation?: TitleAnimation
  generator?: GeneratorClip['generator']
  params?: Partial<GeneratorClip['params']>
  /** Motion clips: element tracks replace the old ones whole. */
  tracks?: MotionClip['tracks']
  camera?: MotionClip['camera'] | null
  detached?: MotionClip['detached'] | null
  /** Over the whole timeline (connected motion clips only; normalize keeps it there). */
  span?: 'timeline' | null
}

export interface MarkerPatch {
  name?: string
  kind?: MarkerKind
  done?: boolean
}

// ---------------------------------------------------------------------------------------------------------------
// Layout (plain data, safe to hand to Vue / workers)

export interface SpineLayoutItem {
  type: 'spine'
  id: string
  index: number
  lane: 0
  /** First frame of the item (inclusive). */
  start: number
  /** start + duration (exclusive); extends into the next item when a transition overlaps it. */
  end: number
  /** End of the range this item owns: the next item's start, or `end` for the last item. */
  ownEnd: number
  overlapIn: number
  overlapOut: number
  item: SpineItem
}

export interface ConnectedLayoutItem {
  type: 'connected'
  id: string
  start: number
  end: number
  /** Resolved lane (collision-free). */
  lane: number
  /** Stored lane preference. */
  preferredLane: number
  anchorId: string
  /** The anchor point lies at/after the spine end (or the anchor is missing). */
  hanging: boolean
  item: ConnectedItem
}

export interface MarkerLayoutItem {
  type: 'marker'
  id: string
  frame: number
  kind: MarkerKind
  name: string
  done: boolean
  anchorId: string
  hanging: boolean
  marker: Marker
}

export type ClipLayoutItem = SpineLayoutItem | ConnectedLayoutItem
export type LayoutEntry = ClipLayoutItem | MarkerLayoutItem

export interface TimelineLayout {
  fps: number
  /** Spine end (end of the last spine item). */
  duration: number
  /** Furthest frame touched by anything, including hanging connected items and markers. */
  extent: number
  spine: SpineLayoutItem[]
  /** Sorted by (start, id). */
  connected: ConnectedLayoutItem[]
  /** Sorted by (frame, id). */
  markers: MarkerLayoutItem[]
  /** Lowest and highest resolved lane (0 when there are no connected items on that side). */
  lanes: { min: number; max: number }
  byId: Map<string, LayoutEntry>
}
