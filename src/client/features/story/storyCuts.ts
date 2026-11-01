import { flicksToSeconds } from '@shared/time/flicks'
import type { AssetDTO } from '@shared/types/assets'
import type { MultishotTakeCuts, StoryMultishot, StoryShot } from '@shared/types/story'
import { nanoid } from 'nanoid'
import { shallowReactive } from 'vue'
import { api, errorMessage } from '@/lib/api'
import { takePieces } from './assembly'
import { breakGroup, canJoinNext, joinNext, takeCuts } from './multishot'
import type { StoryCore } from './storyCore'

/**
 * Multi-shot groups and their takes' cuts: joining and breaking up groups, where a ready take really changes shot
 * (detected once per take), each shot's piece of it, and where the previous shot's take ends.
 */

/** Multi-shot takes whose cuts were (or are being) detected this session: detection runs once per take. */
const cutDetections = new Map<string, Promise<void>>()
/** What detection found, by take: written back without running ffmpeg again if an undo drops it from the doc. */
const detectedCuts = new Map<string, number[]>()
/** The ones not finished yet (for the "detecting…" note). */
const detectingCuts = shallowReactive(new Set<string>())
/** One detection at a time: opening a story with many old takes shouldn't start a dozen ffmpeg runs at once. */
let detectionQueue: Promise<void> = Promise.resolve()

/**
 * The scene score a frame must pass to count as a cut: at 0.3 a real cut of a group take (4.38 s) went unseen, and two
 * shots shared one piece. Extra cuts a lower threshold finds are matched away against the plan (takeCuts).
 */
export const CUT_THRESHOLD = 0.2
/** What detection ran at before CUT_THRESHOLD (takes saved then record none). */
const OLD_THRESHOLD = 0.3

/**
 * Whether a ready take's cuts still want detecting: never detected, or found fewer cuts than its shots have at a
 * threshold above CUT_THRESHOLD — a missed cut put two shots in one piece. Once per take at that threshold.
 */
export function wantsCutDetection(rec: MultishotTakeCuts | undefined, shots: number): boolean {
  if (!rec?.detected) return true
  return rec.detected.length < shots - 1 && (rec.threshold ?? OLD_THRESHOLD) > CUT_THRESHOLD
}

/**
 * `shotByShot`: the group renders shot by shot now (the video's groupShotByShot, looked up when asked — the video is
 * built on the cuts): a shot of it with a take of its own ends where that take ends.
 */
export function createCuts(core: StoryCore, groups: { shotByShot: (g: StoryMultishot) => boolean } = { shotByShot: () => false }) {
  const { story, update, fact, outputOf, maxShotsOf, modelForShot, groupOf, groupShots, chosenGroupVideo, chosenVideoOf, takeIdOf, shotNumber } = core

  // A group takes as many shots as one clip of its model does (a shot not in a group: its own model, for the new pair).
  const canJoin = (shot: StoryShot) => canJoinNext(story.value, shot.id, maxShotsOf(modelForShot(shot)))
  const joinWithNext = (shot: StoryShot) => {
    const maxShots = maxShotsOf(modelForShot(shot))
    update('Multi-shot', (s) => joinNext(s, shot.id, () => nanoid(8), maxShots))
  }
  const breakUp = (g: StoryMultishot) => update('Break up multi-shot', (s) => breakGroup(s, g.id))

  /** Where a ready take of the group changes shot (see takeCuts), and whether detection is still running. */
  function takeCutsOf(g: StoryMultishot, generationId: string) {
    const asset = outputOf(generationId)
    if (!asset?.durationFlicks) return undefined
    return { ...takeCuts(groupShots(g), flicksToSeconds(asset.durationFlicks), g.takes?.[generationId]), detecting: detectingCuts.has(generationId) }
  }

  /** Each shot's piece of the group's chosen take (see takePieces). */
  function groupSegments(g: StoryMultishot) {
    const take = chosenGroupVideo(g)
    if (!take?.durationFlicks) return undefined
    const seconds = flicksToSeconds(take.durationFlicks)
    const id = takeIdOf(g, take)
    return { asset: take, seconds, pieces: takePieces(groupShots(g), seconds, id ? g.takes?.[id] : undefined) }
  }

  /**
   * Finds where a ready group take really cuts (LTX doesn't keep to the planned times) and saves it on the group, once
   * per take. A failure leaves the planned cuts in use.
   */
  function detectTakeCuts(g: StoryMultishot, generationId: string): Promise<void> {
    const asset = outputOf(generationId)
    if (!asset || !wantsCutDetection(g.takes?.[generationId], g.shotIds.length)) return Promise.resolve()
    const saveDetected = (detected: number[]) =>
      fact((s) => {
        const x = s.multishots?.find((m) => m.id === g.id)
        if (!x) return
        x.takes ??= {}
        x.takes[generationId] = { ...(x.takes[generationId] ?? { planned: [] }), detected, threshold: CUT_THRESHOLD }
      })
    const cached = detectedCuts.get(generationId)
    if (cached) {
      saveDetected(cached)
      return Promise.resolve()
    }
    const known = cutDetections.get(generationId)
    if (known) return known
    detectingCuts.add(generationId)
    const run = detectionQueue.then(async () => {
      try {
        // No expected cuts: the raw detection, matched to the plan here (see takeCuts).
        const res = await api.assets.sceneCuts(asset.id, { expected: [], threshold: CUT_THRESHOLD })
        const detected = res.detected ?? []
        detectedCuts.set(generationId, detected)
        saveDetected(detected)
      } catch (err) {
        console.warn(`[story] cut detection failed for take ${generationId}: ${errorMessage(err)}`)
      } finally {
        detectingCuts.delete(generationId)
      }
    })
    detectionQueue = run
    cutDetections.set(generationId, run)
    return run
  }

  /**
   * The previous shot's last frame: the end of its chosen take, or of its piece of a multi-shot take — its own take's
   * when the group renders shot by shot now, as the film is assembled (planAssembly).
   */
  function previousEnd(shot: StoryShot): { asset: AssetDTO; seconds: number } | undefined {
    const prev = story.value.shots[shotNumber(shot) - 2]
    if (!prev) return undefined
    const inGroup = groupOf(prev)
    const group = inGroup && !(groups.shotByShot(inGroup) && chosenVideoOf(prev)) ? inGroup : undefined
    const segments = group ? groupSegments(group) : undefined
    const piece = segments?.pieces.find((p) => p.shotId === prev.id)
    if (segments && piece) {
      // Two frames before a cut: a detected cut can be a frame late, and the next shot must not leak in.
      const frame = 1 / (segments.asset.fps || 24)
      const back = piece.end >= segments.seconds - 1e-3 ? frame : 2 * frame
      return { asset: segments.asset, seconds: Math.max(piece.start, piece.end - back) }
    }
    const video = chosenVideoOf(prev)
    if (!video?.durationFlicks) return undefined
    return { asset: video, seconds: Math.max(0, flicksToSeconds(video.durationFlicks) - 1 / (video.fps || 24)) }
  }

  /** The group's ready take still wants its cuts detected (wantsCutDetection). */
  const cutsWanted = (g: StoryMultishot, generationId: string) => wantsCutDetection(g.takes?.[generationId], g.shotIds.length)

  return { canJoin, joinWithNext, breakUp, takeCutsOf, groupSegments, detectTakeCuts, cutsWanted, previousEnd }
}

export type StoryCuts = ReturnType<typeof createCuts>
