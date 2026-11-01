import type { Flicks } from '../time/flicks'
import type { RoleId } from './project-doc'

export type AssetKind = 'video' | 'image' | 'audio' | 'font'
export type AssetStatus = 'processing' | 'ready' | 'error' | 'missing'
export type AssetSource = 'import' | 'generation' | 'render' | 'derived'

/** Files the app imports, by name (the upload route checks the same list). */
export const IMPORTABLE_FILE = /\.(mp4|mov|m4v|webm|mkv|mp3|wav|m4a|aac|flac|ogg|opus|png|jpe?g|webp|gif|heic|svg|ttf|otf|woff2?)$/i
/** Font files: project fonts for text on boards and in videos. */
export const FONT_FILE = /\.(ttf|otf|woff2?)$/i

/** A font file's face as CSS loads it: the weight is a range ("100 900") for a variable font. */
export interface FontFaceInfo {
  family: string
  weight: string
  style: 'normal' | 'italic'
}
/** The pictures among them: what can go on a canvas board. */
export const VISUAL_FILE = /\.(mp4|mov|m4v|webm|mkv|png|jpe?g|webp|gif|heic|svg)$/i

/** Files the ingest pipeline produces next to the original. Served from /media/:assetId/:variant. */
export type AssetVariant = 'original' | 'proxy' | 'poster' | 'filmstrip' | 'waveform' | 'audio' | 'display'

export interface FilmstripInfo {
  /** Seconds between tiles (tile i shows the frame at i*interval + interval/2). */
  interval: number
  count: number
  tileWidth: number
  tileHeight: number
  columns: number
}

export interface AssetGenerationInfo {
  generationId: string
  modelId: string
  modelLabel: string
  provider: string
  prompt?: string
  params: Record<string, unknown>
  costUsd?: number
}

export interface AlignedWord {
  text: string
  /** Seconds from the asset's t=0. */
  start: number
  end: number
  voiceId?: string
  line?: number
}

export interface AssetDTO {
  id: string
  kind: AssetKind
  name: string
  status: AssetStatus
  error?: string
  source: AssetSource
  /** Default audio role when placed on the timeline. */
  role?: RoleId
  mime?: string
  sizeBytes?: number
  durationFlicks?: Flicks // undefined for still images
  width?: number
  height?: number
  fps?: number
  rotation?: number
  hasVideo: boolean
  hasAudio: boolean
  sampleRate?: number
  channels?: number
  videoCodec?: string
  audioCodec?: string
  /** Seconds between the original's first video timestamp and t=0 of proxy/wav (export adds it back). */
  timeOffset?: number
  loudness?: { integratedLufs: number; truePeakDb: number }
  variants: Partial<Record<AssetVariant, boolean>>
  filmstrip?: FilmstripInfo
  /** Waveform peaks resolution (peaks per second) when the waveform variant exists. */
  waveformRate?: number
  generation?: AssetGenerationInfo
  /** Word timings from TTS/dialogue generation or forced alignment (used for captions). */
  alignment?: { words: AlignedWord[]; source?: string }
  /** Language of a speech-to-text transcript (ISO code), when transcribed. */
  transcriptLanguage?: string
  /** Detected musical beats (seconds from t=0), for beat snapping. */
  beats?: { bpm: number; beats: number[]; downbeats: number[] }
  /** AI description and search tags (media browser natural-language search). */
  description?: string
  aiTags?: string[]
  /** Imported from an SVG: the asset is its PNG rendering and the original SVG is kept beside it. */
  vector?: boolean
  /** A font: the face its own tables declare (missing when they could not be read). */
  font?: FontFaceInfo
  parentIds: string[]
  rating: -1 | 0 | 1 // reject / none / favorite
  keywords: string[]
  projectIds: string[]
  createdAt: string
}

export function mediaUrl(assetId: string, variant: AssetVariant): string {
  return `/media/${assetId}/${variant}`
}
