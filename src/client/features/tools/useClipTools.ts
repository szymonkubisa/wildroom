import * as ops from '@shared/timeline'
import { flicksToSeconds, secondsToFlicks } from '@shared/time/flicks'
import type { AssetDTO } from '@shared/types/assets'
import { type Clip, type MediaClip, activeTake } from '@shared/types/project-doc'
import { getModel } from '@shared/models/registry'
import { nanoid } from 'nanoid'
import { toast } from 'vue-sonner'
import { layersAt } from '@/engine/scene'
import { currentFrame } from '@/features/editor/transport'
import { useTimelineCommands } from '@/features/timeline/commands'
import { type FrameRef, type FrameStats, api, errorMessage } from '@/lib/api'
import { useAssetsStore } from '@/stores/assets'
import { useEditorStore } from '@/stores/editor'
import { useGenerateStore } from '@/stores/generate'
import { useProjectStore } from '@/stores/project'

/** Frames grabbed from clips this session: `${assetId}@${seconds}` → image asset id. */
const grabbedFrames = new Map<string, string>()

/** Runs a slow server tool behind a loading toast; returns undefined (after an error toast) on failure. */
export async function withToast<T>(label: string, fn: () => Promise<T>, done?: (value: T) => string | undefined): Promise<T | undefined> {
  const id = toast.loading(`${label}…`)
  try {
    const value = await fn()
    const message = done?.(value)
    if (message) toast.success(message, { id })
    else toast.dismiss(id)
    return value
  } catch (err) {
    toast.error(`${label} failed`, { id, description: errorMessage(err) })
    return undefined
  }
}

/** Clip-level tools (freeze, reverse, voice clean-up, transcription, beats, colour match). */
export function useClipTools() {
  const project = useProjectStore()
  const editor = useEditorStore()
  const assets = useAssetsStore()
  const commands = useTimelineCommands()
  const fps = () => project.doc.settings.fps

  function mediaClip(clipId: string): { clip: MediaClip; asset: AssetDTO } | undefined {
    const clip = commands.findClip(clipId)
    if (clip?.kind !== 'media') return undefined
    const asset = assets.get(activeTake(clip)?.assetId)
    return asset ? { clip, asset } : undefined
  }

  function startOf(clipId: string): number | undefined {
    const e = project.layout.byId.get(clipId)
    return e && e.type !== 'marker' ? e.start : undefined
  }

  /** Source seconds shown at a timeline frame of a media clip. */
  function sourceSecondsAt(clip: MediaClip, frame: number): number {
    const start = startOf(clip.id) ?? 0
    return flicksToSeconds(activeTake(clip)?.sourceIn ?? 0) + ((frame - start + 0.5) / fps()) * clip.speed
  }

  /** Adds a finished derived asset as the clip's new active take, starting at `sourceSeconds`. */
  function addTake(clipId: string, asset: AssetDTO, sourceSeconds: number, label: string) {
    project.apply(
      ops.audition(clipId, { type: 'add', take: { id: nanoid(10), assetId: asset.id, sourceIn: secondsToFlicks(Math.max(0, sourceSeconds)), label }, select: true }),
      label,
    )
  }

  /** FCP ⌥F: a 2-second still of the frame under the playhead, inserted at the playhead. */
  async function freezeFrame() {
    const frame = currentFrame()
    const scene = commands.currentScene()
    const layer = [...layersAt(scene, frame)].reverse().find((l) => l.kind === 'media' && l.assetId && !l.still)
    const source = layer ? commands.findClip(layer.clipId) : undefined
    if (!layer?.assetId || source?.kind !== 'media' || !assets.projectId) return toast.warning('Put the playhead over a video clip first')
    const seconds = layer.sourceStart + ((frame + 0.5 - layer.start) / scene.fps) * layer.speed
    const still = await withToast('Freeze frame', () => api.assets.frame(assets.projectId!, layer.assetId!, seconds, `${source.name ?? 'Clip'} — freeze`))
    if (!still) return
    assets.upsert(still)
    const ctx = project.opContext()
    const clip = ops.makeMediaClip({ assetId: still.id, media: { kind: 'image', hasVideo: true, hasAudio: false }, fps: fps(), durationFrames: 2 * fps(), newId: ctx.newId, name: 'Freeze frame' })
    if (source.video) clip.video = structuredClone({ ...source.video, opacityKeys: undefined, transformKeys: undefined })
    const spine = project.layout.spine.some((s) => s.id === source.id)
    const lane = project.layout.connected.find((c) => c.id === source.id)?.lane ?? 1
    project.apply(spine ? ops.insertAt(frame, [clip]) : ops.connectAt(frame, [clip], lane), 'Freeze frame')
    editor.select([clip.id])
  }

  /** Plays the clip backwards: a reversed render becomes a new take showing the same range. */
  async function reverseClip(clipId: string) {
    const found = mediaClip(clipId)
    if (!found || !assets.projectId) return
    const { clip, asset } = found
    if (asset.kind === 'image') return toast.warning('Stills cannot be reversed')
    const reversedOf = asset.parentIds.length === 1 && asset.name.endsWith('(reversed)') ? assets.get(asset.parentIds[0]) : undefined
    const target = reversedOf ?? (await withToast('Reversing', () => api.assets.reverse(assets.projectId!, asset.id).then((a) => (assets.upsert(a), assets.whenReady(a.id)))))
    if (!target?.durationFlicks) return
    const inS = flicksToSeconds(activeTake(clip)?.sourceIn ?? 0)
    const usedS = (clip.duration / fps()) * clip.speed
    const newIn = flicksToSeconds(target.durationFlicks) - (inS + usedS)
    addTake(clip.id, target, newIn, reversedOf ? 'Forward' : 'Reversed')
  }

  /** Removes background noise/music from the clip's audio; the clean voice becomes a new take (audio clips). */
  async function isolateVoice(clipId: string) {
    const found = mediaClip(clipId)
    if (!found || !assets.projectId) return
    const { clip, asset } = found
    if (!asset.hasAudio) return toast.warning('This clip has no audio')
    const voice = await withToast(
      'Isolating voice',
      () => api.assets.isolateVoice(assets.projectId!, asset.id).then((a) => (assets.upsert(a), assets.whenReady(a.id))),
      () => 'Clean voice ready',
    )
    if (!voice) return
    const inS = flicksToSeconds(activeTake(clip)?.sourceIn ?? 0)
    if (!clip.video) return addTake(clip.id, voice, inS, 'Voice isolated')
    // Video clip: mute its own sound and connect the clean voice underneath, in sync.
    const start = startOf(clip.id) ?? 0
    const ctx = project.opContext()
    const voiceClip = ops.makeMediaClip({ assetId: voice.id, media: ctx.media(voice.id)!, fps: fps(), sourceIn: secondsToFlicks(inS), durationFrames: clip.duration, role: 'dialogue', newId: ctx.newId, name: voice.name })
    voiceClip.speed = clip.speed
    project.apply((draft, c) => {
      ops.setProps(clip.id, { audio: { enabled: false } })(draft, c)
      ops.connectAt(start, [voiceClip], -1)(draft, c)
    }, 'Isolate voice')
  }

  async function transcribeAsset(assetId: string): Promise<AssetDTO | undefined> {
    return withToast('Transcribing', () => api.assets.transcribe(assetId).then((a) => (assets.upsert(a), a)), (a) => `Transcribed ${a.alignment?.words.length ?? 0} words`)
  }

  async function detectBeats(clipId: string) {
    const found = mediaClip(clipId)
    if (!found) return
    await withToast('Detecting beats', () => api.assets.beats(found.asset.id).then((a) => (assets.upsert(a), a)), (a) => `${a.beats?.beats.length ?? 0} beats · ${a.beats?.bpm ?? '?'} BPM — cuts now snap to them`)
  }

  /** Frame shown in the middle of a clip (as proxy seconds). */
  function midFrame(clip: Clip): FrameRef | undefined {
    if (clip.kind !== 'media') return undefined
    const asset = assets.get(activeTake(clip)?.assetId)
    if (!asset || asset.kind === 'audio') return undefined
    const start = startOf(clip.id) ?? 0
    return { assetId: asset.id, seconds: asset.kind === 'image' ? 0 : sourceSecondsAt(clip, start + clip.duration / 2) }
  }

  /** Grades `clipId` to look like `referenceId` (exposure, contrast, saturation and channel balance). */
  async function matchColor(clipId: string, referenceId: string) {
    const target = commands.findClip(clipId)
    const reference = commands.findClip(referenceId)
    const a = target && midFrame(target)
    const b = reference && midFrame(reference)
    if (!a || !b || !target || target.kind === 'gap' || !target.video) return toast.warning('Both clips need a picture')
    const stats = await withToast('Matching colour', () => api.analysis.frameStats([a, b]))
    if (!stats) return
    const params = matchParams(stats[0]!, stats[1]!)
    const others = target.video.effects.filter((e) => e.type !== 'color' && e.type !== 'balance')
    project.apply(
      ops.setProps(target.id, {
        video: {
          effects: [
            { id: nanoid(8), type: 'color', enabled: true, params: { exposure: params.exposure, contrast: params.contrast, saturation: params.saturation, hue: 0 } },
            { id: nanoid(8), type: 'balance', enabled: true, params: params.balance },
            ...others,
          ],
        },
      }),
      'Match colour',
    )
    toast.success('Colour matched', { description: 'Fine-tune it under Effects in the Inspector.' })
  }

  /** Frame (as a new image asset) at a timeline frame of a video/image clip. */
  async function frameAssetAt(clip: Clip, frame: number, label: string): Promise<string | undefined> {
    if (clip.kind !== 'media' || !assets.projectId) return undefined
    const asset = assets.get(activeTake(clip)?.assetId)
    if (!asset || asset.kind === 'audio') return undefined
    if (asset.kind === 'image') return asset.id
    const seconds = sourceSecondsAt(clip, frame)
    // Clicking Extend again for the same frame reuses the still grabbed before instead of adding a duplicate.
    const key = `${asset.id}@${seconds.toFixed(3)}`
    const known = grabbedFrames.get(key)
    if (known && assets.get(known)) return known
    const still = await api.assets.frame(assets.projectId, asset.id, seconds, label)
    assets.upsert(still)
    grabbedFrames.set(key, still.id)
    return still.id
  }

  /** What the clip shows, in words: its generation prompt, else its AI description (imported footage has no prompt). */
  function promptOf(clip: Clip | undefined): string {
    if (clip?.kind !== 'media') return ''
    const asset = assets.get(activeTake(clip)?.assetId)
    return (asset?.generation?.prompt || asset?.description || '').trim()
  }

  /** A ready-to-use prompt for continuing a clip, so extend never opens with an empty (required) prompt. */
  function continuationPrompt(clip: Clip | undefined, direction: 'after' | 'before' | 'between'): string {
    const scene = promptOf(clip)
    const lead = {
      after: 'Continue this shot seamlessly from the start frame',
      before: 'The moments leading into the end frame, flowing seamlessly into it',
      between: 'A seamless bridging shot from the start frame to the end frame',
    }[direction]
    const keep = 'same scene, subject, action, camera movement, lighting and style, with natural continuous motion and no cuts.'
    return scene ? `${lead}: ${keep} Scene: ${scene}` : `${lead}: ${keep}`
  }

  /**
   * Generates a shot for a storyline gap: the previous clip's last frame is the start frame and the next clip's
   * first frame the end frame, so the new shot bridges the cut.
   */
  async function fillGap(gapId: string) {
    const spine = project.layout.spine
    const i = spine.findIndex((s) => s.id === gapId)
    const gap = spine[i]
    if (!gap || gap.item.kind !== 'gap') return
    const prev = spine[i - 1]
    const next = spine[i + 1]
    const frames = await withToast('Grabbing neighbouring frames', async () => ({
      first: prev ? await frameAssetAt(prev.item, prev.end - prev.overlapOut - 1, `${prev.item.name ?? 'Shot'} — last frame`) : undefined,
      last: next ? await frameAssetAt(next.item, next.start, `${next.item.name ?? 'Shot'} — first frame`) : undefined,
    }))
    if (!frames) return
    const params: Record<string, unknown> = { prompt: continuationPrompt(promptOf(prev?.item) ? prev?.item : next?.item, frames.first && frames.last ? 'between' : 'after') }
    if (frames.first) params.firstFrame = frames.first
    if (frames.last && frames.first) params.lastFrame = frames.last
    useGenerateStore().open('video', {
      params,
      fitSeconds: gap.item.duration / fps(),
      target: { gapId, label: `Fills the ${(gap.item.duration / fps()).toFixed(1)} s gap${frames.first && frames.last ? ', bridging both neighbouring shots' : ''}` },
    })
  }

  /** Generates a continuation of a clip from its last visible frame, placed right after it. */
  async function extendClip(clipId: string, seconds?: number) {
    const clip = commands.findClip(clipId)
    const end = project.layout.byId.get(clipId)
    if (clip?.kind !== 'media' || !end || end.type === 'marker') return
    const frame = await withToast('Grabbing the last frame', () => frameAssetAt(clip, end.end - (end.type === 'spine' ? end.overlapOut : 0) - 1, `${clip.name ?? 'Clip'} — last frame`))
    if (!frame) return toast.warning('Only video clips can be extended')
    useGenerateStore().open('video', {
      params: { firstFrame: frame, prompt: continuationPrompt(clip, 'after') },
      fitSeconds: seconds,
      target: { afterClipId: clipId, label: 'Continues the clip — placed right after it' },
    })
  }

  /**
   * Generates a lead-in that ends exactly on the clip's first frame, placed right before it. Video models need a
   * start frame to honour an end frame, so this takes two steps: an image of the moment just before (from the first
   * frame as reference), then a video from that image to the first frame.
   */
  async function extendBeforeClip(clipId: string, seconds?: number) {
    const clip = commands.findClip(clipId)
    const at = project.layout.byId.get(clipId)
    if (clip?.kind !== 'media' || !at || at.type === 'marker') return
    // The first frame that plays on its own: after an incoming transition, mirroring the end-frame grab in extendClip.
    const startFrame = at.start + (at.type === 'spine' ? at.overlapIn : 0)
    const first = await withToast('Grabbing the first frame', () => frameAssetAt(clip, startFrame, `${clip.name ?? 'Clip'} — first frame`))
    if (!first) return toast.warning('Only video clips can be extended')
    const prompt = promptOf(clip)
    const model = assets.get(activeTake(clip)?.assetId)?.generation?.modelId
    useGenerateStore().open('image', {
      params: {
        prompt: `The same scene a few seconds earlier — same place, characters, wardrobe, lighting, lens and style, just before the action continues.${prompt ? ` Scene: ${prompt}` : ''}`,
        referenceImages: [first],
      },
      target: {
        label: 'Step 1 of 2: a frame from a moment earlier — then a video from it to the clip’s first frame, placed before the clip',
        chain: {
          clipId,
          prompt: continuationPrompt(clip, 'before'),
          lastFrame: first,
          seconds,
          // Reuse the shot's model only if it can end on a given frame; otherwise Generate picks one that can.
          videoModelId: model && getModel(model)?.params.some((p) => p.key === 'lastFrame') ? model : undefined,
          target: { beforeClipId: clipId, label: 'Leads into the clip — ends on its first frame, placed right before it' },
          readyMessage: 'Earlier frame ready',
        },
      },
    })
  }

  return { fillGap, extendClip, extendBeforeClip, freezeFrame, reverseClip, isolateVoice, transcribeAsset, detectBeats, matchColor, midFrame, sourceSecondsAt, startOf }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 1))
const round = (v: number) => Math.round(v * 100) / 100

/** Colour-effect parameters that move `target` frame statistics towards `reference`. */
export function matchParams(target: FrameStats, reference: FrameStats) {
  const eps = 1e-3
  const exposure = clamp(reference.lumaMean / Math.max(eps, target.lumaMean) - 1, -0.8, 1)
  const contrast = clamp(reference.lumaStd / Math.max(eps, target.lumaStd), 0.5, 1.8)
  const saturation = clamp(reference.saturation / Math.max(eps, target.saturation), 0, 2)
  const chroma = (s: FrameStats, i: number) => s.mean[i]! / Math.max(eps, s.lumaMean)
  const gain = (i: number) => round(clamp(chroma(reference, i) / Math.max(eps, chroma(target, i)), 0.6, 1.6))
  return { exposure: round(exposure), contrast: round(contrast), saturation: round(saturation), balance: { r: gain(0), g: gain(1), b: gain(2) } }
}
