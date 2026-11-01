import type { ProjectKind } from '@shared/projects/meta'
import type { ProjectEntry } from '@shared/types/api'
import type { ProjectSettings } from '@shared/types/project-doc'
import type { Workspace } from '@/stores/editor'

/** Home's kind chips: what each makes, where it opens and the format it starts in. */
export interface StartKind {
  id: ProjectKind
  label: string
  /** The filter's plural ("Films"). */
  plural: string
  format: string
  hint: string
  placeholder: string
  /** "Try" chips under the prompt. */
  examples: string[]
  workspace: Workspace
  settings: Partial<ProjectSettings>
}

export const START_KINDS: StartKind[] = [
  {
    id: 'film',
    label: 'Film',
    plural: 'Films',
    format: '16:9 · 24 fps',
    hint: 'Opens Plan: the Director writes the script, scenes and shots from your idea, then shows the plan with its cost. Nothing is rendered until you approve it.',
    placeholder: 'A 45-second film: a boy catches his first fish with his grandfather on a misty lake at dawn…',
    examples: ['A 45-second film: a boy catches his first fish with his grandfather', 'A western stand-off at noon, in one take', 'Two strangers share an umbrella in the rain'],
    workspace: 'story',
    settings: { width: 1920, height: 1080, fps: 24, fpsAuto: false },
  },
  {
    id: 'ad',
    label: 'Ad',
    plural: 'Ads',
    format: '16:9 · 24 fps',
    hint: 'Opens Plan: the Director writes a short ad script from your brief, its scenes and shots, then shows the plan with its cost. Nothing is rendered until you approve it.',
    placeholder: 'A 30-second ad for a small bakery in Leeds: flour, steam, early light…',
    examples: ['A 30-second ad for a small bakery in Leeds', 'A product film for a handmade ceramic mug', 'A 15-second teaser for a music festival'],
    workspace: 'story',
    settings: { width: 1920, height: 1080, fps: 24, fpsAuto: false },
  },
  {
    id: 'social',
    label: 'Social post',
    plural: 'Social',
    format: '4:5 · stills and short clips',
    hint: 'Opens Create, a board for images and posts; your brief waits in Brief → asset set.',
    placeholder: 'Three posts announcing our film premiere, same look as the poster…',
    examples: ['Three posts announcing our film premiere', 'A carousel of behind-the-scenes stills', 'A launch post for a new coffee blend'],
    workspace: 'canvas',
    settings: { width: 1080, height: 1350, fps: 24, fpsAuto: true },
  },
  {
    id: 'edit',
    label: 'Edit footage',
    plural: 'Edits',
    format: '16:9 · frame rate from the first clip',
    hint: 'Opens Edit: drop your clips in. The frame rate follows the first video clip.',
    placeholder: 'Cut my travel clips into a 60-second reel with music…',
    examples: ['Cut a 60-second reel from my clips', 'Add captions and music to an interview', 'A trailer from last summer’s footage'],
    workspace: 'edit',
    settings: { width: 1920, height: 1080, fps: 24, fpsAuto: true },
  },
]

export const KIND_LABELS: Record<ProjectKind, string> = { film: 'Film', ad: 'Ad', social: 'Social', edit: 'Edit' }

/** A project's name from its brief: its first sentence, a few words of it ("Untitled Film" without one). */
export function nameFromBrief(brief: string, kind: ProjectKind): string {
  const fallback = `Untitled ${KIND_LABELS[kind]}`
  // "A 45-second film: Kuba catches…" → what comes after the colon names it better.
  let text = brief.trim().split(/\n/)[0] ?? ''
  const colon = text.indexOf(':')
  if (colon > 0 && colon < 40 && text.slice(colon + 1).trim().split(/\s+/).length >= 2) text = text.slice(colon + 1)
  text = (text.split(/(?<=[.!?…])\s|[.!?…]$/)[0] ?? '').replace(/[.!?…,;:]+$/, '').trim()
  const words = text.split(/\s+/).filter(Boolean).slice(0, 6)
  if (!words.length) return fallback
  const name = words.join(' ').replace(/[/\\:]/g, '-').slice(0, 60).trim()
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export type ProjectSort = 'edited' | 'created' | 'name'
export const PROJECT_SORTS: { id: ProjectSort; label: string }[] = [
  { id: 'edited', label: 'Last edited' },
  { id: 'created', label: 'Newest first' },
  { id: 'name', label: 'Name A–Z' },
]

export interface ProjectFilter {
  query: string
  kind: ProjectKind | 'all'
  /** Every one of them (AND). */
  tags: string[]
  sort: ProjectSort
  /** Paths of the projects pinned on this machine: first, whatever the sort. */
  pinned: ReadonlySet<string>
}

/** What the state of a project reads as, for the search ("open", "missing"…). */
function stateWords(p: ProjectEntry): string {
  if (p.state === 'missing') return 'missing not found'
  if (p.state === 'locked') return `locked open on ${p.lockedBy?.host ?? 'another computer'}`
  if (p.state === 'unreadable') return 'unreadable damaged'
  if (p.state === 'newer-format') return 'newer version'
  return p.open ? 'open' : ''
}

/** Every word typed is in the name, a tag, the status or the kind ("#client" looks only at tags). */
export function matchesQuery(p: ProjectEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const tags = (p.tags ?? []).map((t) => t.toLowerCase())
  const text = [p.name, p.status, stateWords(p), p.kind ? KIND_LABELS[p.kind] : '', tags.join(' ')].join(' ').toLowerCase()
  return words.every((w) => (w.startsWith('#') ? tags.some((t) => t.includes(w.slice(1))) : text.includes(w)))
}

const editedAt = (p: ProjectEntry) => Date.parse(p.updatedAt ?? p.lastOpenedAt ?? '') || 0
const createdAt = (p: ProjectEntry) => Date.parse(p.createdAt ?? p.updatedAt ?? '') || 0

/** The projects the filter lets through: pinned first, then by the sort. */
export function filterProjects(list: ProjectEntry[], f: ProjectFilter): ProjectEntry[] {
  const shown = list.filter(
    (p) => (f.kind === 'all' || p.kind === f.kind) && f.tags.every((t) => p.tags?.includes(t)) && matchesQuery(p, f.query),
  )
  const by =
    f.sort === 'name'
      ? (a: ProjectEntry, b: ProjectEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
      : f.sort === 'created'
        ? (a: ProjectEntry, b: ProjectEntry) => createdAt(b) - createdAt(a)
        : (a: ProjectEntry, b: ProjectEntry) => editedAt(b) - editedAt(a)
  return shown.sort((a, b) => Number(f.pinned.has(b.path)) - Number(f.pinned.has(a.path)) || by(a, b))
}

/** Every tag in use, with how many projects have it: the most used first. */
export function tagCounts(list: ProjectEntry[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const p of list) for (const t of p.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

/** Reads a remembered per-machine value (private windows and blocked storage read as nothing). */
export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Remembers a per-machine value; `null` forgets it. Without storage it lasts until the page closes. */
export function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Private window or blocked storage.
  }
}
