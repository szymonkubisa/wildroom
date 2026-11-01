import * as ops from '@shared/timeline'
import { canExtendWithVeo, VEO_EXTEND_MAX_SECONDS, VEO_EXTEND_SECONDS } from '@shared/models/catalog/fal'
import { getModel } from '@shared/models/registry'
import { isMotionItem } from '@shared/motion/evaluate'
import { slideUpIn, stagger } from '@shared/motion/presets'
import type { ModelSpec } from '@shared/models/types'
import { flicksToSeconds } from '@shared/time/flicks'
import { clipsInAllTimelines, timelineExportName } from '@shared/timeline/timelines'
import type { GenerationDTO } from '@shared/types/jobs'
import {
  type Clip,
  type MediaClip,
  type MotionClip,
  type Take,
  type TitleTemplate,
  type TransitionType,
  activeTake,
  defaultAudioProps,
  defaultVideoProps,
} from '@shared/types/project-doc'
import { nanoid } from 'nanoid'
import { toast } from 'vue-sonner'
import { buildScene } from '@/engine/buildScene'
import { captionCuesFromDialogue, captionCuesFromTimeline, cuesToSrt, cuesToVtt, downloadText } from '@/features/captions/captions'
import { currentFrame } from '@/features/editor/transport'
import { layersAt } from '@/engine/scene'
import { api, errorMessage } from '@/lib/api'
import { useAssetsStore } from '@/stores/assets'
import { useEditorStore } from '@/stores/editor'
import { type GenerateTarget, useGenerateStore } from '@/stores/generate'
import { useJobsStore } from '@/stores/jobs'
import { useProjectStore } from '@/stores/project'

/** Editor actions shared by menus, shortcuts and panels. Every doc change goes through the project store. */
export function useTimelineCommands() {
  const project = useProjectStore()
  const editor = useEditorStore()
  const assets = useAssetsStore()

  const playhead = currentFrame
  const fps = () => project.doc.settings.fps

  function clipsFromAssets(ids: string[]): MediaClip[] {
    const ctx = project.opContext()
    const clips: MediaClip[] = []
    let fonts = 0
    for (const id of ids) {
      const asset = assets.get(id)
      if (asset?.kind === 'font') fonts++
      if (!asset || asset.status !== 'ready' || asset.kind === 'font') continue
      clips.push(
        ops.makeMediaClip({
          assetId: asset.id,
          media: ctx.media(asset.id)!,
          fps: fps(),
          role: asset.kind === 'audio' ? (asset.role ?? 'dialogue') : 'effects',
          newId: ctx.newId,
          name: asset.name,
        }),
      )
    }
    if (!clips.length) toast.warning(fonts === ids.length ? 'Fonts are picked in the text inspector, not placed on the timeline' : 'Select media that has finished processing')
    return clips
  }

  const isAudioOnly = (clip: Clip) => clip.kind === 'media' && !clip.video

  function appendAssets(ids: string[]) {
    const clips = clipsFromAssets(ids)
    if (clips.length) project.apply(ops.appendToSpine(clips), 'Append to storyline')
  }

  function insertAssets(ids: string[], frame = playhead()) {
    const clips = clipsFromAssets(ids)
    if (clips.length) project.apply(ops.insertAt(frame, clips), 'Insert')
  }

  function connectAssets(ids: string[], frame = playhead()) {
    const clips = clipsFromAssets(ids)
    if (!clips.length) return
    const audio = clips.filter(isAudioOnly)
    const visual = clips.filter((c) => !isAudioOnly(c))
    project.apply((draft, ctx) => {
      if (visual.length) ops.connectAt(frame, visual, 1)(draft, ctx)
      if (audio.length) ops.connectAt(frame, audio, -1)(draft, ctx)
    }, 'Connect')
  }

  function overwriteAssets(ids: string[], frame = playhead()) {
    const clips = clipsFromAssets(ids)
    if (clips.length) project.apply(ops.overwriteAt(frame, clips), 'Overwrite')
  }

  /** On a timeline (open or not), a canvas board or in the brand kit: removing it from the project would leave a hole. */
  function isAssetUsed(assetId: string): boolean {
    const d = project.doc
    const onTimeline = clipsInAllTimelines(d).some(
      (c) => c.kind === 'media' && c.takes.some((t) => t.assetId === assetId),
    )
    const onCanvas = (d.canvas?.boards ?? []).some((b) => b.items.some((i) => i.kind === 'asset' && i.assetId === assetId))
    const inBrand = Boolean(d.brand && [...d.brand.logoAssetIds, ...d.brand.refAssetIds].includes(assetId))
    return onTimeline || onCanvas || inBrand
  }

  function currentScene() {
    return buildScene(project.doc, project.layout, (id) => assets.get(id))
  }

  /** Exact frame under the playhead (topmost visible media) as a new image asset. */
  async function grabFrameAtPlayhead(): Promise<string | undefined> {
    const scene = currentScene()
    const frame = playhead()
    const layer = [...layersAt(scene, frame)].reverse().find((l) => l.kind === 'media' && l.assetId && !l.still)
    if (!layer?.assetId || !assets.projectId) {
      toast.warning('No video under the playhead')
      return undefined
    }
    const seconds = layer.sourceStart + ((frame + 0.5 - layer.start) / scene.fps) * layer.speed
    const asset = await api.assets.frame(assets.projectId, layer.assetId, seconds)
    assets.upsert(asset)
    return asset.id
  }

  function durationFramesFor(params: Record<string, unknown>): number {
    const seconds = Number(params.duration ?? params.durationSeconds ?? 5)
    return Math.max(1, Math.round((Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * fps()))
  }

  /**
   * Sound gets no placeholder (an audio take without a file would play nothing): each result is connected below the
   * picture at `frame` once its file is ready — in the project it was made for, if that is still the open one.
   */
  function connectAudioWhenReady(generations: GenerationDTO[], frame: number) {
    const projectId = project.id
    const waiting = new Set(generations.map((g) => g.id))
    const off = useJobsStore().onFinished((job) => {
      if (!waiting.delete(job.id)) return
      if (!waiting.size) off()
      const assetId = job.status === 'succeeded' ? job.outputAssetIds[0] : undefined
      if (!assetId || project.id !== projectId) return
      void assets.whenReady(assetId).then(
        () => project.id === projectId && connectAssets([assetId], frame),
        () => {},
      )
    })
  }

  /** Puts freshly created generations on the timeline as pending takes (sound once it's ready). */
  function attachGenerations(target: GenerateTarget, generations: GenerationDTO[], model: ModelSpec) {
    if (!generations.length) return
    // Upscales and lip-syncs keep the source timing, so the new take starts where the current one does.
    const sameTiming = model.kind === 'upscale' || model.kind === 'lipsync'
    const baseClip = target.clipId ? findClip(target.clipId) : undefined
    const sourceIn = sameTiming && baseClip?.kind === 'media' ? (activeTake(baseClip)?.sourceIn ?? 0) : 0
    const takes: Take[] = generations.map((g) => ({ id: nanoid(10), generationId: g.id, sourceIn, label: g.label }))
    if (target.clipId) {
      const clipId = target.clipId
      project.apply((draft, ctx) => {
        takes.forEach((take, i) => ops.audition(clipId, { type: 'add', take, select: i === takes.length - 1 })(draft, ctx))
      }, 'New take')
      return
    }
    if (model.output === 'audio') {
      if (target.frame !== undefined) connectAudioWhenReady(generations, target.frame)
      return
    }
    const gap = target.gapId ? project.layout.spine.find((s) => s.id === target.gapId && s.item.kind === 'gap') : undefined
    const after = target.afterClipId ? project.layout.byId.get(target.afterClipId) : undefined
    const before = target.beforeClipId ? project.layout.byId.get(target.beforeClipId) : undefined
    const newDuration = durationFramesFor(generations[0]!.params)
    const frame =
      gap?.start ??
      (after && after.type !== 'marker' ? after.end - (after.type === 'spine' ? after.overlapOut : 0) : undefined) ??
      (before && before.type !== 'marker' ? (before.type === 'spine' ? before.start : Math.max(0, before.start - newDuration)) : undefined) ??
      target.frame
    if (frame === undefined) return
    const clip: MediaClip = {
      kind: 'media',
      id: nanoid(10),
      name: generations[0]!.label,
      duration: gap ? gap.item.duration : newDuration,
      enabled: true,
      takes,
      active: 0,
      speed: 1,
      video: defaultVideoProps(),
      audio: model.output === 'video' ? defaultAudioProps('effects') : undefined,
    }
    if (gap) return void project.apply(ops.replaceGap(gap.id, clip), 'Fill gap')
    // Before a storyline clip: insert at its start (it moves right, so the new shot ends where it begins).
    if (before && before.type === 'spine') return void project.apply(ops.insertAt(frame, [clip]), 'Extend before')
    if (before && before.type === 'connected') return void project.apply(ops.connectAt(frame, [clip], before.lane), 'Extend before')
    if (after && after.type === 'spine') return void project.apply(ops.insertAt(frame, [clip]), 'Extend')
    if (after && after.type === 'connected') return void project.apply(ops.connectAt(frame, [clip], after.lane), 'Extend')
    const owner = ops.ownerAt(project.layout, frame)
    if (!owner || owner.item.kind === 'gap') project.apply(ops.overwriteAt(frame, [clip]), 'Generate here')
    else project.apply(ops.connectAt(frame, [clip], 1), 'Generate here')
  }

  function selectedOrUnderPlayhead(): string[] {
    if (editor.selection.length) return editor.selection
    const owner = ops.ownerAt(project.layout, playhead())
    return owner ? [owner.id] : []
  }

  function bladeAtPlayhead(all = false) {
    project.apply(ops.bladeAt(playhead(), all ? undefined : editor.selection.length ? editor.selection : undefined), all ? 'Blade all' : 'Blade')
  }

  function deleteSelection(mode: 'ripple' | 'gap' = 'ripple') {
    if (!editor.selection.length) return
    const ids = [...editor.selection]
    project.apply(mode === 'ripple' ? ops.rippleDelete(ids) : ops.replaceWithGap(ids), mode === 'ripple' ? 'Delete' : 'Replace with gap')
    editor.select([])
  }

  function copySelection(): boolean {
    const entries = ops.copyEntries(project.layout, editor.selection)
    if (!entries.length) return false
    editor.clipboard = entries
    toast(`Copied ${entries.length} clip${entries.length === 1 ? '' : 's'}`, { duration: 1000 })
    return true
  }

  function cutSelection() {
    if (copySelection()) deleteSelection('ripple')
  }

  function paste(frame = playhead()) {
    if (!editor.clipboard.length) return toast.warning('Nothing to paste — copy clips with ⌘C first')
    // The playhead often sits on a clip's last frame (End, ↓): paste at that edit point instead of cutting a 1-frame sliver.
    const edges = [0, ...project.layout.spine.map((x) => x.end)]
    const edge = edges.find((e) => Math.abs(e - frame) <= 1)
    project.apply(ops.pasteClips(edge ?? frame, editor.clipboard), 'Paste')
  }

  /** Copies the selection and pastes it right after the last selected clip. */
  function duplicateSelection() {
    const entries = ops.copyEntries(project.layout, editor.selection)
    if (!entries.length) return
    const ends = editor.selection.map((id) => project.layout.byId.get(id)).map((e) => (e && e.type !== 'marker' ? e.end - (e.type === 'spine' ? e.overlapOut : 0) : 0))
    project.apply(ops.pasteClips(Math.max(...ends), entries), 'Duplicate')
  }

  function toggleEnabled() {
    const ids = selectedOrUnderPlayhead()
    const clips = ids.map((id) => findClip(id)).filter(Boolean) as Clip[]
    if (!clips.length) return
    const enable = clips.some((c) => !c.enabled)
    project.apply((draft, ctx) => {
      for (const c of clips) ops.setProps(c.id, { enabled: enable })(draft, ctx)
    }, enable ? 'Enable' : 'Disable')
  }

  function findClip(id: string): Clip | undefined {
    const d = project.doc
    return d.spine.find((c) => c.id === id) ?? d.connected.find((c) => c.id === id)?.clip
  }

  /** Adds a transition at the edit point closest to the playhead (or after each selected spine clip). */
  function addTransition(type: TransitionType = 'dissolve') {
    const layout = project.layout
    const duration = Math.round(fps())
    let targets = layout.spine.filter((s) => editor.selection.includes(s.id)).map((s) => s.id)
    if (!targets.length) {
      const f = playhead()
      let best: { id: string; dist: number } | undefined
      layout.spine.forEach((s, i) => {
        if (i === layout.spine.length - 1 && layout.spine.length > 1) return
        const dist = Math.abs(s.end - f)
        if (!best || dist < best.dist) best = { id: s.id, dist }
      })
      if (best) targets = [best.id]
    }
    if (!targets.length) return
    project.apply((draft, ctx) => {
      for (const id of targets) ops.setTransition(id, 'out', { type, duration })(draft, ctx)
    }, 'Add transition')
  }

  /** Removes a storyline clip's outgoing transition (its badge on the timeline). */
  function removeTransition(id: string) {
    project.apply(ops.setTransition(id, 'out', null), 'Remove transition')
    editor.selectedTransition = undefined
  }

  function detachAudio() {
    const ids = selectedOrUnderPlayhead()
    project.apply((draft, ctx) => {
      for (const id of ids) ops.detachAudio(id)(draft, ctx)
    }, 'Detach audio')
  }

  function liftFromStoryline() {
    const ids = editor.selection.filter((id) => project.layout.spine.some((s) => s.id === id))
    project.apply((draft, ctx) => {
      for (const id of ids) ops.liftFromStoryline(id)(draft, ctx)
    }, 'Lift from storyline')
  }

  function overwriteToPrimary() {
    const ids = editor.selection.filter((id) => project.layout.connected.some((c) => c.id === id))
    project.apply((draft, ctx) => {
      for (const id of ids) ops.overwriteToPrimary(id)(draft, ctx)
    }, 'Overwrite to primary storyline')
  }

  function addMarker(kind: 'standard' | 'todo' | 'chapter' = 'standard') {
    project.apply(ops.addMarker(playhead(), kind, kind === 'todo' ? 'To do' : 'Marker'), 'Add marker')
  }

  function addTitle(template: TitleTemplate = 'basic') {
    const ctx = project.opContext()
    const title = ops.makeTitle({ template, text: template === 'lower-third' ? 'Name Surname' : 'Title', newId: ctx.newId, duration: Math.round(fps() * 4) })
    project.apply(ops.connectAt(playhead(), [title], 1), 'Add title')
    editor.select([title.id])
    editor.rightTab = 'inspector'
  }

  function addGenerator(color = '#101014') {
    const clip: Clip = {
      kind: 'generator',
      id: nanoid(10),
      name: 'Solid',
      duration: Math.round(fps() * 5),
      enabled: true,
      generator: 'solid',
      params: { color },
      video: defaultVideoProps(),
    }
    project.apply(ops.connectAt(playhead(), [clip], 1), 'Add generator')
  }

  /**
   * A Canvas frame as a motion clip at the playhead: into the storyline over a gap or past the end, else connected
   * above it. Its elements come in one after another (fade and rise), to be refined in the inspector.
   */
  /**
   * A frame on the timeline as a motion clip at the playhead (its elements sliding in one after another) — or, as an
   * `overlay`, over the whole timeline above everything (a header, a progress bar), still until you animate it.
   */
  function addMotion(boardId: string, frameId: string, overlay = false): MotionClip | undefined {
    const board = project.doc.canvas?.boards.find((b) => b.id === boardId)
    const frame = board?.items.find((i) => i.id === frameId && i.kind === 'frame')
    if (!board || !frame) return undefined
    const rate = fps()
    if (overlay) {
      if (!project.doc.spine.length) {
        toast.warning('Put something on the timeline first: the overlay lasts as long as it')
        return undefined
      }
      const clip: MotionClip = { ...ops.makeMotion({ boardId, frameId, newId: project.opContext().newId, duration: 1, name: frame.name ?? 'Overlay' }), span: 'timeline' }
      project.apply(ops.connectAt(0, [clip], 1), 'Add frame as timeline overlay')
      editor.select([clip.id])
      return clip
    }
    const ids = board.items.filter((i) => i.frameId === frameId && isMotionItem(i)).map((i) => i.id)
    const tracks = stagger(ids, Math.round(rate * 0.2), Math.round(rate * 0.25), (at) => slideUpIn({ at, frames: Math.round(rate * 0.6), distance: Math.round(frame.h * 0.04) }))
    const clip = ops.makeMotion({ boardId, frameId, tracks, newId: project.opContext().newId, duration: Math.round(rate * 5), name: frame.name ?? 'Frame' })
    const at = playhead()
    const owner = ops.ownerAt(project.layout, at)
    if (!owner || owner.item.kind === 'gap') project.apply(ops.overwriteAt(at, [clip]), 'Add frame to timeline')
    else project.apply(ops.connectAt(at, [clip], 1), 'Add frame to timeline')
    editor.select([clip.id])
    return clip
  }

  function cycleTake(delta: number) {
    const id = selectedOrUnderPlayhead().find((cid) => {
      const c = findClip(cid)
      return c?.kind === 'media' && c.takes.length > 1
    })
    const clip = id ? findClip(id) : undefined
    if (!clip || clip.kind !== 'media') return
    const index = (clip.active + delta + clip.takes.length) % clip.takes.length
    project.apply(ops.audition(clip.id, { type: 'select', index }), 'Switch take')
    toast(`Take ${index + 1} of ${clip.takes.length}`, { duration: 1200 })
  }

  function finalizeAudition(clipId: string) {
    project.apply(ops.audition(clipId, { type: 'finalize' }), 'Finalize take')
  }

  function fitToMedia(clipId: string) {
    const clip = findClip(clipId)
    if (clip?.kind !== 'media') return
    const take = activeTake(clip)
    const asset = assets.get(take?.assetId)
    if (!asset?.durationFlicks || !take) return
    const seconds = (flicksToSeconds(asset.durationFlicks) - flicksToSeconds(take.sourceIn)) / clip.speed
    project.apply(ops.setRange(clip.id, { duration: Math.max(1, Math.floor(seconds * fps())) }), 'Fit to media')
  }

  /** Opens the Composer to make another take for a clip, pre-filled from its active take. */
  function newTake(clipId: string) {
    const clip = findClip(clipId)
    if (clip?.kind !== 'media') return
    const asset = assets.get(activeTake(clip)?.assetId)
    const gen = asset?.generation
    const model = gen ? getModel(gen.modelId) : undefined
    useGenerateStore().open(model?.kind ?? 'video', { modelId: model?.id, params: gen?.params, target: { clipId } })
  }

  function captionIds(): string[] {
    return project.layout.connected
      .filter((c) => c.item.clip.kind === 'title' && c.item.clip.template === 'caption')
      .map((c) => c.id)
  }

  /** Replaces caption clips with fresh ones built from the dialogue's word timings. */
  function generateCaptions() {
    const cues = captionCuesFromDialogue(currentScene(), (id) => assets.get(id))
    if (!cues.length) {
      toast.warning('No dialogue with word timings found', {
        description: 'Captions come from ElevenLabs voice/dialogue clips, or from clips you transcribe (right-click → Clip tools → Transcribe speech).',
      })
      return
    }
    const existing = captionIds()
    const lane = Math.max(1, ...project.layout.connected.filter((c) => !existing.includes(c.id)).map((c) => c.lane)) + 1
    project.apply((draft, ctx) => {
      if (existing.length) ops.remove(existing, 'ripple')(draft, ctx)
      for (const cue of cues) {
        const title = ops.makeTitle({ template: 'caption', text: cue.text, duration: cue.end - cue.start, newId: ctx.newId, name: 'Caption' })
        ops.connectAt(cue.start, [title], lane)(draft, ctx)
      }
    }, 'Generate captions')
    toast.success(`${cues.length} captions added`, { description: 'Edit them like titles; they burn in on export.' })
  }

  function removeCaptions() {
    const ids = captionIds()
    if (ids.length) project.apply(ops.remove(ids, 'ripple'), 'Remove captions')
  }

  function exportCaptions(format: 'srt' | 'vtt' = 'srt') {
    const cues = captionCuesFromTimeline(project.layout)
    if (!cues.length) {
      toast.warning('There are no captions on the timeline yet')
      return
    }
    const text = format === 'srt' ? cuesToSrt(cues, fps()) : cuesToVtt(cues, fps())
    downloadText(`${timelineExportName(project.name || 'captions', project.doc)}.${format}`, text, format === 'srt' ? 'application/x-subrip' : 'text/vtt')
  }

  /** Saves, then downloads the timeline as Final Cut Pro XML (media referenced by file path). */
  async function exportFcpxml() {
    if (!project.id) return
    await project.save()
    // The server builds the XML from the saved project: an unsaved one would export an older version.
    if (project.saveState === 'error') {
      toast.error('FCPXML export needs the project saved first', { description: 'Autosave failed — see the message above.' })
      return
    }
    let res: Response
    try {
      res = await fetch(`/api/projects/${project.id}/fcpxml`)
    } catch (err) {
      toast.error('FCPXML export failed', { description: errorMessage(err) })
      return
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined
      toast.error('FCPXML export failed', { description: body?.error })
      return
    }
    const warnings = JSON.parse(decodeURIComponent(res.headers.get('x-fcpxml-warnings') ?? '%5B%5D')) as string[]
    downloadText(`${timelineExportName(project.name || 'project', project.doc)}.fcpxml`, await res.text(), 'application/xml')
    if (warnings.length) toast.warning('Exported for Final Cut Pro with notes', { description: warnings.join(' ') })
    else toast.success('Exported for Final Cut Pro')
  }

  /** Upscale the clip's active take; the result arrives as a new take of the same clip. */
  function upscaleClip(clipId: string) {
    const clip = findClip(clipId)
    if (clip?.kind !== 'media') return
    const asset = assets.get(activeTake(clip)?.assetId)
    if (!asset || asset.kind === 'audio') return toast.warning('Only video and image clips can be upscaled')
    useGenerateStore().open('upscale', {
      params: asset.kind === 'video' ? { video: asset.id } : { image: asset.id },
      target: { clipId },
    })
  }

  /** Continue a Veo-made clip with Veo 3.1 Extend; the whole, longer clip arrives as a new take. */
  function extendWithVeo(clipId: string) {
    const clip = findClip(clipId)
    if (clip?.kind !== 'media') return
    const asset = assets.get(activeTake(clip)?.assetId)
    if (!asset || !canExtendWithVeo(asset)) {
      return toast.warning(`Only Veo-made clips up to 1080p and ${VEO_EXTEND_MAX_SECONDS - VEO_EXTEND_SECONDS} s can be extended with Veo`)
    }
    useGenerateStore().open('video', {
      modelId: 'fal-veo3.1-extend',
      params: { video: asset.id, prompt: asset.generation?.prompt ?? '' },
      target: { clipId, label: 'The longer clip becomes a new take — then use Fit to media length' },
    })
  }

  function generateHere(frame = playhead()) {
    useGenerateStore().open('video', { target: { frame } })
  }

  return {
    appendAssets,
    insertAssets,
    connectAssets,
    overwriteAssets,
    isAssetUsed,
    grabFrameAtPlayhead,
    attachGenerations,
    bladeAtPlayhead,
    deleteSelection,
    toggleEnabled,
    copySelection,
    cutSelection,
    paste,
    duplicateSelection,
    addTransition,
    removeTransition,
    detachAudio,
    liftFromStoryline,
    overwriteToPrimary,
    addMarker,
    addTitle,
    addGenerator,
    addMotion,
    cycleTake,
    finalizeAudition,
    fitToMedia,
    newTake,
    upscaleClip,
    extendWithVeo,
    generateHere,
    generateCaptions,
    removeCaptions,
    exportCaptions,
    exportFcpxml,
    findClip,
    currentScene,
  }
}
