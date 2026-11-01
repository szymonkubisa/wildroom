import { getModel } from '@shared/models/registry'
import type { ParamValues } from '@shared/models/types'
import { flicksToSeconds } from '@shared/time/flicks'
import type { AssetDTO } from '@shared/types/assets'
import type { StoryLine, StoryShot } from '@shared/types/story'
import { nanoid } from 'nanoid'
import { toast } from 'vue-sonner'
import { ApiRequestError, api, errorMessage } from '@/lib/api'
import { animaticSeconds, tempVoiceFresh, timingChanges } from './animatic'
import { type AssemblyOptions, cutEdited, layOutStoryCut, planAssembly } from './assembly'
import { lineSeconds } from './dialogueFit'
import { speaksAudio } from './soundtrack'
import type { StoryCore } from './storyCore'
import type { StoryCuts } from './storyCuts'
import type { StoryVideo } from './storyVideo'

/**
 * The story onto its own timeline, the Story cut: its chosen takes (else stills, else title cards) with their lines,
 * or the animatic — laid out again as a whole each time, never added to whatever timeline is open.
 */
export function createAssemble(core: StoryCore, cuts: StoryCuts, video: Pick<StoryVideo, 'groupShotByShot'>) {
  const { story, update, fact, outputOf, keyframeOf, chosenVideoOf, chosenGroupVideo, takeModelId, groups, groupOf, takeIdOf } = core
  const { project, assets, jobs } = core.stores
  const { detectTakeCuts } = cuts
  const { groupShotByShot } = video

  // ---- assemble
  /**
   * Lays the shots out on the Story cut as one undo step (see planAssembly, layOutStoryCut): the chosen takes, else the
   * keyframe stills, else title cards, with the lines connected under each shot. The cut is made the first time and
   * replaced after that — Undo puts the cut before back; the project's other timelines are never touched.
   */
  async function layOut(opts: AssemblyOptions & { label: string }): Promise<{ count: number; missing: number; seconds: number } | undefined> {
    if (!story.value.shots.length) {
      toast.warning('No shots to put on the timeline')
      return undefined
    }
    // Chosen group takes whose real cuts aren't known yet (normally found as soon as the take is ready).
    await Promise.all(
      groups.value.map((g) => {
        const take = chosenGroupVideo(g)
        const id = take && takeIdOf(g, take)
        return id ? detectTakeCuts(g, id) : undefined
      }),
    )
    const s = story.value
    const ctx = project.opContext()
    const plan = planAssembly(
      s,
      {
        fps: project.doc.settings.fps,
        media: ctx.media,
        newId: ctx.newId,
        groupTake: (g) => {
          const take = chosenGroupVideo(g)
          return take && { asset: take, generationId: takeIdOf(g, take) }
        },
        shotMedia: (shot) => chosenVideoOf(shot) ?? keyframeOf(shot),
        separate: groupShotByShot,
        shotTake: chosenVideoOf,
      },
      opts,
    )
    project.apply(layOutStoryCut(plan, s.cutTimelineId ?? nanoid(10)), opts.label)
    const frames = project.doc.spine.reduce((n, item) => n + item.duration, 0)
    return { count: s.shots.length, missing: plan.missing, seconds: frames / project.doc.settings.fps }
  }

  /** The Story cut was edited by hand since it was last laid out: laying it out again replaces those edits. */
  const storyCutEdited = () => cutEdited(project.doc)

  /**
   * The take the shot is assembled from (its group's chosen take, else its own — its own first when the group renders
   * shot by shot, as planAssembly lays it) already has the lines in its sound: made to the shot's voice track, or by a
   * model that voiced them itself (LTX, Kling with sound…) — ElevenLabs lines laid under it would say everything twice
   * (voiced for an LTX dialogue shot, then rendered with Kling).
   */
  const takeHoldsLines = (shot: StoryShot) => {
    const g = groupOf(shot)
    const groupTake = g && !(groupShotByShot(g) && chosenVideoOf(shot)) ? chosenGroupVideo(g) : undefined
    const take = groupTake ?? chosenVideoOf(shot)
    const gid = take && (groupTake ? takeIdOf(g!, take) : take.generation?.generationId)
    if (!take || !gid) return false
    if (!groupTake && shot.takes?.[gid]?.voiceTrackAssetId) return true
    const model = getModel(takeModelId(gid) ?? '')
    const params = (jobs.byId[gid]?.params ?? take.generation?.params ?? {}) as ParamValues
    return Boolean(model && speaksAudio(model, params))
  }
  const voicedLines = (shot: StoryShot) =>
    takeHoldsLines(shot) ? [] : shot.dialogue.map((l) => outputOf(l.generationId)).filter((a): a is AssetDTO => Boolean(a))

  /** Update timeline: the story's chosen takes (else stills) on the Story cut, replacing what it held. */
  async function assemble(): Promise<{ count: number; missing: number; seconds: number } | undefined> {
    const done = await layOut({ lines: voicedLines, label: 'Update timeline' })
    if (!done) return undefined
    toast.success(`Story cut updated · ${done.count} shot${done.count === 1 ? '' : 's'}, ${Math.round(done.seconds)} s`, {
      description: done.missing
        ? `${done.missing} shot${done.missing === 1 ? ' has' : 's have'} no still or take yet: ${done.missing === 1 ? 'it is a title card' : 'they are title cards'}. Undo puts the cut before back.`
        : 'Undo puts the cut before back; your other timelines aren’t touched.',
    })
    return done
  }

  // ---- animatic: the cut with free temp voices, to see the pacing before paying for anything
  const assetExists = (id: string) => Boolean(assets.get(id))
  const spokenLines = (shot: StoryShot) => shot.dialogue.filter((l) => l.text.trim())
  /** The audio an animatic line uses: the real (ElevenLabs) line when there is one, else its temp voice. */
  const animaticAudio = (line: StoryLine) => outputOf(line.generationId) ?? (tempVoiceFresh(line, assetExists) ? assets.get(line.tempVoice!.assetId) : undefined)

  /** Lines that still need a temp voice (no real audio, no temp voice that still says the line). */
  const linesToVoice = () =>
    story.value.shots.flatMap((shot) => spokenLines(shot).filter((l) => !outputOf(l.generationId) && !tempVoiceFresh(l, assetExists)).map((line) => ({ shot, line })))

  /**
   * Makes the missing temp voices one by one (macOS `say`, free) and caches each on its line. Stops early when the
   * server can't make temp voices at all (`unavailable`).
   */
  async function voiceAnimatic(onProgress: (done: number, total: number) => void): Promise<{ made: number; failed: number; unavailable?: string }> {
    const todo = linesToVoice()
    let made = 0
    let failed = 0
    onProgress(0, todo.length)
    for (const [i, { shot, line }] of todo.entries()) {
      try {
        const asset = await api.tempVoice.create(project.id!, { text: line.text })
        assets.upsert(asset)
        const seconds = asset.durationFlicks ? Math.round(flicksToSeconds(asset.durationFlicks) * 100) / 100 : undefined
        fact((s) => {
          const l = s.shots.find((x) => x.id === shot.id)?.dialogue.find((x) => x.id === line.id)
          if (l) l.tempVoice = { assetId: asset.id, text: line.text, ...(seconds ? { seconds } : {}) }
        })
        made++
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 501) return { made, failed, unavailable: err.message }
        failed++
        console.warn(`[story] temp voice failed: ${errorMessage(err)}`)
      }
      onProgress(i + 1, todo.length)
    }
    return { made, failed }
  }

  /** Seconds of one line in the animatic: its audio's length, else a speaking-time estimate. */
  function animaticLineSeconds(line: StoryLine): number {
    const audio = animaticAudio(line)
    if (audio?.durationFlicks) return flicksToSeconds(audio.durationFlicks)
    if (line.tempVoice?.seconds && tempVoiceFresh(line, assetExists)) return line.tempVoice.seconds
    return Math.max(0.5, lineSeconds(line.text))
  }

  /** Each shot's animatic length (see animaticSeconds). */
  const animaticTiming = () => new Map(story.value.shots.map((shot) => [shot.id, animaticSeconds(shot.duration, spokenLines(shot).map(animaticLineSeconds))]))

  /** Puts the animatic on the Story cut (replacing it); returns the shots whose length it changed (to offer applying them). */
  async function assembleAnimatic(): Promise<{ id: string; seconds: number }[] | undefined> {
    const timing = animaticTiming()
    // No temp music: it would be a paid generation. A free temp track could be laid under the spine here later.
    const done = await layOut({
      seconds: (shot) => timing.get(shot.id) ?? shot.duration,
      lines: (shot) => spokenLines(shot).map(animaticAudio).filter((a): a is AssetDTO => Boolean(a)),
      label: 'Animatic on the Story cut',
    })
    if (!done) return undefined
    return timingChanges(story.value.shots, timing)
  }

  /** Gives the shots their animatic lengths, in one undoable step. */
  function applyTiming(changes: { id: string; seconds: number }[]) {
    const byId = new Map(changes.map((c) => [c.id, c.seconds]))
    update('Apply animatic timing', (s) => {
      for (const shot of s.shots) {
        const seconds = byId.get(shot.id)
        if (seconds !== undefined) shot.duration = seconds
      }
    })
  }

  return { assemble, storyCutEdited, linesToVoice, voiceAnimatic, assembleAnimatic, applyTiming }
}
