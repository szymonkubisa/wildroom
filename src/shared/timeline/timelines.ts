import { type Draft, current, isDraft } from 'immer'
import type {
  Clip,
  ConnectedItem,
  Marker,
  MixSettings,
  ProjectDoc,
  ProjectSettings,
  SpineItem,
  TimelineEntry,
} from '../types/project-doc'
import { PROJECT_FPS_OPTIONS } from './fps'
import { indexSpine } from './layout'
import type { TimelineRecipe } from './types'

/**
 * Multiple timelines per project ("stash" model). The open timeline is the document's top-level `settings`, `spine`,
 * `connected`, `markers` and `mix`, so every existing reader works unchanged; the other timelines keep the same
 * fields in their `TimelineEntry` until they are opened. Opening one swaps the two — one undoable edit.
 *
 * Documents made before multiple timelines have no `timelines`: they hold one implicit timeline, "Main" (id `main`),
 * written out by the first timeline operation. Every op below is a recipe for `applyOp` / the project store's `apply`.
 */

export const DEFAULT_TIMELINE_ID = 'main'
export const DEFAULT_TIMELINE_NAME = 'Main'

/** What an Assets card shows about a timeline. */
export interface TimelineSummary {
  id: string
  name: string
  /** The open timeline (its content is the document's top-level fields). */
  active: boolean
  settings: ProjectSettings
  durationFrames: number
  /** First media take's asset on the primary storyline — the card's picture. */
  posterAssetId?: string
  createdAt?: string
  updatedAt?: string
}

interface TimelineContent {
  settings: ProjectSettings
  spine: SpineItem[]
  connected: ConnectedItem[]
  markers: Marker[]
  mix?: MixSettings
}

/** A plain value of a (possibly draft) object, safe to move elsewhere in the tree or to clone. */
const plain = <T>(v: T): T => (isDraft(v) ? (current(v as Draft<T>) as T) : v)
const nowIso = () => new Date().toISOString()

/** Id of the open timeline. */
export function currentTimelineId(doc: ProjectDoc): string {
  return doc.activeTimelineId ?? DEFAULT_TIMELINE_ID
}

function spineEnd(spine: readonly SpineItem[]): number {
  return indexSpine(spine as SpineItem[]).end
}

function firstPosterAssetId(spine: readonly SpineItem[]): string | undefined {
  for (const item of spine) {
    if (item.kind !== 'media') continue
    const take = item.takes[item.active] ?? item.takes[0]
    if (take?.assetId) return take.assetId
  }
  return undefined
}

/** Is the open timeline listed in `timelines`? (Not for old documents, or a hand-edited file.) */
function activeListed(doc: ProjectDoc): boolean {
  const id = currentTimelineId(doc)
  return Boolean(doc.timelines?.some((t) => t.id === id))
}

export function timelineCount(doc: ProjectDoc): number {
  return (doc.timelines?.length ?? 0) + (activeListed(doc) ? 0 : 1)
}

function timelineExists(doc: ProjectDoc, id: string): boolean {
  return id === currentTimelineId(doc) || Boolean(doc.timelines?.some((t) => t.id === id))
}

/** Every timeline of the project in Assets order; the open one is summarised from the live top-level fields. */
export function timelineSummaries(doc: ProjectDoc): TimelineSummary[] {
  const activeId = currentTimelineId(doc)
  const live = (e?: TimelineEntry): TimelineSummary => ({
    id: activeId,
    name: e?.name ?? DEFAULT_TIMELINE_NAME,
    active: true,
    settings: doc.settings,
    durationFrames: spineEnd(doc.spine),
    posterAssetId: firstPosterAssetId(doc.spine),
    createdAt: e?.createdAt,
    updatedAt: e?.updatedAt,
  })
  const list = doc.timelines ?? []
  const out = list.map(
    (e): TimelineSummary =>
      e.id === activeId
        ? live(e)
        : {
            id: e.id,
            name: e.name,
            active: false,
            settings: e.settings,
            durationFrames: e.spine ? spineEnd(e.spine) : (e.durationFrames ?? 0),
            posterAssetId: e.spine ? firstPosterAssetId(e.spine) : e.posterAssetId,
            createdAt: e.createdAt,
            updatedAt: e.updatedAt,
          },
  )
  if (!activeListed(doc)) out.unshift(live())
  return out
}

/** The open timeline's name. */
export function activeTimelineName(doc: ProjectDoc): string {
  const id = currentTimelineId(doc)
  return doc.timelines?.find((t) => t.id === id)?.name ?? DEFAULT_TIMELINE_NAME
}

/** Name for exports of the open timeline: the project name, plus the timeline's when the project has several. */
export function timelineExportName(projectName: string, doc: ProjectDoc): string {
  return timelineCount(doc) > 1 ? `${projectName} — ${activeTimelineName(doc)}` : projectName
}

/** Clips of every timeline, stashed ones included (e.g. to tell whether an asset is still used). */
export function clipsInAllTimelines(doc: ProjectDoc): Clip[] {
  const clips: Clip[] = [...doc.spine, ...doc.connected.map((c) => c.clip)]
  const activeId = currentTimelineId(doc)
  for (const t of doc.timelines ?? []) {
    if (t.id === activeId) continue
    clips.push(...(t.spine ?? []), ...(t.connected ?? []).map((c) => c.clip))
  }
  return clips
}

function uniqueName(list: readonly TimelineEntry[], base: string): string {
  const taken = new Set(list.map((t) => t.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

/** Default name of the next new timeline ("Timeline 2", "Timeline 3"…). */
export function nextTimelineName(doc: ProjectDoc): string {
  const taken = new Set(timelineSummaries(doc).map((t) => t.name.toLowerCase()))
  for (let n = timelineCount(doc) + 1; ; n++) if (!taken.has(`timeline ${n}`)) return `Timeline ${n}`
}

/** Writes out the timeline list (old documents: the implicit "Main") so the open timeline has its entry. */
function ensureTimelines(draft: ProjectDoc, now: string): TimelineEntry[] {
  const activeId = currentTimelineId(draft)
  if (!draft.timelines) draft.timelines = []
  const list = draft.timelines
  if (!list.some((t) => t.id === activeId)) {
    const entry: TimelineEntry = {
      id: activeId,
      name: uniqueName(list, DEFAULT_TIMELINE_NAME),
      createdAt: now,
      updatedAt: now,
      settings: { ...plain(draft.settings) },
      durationFrames: spineEnd(draft.spine),
    }
    const poster = firstPosterAssetId(draft.spine)
    if (poster) entry.posterAssetId = poster
    list.unshift(entry)
  }
  if (draft.activeTimelineId !== activeId) draft.activeTimelineId = activeId
  return list
}

function topLevelContent(draft: ProjectDoc): TimelineContent {
  const content: TimelineContent = {
    settings: { ...plain(draft.settings) },
    spine: plain(draft.spine),
    connected: plain(draft.connected),
    markers: plain(draft.markers),
  }
  if (draft.mix) content.mix = plain(draft.mix)
  return content
}

function stashedContent(entry: TimelineEntry): TimelineContent {
  const content: TimelineContent = {
    settings: { ...plain(entry.settings) },
    spine: plain(entry.spine ?? []),
    connected: plain(entry.connected ?? []),
    markers: plain(entry.markers ?? []),
  }
  if (entry.mix) content.mix = plain(entry.mix)
  return content
}

function writeStash(entry: TimelineEntry, content: TimelineContent, now: string) {
  entry.settings = content.settings
  entry.spine = content.spine
  entry.connected = content.connected
  entry.markers = content.markers
  if (content.mix) entry.mix = content.mix
  else delete entry.mix
  entry.durationFrames = spineEnd(content.spine)
  const poster = firstPosterAssetId(content.spine)
  if (poster) entry.posterAssetId = poster
  else delete entry.posterAssetId
  entry.updatedAt = now
}

/** Moves a stashed timeline into the top-level fields; its entry keeps the summary (settings, duration, poster). */
function loadStash(entry: TimelineEntry, draft: ProjectDoc) {
  const content = stashedContent(entry)
  draft.settings = content.settings
  draft.spine = content.spine
  draft.connected = content.connected
  draft.markers = content.markers
  if (content.mix) draft.mix = content.mix
  else delete draft.mix
  entry.settings = { ...content.settings }
  delete entry.spine
  delete entry.connected
  delete entry.markers
  delete entry.mix
}

/** New ids for every clip, take, connected item and marker (anchors follow), so copies never share ids. */
function withFreshIds(content: TimelineContent, newId: () => string): TimelineContent {
  const c = structuredClone(content)
  const map = new Map<string, string>()
  const freshClip = (clip: Clip, id = newId()) => {
    map.set(clip.id, id)
    clip.id = id
    if (clip.kind === 'media') for (const t of clip.takes) t.id = newId()
  }
  for (const clip of c.spine) freshClip(clip)
  for (const item of c.connected) {
    const id = newId()
    map.set(item.id, id)
    item.id = id
    freshClip(item.clip, id)
  }
  for (const m of c.markers) m.id = newId()
  for (const item of c.connected) item.anchorId = map.get(item.anchorId) ?? item.anchorId
  for (const m of c.markers) m.anchorId = map.get(m.anchorId) ?? m.anchorId
  return c
}

export interface CreateTimelineOptions {
  id: string
  /** Defaults to "Timeline N"; made unique. */
  name?: string
  /** Format of the new timeline; anything not given is taken from the open timeline. */
  settings?: Partial<ProjectSettings>
  now?: string
}

/** Adds an empty timeline (it is not opened). */
export function createTimeline(opts: CreateTimelineOptions): TimelineRecipe {
  return (draft) => {
    if (timelineExists(draft, opts.id)) return
    const now = opts.now ?? nowIso()
    const name = opts.name?.trim() || nextTimelineName(draft)
    const list = ensureTimelines(draft, now)
    const given = Object.fromEntries(Object.entries(opts.settings ?? {}).filter(([, v]) => v !== undefined))
    list.push({
      id: opts.id,
      name: uniqueName(list, name),
      createdAt: now,
      updatedAt: now,
      settings: { ...plain(draft.settings), ...given },
      durationFrames: 0,
      spine: [],
      connected: [],
      markers: [],
    })
  }
}

/** Opens a timeline: the open one is stashed into its entry, the target's content becomes the top-level fields. */
export function openTimeline(id: string, now = nowIso()): TimelineRecipe {
  return (draft) => {
    if (id === currentTimelineId(draft) || !draft.timelines?.some((t) => t.id === id)) return
    const list = ensureTimelines(draft, now)
    const outgoing = list.find((t) => t.id === draft.activeTimelineId)!
    const incoming = list.find((t) => t.id === id)!
    const content = topLevelContent(draft)
    loadStash(incoming, draft)
    writeStash(outgoing, content, now)
    draft.activeTimelineId = id
  }
}

export function renameTimeline(id: string, name: string, now = nowIso()): TimelineRecipe {
  return (draft) => {
    const value = name.trim()
    if (!value || !timelineExists(draft, id)) return
    const entry = ensureTimelines(draft, now).find((t) => t.id === id)!
    if (entry.name === value) return
    entry.name = value
    entry.updatedAt = now
  }
}

export interface DuplicateTimelineOptions {
  /** Id of the copy (default: a new id from the op context). */
  id?: string
  /** Defaults to "<name> copy"; made unique. */
  name?: string
  now?: string
}

/** Adds an independent copy of a timeline (fresh clip ids) right after it; the copy is not opened. */
export function duplicateTimeline(sourceId: string, opts: DuplicateTimelineOptions = {}): TimelineRecipe {
  return (draft, ctx) => {
    if (!timelineExists(draft, sourceId) || (opts.id && timelineExists(draft, opts.id))) return
    const now = opts.now ?? nowIso()
    const list = ensureTimelines(draft, now)
    const index = list.findIndex((t) => t.id === sourceId)
    const source = list[index]!
    const content = withFreshIds(sourceId === draft.activeTimelineId ? topLevelContent(draft) : stashedContent(source), ctx.newId)
    const copy: TimelineEntry = {
      id: opts.id ?? ctx.newId(),
      name: uniqueName(list, opts.name?.trim() || `${source.name} copy`),
      createdAt: now,
      updatedAt: now,
      settings: content.settings,
      durationFrames: 0,
    }
    writeStash(copy, content, now)
    list.splice(index + 1, 0, copy)
  }
}

/** Deletes a timeline. The last one cannot be deleted; deleting the open one opens its neighbour first. */
export function deleteTimeline(id: string, now = nowIso()): TimelineRecipe {
  return (draft, ctx) => {
    if (!timelineExists(draft, id) || timelineCount(draft) < 2) return
    const list = ensureTimelines(draft, now)
    const index = list.findIndex((t) => t.id === id)
    if (id === draft.activeTimelineId) {
      const neighbour = list[index + 1] ?? list[index - 1]!
      openTimeline(neighbour.id, now)(draft, ctx)
    }
    list.splice(
      list.findIndex((t) => t.id === id),
      1,
    )
  }
}

/** Why a saved document's timeline list is malformed (undefined when it is fine). */
export function timelinesProblem(doc: ProjectDoc): string | undefined {
  if (doc.activeTimelineId !== undefined && (typeof doc.activeTimelineId !== 'string' || !doc.activeTimelineId)) return 'Invalid active timeline'
  if (doc.timelines === undefined) return undefined
  if (!Array.isArray(doc.timelines)) return 'Invalid timelines'
  const ids = new Set<string>()
  const fpsOk = (fps: unknown) => (PROJECT_FPS_OPTIONS as readonly unknown[]).includes(fps)
  for (const t of doc.timelines as unknown[]) {
    const e = t as Partial<TimelineEntry> | null
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id || typeof e.name !== 'string') return 'Invalid timeline'
    if (ids.has(e.id)) return 'Duplicate timeline id'
    ids.add(e.id)
    if (!e.settings || typeof e.settings !== 'object' || !fpsOk(e.settings.fps)) return 'Unsupported timeline frame rate'
    for (const key of ['spine', 'connected', 'markers'] as const) if (e[key] !== undefined && !Array.isArray(e[key])) return 'Invalid timeline'
  }
  return undefined
}
