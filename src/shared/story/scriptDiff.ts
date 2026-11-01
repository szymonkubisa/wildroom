import type { StoryLine, StoryScene, StoryShot } from '../types/story'

/**
 * Update scenes, pure: which scenes' parts of the script changed since their shots were written, and how a scene's
 * rewritten shots take over what the old ones had. The script is cut the way the outline cut it (the server's
 * sliceScript): the first scene from the top, every other one from its opening words, each to where the next starts.
 */

/** A screenplay scene heading line: INT. / EXT. / INT./EXT. / I/E. and the rest (the server's SCENE_HEADING). */
const SCENE_HEADING = /^\s*(?:INT\.?\s*\/\s*EXT\.?|EXT\.?\s*\/\s*INT\.?|I\/E\.?|INT\.|EXT\.)\s*(.+)$/i
/** A Polish one, in capitals only (the server's SCENE_HEADING_PL). */
const SCENE_HEADING_PL = /^\s*(?:(?:WN|WEW)\.?\s*\/\s*(?:PL|ZEW)\.?|(?:PL|ZEW)\.?\s*\/\s*(?:WN|WEW)\.?|WN\.|WEW\.|PL\.|ZEW\.)\s*(.+)$/
export const isSceneHeading = (line: string) => SCENE_HEADING.test(line) || SCENE_HEADING_PL.test(line)

/** Lower case, one space between words, plain quotes and dashes — with where each character came from in `text`. */
function searchable(text: string): { text: string; at: number[] } {
  let out = ''
  const at: number[] = []
  for (let i = 0; i < text.length; i++) {
    let ch = text[i]!
    if (/\s/.test(ch)) {
      if (!out || out.endsWith(' ')) continue
      ch = ' '
    } else {
      ch = ch.toLowerCase().replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[–—]/g, '-')
    }
    out += ch
    at.push(i)
  }
  return { text: out, at }
}

/** The same text but for spacing, case, curly quotes and dashes. */
export const sameText = (a: string | undefined, b: string | undefined) => searchable(a ?? '').text.trim() === searchable(b ?? '').text.trim()

const headingsOf = (text: string) =>
  text
    .split('\n')
    .filter(isSceneHeading)
    .map((l) => l.trim())

export interface SceneChange {
  sceneId: string
  /** The scene's part of the script now. */
  script: string
}

export interface ScriptDiff {
  /** Scenes whose part of the script differs from what their shots were written from, with the part as it is now. */
  changed: SceneChange[]
  unchanged: string[]
  /** Scenes with no part of the script (added by hand, or from before scenes kept theirs): nothing to compare. */
  notCompared: string[]
  /** Scene headings new in a scene's part: a scene the outline doesn't have, written into that scene's shots. */
  newHeadings: { sceneId: string; heading: string }[]
  /** Why the scenes can't be matched to the script any more (a scene's opening was deleted or rewritten). */
  problem?: string
}

/**
 * Compares the script with the parts its scenes were written from (StoryScene.script): each scene's part now runs from
 * its opening words — found in order, as the outline cut them — to the next scene's. A scene whose opening is gone
 * can't be placed, and then nothing is: the whole outline has to be made again.
 */
export function diffScript(script: string, scenes: readonly Pick<StoryScene, 'id' | 'title' | 'script'>[]): ScriptDiff {
  const compared = scenes.filter((x) => x.script?.trim())
  const notCompared = scenes.filter((x) => !x.script?.trim()).map((x) => x.id)
  const empty: ScriptDiff = { changed: [], unchanged: [], notCompared, newHeadings: [] }
  if (!compared.length) return { ...empty, problem: 'These scenes weren’t made from the script' }
  const hay = searchable(script)
  const starts: number[] = []
  let from = 0
  for (const [k, scene] of compared.entries()) {
    const words = searchable(scene.script!).text.trim().split(' ')
    const found = [words.slice(0, 10).join(' '), words.slice(0, 5).join(' ')]
      .filter((needle) => needle.length >= 8 || needle === words.join(' '))
      .map((needle) => hay.text.indexOf(needle, from))
      .find((i) => i >= 0)
    // The first scene starts the script (whatever comes before its opening is its own), as the outline cut it.
    if (k === 0) {
      from = (found ?? 0) + 1
      starts.push(0)
      continue
    }
    if (found === undefined) {
      const n = scenes.findIndex((x) => x.id === scene.id) + 1
      return { ...empty, problem: `Scene ${n}’s opening (“${words.slice(0, 6).join(' ')}…”) isn’t in the script any more` }
    }
    from = found + 1
    // An opening below its scene heading: the heading belongs to this scene.
    let start = hay.at[found]!
    const before = script.slice(0, start).replace(/\s+$/, '')
    const lineStart = before.lastIndexOf('\n') + 1
    if (isSceneHeading(before.slice(lineStart)) && lineStart > (starts.at(-1) ?? -1)) start = lineStart
    starts.push(start)
  }
  const out: ScriptDiff = { ...empty }
  compared.forEach((scene, k) => {
    const part = script.slice(starts[k], starts[k + 1] ?? script.length).trim()
    if (sameText(part, scene.script)) return void out.unchanged.push(scene.id)
    out.changed.push({ sceneId: scene.id, script: part })
    const had = new Set(headingsOf(scene.script!).map((h) => searchable(h).text))
    for (const heading of headingsOf(part)) if (!had.has(searchable(heading).text)) out.newHeadings.push({ sceneId: scene.id, heading })
  })
  return out
}

// ---- the rewritten shots

/** Words of a shot's action (what happens, and the prompt), for telling the same shot from another. */
const actionWords = (shot: Pick<StoryShot, 'description' | 'prompt'>) =>
  new Set((`${shot.description} ${shot.prompt}`.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)))
const STOP = new Set(['the', 'and', 'his', 'her', 'their', 'with', 'from', 'into', 'onto', 'then', 'that', 'this', 'for', 'are', 'was', 'its', 'they', 'them', 'him', 'she', 'one', 'shot'])

/** How alike two shots' actions are (0–1): the words they share, of all their words. */
export function actionLikeness(a: Pick<StoryShot, 'description' | 'prompt'>, b: Pick<StoryShot, 'description' | 'prompt'>): number {
  const x = actionWords(a)
  const y = actionWords(b)
  if (!x.size && !y.size) return 1
  const shared = [...x].filter((w) => y.has(w)).length
  return shared / (x.size + y.size - shared)
}

/** At least this alike: the same shot written again (it takes over the old one's still and takes). */
const SAME_SHOT = 0.3
/** …and this alike, with the same cast: the same action, kept as it was. */
const SAME_ACTION = 0.8

const sameCast = (a: StoryShot, b: StoryShot) => a.characterIds.length === b.characterIds.length && a.characterIds.every((id) => b.characterIds.includes(id))

export interface ShotMerge {
  /** The scene's shots: the written ones, with what the old ones they replace had. */
  shots: StoryShot[]
  /** Old shots whose action didn't change: kept, with the new lines and sound. */
  kept: number
  /** Old shots written again: the new text, with the old still (marked stale, "Still · redo") and takes. */
  rewritten: number
  /** Shots that are new. */
  added: number
  /** Old shots with no counterpart: gone (Undo brings them back; their pictures and clips stay in the Library). */
  dropped: number
}

/** The new lines, keeping an old line's voice where the same character says the same words. */
function carryLines(old: StoryShot, lines: StoryLine[]): StoryLine[] {
  const pool = [...old.dialogue]
  return lines.map((line) => {
    const k = pool.findIndex((l) => l.characterId === line.characterId && sameText(l.text, line.text))
    return k >= 0 ? pool.splice(k, 1)[0]! : line
  })
}

/** What a shot has made, and what only the user sets: it goes over to the shot that replaces it. */
function carryMedia(old: StoryShot, written: StoryShot): StoryShot {
  const out: StoryShot = { ...written, id: old.id, dialogue: carryLines(old, written.dialogue) }
  const keep = ['keyframeGenerationId', 'keyframeAssetId', 'keyframeHistory', 'videoGenerationIds', 'chosenAssetId', 'finalGenerationId', 'takes', 'modelId', 'continues', 'light', 'blocking', 'voiceTrack'] as const
  for (const key of keep) if (old[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = old[key]
  // The end picture is the old end's: kept only while the end is described the same.
  if (old.endFrame && sameText(old.endFrame, written.endFrame)) {
    for (const key of ['endKeyframeGenerationId', 'endKeyframeAssetId', 'endCheck', 'endUse'] as const) if (old[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = old[key]
  }
  if (old.keyframeAssetId || old.keyframeGenerationId) out.stillStale = true
  return out
}

/**
 * The scene's rewritten shots matched to its old ones, in order: each written shot takes the most alike old shot still
 * left after the last one taken. The same action with the same cast keeps the old shot (its still is still right) with
 * the new lines and sound; another match takes the new text and the old shot's still — marked stale — and takes; the
 * rest are new, and old shots nobody took go.
 */
export function mergeRewrittenShots(old: readonly StoryShot[], written: readonly StoryShot[]): ShotMerge {
  const out: ShotMerge = { shots: [], kept: 0, rewritten: 0, added: 0, dropped: 0 }
  const used = new Set<number>()
  let after = 0
  for (const shot of written) {
    let best = -1
    let score = 0
    for (let j = after; j < old.length; j++) {
      const s = actionLikeness(old[j]!, shot)
      if (s > score) {
        best = j
        score = s
      }
    }
    const match = best >= 0 && (score >= SAME_SHOT || sameText(old[best]!.description, shot.description)) ? old[best]! : undefined
    if (!match) {
      out.shots.push(shot)
      out.added++
      continue
    }
    used.add(best)
    after = best + 1
    if (sameCast(match, shot) && (score >= SAME_ACTION || sameText(match.description, shot.description))) {
      out.shots.push({ ...match, dialogue: carryLines(match, shot.dialogue), ...(shot.sfx ? { sfx: shot.sfx } : {}) })
      out.kept++
    } else {
      out.shots.push(carryMedia(match, shot))
      out.rewritten++
    }
  }
  out.dropped = old.length - used.size
  return out
}
