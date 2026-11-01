import type { Flicks } from '../time/flicks'
import {
  type GapClip,
  type GeneratorClip,
  type MediaClip,
  type MotionClip,
  type RoleId,
  type Take,
  type TitleAnimation,
  type TitleClip,
  type TitleStyle,
  type TitleTemplate,
  defaultAudioProps,
  defaultVideoProps,
} from '../types/project-doc'
import type { MediaInfo } from './types'
import { framesAvailable } from './util'

export const STILL_DEFAULT_SECONDS = 5

export interface MakeMediaClipInput {
  /** Omit for a pending take (generation still running); then pass `generationId`. */
  assetId?: string
  generationId?: string
  media: MediaInfo
  /** Project fps the duration is expressed in. */
  fps: number
  sourceIn?: Flicks
  durationFrames?: number
  /** Audio role (defaults to 'dialogue'). */
  role?: RoleId
  name?: string
  newId: () => string
}

/**
 * Media clip with a single take. Stills default to 5 s, video/audio to the rest of the asset from `sourceIn`
 * (5 s when the length is unknown, e.g. pending generations). Video props only for assets with video (or
 * images), audio props only for assets with audio.
 */
export function makeMediaClip(input: MakeMediaClipInput): MediaClip {
  const { media, fps } = input
  const isStill = media.kind === 'image'
  const sourceIn = isStill ? 0 : Math.max(0, Math.round(input.sourceIn ?? 0))
  const available =
    !isStill && media.durationFlicks !== undefined ? framesAvailable(media.durationFlicks - sourceIn, 1, fps) : undefined
  let duration = Math.round(input.durationFrames ?? available ?? STILL_DEFAULT_SECONDS * fps)
  if (available !== undefined) duration = Math.min(duration, available)

  const id = input.newId()
  const take: Take = { id: input.newId(), sourceIn }
  if (input.assetId !== undefined) take.assetId = input.assetId
  if (input.generationId !== undefined) take.generationId = input.generationId

  const clip: MediaClip = { kind: 'media', id, duration: Math.max(1, duration), enabled: true, takes: [take], active: 0, speed: 1 }
  if (input.name !== undefined) clip.name = input.name
  if (media.hasVideo || isStill) clip.video = defaultVideoProps()
  if (media.hasAudio) clip.audio = defaultAudioProps(input.role ?? 'dialogue')
  return clip
}

export function makeGap(duration: number, newId: () => string): GapClip {
  return { kind: 'gap', id: newId(), duration: Math.max(1, Math.round(duration)), enabled: true }
}

export const DEFAULT_TITLE_STYLE: Readonly<TitleStyle> = Object.freeze({
  fontFamily: 'Helvetica Neue',
  fontSize: 64,
  fontWeight: 600,
  color: '#ffffff',
  align: 'center',
  shadow: true,
})

export interface MakeTitleInput {
  duration: number
  newId: () => string
  text?: string
  subtitle?: string
  template?: TitleTemplate
  style?: Partial<TitleStyle>
  animation?: TitleAnimation
  name?: string
}

export function makeTitle(input: MakeTitleInput): TitleClip {
  const clip: TitleClip = {
    kind: 'title',
    id: input.newId(),
    duration: Math.max(1, Math.round(input.duration)),
    enabled: true,
    template: input.template ?? 'basic',
    text: input.text ?? 'Title',
    style: { ...DEFAULT_TITLE_STYLE, ...input.style },
    animation: input.animation ?? 'none',
    video: defaultVideoProps(),
  }
  if (input.subtitle !== undefined) clip.subtitle = input.subtitle
  if (input.name !== undefined) clip.name = input.name
  return clip
}

export interface MakeGeneratorInput {
  duration: number
  newId: () => string
  generator?: GeneratorClip['generator']
  params?: Partial<GeneratorClip['params']>
  name?: string
}

export function makeGenerator(input: MakeGeneratorInput): GeneratorClip {
  const clip: GeneratorClip = {
    kind: 'generator',
    id: input.newId(),
    duration: Math.max(1, Math.round(input.duration)),
    enabled: true,
    generator: input.generator ?? 'solid',
    params: { color: '#000000', ...input.params },
    video: defaultVideoProps(),
  }
  if (input.name !== undefined) clip.name = input.name
  return clip
}

export interface MakeMotionInput {
  duration: number
  newId: () => string
  boardId: string
  frameId: string
  tracks?: MotionClip['tracks']
  name?: string
}

/** A Canvas frame on the timeline; elements without a track stay still. */
export function makeMotion(input: MakeMotionInput): MotionClip {
  const clip: MotionClip = {
    kind: 'motion',
    id: input.newId(),
    duration: Math.max(1, Math.round(input.duration)),
    enabled: true,
    boardId: input.boardId,
    frameId: input.frameId,
    tracks: input.tracks ?? {},
    video: defaultVideoProps(),
  }
  if (input.name !== undefined) clip.name = input.name
  return clip
}
