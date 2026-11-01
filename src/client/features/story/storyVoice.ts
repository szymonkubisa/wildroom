import { fitParams } from '@shared/models/fit'
import { getModel } from '@shared/models/registry'
import { flicksToSeconds } from '@shared/time/flicks'
import type { StoryShot } from '@shared/types/story'
import { shallowReactive } from 'vue'
import { toast } from 'vue-sonner'
import { api, errorMessage } from '@/lib/api'
import { titleCase } from './cast'
import { maxClipSeconds } from './multishot'
import * as planning from './planning'
import type { StoryCore } from './storyCore'
import type { Planned, StoryRunner } from './storyRunner'
import { voiceSampleBed, voiceSampleText } from './voiceSample'
import { type VoiceTrackPlan, pcm16Wav, planVoiceTrack, renderVoiceTrack } from './voiceTrack'

/**
 * Voices: the characters' voice samples for LTX, the ElevenLabs lines, and dialogue shots made to their lines (LTX's
 * audio to follow) — their voice track planned, made and kept on the shot.
 */

/** Characters whose voice sample is being made (the Cast's button). */
const makingVoiceSamples = shallowReactive(new Set<string>())

export function createVoice(core: StoryCore, runner: StoryRunner) {
  const { story, update, updateShot, fact, usable, modelFor, modelForShot, outputOf, characterName, shotNumber } = core
  const { project, assets, jobs } = core.stores
  const { startJob, settled, run } = runner

  /**
   * Makes the character's voice sample for LTX (Audio 1/2 of Licon's references): their ElevenLabs voice saying their
   * own words (voiceSampleText) over a quiet bed of the scene's sound with soft music (voiceSampleBed, ElevenLabs SFX),
   * mixed to one ≤ 6 s WAV on the server, then set as the character's sample.
   */
  async function makeVoiceSample(characterId: string): Promise<void> {
    const c = story.value.characters.find((x) => x.id === characterId)
    if (!c || makingVoiceSamples.has(characterId)) return
    const name = titleCase(c.name)
    // Eleven v4 when it can render, whatever the story's line voices use; else the story's voice model.
    const speech = [getModel('eleven-v4-tts')].find(usable) ?? modelFor('speech')
    if (!speech) return void toast.warning('No voice model available — add an ElevenLabs key in Settings → Providers')
    if (speech.provider !== 'mock' && !c.voiceId) return void toast.warning(`Pick a voice for ${name} first`)
    const bedModel = ['eleven-sfx', 'mock-sfx'].map((id) => getModel(id)).find(usable)
    makingVoiceSamples.add(characterId)
    try {
      const speechJob = await startJob(speech, fitParams(speech, { text: voiceSampleText(story.value, c), voiceId: c.voiceId }))
      const bedJob = bedModel
        ? await startJob(bedModel, fitParams(bedModel, { prompt: voiceSampleBed(story.value, c), autoDuration: false, durationSeconds: 6 })).catch(() => undefined)
        : undefined
      await settled(bedJob ? [speechJob, bedJob] : [speechJob])
      const spoken = outputOf(speechJob)
      if (!spoken) throw new Error(jobs.byId[speechJob]?.error?.message ?? 'The voice render did not finish')
      await assets.whenReady(spoken.id)
      // The bed is a nicety: without it the sample is the voice alone.
      const bed = bedJob && outputOf(bedJob) ? await assets.whenReady(outputOf(bedJob)!.id).catch(() => undefined) : undefined
      const sample = await api.assets.voiceSample(project.id!, { speechAssetId: spoken.id, bedAssetId: bed?.id, name: `${name} — voice sample` })
      assets.upsert(sample)
      update('Voice sample', (s) => {
        const x = s.characters.find((y) => y.id === characterId)
        if (x) x.voiceSampleAssetId = sample.id
      })
      toast.success(`Voice sample for ${name} ready`, { description: bed ? undefined : 'Without a sound bed (no sound-effects model available)' })
    } catch (err) {
      toast.error(`Voice sample for ${name} failed`, { description: errorMessage(err) })
    } finally {
      makingVoiceSamples.delete(characterId)
    }
  }

  const makingVoiceSample = (characterId: string) => makingVoiceSamples.has(characterId)

  // ---- dialogue shots made to their ElevenLabs lines (LTX's audio to follow)

  /** The shot's model makes it to its recorded lines (see planning.followsVoices). */
  const followsVoices = (shot: StoryShot, model = modelForShot(shot)) => planning.followsVoices(story.value, shot, model)

  /** Where the shot's voiced lines go in its voice track; undefined while a spoken line has no ElevenLabs audio. */
  function voiceTrackPlan(shot: StoryShot): VoiceTrackPlan | undefined {
    const voiced = shot.dialogue.filter((l) => l.text.trim()).map((l) => outputOf(l.generationId))
    if (!voiced.length || voiced.some((a) => !a?.durationFlicks)) return undefined
    const model = modelForShot(shot)
    return planVoiceTrack(
      voiced.map((a) => ({ assetId: a!.id, seconds: flicksToSeconds(a!.durationFlicks!) })),
      shot.duration,
      model ? maxClipSeconds(model) : 10,
    )
  }

  /** The shot's voice track, when it was made from its current lines and length and is ready. */
  function voiceTrackOf(shot: StoryShot): { id: string; seconds: number } | undefined {
    const track = shot.voiceTrack
    if (!track || assets.get(track.assetId)?.status !== 'ready') return undefined
    const plan = voiceTrackPlan(shot)
    return plan?.key === track.key ? { id: track.assetId, seconds: plan.seconds } : undefined
  }

  /**
   * Gets a dialogue shot ready to be made to its lines: voices those without ElevenLabs audio yet (and waits for them),
   * mixes them into one track as long as the shot and keeps it on the shot — lengthening the shot when the lines need
   * more. False when that can't be done: the take is then rendered with LTX voicing the lines itself.
   */
  async function prepareVoiceTrack(shotId: string): Promise<boolean> {
    const current = () => story.value.shots.find((x) => x.id === shotId)
    const first = current()
    if (!first) return false
    const n = shotNumber(first)
    const voicing = (gid?: string) => Boolean(gid && jobs.byId[gid] && !jobs.isTerminal(jobs.byId[gid]!))
    const todo = first.dialogue.filter((l) => l.text.trim() && !outputOf(l.generationId) && !voicing(l.generationId))
    if (todo.length) await run(planLines({ ...first, dialogue: todo }))
    const voiced = current()
    if (!voiced) return false
    await settled(voiced.dialogue.flatMap((l) => (l.text.trim() && l.generationId ? [l.generationId] : [])))
    const shot = current()
    if (!shot) return false
    const plan = voiceTrackPlan(shot)
    if (!plan) {
      toast.warning(`Shot ${n}: a line has no ElevenLabs audio`, { description: 'LTX speaks the lines itself in this take.' })
      return false
    }
    if (!plan.fits) {
      toast.warning(`Shot ${n}: its lines need more than one clip`, { description: 'Split the shot — LTX speaks the lines itself in this take.' })
      return false
    }
    if (voiceTrackOf(shot)) return true
    try {
      await Promise.all(plan.placements.map((p) => assets.whenReady(p.assetId)))
      const file = new File([pcm16Wav(await renderVoiceTrack(plan))], `Shot ${n} voice track.wav`, { type: 'audio/wav' })
      const asset = await api.assets.upload(project.id!, file, undefined, { parentIds: [...new Set(plan.placements.map((p) => p.assetId))], label: `Shot ${n} · voice track` })
      assets.upsert(asset)
      await assets.whenReady(asset.id)
      fact((s) => {
        const x = s.shots.find((y) => y.id === shotId)
        if (!x) return
        x.voiceTrack = { assetId: asset.id, key: plan.key }
        if (plan.seconds > x.duration) x.duration = plan.seconds
      })
      return true
    } catch (err) {
      toast.error(`Shot ${n}: couldn’t make the voice track`, { description: `${errorMessage(err)} — LTX speaks the lines itself in this take.` })
      return false
    }
  }

  function planLines(shot: StoryShot): (Planned | string)[] {
    const model = modelFor('speech')
    if (!model) return ['No voice model available — add an ElevenLabs key or enable demo mode']
    return shot.dialogue
      .filter((line) => line.text.trim())
      .map((line) => {
        const voiceId = story.value.characters.find((c) => c.id === line.characterId)?.voiceId
        if (model.provider !== 'mock' && !voiceId) return `Pick a voice for ${characterName(line.characterId) ?? 'this character'} in the cast panel`
        const params = fitParams(model, { text: line.text, voiceId })
        return {
          model,
          params,
          label: `Line · ${characterName(line.characterId) ?? 'narrator'}`,
          apply: (gid: string) =>
            updateShot(shot.id, 'Voice line', (s) => {
              const l = s.dialogue.find((x) => x.id === line.id)
              if (l) l.generationId = gid
            }),
        }
      })
  }

  return { makeVoiceSample, makingVoiceSample, followsVoices, voiceTrackPlan, voiceTrackOf, prepareVoiceTrack, planLines }
}

export type StoryVoice = ReturnType<typeof createVoice>
