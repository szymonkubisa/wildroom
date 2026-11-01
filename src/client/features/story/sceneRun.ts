import { validGroups } from '@shared/story/structure'
import type { StoryDoc, StoryMultishot, StoryShot } from '@shared/types/story'

/**
 * "Animate scene", pure: what a scene renders as (its shots and multi-shot groups, in order) and which of them start
 * at once and which wait. The queue renders in the order jobs are made, so the scene's first shot comes back first; only
 * a continuing shot (StoryShot.continues) waits — for the take it starts from.
 */

/** One render of a scene: a shot of its own, or a multi-shot group (one clip). */
export interface RunUnit {
  id: string
  shot?: StoryShot
  group?: StoryMultishot
  /** The unit's first shot. */
  first: StoryShot
  /** Starts from the previous shot's take, so it waits for it. */
  continues: boolean
  /**
   * A group that renders shot by shot now but already has its one clip (an older take, chosen and ready): that clip
   * covers its shots, so there is nothing to render — a shot's own Animate still makes a take of it.
   */
  covered?: boolean
}

export function sceneUnits(
  story: StoryDoc,
  sceneId: string,
  shotByShot: (g: StoryMultishot) => boolean = () => false,
  covered: (g: StoryMultishot) => boolean = () => false,
): RunUnit[] {
  // A group rendered shot by shot (on LTX, or its later shots have keyframes of their own) is its shots, each a render
  // — unless a clip of it already covers them.
  const groups = validGroups(story).filter((g) => !shotByShot(g) || covered(g))
  const units: RunUnit[] = []
  const seen = new Set<string>()
  for (const shot of story.shots) {
    if (shot.sceneId !== sceneId) continue
    const group = groups.find((g) => g.shotIds.includes(shot.id))
    if (group) {
      if (!seen.has(group.id)) units.push({ id: group.id, group, first: shot, continues: false, ...(shotByShot(group) ? { covered: true } : {}) })
      seen.add(group.id)
      continue
    }
    units.push({ id: shot.id, shot, first: shot, continues: continuing(story, shot) })
  }
  return units
}

/** Why the shot can't continue from the one before it (undefined: it can). */
export function continuesBlocker(story: StoryDoc, shot: StoryShot): string | undefined {
  const i = story.shots.findIndex((x) => x.id === shot.id)
  const prev = story.shots[i - 1]
  if (!prev) return 'The first shot has nothing to continue from'
  if (prev.sceneId !== shot.sceneId) return 'The shot before it is in another scene — a new scene starts with a cut'
  if (validGroups(story).some((g) => g.shotIds.includes(shot.id))) return 'A shot in a multi-shot is part of one clip already'
  return undefined
}

/** The shot continues the one before (StoryShot.continues) and can: its takes start where that shot's take ends. */
export const continuing = (story: StoryDoc, shot: StoryShot): boolean => Boolean(shot.continues) && !continuesBlocker(story, shot)

/**
 * The run: units with nothing to do (`busy`: a take already done or rendering; `covered` by a group's clip) are
 * skipped — so pressing it again after a reload just picks up what is left — the rest start now, except continuing
 * ones, which wait.
 */
export function planSceneRun(units: readonly RunUnit[], busy: (unit: RunUnit) => boolean): { now: RunUnit[]; waiting: RunUnit[] } {
  const now: RunUnit[] = []
  const waiting: RunUnit[] = []
  for (const unit of units) {
    if (unit.covered || busy(unit)) continue
    ;(unit.continues ? waiting : now).push(unit)
  }
  return { now, waiting }
}
