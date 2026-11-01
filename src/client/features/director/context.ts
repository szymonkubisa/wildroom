import type { ContextShot, DirectorContext } from '@shared/director/plan'
import type { ProjectKind } from '@shared/projects/meta'
import { shotsOfScene } from '@shared/story/structure'
import { PLACE_VIEWS, type StoryDoc, type StoryShot } from '@shared/types/story'

/** How long a script the Director is sent (the start of it): a long screenplay's outline already sums up the rest. */
export const SCRIPT_EXCERPT_CHARS = 5000

/** What the project's own parts say about a shot, a character or a place (the storyboard's lookups). */
export interface ContextSources {
  story: StoryDoc
  name?: string
  kind?: ProjectKind
  brandOn: boolean
  spentUsd?: number
  models: DirectorContext['models']
  shotName: (shot: StoryShot) => string
  still: (shot: StoryShot) => ContextShot['still']
  take: (shot: StoryShot) => ContextShot['take']
  /** The place's directions it has a photo of. */
  placeViews: (placeId: string) => string[]
  /** The Story cut timeline exists. */
  storyCut: boolean
}

const cut = (text: string | undefined, max: number) => {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/**
 * The project as the Director is told it (`/director/plan`): the story's scenes and shots with how far each is made,
 * the cast and places with their pictures, the models, the spend — compact, and within the server's limits.
 */
export function directorContext(src: ContextSources): DirectorContext {
  const st = src.story
  const placeName = (id?: string) => (id ? st.places?.find((p) => p.id === id)?.name : undefined)
  const script = st.script ?? ''
  const edited = st.outlinedFrom !== undefined && st.outlinedFrom.trim() !== script.trim()
  return {
    ...(src.name ? { name: cut(src.name, 160) } : {}),
    ...(src.kind ? { kind: src.kind } : {}),
    ...(st.title ? { title: cut(st.title, 160) } : {}),
    ...(st.logline ? { logline: cut(st.logline, 400) } : {}),
    ...(st.style ? { style: cut(st.style, 400) } : {}),
    script: { length: script.length, excerpt: script.slice(0, SCRIPT_EXCERPT_CHARS), edited },
    brandOn: src.brandOn,
    ...(st.budgetUsd ? { budgetUsd: st.budgetUsd } : {}),
    ...(src.spentUsd !== undefined ? { spentUsd: Math.round(src.spentUsd * 100) / 100 } : {}),
    models: src.models,
    cast: st.characters.slice(0, 40).map((c) => ({ id: c.id, name: cut(c.name, 120) || 'Unnamed', picture: Boolean(c.refAssetId), voice: Boolean(c.voiceId) })),
    places: (st.places ?? []).slice(0, 40).map((p) => ({ id: p.id, name: cut(p.name, 120) || 'Unnamed', picture: Boolean(p.refAssetIds?.length), views: src.placeViews(p.id).slice(0, 4) })),
    scenes: (st.scenes ?? []).slice(0, 60).map((scene, i) => ({
      id: scene.id,
      n: i + 1,
      title: cut(scene.title, 160) || `Scene ${i + 1}`,
      ...(scene.summary ? { summary: cut(scene.summary, 400) } : {}),
      ...(placeName(scene.placeId) ? { place: cut(placeName(scene.placeId), 120) } : {}),
      ...(scene.time ? { time: cut(scene.time, 80) } : {}),
      ...(scene.light ? { light: cut(scene.light, 240) } : {}),
      shots: shotsOfScene(st, scene.id)
        .slice(0, 80)
        .map((shot) => ({
          id: shot.id,
          n: src.shotName(shot).slice(0, 12),
          what: cut(shot.description || shot.prompt, 240),
          seconds: Math.min(600, Math.max(0, shot.duration || 0)),
          lines: Math.min(99, shot.dialogue.filter((l) => l.text.trim()).length),
          still: src.still(shot),
          take: src.take(shot),
        })),
    })),
    storyCut: src.storyCut,
  }
}

/** The directions of a place it has a photo of (main, reverse…), from the storyboard's own lookup. */
export const viewsWith = (has: (view: (typeof PLACE_VIEWS)[number]) => boolean) => PLACE_VIEWS.filter(has)
