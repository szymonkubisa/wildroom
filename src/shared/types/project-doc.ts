import type { Flicks } from '../time/flicks'
import type { StoryDoc } from './story'
import type { BrandKit } from './brand'
import type { CanvasDoc, CanvasItem } from './canvas'
import type { DirectorDoc } from '../director/plan'

/**
 * Project document — the Final Cut–style magnetic timeline.
 *
 * Units:
 *  - Timeline placement and durations: integer project frames.
 *  - Anything that points into source media (sourceIn, anchors, keyframe source times): integer flicks.
 *
 * The primary storyline ("spine") is always contiguous. A spine item with `transitionOut` overlaps the next
 * item by the transition duration (overlap mode — works with AI clips that have no handles).
 * Connected items hang off a spine item at a *source time* of that item, so head trims and retimes keep
 * them locked to the picture. The browser is the only writer of this document.
 */

export const PROJECT_DOC_VERSION = 1

export type RoleId = string // 'video' | 'titles' | 'dialogue' | 'music' | 'effects' | 'captions' | subrole 'dialogue.alice'

export interface RoleDef {
  id: RoleId
  name: string
  kind: 'video' | 'audio'
  color: string // css color / token
}

export const DEFAULT_ROLES: RoleDef[] = [
  { id: 'video', name: 'Video', kind: 'video', color: 'var(--role-video)' },
  { id: 'titles', name: 'Titles', kind: 'video', color: 'var(--role-titles)' },
  { id: 'dialogue', name: 'Dialogue', kind: 'audio', color: 'var(--role-dialogue)' },
  { id: 'music', name: 'Music', kind: 'audio', color: 'var(--role-music)' },
  { id: 'effects', name: 'Effects', kind: 'audio', color: 'var(--role-effects)' },
]

export interface ProjectSettings {
  fps: number // integer: 24 | 25 | 30 | 48 | 50 | 60
  /** When true, fps is taken from the first video clip added, then locked. */
  fpsAuto: boolean
  width: number
  height: number
  sampleRate: 48000
}

/** Normalized transform: x/y offsets as a fraction of frame width/height, scale 1 = conformed size. */
export interface Transform {
  x: number
  y: number
  scale: number
  rotation: number // degrees
}

export interface Crop {
  left: number
  right: number
  top: number
  bottom: number
} // fractions 0..1 of the source

/** Named interpolations from a keyframe to the next one ('hold' keeps the value until the next key). */
export type KeyEasePreset = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold' | 'back' | 'elastic' | 'bounce'

/** CSS-style `cubic-bezier(x1, y1, x2, y2)`; x1 and x2 within 0..1. */
export interface BezierEase {
  type: 'bezier'
  p: [number, number, number, number]
}

export type KeyEase = KeyEasePreset | BezierEase

/** Keyframes; `frame` is relative to the clip's start on the timeline. `ease` shapes the segment after this key. */
export interface Keyframe<T> {
  frame: number
  value: T
  ease?: KeyEase
}

export type Conform = 'fit' | 'fill' | 'none'

export interface EffectInstance {
  id: string
  type: string // registry key, e.g. 'color', 'blur', 'vignette', 'grain', 'letterbox'
  enabled: boolean
  params: Record<string, number | string | boolean>
}

export interface VideoProps {
  enabled: boolean
  conform: Conform
  transform: Transform
  crop: Crop
  opacity: number // 0..1
  opacityKeys?: Keyframe<number>[]
  transformKeys?: Keyframe<Transform>[]
  effects: EffectInstance[]
}

export interface AudioProps {
  enabled: boolean
  role: RoleId
  gainDb: number
  gainKeys?: Keyframe<number>[] // dB
  pan: number // -1..1
  fadeIn: number // frames
  fadeOut: number // frames
}

export type TransitionType = 'dissolve' | 'dip-black' | 'dip-white'

export interface Transition {
  type: TransitionType
  duration: number // frames; the next spine item overlaps this one by this amount
}

/** A take: one candidate piece of media for a clip. Pending takes have a generation but no asset yet. */
export interface Take {
  id: string
  assetId?: string
  generationId?: string
  sourceIn: Flicks
  label?: string
}

interface ClipBase {
  id: string
  name?: string
  duration: number // frames
  enabled: boolean
  transitionIn?: Transition // only honoured on the first spine item (fade from black)
  transitionOut?: Transition
}

/** Media clip. `takes.length > 1` makes it an audition (FCP), `takes[active]` is what plays. */
export interface MediaClip extends ClipBase {
  kind: 'media'
  takes: Take[]
  active: number
  speed: number // 1 = normal; audio follows playbackRate (pitch shifts) in v1
  video?: VideoProps
  audio?: AudioProps
}

export interface GapClip extends ClipBase {
  kind: 'gap'
}

export type TitleTemplate = 'basic' | 'lower-third' | 'centered' | 'caption'
export type TitleAnimation = 'none' | 'fade' | 'slide-up' | 'typewriter'

export interface TitleStyle {
  fontFamily: string
  fontSize: number // px at project resolution
  fontWeight: number
  color: string
  align: 'left' | 'center' | 'right'
  background?: string
  shadow: boolean
}

export interface TitleClip extends ClipBase {
  kind: 'title'
  template: TitleTemplate
  text: string
  subtitle?: string
  style: TitleStyle
  animation: TitleAnimation
  video?: VideoProps
}

export interface GeneratorClip extends ClipBase {
  kind: 'generator'
  generator: 'solid' | 'gradient'
  params: { color: string; color2?: string; angle?: number }
  video?: VideoProps
}

/** How a motion element appears as its `reveal` goes 0 → 1. */
export type RevealMode =
  | 'typewriter'
  | 'words'
  | 'wipe-left'
  | 'wipe-up'
  | 'draw'
  // Kinetic text: each word or letter animates on its own, one after another.
  | 'words-rise'
  | 'words-pop'
  | 'words-blur'
  | 'letters-rise'
  | 'letters-fade'
  /** The marker runs under the highlighted words (all of the text when none is). */
  | 'highlight-sweep'
  /** Numbers count up like an odometer, from `rollFrom`. */
  | 'roll'

/** Offset from the element's place on the board (frame units); scale and rotation turn around its centre. */
export interface MotionItemTransform {
  x: number
  y: number
  scale: number
  rotation: number // degrees
}

/** Animation of one board element. Keyframe frames count from the start of the animation (see `MotionClip.offset`). */
export interface MotionTrack {
  opacity?: Keyframe<number>[]
  transform?: Keyframe<MotionItemTransform>[]
  /** Width and height factors on top of `scale`, along the element's own axes (bars growing, a flip). */
  stretch?: Keyframe<MotionStretch>[]
  /** Text colour, a shape's fill (its outline when it has no fill); mixed in OKLab between keys. */
  color?: Keyframe<string>[]
  /** Gaussian blur, frame units (rack focus, a soft foreground). */
  blur?: Keyframe<number>[]
  /**
   * Timed to the voice-over: the element's keys move together so its first one lands where these words are said
   * (worked out from the voice clips' word timings whenever it plays, so a new recording re-times it).
   */
  anchor?: MotionWordAnchor
  /** Follows the clip's progress (0 at its first frame, 1 at its last): the reveal, or the outline drawn so far. */
  progress?: 'reveal' | 'trim'
  /** Motion blur: how long the shutter stays open, as a part of a frame (0.5 = the film-camera 180°). */
  motionBlur?: number
  /** Procedural motion on top of the keys (shake, float, spin…). */
  behaviors?: MotionBehavior[]
  /** The keys between these animation frames repeat after `to`, again and again. */
  loop?: { from: number; to: number }
  /** Rides along another element's outline (a path, line, arc or any shape) instead of staying in place. */
  follow?: MotionFollow
  /** 0..1, how much of the element shows, the way `revealMode` says. */
  reveal?: Keyframe<number>[]
  revealMode?: RevealMode
  /** `roll`: the value the numbers count from (0 when unset). */
  rollFrom?: number
  /** Shapes: the part of the outline stroked (0..1 of its length), e.g. a line growing from its middle or a gauge. */
  trim?: Keyframe<MotionTrim>[]
}

export interface MotionWordAnchor {
  /** The words, as said ("the drama triangle"); case and punctuation don't matter. */
  text: string
  /** Which time they are said (1 = the first), counted in the clip's voices in order. */
  nth?: number
  /** The voice clip to look in; unset, the dialogue clips playing while the motion clip does. */
  clipId?: string
  /** Frames from the first word's start (negative: a little before it). */
  offset?: number
  /**
   * The animation frame (as stored) that lands on the words: the first key when the track was anchored. Keys added
   * before it play before the words instead of moving everything later. Unset (older files): the first key.
   */
  at?: number
}

export type MotionBehaviorKind = 'shake' | 'wiggle' | 'float' | 'spin' | 'orbit' | 'pulse'

/** Motion worked out from time and a seed (see `shared/motion/behaviors.ts`). */
export interface MotionBehavior {
  kind: MotionBehaviorKind
  /** Frame units for moves (shake, wiggle, float, orbit), degrees per period for spin, the peak growth for pulse (0.1 = 10%). */
  amount: number
  /** Frames per cycle. */
  period: number
  seed?: number
  /** Animation frames it runs between (the whole clip when unset); it eases in and out at those ends. */
  from?: number
  to?: number
}

export interface MotionFollow {
  /** The shape in the same frame whose outline is the route. */
  pathId: string
  /** 0..1 along the outline, where the element's centre is. */
  progress: Keyframe<number>[]
  /** Turn with the route (added to the element's own rotation). */
  orient?: boolean
}

export interface MotionStretch {
  x: number
  y: number
}

export interface MotionTrim {
  start: number
  end: number
}

/** Pan and zoom inside the frame: x/y move the view's centre from the frame's centre (frame units); zoom 1 = whole frame. */
export interface MotionCamera {
  x: number
  y: number
  zoom: number
}

/** A Canvas frame (artboard) played as an animated scene. Elements without a track stay still. */
export interface MotionClip extends ClipBase {
  kind: 'motion'
  boardId: string
  frameId: string
  /** Snapshot of the frame (first) and its contents; set = the clip no longer follows the board. */
  detached?: CanvasItem[]
  /** By canvas item id. */
  tracks: Record<string, MotionTrack>
  camera?: Keyframe<MotionCamera>[]
  /** Frames of the animation cut off the head (like a media clip's source in): blade and trims move it, not the keys. */
  offset?: number
  /**
   * An overlay over the whole timeline (a header, a progress bar): kept connected from the first frame to the last,
   * on the top lane, whatever the edit.
   */
  span?: 'timeline'
  video?: VideoProps
}

export type Clip = MediaClip | GapClip | TitleClip | GeneratorClip | MotionClip
export type SpineItem = Clip

export interface ConnectedItem {
  kind: 'clip' // 'storyline' reserved for connected storylines
  id: string // same as clip.id
  clip: Exclude<Clip, GapClip>
  anchorId: string // spine item id
  anchorSourceTime: Flicks // source time of the anchor at this item's start frame
  lane: number // preference: >0 above the storyline, <0 below. Actual lane resolved by layout().
}

export type MarkerKind = 'standard' | 'todo' | 'chapter'

export interface Marker {
  id: string
  kind: MarkerKind
  name: string
  anchorId: string
  anchorSourceTime: Flicks
  done?: boolean
}

export interface RoleMix {
  gainDb: number
  mute: boolean
  solo: boolean
}

/** Mix settings — used identically by playback and export. */
export interface MixSettings {
  masterDb: number
  /** Per base role ('dialogue', 'music', 'effects'…). */
  roles: Record<string, RoleMix>
  /** Lower music under dialogue (deterministic gain automation, not a live compressor). */
  ducking: { enabled: boolean; amountDb: number; fadeSeconds: number }
  /** Bring each dialogue clip to a common loudness (from the ingest measurement). */
  normalizeDialogue: boolean
}

export function defaultMix(): MixSettings {
  return {
    masterDb: 0,
    roles: {},
    ducking: { enabled: true, amountDb: -12, fadeSeconds: 0.35 },
    normalizeDialogue: true,
  }
}

/** Loudness target for dialogue clip normalisation (before the export loudness pass). */
export const DIALOGUE_TARGET_LUFS = -23

/** Saved media-browser filter (FCP smart collection). */
export interface SmartCollection {
  id: string
  name: string
  query?: string
  kind?: 'video' | 'image' | 'audio' | 'font' | 'timeline'
  role?: string
  keywords?: string[]
  favoritesOnly?: boolean
}

/**
 * One timeline of the project, listed in Assets. The open timeline lives in the document's top-level fields
 * (`settings`, `spine`, `connected`, `markers`, `mix`) so every reader — layout, playback, export, FCPXML, story
 * assembly — keeps working on "the timeline"; the others are stashed in their entry until they are opened.
 * Roles, story, canvas and brand are project-wide. See `shared/timeline/timelines.ts` for the operations.
 */
export interface TimelineEntry {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  /** Format: authoritative while stashed, a cache of the top-level settings while open. */
  settings: ProjectSettings
  /** Card summary, refreshed whenever the timeline is stashed (the open one is summarised live). */
  durationFrames: number
  posterAssetId?: string
  /** Stashed content — present only while this timeline is not the open one. */
  spine?: SpineItem[]
  connected?: ConnectedItem[]
  markers?: Marker[]
  mix?: MixSettings
}

export interface ProjectDoc {
  version: typeof PROJECT_DOC_VERSION
  settings: ProjectSettings
  spine: SpineItem[]
  connected: ConnectedItem[]
  markers: Marker[]
  roles: RoleDef[]
  /** Optional for documents created before the mixer existed. */
  mix?: MixSettings
  /**
   * Every timeline of the project, the open one included (its content is in the top-level fields). Absent in
   * documents made before multiple timelines: they have one implicit timeline, "Main".
   */
  timelines?: TimelineEntry[]
  /** Id of the open timeline in `timelines` (absent → the implicit "Main"). */
  activeTimelineId?: string
  /** AI Director workspace: script, cast and shot list. */
  story?: StoryDoc
  /** Smart collections in the media browser. */
  collections?: SmartCollection[]
  /** Canvas workspace: boards of images, frames, text and notes. */
  canvas?: CanvasDoc
  /** Brand kit: identity, palette, type, logos and style for generations. */
  brand?: BrandKit
  /** The Director's chat beside the project: its last messages and plans (kept out of the undo history). */
  director?: DirectorDoc
}

export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0 }
export const DEFAULT_CROP: Crop = { left: 0, right: 0, top: 0, bottom: 0 }

export function defaultVideoProps(): VideoProps {
  return {
    enabled: true,
    conform: 'fit',
    transform: { ...DEFAULT_TRANSFORM },
    crop: { ...DEFAULT_CROP },
    opacity: 1,
    effects: [],
  }
}

export function defaultAudioProps(role: RoleId = 'dialogue'): AudioProps {
  return { enabled: true, role, gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0 }
}

export function createEmptyDoc(settings?: Partial<ProjectSettings>): ProjectDoc {
  return {
    version: PROJECT_DOC_VERSION,
    settings: { fps: 24, fpsAuto: true, width: 1920, height: 1080, sampleRate: 48000, ...settings },
    spine: [],
    connected: [],
    markers: [],
    roles: DEFAULT_ROLES.map((r) => ({ ...r })),
  }
}

export function activeTake(clip: MediaClip): Take | undefined {
  return clip.takes[clip.active] ?? clip.takes[0]
}

/** Source "in" of any clip: gaps, titles, generators and motion clips behave like media whose source time starts at 0. */
export function clipSourceIn(clip: Clip): Flicks {
  return clip.kind === 'media' ? (activeTake(clip)?.sourceIn ?? 0) : 0
}

export function clipSpeed(clip: Clip): number {
  return clip.kind === 'media' ? clip.speed : 1
}
