import { keyframeValue } from '@shared/timeline/keyframes'
import type { CanvasFrameItem, CanvasItem } from '@shared/types/canvas'
import type { AudioProps, GeneratorClip, MotionClip, RoleId, TitleClip, TransitionType, VideoProps } from '@shared/types/project-doc'

/**
 * Engine-facing, resolved view of the timeline: absolute frame ranges, source offsets in seconds,
 * compositing order and transition envelopes. Built once per document revision.
 */

export interface TransitionEnvelope {
  type: TransitionType
  /** Frame range [start, end) where the transition happens. */
  start: number
  end: number
  /** 'in' = this layer is the incoming side, 'out' = outgoing side. */
  side: 'in' | 'out'
  /** When there is no other side (first/last item) it is a fade from/to black. */
  solo: boolean
}

export interface VideoLayer {
  clipId: string
  kind: 'media' | 'title' | 'generator' | 'motion' | 'pending'
  assetId?: string
  /** Timeline frames [start, end). */
  start: number
  end: number
  /** Source seconds (relative to the asset's t=0 = first video frame) at `start`. */
  sourceStart: number
  speed: number
  /** Compositing order: lower draws first. */
  z: number
  lane: number
  video: VideoProps
  transitions: TransitionEnvelope[]
  title?: TitleClip
  generator?: GeneratorClip
  motion?: MotionLayer
  still?: boolean
  label?: string
}

/** A motion clip's frame, resolved from the board (or its detached snapshot) when the scene is built. */
export interface MotionLayer {
  clip: MotionClip
  /** Absent when the board or the frame is gone. */
  frame?: CanvasFrameItem
  /** The frame's contents, back to front. */
  items: CanvasItem[]
  /** Elements showing a video: they play like clips (from the layer's `sourceStart`, muted). */
  videos: { itemId: string; assetId: string }[]
}

/** A video that has to be decoded for a layer: the clip's own media, or a video element inside a motion frame. */
export interface VideoFeed {
  /** Decoder owner key (pool slot / export stream). */
  owner: string
  assetId: string
  layer: VideoLayer
  /** Motion frames: the element showing it. */
  itemId?: string
}

/** Decoder owner key of a video element inside a motion clip. */
export function motionVideoOwner(clipId: string, itemId: string): string {
  return `${clipId}:${itemId}`
}

/**
 * Where in its source a video is shown at `time` (seconds): a video shorter than its clip (one inside a motion
 * clip's frame) stays on its last frame once it has played, rather than starting over.
 */
export function heldSourceTime(time: number, duration: number | undefined): number {
  return duration && time > duration - 0.05 ? Math.max(0, duration - 0.05) : time
}

export function videoFeeds(layer: VideoLayer): VideoFeed[] {
  if (layer.kind === 'media') return layer.assetId && !layer.still ? [{ owner: layer.clipId, assetId: layer.assetId, layer }] : []
  if (layer.kind === 'motion') return (layer.motion?.videos ?? []).map((v) => ({ owner: motionVideoOwner(layer.clipId, v.itemId), assetId: v.assetId, layer, itemId: v.itemId }))
  return []
}

export interface DuckEnvelope {
  /** Merged dialogue ranges [start, end) in frames. */
  ranges: [number, number][]
  amountDb: number
  /** Ramp length in frames. */
  ramp: number
}

export interface AudioSegment {
  clipId: string
  assetId: string
  start: number
  end: number
  sourceStart: number
  speed: number
  role: RoleId
  audio: AudioProps
  transitions: TransitionEnvelope[]
  /** Loudness normalisation offset (dialogue). */
  normGainDb?: number
  /** Ducking under dialogue (music). */
  duck?: DuckEnvelope
}

export interface Scene {
  fps: number
  width: number
  height: number
  /** Last frame + 1 of anything that plays. */
  duration: number
  video: VideoLayer[]
  audio: AudioSegment[]
  /** Edit points (frames) for ↑/↓ navigation and snapping. */
  editPoints: number[]
}

export function emptyScene(): Scene {
  return { fps: 24, width: 1920, height: 1080, duration: 0, video: [], audio: [], editPoints: [0] }
}

export function layersAt(scene: Scene, frame: number): VideoLayer[] {
  return scene.video.filter((l) => frame >= l.start && frame < l.end)
}

export { keyframeValue } from '@shared/timeline/keyframes'

/** Opacity multiplier from transitions at a (fractional) frame. */
export function transitionOpacity(layer: { transitions: TransitionEnvelope[] }, frame: number): number {
  let alpha = 1
  for (const tr of layer.transitions) {
    if (frame < tr.start || frame >= tr.end) continue
    const p = (frame - tr.start) / Math.max(1, tr.end - tr.start)
    if (tr.type === 'dissolve') {
      if (tr.side === 'in') alpha *= p
      else if (tr.solo) alpha *= 1 - p
      // outgoing side of a dissolve stays opaque underneath the incoming layer
    } else {
      // dip to black/white: out-side fades out in the first half, in-side fades in during the second half
      if (tr.solo) alpha *= tr.side === 'in' ? p : 1 - p
      else if (tr.side === 'out') alpha *= p < 0.5 ? 1 - p * 2 : 0
      else alpha *= p < 0.5 ? 0 : (p - 0.5) * 2
    }
  }
  return alpha
}

/** Colour of the dip (for dip-to-white), if the frame is inside one. */
export function dipColorAt(scene: Scene, frame: number): { color: string; amount: number } | undefined {
  for (const layer of scene.video) {
    for (const tr of layer.transitions) {
      if (tr.type !== 'dip-white' || frame < tr.start || frame >= tr.end || tr.side !== 'out') continue
      const p = (frame - tr.start) / Math.max(1, tr.end - tr.start)
      return { color: '#ffffff', amount: 1 - Math.abs(p - 0.5) * 2 }
    }
  }
  return undefined
}

/** Audio gain multiplier (linear) from transitions: equal-power crossfades. */
export function transitionGain(seg: { transitions: TransitionEnvelope[] }, frame: number): number {
  let g = 1
  for (const tr of seg.transitions) {
    if (frame < tr.start || frame >= tr.end) continue
    const p = (frame - tr.start) / Math.max(1, tr.end - tr.start)
    g *= tr.side === 'in' ? Math.sin((p * Math.PI) / 2) : Math.cos((p * Math.PI) / 2)
  }
  return g
}

export function dbToGain(db: number): number {
  return db <= -60 ? 0 : 10 ** (db / 20)
}

/** 0..1 ducking depth at a frame (ramps in before and out after each dialogue range). */
export function duckDepth(duck: DuckEnvelope, frame: number): number {
  let depth = 0
  for (const [a, b] of duck.ranges) {
    if (frame < a - duck.ramp || frame >= b + duck.ramp) continue
    const d = frame < a ? (frame - (a - duck.ramp)) / Math.max(1, duck.ramp) : frame < b ? 1 : 1 - (frame - b) / Math.max(1, duck.ramp)
    if (d > depth) depth = d
    if (depth >= 1) break
  }
  return depth
}

/** Full clip-level gain at a timeline frame (base, keyframes, normalisation, ducking, fades, transitions). */
export function segmentGain(seg: AudioSegment, frame: number): number {
  const local = frame - seg.start
  const length = seg.end - seg.start
  let db = keyframeValue(seg.audio.gainKeys, local, seg.audio.gainDb) + (seg.normGainDb ?? 0)
  if (seg.duck) db += seg.duck.amountDb * duckDepth(seg.duck, frame)
  let g = dbToGain(db)
  if (seg.audio.fadeIn > 0 && local < seg.audio.fadeIn) g *= Math.max(0, local / seg.audio.fadeIn)
  if (seg.audio.fadeOut > 0 && local > length - seg.audio.fadeOut) g *= Math.max(0, (length - local) / seg.audio.fadeOut)
  return g * transitionGain(seg, frame)
}
