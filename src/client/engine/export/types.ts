import type { FontSpec } from '../fonts'
import type { Scene } from '../scene'

export interface ExportAssetInfo {
  kind: 'video' | 'image' | 'audio'
  width: number
  height: number
  /** Seconds to add to source times when decoding the original (first video timestamp). */
  timeOffset: number
  /** Seconds (videos): past the end, a video holds its last frame. */
  duration?: number
  /** Copies to try for a still picture (Canvas elements), best first. */
  stills?: string[]
}

export type ExportCodec = 'avc' | 'hevc'
export type ExportQuality = 'medium' | 'high' | 'very-high'

export interface ExportJob {
  exportId: string
  scene: Scene
  assets: Record<string, ExportAssetInfo>
  startFrame: number
  endFrame: number
  width: number
  height: number
  codec: ExportCodec
  quality: ExportQuality
  /** Project font files the text needs, registered in the worker before the first frame. */
  fonts: FontSpec[]
}

export type ExportWorkerMessage =
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; bytes: number }
  | { type: 'error'; message: string }
