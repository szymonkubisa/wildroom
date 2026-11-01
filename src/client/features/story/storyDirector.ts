import { soloEndFrameShots, splitGroups } from '@shared/models/groups'
import { rendersSeparately, workflowFor } from '@shared/models/workflow'
import { type SceneChange, mergeRewrittenShots } from '@shared/story/scriptDiff'
import { outlineToStory, replaceSceneShots, shotsOfScene } from '@shared/story/structure'
import {
  type BreakdownShot,
  type Outline,
  type OutlineResponse,
  PLACE_VIEWS,
  type SceneShotsRequest,
  type StoryDoc,
  type StoryScene,
  type StoryShot,
  type WriteScriptResponse,
} from '@shared/types/story'
import { nanoid } from 'nanoid'
import { shallowReactive } from 'vue'
import { toast } from 'vue-sonner'
import { api, errorMessage } from '@/lib/api'
import { breakdownGroups } from './multishot'
import { placeViewPhoto } from './references'
import type { StoryCore } from './storyCore'

/**
 * The AI Director's passes: the script outlined into cast, places, chapters and scenes, and each scene's shots written
 * (or only the scenes whose part of the script changed: Update scenes) — applied to the story as undoable steps.
 */

/** The AI Director's calls (lib/api.ts): kept under this name for the story's components and the Composer. */
export const directorApi = api.director

/** Scenes whose shots the Director is writing (about a minute): shown on whichever scene is open, written once at a time. */
const writingScenes = shallowReactive(new Set<string>())

export function createDirector(core: StoryCore) {
  const { story, aspect, update, modelFor, groups, keyframeOf } = core

  // ---- the Director's shots
  /**
   * A shot as the Director wrote it, with the story's ids for its cast (by name) and place — those it lists as hidden
   * in the dark too (StoryShot.hiddenIds), never also with their face.
   */
  function shotFrom(x: BreakdownShot, idFor: (name: string) => string | undefined, placeId: string | undefined): StoryShot {
    const characterIds = x.characters.map(idFor).filter((v): v is string => Boolean(v))
    const hiddenIds = [...new Set((x.hidden ?? []).map(idFor).filter((v): v is string => Boolean(v) && !characterIds.includes(v!)))]
    return {
      id: nanoid(8),
      scene: x.scene || undefined,
      description: x.description,
      shotType: x.shotType || undefined,
      ...(x.view ? { view: x.view } : {}),
      ...(x.frame ? { frame: x.frame } : {}),
      ...(x.endFrame ? { endFrame: x.endFrame } : {}),
      ...(x.background ? { background: x.background } : {}),
      camera: x.camera || undefined,
      prompt: x.prompt,
      duration: x.durationSeconds,
      characterIds,
      // Hidden wins over seen in part: a partial one's face reference goes along.
      partialIds: (x.partial ?? []).map(idFor).filter((v): v is string => Boolean(v) && !x.characters.some((c) => idFor(c) === v) && !hiddenIds.includes(v!)),
      ...(hiddenIds.length ? { hiddenIds } : {}),
      placeId,
      dialogue: x.dialogue.map((d) => ({ id: nanoid(8), characterId: idFor(d.character), text: d.text })),
      sfx: x.sfx || undefined,
      videoGenerationIds: [],
    }
  }

  /** What the Director gets about the cast and places already set: their names, looks, voices, blocking and light. */
  const knownCast = () => story.value.characters.map((c) => ({ name: c.name, description: c.description, ...(c.voice ? { voice: c.voice } : {}) }))
  const knownPlaces = () =>
    (story.value.places ?? []).map((p) => ({ name: p.name, description: p.description, ...(p.blocking ? { blocking: p.blocking } : {}), ...(p.light ? { light: p.light } : {}) }))

  /**
   * An idea → a short screenplay in place of the script (Write script from idea, a brief from Home, the Director's
   * chat), and the film's title from it; undoable.
   */
  async function writeScript(idea: string): Promise<WriteScriptResponse> {
    const res = await directorApi.writeScript({ idea, style: story.value.style, aspect: aspect.value })
    update('Write script', (st) => {
      st.script = res.script
      if (res.title && res.title !== 'Untitled') st.title = res.title
    })
    return res
  }

  /** Pass one: the script → cast, places, chapters and scenes. Replaces the structure (and its shots); undoable. */
  async function outlineStory(): Promise<OutlineResponse> {
    // The script as sent: Update scenes later compares the script with it.
    const script = story.value.script
    const res = await directorApi.outline({
      script,
      style: story.value.style,
      aspect: aspect.value,
      characters: knownCast(),
      places: knownPlaces(),
      targetModelId: modelFor('video')?.id,
    })
    applyOutline(res.outline, script)
    return res
  }

  function applyOutline(outline: Outline, from?: string) {
    update('Outline story', (s) => {
      outlineToStory(s, outline, () => nanoid(8))
      if (from !== undefined) s.outlinedFrom = from
      else delete s.outlinedFrom
    })
  }

  /** What one scene already has that rewriting its shots would set aside (undo brings it back; the files stay in Assets). */
  function sceneWork(sceneId: string): { shots: number; keyframes: number; takes: number } {
    const shots = shotsOfScene(story.value, sceneId)
    const ids = new Set(shots.map((x) => x.id))
    const groupTakes = groups.value.filter((g) => g.shotIds.some((id) => ids.has(id))).reduce((n, g) => n + g.videoGenerationIds.length, 0)
    return {
      shots: shots.length,
      keyframes: shots.filter((x) => keyframeOf(x)).length,
      takes: shots.reduce((n, x) => n + x.videoGenerationIds.length, 0) + groupTakes,
    }
  }

  /** Pass two's request for a scene: its part of the script, its place and cast as set, and the scenes around it. */
  function sceneShotsRequest(sceneId: string): SceneShotsRequest | undefined {
    const s = story.value
    const scenes = s.scenes ?? []
    const k = scenes.findIndex((x) => x.id === sceneId)
    const scene = scenes[k]
    if (!scene) return undefined
    const place = scene.placeId ? s.places?.find((p) => p.id === scene.placeId) : undefined
    const cast = scene.castIds?.length ? s.characters.filter((c) => scene.castIds!.includes(c.id)) : s.characters
    const prev = scenes[k - 1]
    const next = scenes[k + 1]
    const last = prev ? shotsOfScene(s, prev.id).at(-1) : undefined
    return {
      script: scene.script ?? '',
      style: s.style,
      aspect: aspect.value,
      targetModelId: modelFor('video')?.id,
      targetShots: scene.targetShots,
      scene: { heading: scene.title, summary: scene.summary, time: scene.time, light: scene.light, blocking: scene.blocking, continuesPrevious: scene.continuesPrevious },
      ...(place
        ? {
            place: {
              name: place.name,
              description: place.description,
              blocking: place.blocking,
              light: place.light,
              photos: (place.refAssetIds ?? []).map((id) => place.refNotes?.[id]).filter((n): n is string => Boolean(n)),
              views: PLACE_VIEWS.filter((v) => placeViewPhoto(place, v)),
            },
          }
        : {}),
      characters: cast.map((c) => ({ name: c.name, description: c.description, ...(c.voice ? { voice: c.voice } : {}) })),
      ...(prev
        ? {
            previous: {
              heading: prev.title,
              summary: prev.summary,
              samePlace: Boolean(prev.placeId && prev.placeId === scene.placeId),
              ...(last ? { lastShot: { shotType: last.shotType, description: last.description, prompt: last.prompt } } : {}),
            },
          }
        : {}),
      ...(next ? { next: { heading: next.title, summary: next.summary } } : {}),
    }
  }

  /** Pass two: writes (or rewrites) one scene's shots. Undoable; returns how many it wrote. */
  async function writeShotsForScene(sceneId: string): Promise<number> {
    const req = sceneShotsRequest(sceneId)
    if (!req || writingScenes.has(sceneId)) return 0
    writingScenes.add(sceneId)
    try {
      const res = await directorApi.sceneShots(req)
      applySceneShots(sceneId, res.shots)
      return res.shots.length
    } finally {
      writingScenes.delete(sceneId)
    }
  }

  const writingShots = (sceneId: string) => writingScenes.has(sceneId)

  /**
   * No groups for a model that renders shot by shot (LTX, rendersSeparately): the server already numbers every shot 0
   * there — this holds for a reply from an older server, or one the story's model changed under.
   */
  const separate = () => rendersSeparately(modelFor('video'), true)

  /**
   * A scene's shots as the Director wrote them, with the story's ids for the cast (by name; names not in the cast go
   * into `unknown`) and the multi-shot groups over them (none on a model that renders shot by shot). Call inside an
   * update.
   */
  function writtenShots(s: StoryDoc, scene: StoryScene, written: BreakdownShot[], unknown: Set<string>): { shots: StoryShot[]; runs: number[][] } {
    const limits = workflowFor(modelFor('video')).multishot
    const byName = new Map(s.characters.map((c) => [c.name.toLowerCase(), c.id]))
    const idFor = (name: string) => {
      const id = byName.get(name.toLowerCase())
      if (!id && name.trim()) unknown.add(name.trim())
      return id
    }
    const shots = written.map((x) => shotFrom(x, idFor, scene.placeId))
    const runs = separate() ? [] : breakdownGroups(splitGroups(soloEndFrameShots(written), limits), limits.maxShots)
    return { shots, runs }
  }

  const groupsOver = (shots: StoryShot[], runs: number[][]) =>
    runs.map((run) => ({ id: nanoid(8), shotIds: run.map((i) => shots[i]!.id), videoGenerationIds: [] }))

  function warnUnknown(unknown: Set<string>) {
    if (unknown.size) {
      toast.warning(`Not in the cast: ${[...unknown].join(', ')}`, { description: 'Their shots and lines have no character — add them in Cast & Places, then write the shots again.' })
    }
  }

  function applySceneShots(sceneId: string, written: BreakdownShot[]) {
    const unknown = new Set<string>()
    update('Write shots', (s) => {
      const scene = s.scenes?.find((x) => x.id === sceneId)
      if (!scene) return
      const { shots, runs } = writtenShots(s, scene, written, unknown)
      replaceSceneShots(s, sceneId, shots, groupsOver(shots, runs))
    })
    warnUnknown(unknown)
  }

  // ---- Update scenes: only the scenes whose part of the script changed

  /** The scene-shots request for a scene written from `script` (its part of the script as it is now). */
  function updateRequest(change: SceneChange): SceneShotsRequest | undefined {
    const req = sceneShotsRequest(change.sceneId)
    return req && { ...req, script: change.script }
  }

  /**
   * Writes the changed scenes' shots again from their parts of the script as they are now (one Director call each, at
   * once), then applies them all as one undo step: each scene takes its new part, and its rewritten shots take over the
   * old ones' stills and takes (mergeRewrittenShots) — the same action kept, a rewritten one with its still marked
   * stale. Scenes not in `changes` are untouched. A scene whose call failed keeps its shots and part (it shows as
   * changed next time); the script is recorded as the one the plan follows only when every call came back.
   */
  async function updateScenes(changes: SceneChange[]): Promise<{ scenes: number; kept: number; rewritten: number; added: number; dropped: number; failed: number; error?: string }> {
    const script = story.value.script
    const todo = changes.filter((c) => !writingScenes.has(c.sceneId))
    for (const c of todo) writingScenes.add(c.sceneId)
    let results: PromiseSettledResult<{ change: SceneChange; shots: BreakdownShot[] }>[]
    try {
      results = await Promise.allSettled(
        todo.map(async (change) => {
          const req = updateRequest(change)
          if (!req) throw new Error('The scene is gone')
          return { change, shots: (await directorApi.sceneShots(req)).shots }
        }),
      )
    } finally {
      for (const c of todo) writingScenes.delete(c.sceneId)
    }
    const done = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    const failed = results.filter((r) => r.status === 'rejected')
    const out = { scenes: 0, kept: 0, rewritten: 0, added: 0, dropped: 0, failed: failed.length + (changes.length - todo.length) }
    const unknown = new Set<string>()
    // Matched against the story as it is now (plain values: the merge copies the old shots it keeps), applied at once.
    const now = story.value
    const plans = done.flatMap(({ change, shots: written }) => {
      const scene = now.scenes?.find((x) => x.id === change.sceneId)
      if (!scene) return []
      const { shots, runs } = writtenShots(now, scene, written, unknown)
      const merged = mergeRewrittenShots(shotsOfScene(now, scene.id), shots)
      out.scenes++
      out.kept += merged.kept
      out.rewritten += merged.rewritten
      out.added += merged.added
      out.dropped += merged.dropped
      // The groups as written, over the shots that stand in their places now.
      return [{ change, shots: merged.shots, groups: groupsOver(merged.shots, runs) }]
    })
    if (plans.length) {
      update('Update scenes', (s) => {
        for (const p of plans) {
          const scene = s.scenes?.find((x) => x.id === p.change.sceneId)
          if (!scene) continue
          scene.script = p.change.script
          replaceSceneShots(s, scene.id, p.shots, p.groups)
        }
        if (!out.failed) s.outlinedFrom = script
      })
    }
    warnUnknown(unknown)
    const reason = failed[0]?.status === 'rejected' ? failed[0].reason : undefined
    return reason ? { ...out, error: errorMessage(reason) } : out
  }

  return { writeScript, outlineStory, applyOutline, sceneWork, sceneShotsRequest, writeShotsForScene, writingShots, applySceneShots, updateRequest, updateScenes }
}
