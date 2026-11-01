import type { Outline, StoryCharacter, StoryChapter, StoryDoc, StoryMultishot, StoryPlace, StoryScene, StoryShot } from '../types/story'

/**
 * The story's structure — chapters → scenes → shots — as plain functions over the document. Shots stay one flat list
 * in story order (everything that renders and assembles walks it); a shot's `sceneId` says which scene it belongs to,
 * and the list keeps each scene's shots together, in scene order (normalizeStory). Edits mutate (call inside an update).
 */

const MIN_GROUP_SHOTS = 2

type Shots = Pick<StoryDoc, 'shots'>
type Scenes = Pick<StoryDoc, 'scenes'>

/** Multi-shot groups whose shots all still exist, follow one another in story order, and belong to one scene. */
export function validGroups(story: Pick<StoryDoc, 'shots' | 'multishots'>): StoryMultishot[] {
  const index = new Map(story.shots.map((s, i) => [s.id, i]))
  return (story.multishots ?? []).filter((g) => {
    const at = g.shotIds.map((id) => index.get(id))
    if (at.length < MIN_GROUP_SHOTS || !at.every((i, k) => i !== undefined && (k === 0 || i === at[k - 1]! + 1))) return false
    const scene = story.shots[at[0]!]!.sceneId
    return at.every((i) => story.shots[i!]!.sceneId === scene)
  })
}

// ---- lookups

export const sceneOf = (story: Scenes, shot: Pick<StoryShot, 'sceneId'>): StoryScene | undefined =>
  shot.sceneId ? story.scenes?.find((s) => s.id === shot.sceneId) : undefined

export const placeOf = (story: Pick<StoryDoc, 'places'>, shot: Pick<StoryShot, 'placeId'>): StoryPlace | undefined =>
  shot.placeId ? story.places?.find((p) => p.id === shot.placeId) : undefined

/** Who stands where in the shot: its own blocking, else its scene's, else its place's. */
export const blockingOf = (story: Pick<StoryDoc, 'scenes' | 'places'>, shot: StoryShot): string | undefined =>
  shot.blocking?.trim() || sceneOf(story, shot)?.blocking?.trim() || placeOf(story, shot)?.blocking?.trim() || undefined

/**
 * The shot's light: its own (StoryShot.light, as written: it is this shot's alone), else its scene's, else its
 * place's — those as a steady state (steadyLight).
 */
export const lightOf = (story: Pick<StoryDoc, 'scenes' | 'places'>, shot: StoryShot): string | undefined =>
  shot.light?.trim() || steadyLight(sceneOf(story, shot)?.light ?? '') || steadyLight(placeOf(story, shot)?.light ?? '') || undefined

/** The light a shot gets from its scene (else its place) — what its own light replaces. */
export const sceneLightOf = (story: Pick<StoryDoc, 'scenes' | 'places'>, shot: StoryShot): string | undefined =>
  steadyLight(sceneOf(story, shot)?.light ?? '') || steadyLight(placeOf(story, shot)?.light ?? '') || undefined

/** Something that happens: the light that holds before it is not the light after. */
const LIGHT_EVENT = /\b(when|whenever|as soon as|once|until|till|later|then|suddenly|eventually|switch(es|ed)? on|turns? on|flicks? on|comes? on|goes out|activat(es|ed|ing)|ignit(es|ed)|starts|started|begins|began)\b/i
const STARTS_WITH_EVENT = new RegExp(String.raw`^\W*` + LIGHT_EVENT.source, 'i')
/** What lies far off, or in one direction only (the compass, a screen side, behind the establishing camera). */
const LIGHT_FAR = /\b(horizon|distant|distance|far[- ]?(away|off)|skyline|planets?|(north|south|east|west)(ern|ward|wards)?|screen[- ]?(left|right)|establishing camera|behind the camera)\b/i

/**
 * The light as one steady state, the same in every frame of the scene. Clauses with events go: "when the Porsche
 * activates, its white headlights project…" lit the headlights in all eleven keyframes of The Chase, though they come
 * on in one shot (which says so). After the first clause, what lies far off or in one direction goes too — from the
 * point it starts: "…nearly shadowless faces and a stark black smoke column on the eastern horizon" put the smoke
 * behind every shot of The Last Road, whichever way the camera looked (the place's geography says where it is). The
 * first clause stays unless it is an event: it is the light.
 */
export function steadyLight(text: string): string {
  const clauses = text.trim().split(/(?<=[.;])\s+/).filter(Boolean)
  const kept = clauses.flatMap((clause, i) => {
    if (i === 0) return STARTS_WITH_EVENT.test(clause) ? [] : [clause]
    if (LIGHT_EVENT.test(clause)) return []
    if (!LIGHT_FAR.test(clause)) return [clause]
    // What the clause says before it reaches the far thing ("soft, nearly shadowless faces").
    const parts = clause.split(/(,\s+|\s+and\s+|\s+with\s+)/)
    const near = parts.findIndex((p, k) => k % 2 === 0 && LIGHT_FAR.test(p))
    const before = parts.slice(0, Math.max(0, near - 1)).join('').trim()
    return before ? [`${before}${/[.;]$/.exec(clause)?.[0] ?? ''}`] : []
  })
  if (kept.length === clauses.length && kept.every((c, i) => c === clauses[i])) return text.trim()
  const out = kept.join(' ').replace(/[;,:]\s*$/, '.')
  return out.charAt(0).toUpperCase() + out.slice(1)
}

export const shotsOfScene = (story: Shots, sceneId: string): StoryShot[] => story.shots.filter((s) => s.sceneId === sceneId)

/** 1-based; 0 when there is no such scene. */
export const sceneNumber = (story: Scenes, sceneId: string | undefined): number =>
  sceneId ? (story.scenes?.findIndex((s) => s.id === sceneId) ?? -1) + 1 : 0

/** "2.3" — scene 2, its third shot; just "7" in a story of one scene, or for a shot outside any scene. */
export function shotLabel(story: Shots & Scenes, shot: Pick<StoryShot, 'id' | 'sceneId'>): string {
  const i = story.shots.findIndex((x) => x.id === shot.id)
  const scene = sceneNumber(story, shot.sceneId)
  if (!scene || story.scenes!.length < 2) return String(i + 1)
  const within = story.shots.slice(0, i + 1).filter((x) => x.sceneId === shot.sceneId).length
  return `${scene}.${within}`
}

/** What shots were grouped by before scenes: their place, else their scene heading. */
export const legacySceneKey = (shot: Pick<StoryShot, 'placeId' | 'scene'>): string | undefined => shot.placeId ?? (shot.scene?.trim() || undefined)

// ---- scenes from older stories

/**
 * Scenes for shots that have none: each run of consecutive shots with the same place (else the same scene heading)
 * — what shots were grouped by before — never splitting a multi-shot group. Ids come from the run's first shot, so
 * deriving again gives the same scenes. Returns the scenes and each shot's scene id.
 */
export function deriveScenes(story: Pick<StoryDoc, 'shots' | 'multishots' | 'places'>): { scenes: StoryScene[]; sceneIds: string[] } {
  const groupOfShot = new Map<string, string>()
  for (const g of validGroups({ shots: story.shots.map((s) => ({ ...s, sceneId: undefined })), multishots: story.multishots })) {
    for (const id of g.shotIds) groupOfShot.set(id, g.id)
  }
  const scenes: StoryScene[] = []
  const sceneIds: string[] = []
  let current: StoryScene | undefined
  let key: string | undefined
  story.shots.forEach((shot, i) => {
    const k = legacySceneKey(shot)
    const prev = story.shots[i - 1]
    const sameGroup = prev !== undefined && groupOfShot.has(shot.id) && groupOfShot.get(prev.id) === groupOfShot.get(shot.id)
    if (!current || (!sameGroup && k !== key)) {
      const place = shot.placeId ? story.places?.find((p) => p.id === shot.placeId) : undefined
      current = {
        id: `sc_${shot.id}`,
        title: shot.scene?.trim() || place?.name || `Scene ${scenes.length + 1}`,
        ...(shot.placeId ? { placeId: shot.placeId } : {}),
      }
      scenes.push(current)
      key = k
    }
    const cast = new Set([...(current.castIds ?? []), ...shot.characterIds, ...(shot.partialIds ?? [])])
    if (cast.size) current.castIds = [...cast]
    sceneIds.push(current.id)
  })
  return { scenes, sceneIds }
}

const inOrder = <T>(xs: readonly T[], rank: (x: T) => number) => xs.every((x, i) => i === 0 || rank(xs[i - 1]!) <= rank(x))

/**
 * Puts the structure right after any edit: a story with shots and no scenes gets them (deriveScenes); scenes point at
 * chapters that exist (every scene has one once there are chapters) and come in chapter order; a shot with no scene
 * (or a deleted one) joins the scene of the shot before it; shots come in scene order. Empty scenes stay — an outline's
 * scenes have no shots until they are written. Mutates; returns whether anything changed.
 */
export function normalizeStory(story: StoryDoc): boolean {
  let changed = false
  if (!story.scenes?.length) {
    if (!story.shots.length) return false
    const { scenes, sceneIds } = deriveScenes(story)
    story.scenes = scenes
    story.shots.forEach((s, i) => (s.sceneId = sceneIds[i]))
    changed = true
  }
  const chapters = story.chapters ?? []
  const chapterIds = new Set(chapters.map((c) => c.id))
  let lastChapter = chapters[0]?.id
  for (const scene of story.scenes!) {
    if (scene.chapterId && !chapterIds.has(scene.chapterId)) {
      delete scene.chapterId
      changed = true
    }
    if (!chapters.length) continue
    if (!scene.chapterId) {
      scene.chapterId = lastChapter
      changed = true
    }
    lastChapter = scene.chapterId
  }
  if (chapters.length) {
    const rank = new Map(chapters.map((c, i) => [c.id, i]))
    const byChapter = (s: StoryScene) => rank.get(s.chapterId!) ?? 0
    if (!inOrder(story.scenes!, byChapter)) {
      story.scenes = [...story.scenes!].sort((a, b) => byChapter(a) - byChapter(b))
      changed = true
    }
  }
  const scenes = story.scenes!
  const known = new Set(scenes.map((s) => s.id))
  const firstKnown = story.shots.find((s) => s.sceneId && known.has(s.sceneId))?.sceneId ?? scenes[0]!.id
  let previous: string | undefined
  for (const shot of story.shots) {
    if (!shot.sceneId || !known.has(shot.sceneId)) {
      shot.sceneId = previous ?? firstKnown
      changed = true
    }
    previous = shot.sceneId
  }
  const rank = new Map(scenes.map((s, i) => [s.id, i]))
  const byScene = (s: StoryShot) => rank.get(s.sceneId!)!
  if (!inOrder(story.shots, byScene)) {
    story.shots = [...story.shots].sort((a, b) => byScene(a) - byScene(b))
    changed = true
  }
  return changed
}

/**
 * The story as it should be on load (stories from before scenes get them), or undefined when it already is — a copy:
 * the loaded document isn't touched.
 */
export function sanitizeStory(story: StoryDoc | undefined): StoryDoc | undefined {
  if (!story || !Array.isArray(story.shots)) return undefined
  const copy: StoryDoc = {
    ...story,
    shots: story.shots.map((s) => ({ ...s })),
    ...(story.scenes ? { scenes: story.scenes.map((s) => ({ ...s })) } : {}),
    ...(Array.isArray(story.characters) ? { characters: story.characters.map((c) => ({ ...c })) } : {}),
    ...(Array.isArray(story.places) ? { places: story.places.map((p) => ({ ...p })) } : {}),
  }
  const fixed = sanitizeFields(copy)
  return normalizeStory(copy) || fixed ? copy : undefined
}

const isText = (v: unknown): v is string => typeof v === 'string'

/** Quick picks as saved: group → a word, or several; anything else goes (undefined when nothing is left). */
export function cleanPicks(picks: unknown): Record<string, string | string[]> | undefined {
  if (!picks || typeof picks !== 'object' || Array.isArray(picks)) return undefined
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(picks as Record<string, unknown>)) {
    if (isText(value) && value.trim()) out[key] = value
    else if (Array.isArray(value)) {
      const words = value.filter((v): v is string => isText(v) && Boolean(v.trim()))
      if (words.length) out[key] = words
    }
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * The optional fields added since stories were first saved (picks, a shot's own light, a stale still, the script the
 * scenes were made from, the Story cut), dropped or trimmed to their shape when a file holds something else — so a
 * hand-edited or damaged project still opens. Mutates the copy; returns whether anything changed.
 */
function sanitizeFields(story: StoryDoc): boolean {
  let changed = false
  const drop = <T extends object>(x: T, key: keyof T) => {
    delete x[key]
    changed = true
  }
  if (story.outlinedFrom !== undefined && !isText(story.outlinedFrom)) drop(story, 'outlinedFrom')
  if (story.cutTimelineId !== undefined && !(isText(story.cutTimelineId) && story.cutTimelineId)) drop(story, 'cutTimelineId')
  if (story.cutSignature !== undefined && !isText(story.cutSignature)) drop(story, 'cutSignature')
  for (const x of [...(Array.isArray(story.characters) ? story.characters : []), ...(Array.isArray(story.places) ? story.places : [])]) {
    if (x.picks === undefined) continue
    const picks = cleanPicks(x.picks)
    if (!picks) drop(x, 'picks')
    else if (JSON.stringify(picks) !== JSON.stringify(x.picks)) {
      x.picks = picks
      changed = true
    }
  }
  for (const shot of story.shots) {
    if (shot.light !== undefined && !isText(shot.light)) drop(shot, 'light')
    if (shot.stillStale !== undefined && shot.stillStale !== true) drop(shot, 'stillStale')
  }
  return changed
}

// ---- edits

/** Where a scene's shots go in the list: after its last shot, or, while it has none, before the next scene's first. */
function sceneEnd(story: StoryDoc, sceneId: string): number {
  const rank = new Map((story.scenes ?? []).map((s, i) => [s.id, i]))
  const own = rank.get(sceneId) ?? Number.POSITIVE_INFINITY
  const after = story.shots.findIndex((s) => (rank.get(s.sceneId ?? '') ?? -1) > own)
  return after < 0 ? story.shots.length : after
}

/** Moves a shot into a scene (the list order is left to normalizeStory); a place it had from its old scene follows. */
function assignScene(story: StoryDoc, shot: StoryShot, scene: StoryScene) {
  const old = sceneOf(story, shot)
  shot.sceneId = scene.id
  shot.scene = scene.title
  if (!shot.placeId || shot.placeId === old?.placeId) {
    if (scene.placeId) shot.placeId = scene.placeId
    else delete shot.placeId
  }
}

/**
 * A new shot in a scene: after `afterId` — after its whole multi-shot group when it has one (as moveShot hops) — else
 * at the scene's end; it gets the scene's heading and place.
 */
export function insertShot(story: StoryDoc, sceneId: string, shot: StoryShot, afterId?: string): void {
  const scene = story.scenes?.find((s) => s.id === sceneId)
  if (!scene) return void story.shots.push(shot)
  shot.sceneId = scene.id
  shot.scene = scene.title
  if (!shot.placeId && scene.placeId) shot.placeId = scene.placeId
  // Inside a group the new shot would break it up, and the next edit that keeps only validGroups would drop it with
  // its takes, chosen take and final.
  const group = afterId ? validGroups(story).find((g) => g.shotIds.includes(afterId)) : undefined
  const lastId = group?.shotIds.at(-1) ?? afterId
  const after = lastId ? story.shots.findIndex((s) => s.id === lastId && s.sceneId === sceneId) : -1
  story.shots.splice(after >= 0 ? after + 1 : sceneEnd(story, sceneId), 0, shot)
}

/**
 * One step up or down. A shot at the edge of its scene moves into the neighbouring scene (to its end or start) rather
 * than past its shots; inside a scene it swaps places, hopping over a whole multi-shot group.
 */
export function moveShot(story: StoryDoc, shotId: string, delta: -1 | 1): void {
  const i = story.shots.findIndex((x) => x.id === shotId)
  const shot = story.shots[i]
  if (!shot) return
  const neighbour = story.shots[i + delta]
  const scenes = story.scenes ?? []
  if (scenes.length && neighbour?.sceneId !== shot.sceneId) {
    const k = scenes.findIndex((s) => s.id === shot.sceneId)
    const target = scenes[k + delta]
    if (k < 0 || !target) return
    assignScene(story, shot, target)
    normalizeStory(story)
    return
  }
  if (!neighbour) return
  let j = i + delta
  const group = validGroups(story).find((g) => g.shotIds.includes(neighbour.id))
  if (group) j = story.shots.findIndex((x) => x.id === group.shotIds[delta < 0 ? 0 : group.shotIds.length - 1])
  story.shots.splice(i, 1)
  story.shots.splice(j, 0, shot)
}

/** Sets the scene's place; its shots that had the scene's old place (or none) move with it. */
export function setScenePlace(story: StoryDoc, sceneId: string, placeId: string | undefined): void {
  const scene = story.scenes?.find((s) => s.id === sceneId)
  if (!scene) return
  const old = scene.placeId
  if (placeId) scene.placeId = placeId
  else delete scene.placeId
  for (const shot of shotsOfScene(story, sceneId)) {
    if (shot.placeId && shot.placeId !== old) continue
    if (placeId) shot.placeId = placeId
    else delete shot.placeId
  }
}

/**
 * A scene's shots replaced with new ones (rewritten by the Director), in the scene's place in the list; groups that
 * held the old shots go, `groups` (over the new shots) come in.
 */
export function replaceSceneShots(story: StoryDoc, sceneId: string, shots: StoryShot[], groups: StoryMultishot[] = []): void {
  const scene = story.scenes?.find((s) => s.id === sceneId)
  if (!scene) return
  const removed = new Set(shotsOfScene(story, sceneId).map((s) => s.id))
  story.shots = story.shots.filter((s) => !removed.has(s.id))
  story.multishots = [...(story.multishots ?? []).filter((g) => !g.shotIds.some((id) => removed.has(id))), ...groups]
  for (const shot of shots) {
    shot.sceneId = scene.id
    shot.scene = scene.title
    if (!shot.placeId && scene.placeId) shot.placeId = scene.placeId
  }
  story.shots.splice(sceneEnd(story, sceneId), 0, ...shots)
}

/**
 * Splits a scene before `shotId`: that shot and the ones after it in its scene become a new scene right after it,
 * with the same chapter and settings. Not at the scene's first shot, nor inside a multi-shot group. Returns the new
 * scene's id.
 */
export function splitSceneAt(story: StoryDoc, shotId: string, newId: () => string): string | undefined {
  const shot = story.shots.find((s) => s.id === shotId)
  const scene = shot && sceneOf(story, shot)
  if (!shot || !scene) return undefined
  const own = shotsOfScene(story, scene.id)
  const at = own.findIndex((s) => s.id === shotId)
  if (at <= 0) return undefined
  if (validGroups(story).some((g) => g.shotIds.includes(own[at - 1]!.id) && g.shotIds.includes(shotId))) return undefined
  const created: StoryScene = { ...scene, id: newId(), title: `${scene.title} (2)`, castIds: scene.castIds && [...scene.castIds] }
  delete created.script
  delete created.summary
  delete created.continuesPrevious
  story.scenes!.splice(story.scenes!.indexOf(scene) + 1, 0, created)
  for (const s of own.slice(at)) {
    s.sceneId = created.id
    s.scene = created.title
  }
  return created.id
}

/** Joins a scene into the one before it: its shots go to the end of that scene, and it is removed. */
export function mergeWithPrevious(story: StoryDoc, sceneId: string): boolean {
  const scenes = story.scenes ?? []
  const k = scenes.findIndex((s) => s.id === sceneId)
  const previous = scenes[k - 1]
  if (k <= 0 || !previous) return false
  for (const shot of shotsOfScene(story, sceneId)) {
    shot.sceneId = previous.id
    shot.scene = previous.title
  }
  const merged = scenes[k]!
  if (merged.script?.trim()) previous.script = [previous.script?.trim(), merged.script.trim()].filter(Boolean).join('\n\n')
  previous.castIds = [...new Set([...(previous.castIds ?? []), ...(merged.castIds ?? [])])]
  scenes.splice(k, 1)
  normalizeStory(story)
  return true
}

/** One step up or down; at the edge of its chapter a scene moves into the neighbouring chapter. */
export function moveScene(story: StoryDoc, sceneId: string, delta: -1 | 1): void {
  const scenes = story.scenes ?? []
  const k = scenes.findIndex((s) => s.id === sceneId)
  const scene = scenes[k]
  if (!scene) return
  const neighbour = scenes[k + delta]
  const chapters = story.chapters ?? []
  if (chapters.length && neighbour?.chapterId !== scene.chapterId) {
    const c = chapters.findIndex((x) => x.id === scene.chapterId)
    const target = chapters[c + delta]
    if (!target) return
    scene.chapterId = target.id
  } else if (neighbour) {
    scenes.splice(k, 1)
    scenes.splice(k + delta, 0, scene)
  } else {
    return
  }
  normalizeStory(story)
}

/** Removes a scene with its shots (and the groups over them). */
export function removeScene(story: StoryDoc, sceneId: string): void {
  const removed = new Set(shotsOfScene(story, sceneId).map((s) => s.id))
  story.shots = story.shots.filter((s) => !removed.has(s.id))
  story.multishots = (story.multishots ?? []).filter((g) => !g.shotIds.some((id) => removed.has(id)))
  story.scenes = (story.scenes ?? []).filter((s) => s.id !== sceneId)
}

/** Adds a scene after `afterId` (else at the end), in that scene's chapter (else the last chapter). */
export function addScene(story: StoryDoc, scene: StoryScene, afterId?: string): void {
  const scenes = (story.scenes ??= [])
  const after = afterId ? scenes.findIndex((s) => s.id === afterId) : -1
  const chapterId = scene.chapterId ?? (after >= 0 ? scenes[after]!.chapterId : story.chapters?.at(-1)?.id)
  if (chapterId) scene.chapterId = chapterId
  if (after >= 0) scenes.splice(after + 1, 0, scene)
  else scenes.push(scene)
  normalizeStory(story)
}

/** Removes a chapter; its scenes go to the chapter before it (else the one after). */
export function removeChapter(story: StoryDoc, chapterId: string): void {
  const chapters = story.chapters ?? []
  const c = chapters.findIndex((x) => x.id === chapterId)
  if (c < 0) return
  const heir = chapters[c - 1] ?? chapters[c + 1]
  for (const scene of story.scenes ?? []) {
    if (scene.chapterId !== chapterId) continue
    if (heir) scene.chapterId = heir.id
    else delete scene.chapterId
  }
  chapters.splice(c, 1)
  normalizeStory(story)
}

/** The chapter's scenes, in order. */
export const scenesOfChapter = (story: Scenes, chapterId: string | undefined): StoryScene[] =>
  (story.scenes ?? []).filter((s) => s.chapterId === chapterId)

export const chapterOf = (story: Pick<StoryDoc, 'chapters'>, scene: Pick<StoryScene, 'chapterId'>): StoryChapter | undefined =>
  scene.chapterId ? story.chapters?.find((c) => c.id === scene.chapterId) : undefined

// ---- cast and places by name (the Director names them)

export interface CastIn {
  name: string
  description: string
  voice?: string
}
export interface PlaceIn {
  name: string
  description: string
  blocking?: string
  light?: string
}

/** Adds the characters the story doesn't have yet (by name, any case); for ones it has, only fills what is empty. */
export function mergeCast(story: StoryDoc, cast: readonly CastIn[], newId: () => string): Map<string, StoryCharacter> {
  const byName = new Map(story.characters.map((c) => [c.name.toLowerCase(), c]))
  for (const c of cast) {
    const existing = byName.get(c.name.toLowerCase())
    if (existing) {
      if (!existing.description && c.description) existing.description = c.description
      if (!existing.voice?.trim() && c.voice?.trim()) existing.voice = c.voice.trim()
    } else {
      const created: StoryCharacter = { id: newId(), name: c.name, description: c.description, ...(c.voice?.trim() ? { voice: c.voice.trim() } : {}) }
      story.characters.push(created)
      byName.set(c.name.toLowerCase(), created)
    }
  }
  return byName
}

/** Likewise for places: what the user already wrote stays; gaps are filled. */
export function mergePlaces(story: StoryDoc, places: readonly PlaceIn[], newId: () => string): Map<string, StoryPlace> {
  const list = (story.places ??= [])
  const byName = new Map(list.map((p) => [p.name.toLowerCase(), p]))
  for (const p of places) {
    const existing = byName.get(p.name.toLowerCase())
    if (existing) {
      if (!existing.description && p.description) existing.description = p.description
      if (!existing.blocking && p.blocking) existing.blocking = p.blocking
      if (!existing.light && p.light) existing.light = p.light
    } else {
      const created: StoryPlace = { id: newId(), name: p.name, description: p.description, ...(p.blocking ? { blocking: p.blocking } : {}), ...(p.light ? { light: p.light } : {}) }
      list.push(created)
      byName.set(p.name.toLowerCase(), created)
    }
  }
  return byName
}

/**
 * The Director's outline as the story's structure: its cast and places merged in by name (what is set stays), its
 * chapters and scenes replacing the old ones — and the old shots with them (call inside an undoable update). The
 * film's title and logline come along.
 */
export function outlineToStory(story: StoryDoc, outline: Outline, newId: () => string): void {
  const cast = mergeCast(story, outline.characters, newId)
  const places = mergePlaces(story, outline.places, newId)
  if (outline.title && outline.title !== 'Untitled') story.title = outline.title
  if (outline.logline) story.logline = outline.logline
  story.chapters = []
  story.scenes = []
  story.shots = []
  story.multishots = []
  for (const c of outline.chapters) {
    const chapter: StoryChapter = { id: newId(), title: c.title, ...(c.summary ? { summary: c.summary } : {}) }
    story.chapters.push(chapter)
    for (const s of c.scenes) {
      const place = s.place ? places.get(s.place.toLowerCase()) : undefined
      const castIds = s.characters.map((n) => cast.get(n.toLowerCase())?.id).filter((id): id is string => Boolean(id))
      story.scenes.push({
        id: newId(),
        chapterId: chapter.id,
        title: s.heading,
        ...(s.summary ? { summary: s.summary } : {}),
        ...(s.script ? { script: s.script } : {}),
        ...(place ? { placeId: place.id } : {}),
        ...(s.time ? { time: s.time } : {}),
        // The scene's light only where it isn't the place's own.
        ...(s.light && s.light !== place?.light ? { light: s.light } : {}),
        ...(s.blocking && s.blocking !== place?.blocking ? { blocking: s.blocking } : {}),
        ...(castIds.length ? { castIds } : {}),
        ...(s.continuesPrevious ? { continuesPrevious: true } : {}),
      })
    }
  }
}

/**
 * Timeline markers for an assembled story, at the first shot of each: chapters ("1 · Arrival") when the story has
 * them, else its scenes ("2 · Roadside — dusk") when there are two or more. Scenes without shots get none.
 */
export function assemblyMarks(story: StoryDoc): { shotId: string; kind: 'chapter' | 'standard'; name: string }[] {
  const scenes = story.scenes ?? []
  const firstShot = (sceneIds: Set<string>) => story.shots.find((s) => s.sceneId && sceneIds.has(s.sceneId))?.id
  if (story.chapters?.length) {
    return story.chapters.flatMap((c, i) => {
      const shotId = firstShot(new Set(scenesOfChapter(story, c.id).map((s) => s.id)))
      return shotId ? [{ shotId, kind: 'chapter' as const, name: `${i + 1} · ${c.title}` }] : []
    })
  }
  if (scenes.length < 2) return []
  return scenes.flatMap((sc, i) => {
    const shotId = firstShot(new Set([sc.id]))
    return shotId ? [{ shotId, kind: 'standard' as const, name: `${i + 1} · ${sc.title}` }] : []
  })
}
