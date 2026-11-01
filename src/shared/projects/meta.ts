import type { ProjectDoc } from '../types/project-doc'

/**
 * What a project is, for the Projects page's filter: set when it is made (Home's kind chips, New project's "Start
 * with"), worked out from its document for projects made before (see projectKindOf).
 */
export type ProjectKind = 'film' | 'ad' | 'social' | 'edit'
export const PROJECT_KINDS: readonly ProjectKind[] = ['film', 'ad', 'social', 'edit']

export function isProjectKind(value: unknown): value is ProjectKind {
  return typeof value === 'string' && (PROJECT_KINDS as readonly string[]).includes(value)
}

/** Longest tag kept, and most tags on one project. */
export const TAG_MAX_LENGTH = 24
export const TAGS_MAX = 20

/** "  #Client  Work " → "client work"; empty when nothing is left. */
export function normalizeTag(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .normalize('NFC')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, TAG_MAX_LENGTH)
    .trim()
}

/** Clean, distinct tags in the order given (at most TAGS_MAX); anything that isn't a list reads as none. */
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const value of raw) {
    const tag = normalizeTag(value)
    if (tag && !out.includes(tag)) out.push(tag)
    if (out.length >= TAGS_MAX) break
  }
  return out
}

type DocFacts = Pick<ProjectDoc, 'spine' | 'connected' | 'story' | 'canvas'>

const hasStory = (doc: DocFacts | undefined) => {
  const story = doc?.story
  return Boolean(story && (story.script?.trim() || story.shots?.length || story.scenes?.length))
}
const boardItems = (doc: DocFacts | undefined) => (doc?.canvas?.boards ?? []).reduce((n, b) => n + (b.items?.length ?? 0), 0)
const timelineClips = (doc: DocFacts | undefined) => (doc?.spine?.length ?? 0) + (doc?.connected?.length ?? 0)

/**
 * The project's kind: the one it was made as, else what it mostly is — a story (script, scenes or shots) is a film,
 * a board with nothing on the timeline is social, anything else is an edit.
 */
export function projectKindOf(file: { kind?: unknown; doc?: DocFacts }): ProjectKind {
  if (isProjectKind(file.kind)) return file.kind
  if (hasStory(file.doc)) return 'film'
  if (boardItems(file.doc) > 0 && timelineClips(file.doc) === 0) return 'social'
  return 'edit'
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Where the project is, in a few words for its card and the search ("3 scenes · 14 shots · 9 animated", "Script"). */
export function projectStatus(doc: DocFacts | undefined): string {
  const parts: string[] = []
  const story = doc?.story
  if (story) {
    const shots = story.shots ?? []
    const scenes = story.scenes?.length ?? 0
    if (scenes) parts.push(plural(scenes, 'scene'))
    if (shots.length) parts.push(plural(shots.length, 'shot'))
    const animated = shots.filter((s) => s.videoGenerationIds?.length).length
    if (animated) parts.push(`${animated} animated`)
    if (!parts.length && story.script?.trim()) parts.push('Script')
  }
  const clips = timelineClips(doc)
  if (clips) parts.push(plural(clips, 'clip'))
  const items = boardItems(doc)
  if (items) parts.push(`${plural(items, 'item')} on the board`)
  return parts.join(' · ') || 'Empty'
}
