/** Test helpers for the timeline specs (not shipped code; no test-runner imports). */
import { framesToFlicks, secondsToFlicks } from '../time/flicks'
import {
  type Clip,
  type ConnectedItem,
  type GapClip,
  type Marker,
  type MarkerKind,
  type MediaClip,
  type ProjectDoc,
  type SpineItem,
  type Take,
  type TitleClip,
  createEmptyDoc,
  defaultAudioProps,
  defaultVideoProps,
} from '../types/project-doc'
import { applyOp } from './apply'
import { DEFAULT_TITLE_STYLE } from './factories'
import { anchorAt, indexSpine, layoutTimeline } from './layout'
import type {
  ConnectedLayoutItem,
  MediaInfo,
  MediaInfoLookup,
  OpContext,
  OpResult,
  SpineLayoutItem,
  TimelineRecipe,
} from './types'
import type { ConnectableClip } from './util'

export const FPS = 24

/** v10: 10 s video+audio @24 (240 frames), v4: 4 s video-only, v30: 8 s @29.97, a20: 20 s audio, img: still. */
export const MEDIA: Record<string, MediaInfo> = {
  v10: { kind: 'video', durationFlicks: secondsToFlicks(10), hasVideo: true, hasAudio: true, fps: 24 },
  v4: { kind: 'video', durationFlicks: secondsToFlicks(4), hasVideo: true, hasAudio: false, fps: 24 },
  v30: { kind: 'video', durationFlicks: secondsToFlicks(8), hasVideo: true, hasAudio: true, fps: 29.97 },
  a20: { kind: 'audio', durationFlicks: secondsToFlicks(20), hasVideo: false, hasAudio: true },
  img: { kind: 'image', hasVideo: true, hasAudio: false },
}

export const media: MediaInfoLookup = (id) => MEDIA[id]

export function idGen(prefix = 'n'): () => string {
  let n = 0
  return () => `${prefix}${++n}`
}

export function makeCtx(): OpContext {
  return { media, newId: idGen() }
}

export const f2f = (frames: number, fps = FPS) => framesToFlicks(frames, fps)

export interface TakeSpec {
  asset?: string
  /** Source in, in frames at FPS. */
  sourceIn?: number
  generationId?: string
}

export interface ClipOpts {
  asset?: string
  sourceIn?: number
  speed?: number
  takes?: TakeSpec[]
  active?: number
  video?: boolean
  audio?: boolean
}

export function mclip(id: string, duration: number, o: ClipOpts = {}): MediaClip {
  const specs = o.takes ?? [{ asset: o.asset ?? 'v10', sourceIn: o.sourceIn ?? 0 }]
  const takes = specs.map((t, i) => {
    const take: Take = { id: `${id}.t${i}`, sourceIn: f2f(t.sourceIn ?? 0) }
    if (t.asset) take.assetId = t.asset
    if (t.generationId) take.generationId = t.generationId
    return take
  })
  const clip: MediaClip = { kind: 'media', id, duration, enabled: true, takes, active: o.active ?? 0, speed: o.speed ?? 1 }
  if (o.video !== false) clip.video = defaultVideoProps()
  if (o.audio !== false) clip.audio = defaultAudioProps()
  return clip
}

/** Audio-only media clip on the 20 s audio asset. */
export function aclip(id: string, duration: number, o: ClipOpts = {}): MediaClip {
  return mclip(id, duration, { asset: 'a20', ...o, video: false })
}

export function gap(id: string, duration: number): GapClip {
  return { kind: 'gap', id, duration, enabled: true }
}

export function title(id: string, duration: number, text = 'Hello'): TitleClip {
  return {
    kind: 'title',
    id,
    duration,
    enabled: true,
    template: 'basic',
    text,
    style: { ...DEFAULT_TITLE_STYLE },
    animation: 'none',
    video: defaultVideoProps(),
  }
}

export interface DocOpts {
  fps?: number
  fpsAuto?: boolean
}

export function makeDoc(spine: SpineItem[], opts: DocOpts = {}): ProjectDoc {
  const doc = createEmptyDoc({ fps: opts.fps ?? FPS, fpsAuto: opts.fpsAuto ?? false })
  doc.spine = spine
  return doc
}

/** Connected item anchored (like normalize would) at an absolute frame of `doc`. */
export function connectedAt(doc: ProjectDoc, clip: ConnectableClip, frame: number, lane = 1): ConnectedItem {
  const anchor = anchorAt(doc.spine, indexSpine(doc.spine), frame, doc.settings.fps)!
  return { kind: 'clip', id: clip.id, clip, ...anchor, lane }
}

export function markerAt(doc: ProjectDoc, id: string, frame: number, kind: MarkerKind = 'standard'): Marker {
  const anchor = anchorAt(doc.spine, indexSpine(doc.spine), frame, doc.settings.fps)!
  return { id, kind, name: id, ...anchor }
}

/** Doc with connected clips `[clip, frame, lane?]` and markers `[id, frame]` placed by absolute frame. */
export function build(
  spine: SpineItem[],
  connected: Array<[ConnectableClip, number, number?]> = [],
  markers: Array<[string, number]> = [],
  opts: DocOpts = {},
): ProjectDoc {
  const doc = makeDoc(spine, opts)
  doc.connected = connected.map(([c, f, lane]) => connectedAt(doc, c, f, lane ?? 1))
  doc.markers = markers.map(([id, f]) => markerAt(doc, id, f))
  return doc
}

export function exec(doc: ProjectDoc, recipe: TimelineRecipe, ctx: OpContext = makeCtx()): OpResult {
  return applyOp(doc, recipe, ctx)
}

export function run(doc: ProjectDoc, recipe: TimelineRecipe, ctx: OpContext = makeCtx()): ProjectDoc {
  return applyOp(doc, recipe, ctx).doc
}

/** [id, start, end] of every spine item. */
export function spineOf(doc: ProjectDoc): Array<[string, number, number]> {
  return layoutTimeline(doc).spine.map((s) => [s.id, s.start, s.end])
}

export function spineIds(doc: ProjectDoc): string[] {
  return doc.spine.map((s) => s.id)
}

/** Absolute frame of a clip start or marker. */
export function frameOf(doc: ProjectDoc, id: string): number | undefined {
  const e = layoutTimeline(doc).byId.get(id)
  if (!e) return undefined
  return e.type === 'marker' ? e.frame : e.start
}

export function connectedOf(doc: ProjectDoc, id: string): ConnectedLayoutItem {
  const e = layoutTimeline(doc).byId.get(id)
  if (!e || e.type !== 'connected') throw new Error(`no connected item ${id}`)
  return e
}

export function clipOf(doc: ProjectDoc, id: string): Clip {
  const clip = doc.spine.find((s) => s.id === id) ?? doc.connected.find((c) => c.id === id)?.clip
  if (!clip) throw new Error(`no clip ${id}`)
  return clip
}

export function mediaOf(doc: ProjectDoc, id: string): MediaClip {
  const clip = clipOf(doc, id)
  if (clip.kind !== 'media') throw new Error(`${id} is not media`)
  return clip
}

/** Every invariant `normalize` promises; returns human-readable violations (empty when the doc is valid). */
export function invariantViolations(doc: ProjectDoc): string[] {
  const out: string[] = []
  const ids = new Set<string>()
  const see = (id: string, what: string) => {
    if (ids.has(id)) out.push(`duplicate id ${id} (${what})`)
    ids.add(id)
  }
  const checkClip = (clip: Clip, where: string) => {
    if (!Number.isInteger(clip.duration) || clip.duration < 1) out.push(`${where} ${clip.id}: duration ${clip.duration}`)
    if (clip.kind !== 'media') return
    if (!clip.takes.length) out.push(`${clip.id}: no takes`)
    if (!Number.isInteger(clip.active) || clip.active < 0 || clip.active >= clip.takes.length)
      out.push(`${clip.id}: active ${clip.active} out of range`)
    if (!(clip.speed > 0)) out.push(`${clip.id}: speed ${clip.speed}`)
    for (const t of clip.takes) see(t.id, `take of ${clip.id}`)
  }
  for (const s of doc.spine) {
    see(s.id, 'spine')
    checkClip(s, 'spine')
  }
  for (const c of doc.connected) {
    see(c.id, 'connected')
    if (c.clip.id !== c.id) out.push(`connected ${c.id}: clip id ${c.clip.id}`)
    if ((c.clip.kind as string) === 'gap') out.push(`connected ${c.id} is a gap`)
    if (!Number.isInteger(c.lane) || c.lane === 0) out.push(`connected ${c.id}: lane ${c.lane}`)
    checkClip(c.clip, 'connected')
  }
  for (const m of doc.markers) see(m.id, 'marker')

  const spine = doc.spine
  for (let i = 1; i < spine.length; i++)
    if (spine[i]!.kind === 'gap' && spine[i - 1]!.kind === 'gap') out.push(`adjacent gaps ${spine[i - 1]!.id}+${spine[i]!.id}`)

  let incoming = 0
  spine.forEach((s, i) => {
    if (s.transitionIn) {
      const d = s.transitionIn.duration
      if (i > 0) out.push(`transitionIn on non-first ${s.id}`)
      else if (!Number.isInteger(d) || d < 1 || d > s.duration) out.push(`fade-in ${d} on ${s.id}`)
    }
    let outgoing = 0
    if (s.transitionOut) {
      const d = s.transitionOut.duration
      if (!Number.isInteger(d) || d < 1) out.push(`transition ${d} on ${s.id}`)
      const next = spine[i + 1]
      if (next) {
        if (d > Math.min(s.duration, next.duration) - 1) out.push(`transition ${s.id}: ${d} > min(durations) - 1`)
        outgoing = d
      } else if (d > s.duration) out.push(`fade-out ${d} longer than ${s.id}`)
    }
    if (incoming + outgoing > s.duration - 1) out.push(`${s.id}: in ${incoming} + out ${outgoing} > duration - 1`)
    incoming = outgoing
  })

  if ((doc.connected.length || doc.markers.length) && !spine.length) out.push('connected items/markers without spine')
  const layout = layoutTimeline(doc)
  const checkAnchor = (id: string, anchorId: string, frame: number) => {
    const a = layout.byId.get(anchorId)
    if (!a || a.type !== 'spine') {
      out.push(`${id}: anchor ${anchorId} is not a spine item`)
      return
    }
    const owner = a as SpineLayoutItem
    if (frame < 0) out.push(`${id}: negative frame ${frame}`)
    if (frame >= layout.duration) {
      if (owner.index !== spine.length - 1) out.push(`${id}: hanging at ${frame} but anchored to ${anchorId}`)
    } else if (frame < owner.start || frame >= owner.ownEnd)
      out.push(`${id}: frame ${frame} outside owner ${anchorId} [${owner.start}, ${owner.ownEnd})`)
  }
  for (const c of layout.connected) checkAnchor(c.id, c.anchorId, c.start)
  for (const m of layout.markers) checkAnchor(m.id, m.anchorId, m.frame)

  const lanes = new Map<number, ConnectedLayoutItem[]>()
  for (const c of layout.connected) {
    if (Math.sign(c.lane) !== Math.sign(c.preferredLane)) out.push(`${c.id}: lane ${c.lane} crossed the spine`)
    lanes.set(c.lane, [...(lanes.get(c.lane) ?? []), c])
  }
  for (const [lane, items] of lanes) {
    items.sort((a, b) => a.start - b.start)
    for (let i = 1; i < items.length; i++)
      if (items[i]!.start < items[i - 1]!.end) out.push(`lane ${lane}: ${items[i - 1]!.id} overlaps ${items[i]!.id}`)
  }
  return out
}
