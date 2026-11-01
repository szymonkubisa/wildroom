import { Clapperboard, Film, ImagePlay, LayoutGrid, Scissors, ScanLine, Shuffle } from '@lucide/vue'
import { formatTimecode } from '@shared/time/timecode'
import { flicksToSeconds } from '@shared/time/flicks'
import type { AssetDTO } from '@shared/types/assets'
import type { CanvasAssetItem } from '@shared/types/canvas'
import type { Component } from 'vue'
import { toast } from 'vue-sonner'
import { useTimelineCommands } from '@/features/timeline/commands'
import { api, errorMessage } from '@/lib/api'
import { formatUsd } from '@/lib/format'
import { defaultValues } from '@shared/models/params'
import { allModels, getModel } from '@shared/models/registry'
import type { ModelSpec } from '@shared/models/types'
import type { GenerationDTO, GenKind } from '@shared/types/jobs'
import { useAssetsStore } from '@/stores/assets'
import { useCanvasStore } from '@/stores/canvas'
import { useEditorStore } from '@/stores/editor'
import { useGenerateStore } from '@/stores/generate'
import { useJobsStore } from '@/stores/jobs'
import { useProjectStore } from '@/stores/project'
import { useSettingsStore } from '@/stores/settings'
import { placeGenerations } from '@/features/canvas/useCanvasDoc'
import { openCoverage } from './coverageRun'

/**
 * The same actions on every result — a board item, a Feed tile, a card in Library › Media: Vary, Animate (Extend for a
 * clip), Upscale, Remove BG, Start frame, To timeline. Most set the Composer up (its kind, the picture in its role, the
 * prompt it was made from) and leave Generate to the user; Remove BG on the board runs at once (one click, its cost on
 * the button's tooltip), as the board's menu always did. Lip-sync stays in the Composer's Tools (it needs a clip and a
 * voice line).
 */
export type ResultActionId = 'vary' | 'animate' | 'shots' | 'extend' | 'upscale' | 'removeBg' | 'startFrame' | 'toTimeline'

export interface ResultAction {
  id: ResultActionId
  label: string
  title: string
  icon: Component
  run: () => unknown
}

/** The model a one-click tool uses: the last one picked for that kind if it's ready, else the first ready one. */
export function toolModel(kind: GenKind): ModelSpec | undefined {
  const settings = useSettingsStore()
  const ready = allModels().filter((m) => m.kind === kind && !m.demoOnly && settings.modelReady(m))
  const saved = getModel(localStorage.getItem(`gen.model.${kind}`) ?? '')
  return saved && ready.includes(saved) ? saved : ready[0]
}

/** "~$0.01" for a one-click tool with its default settings (undefined: no ready model or no known price). */
export function toolCost(kind: GenKind): string | undefined {
  const m = toolModel(kind)
  if (!m) return undefined
  try {
    const usd = m.estimateCost(defaultValues(m)).usd
    return usd == null ? undefined : `~${formatUsd(usd)}`
  } catch {
    return undefined
  }
}

/**
 * One-click image tools (remove background, vectorize): runs the tool on every given board image with its default
 * settings and puts each result beside its source. Without a ready model, opens the Composer on that tool so the user
 * can set it up.
 */
export async function runImageTool(kind: 'cutout' | 'vectorize', items: CanvasAssetItem[]) {
  const model = toolModel(kind)
  const first = items[0]?.assetId
  if (!first) return
  if (!model) {
    useGenerateStore().open(kind, { params: { image: first } })
    toast.error(kind === 'cutout' ? 'Background removal needs a fal.ai key' : 'Vectorizing needs a fal.ai key', {
      description: 'Add it in Settings → Providers.',
    })
    return
  }
  const jobs = useJobsStore()
  const projectId = useAssetsStore().projectId
  // The board the sources are on: the user may switch boards while the jobs are being created.
  const boardId = useCanvasStore().board.id
  if (!projectId) return
  let started = 0
  for (const item of items) {
    try {
      const created = await jobs.create({ projectId, modelId: model.id, params: { ...defaultValues(model), image: item.assetId }, variants: 1 })
      placeGenerations({ boardId, anchor: { x: item.x + item.w + 40, y: item.y }, width: item.w }, created)
      started++
    } catch (err) {
      toast.error(`Could not start ${model.label}`, { description: errorMessage(err) })
      break
    }
  }
  if (started) toast.success(`${kind === 'cutout' ? 'Removing background' : 'Vectorizing'}${started > 1 ? ` (${started} images)` : ''}…`, { description: model.label })
}

export function useResultActions() {
  const generate = useGenerateStore()
  const assets = useAssetsStore()
  const commands = useTimelineCommands()
  const editor = useEditorStore()
  const canvas = useCanvasStore()
  const project = useProjectStore()

  /** On the board, the source is selected: the result lands next to it (the board's default target). */
  const focusItem = (item?: CanvasAssetItem) => item && canvas.select([item.id])

  /**
   * Another version: a generated result again with its own model and settings (a new seed), an imported picture as the
   * reference of a new image.
   */
  function vary(asset: AssetDTO, item?: CanvasAssetItem) {
    focusItem(item)
    const gen = asset.generation
    const model = gen ? getModel(gen.modelId) : undefined
    if (model) {
      const { seed: _, ...params } = gen!.params
      return generate.open(model.kind, { modelId: model.id, params })
    }
    if (asset.kind === 'image') generate.open('image', { params: { referenceImages: [asset.id] } })
  }

  /**
   * Everything it was made from back in the Composer — model, prompt, settings, seed and the pictures it was given —
   * to change one thing and generate again.
   */
  function reuse(asset: AssetDTO) {
    const gen = asset.generation
    const model = gen ? getModel(gen.modelId) : undefined
    if (model) return generate.open(model.kind, { modelId: model.id, params: { ...gen!.params } })
    if (asset.kind === 'image') generate.open('image', { params: { referenceImages: [asset.id] } })
  }

  /** A failed render back in the Composer as it was asked for, to change it before trying again. */
  function editAndRetry(job: GenerationDTO) {
    const model = getModel(job.modelId)
    generate.open(model?.kind ?? job.kind, { modelId: job.modelId, params: { ...job.params } })
  }

  /** ♥ on, or off again; Hide (a reject) with an Undo on the toast. */
  async function setRating(asset: AssetDTO, rating: -1 | 0 | 1) {
    const before = asset.rating
    try {
      await assets.update(asset.id, { rating })
      if (rating === -1)
        toast('Hidden', {
          description: 'It stays in Library › Media with rejected items shown.',
          action: { label: 'Undo', onClick: () => void assets.update(asset.id, { rating: before }) },
        })
    } catch (err) {
      toast.error('Couldn’t change the rating', { description: errorMessage(err) })
    }
  }

  /** A still as the start of a clip, with the prompt it was made from as a start for the motion. */
  function animate(asset: AssetDTO, item?: CanvasAssetItem) {
    if (asset.kind === 'video') return extend(asset)
    focusItem(item)
    generate.open('video', { params: { firstFrame: asset.id, ...(asset.generation?.prompt ? { prompt: asset.generation.prompt } : {}) } })
  }

  /** A clip continued from its last frame (a new clip that starts where it ends). */
  async function extend(asset: AssetDTO) {
    try {
      const seconds = flicksToSeconds(asset.durationFlicks ?? 0)
      const frame = await api.assets.frame(assets.projectId!, asset.id, Math.max(0, seconds - 1 / (asset.fps ?? 24)), `${asset.name} — last frame`)
      assets.upsert(frame)
      generate.open('video', { params: { firstFrame: frame.id, prompt: asset.generation?.prompt ?? '' } })
    } catch (err) {
      toast.error('Could not grab the last frame', { description: errorMessage(err) })
    }
  }

  function upscale(asset: AssetDTO, item?: CanvasAssetItem) {
    focusItem(item)
    generate.open('upscale', { params: asset.kind === 'video' ? { video: asset.id } : { image: asset.id } })
  }

  /** On the board: at once, the result beside it. Elsewhere: the Composer on Remove BG with the picture in. */
  function removeBackground(asset: AssetDTO, item?: CanvasAssetItem) {
    if (item && toolModel('cutout')) return void runImageTool('cutout', [item])
    focusItem(item)
    generate.open('cutout', { params: { image: asset.id } })
  }

  /** The picture as the start frame of a new clip; the prompt is the user's to write. */
  function startFrame(asset: AssetDTO, item?: CanvasAssetItem) {
    focusItem(item)
    generate.open('video', { params: { firstFrame: asset.id } })
  }

  /** In Edit: connected at the playhead (above the storyline); elsewhere: at the end of the timeline. */
  function toTimeline(ids: string[]) {
    const inEdit = editor.workspace === 'edit' && project.layout.spine.some((s) => s.item.kind !== 'gap')
    if (inEdit) commands.connectAssets(ids)
    else commands.appendAssets(ids)
    const what = ids.length === 1 ? 'Added' : `${ids.length} items added`
    toast.success(inEdit ? `${what} at the playhead · ${formatTimecode(editor.playhead, project.doc.settings.fps)}` : `${what} to the end of the timeline`, {
      ...(editor.workspace === 'edit' ? {} : { action: { label: 'Open Edit', onClick: () => (editor.workspace = 'edit') } }),
    })
  }

  /** Another take of a timeline clip, from its active take's model and settings. */
  const newTake = (clipId: string) => commands.newTake(clipId)

  /** The actions a result offers, by what it is. */
  function actionsFor(asset: AssetDTO, item?: CanvasAssetItem): ResultAction[] {
    if (asset.status !== 'ready') return []
    const image = asset.kind === 'image'
    const video = asset.kind === 'video'
    const cutout = toolCost('cutout')
    const out: ResultAction[] = []
    if (asset.generation || image)
      out.push({ id: 'vary', label: 'Vary', icon: Shuffle, title: asset.generation ? 'Again with the same model and settings (a new seed)' : 'A new image with this one as the reference', run: () => vary(asset, item) })
    if (image) out.push({ id: 'animate', label: 'Animate', icon: Film, title: 'A clip that starts on this picture, from its prompt', run: () => animate(asset, item) })
    if (image && editor.workspace === 'canvas')
      out.push({ id: 'shots', label: 'Shots', icon: LayoutGrid, title: 'More shots of this moment — a wide, a close-up, the reverse… — drawn from it', run: () => openCoverage(asset, item) })
    if (video) out.push({ id: 'extend', label: 'Extend', icon: Film, title: 'A clip that continues from its last frame', run: () => void extend(asset) })
    if (image || video) out.push({ id: 'upscale', label: 'Upscale', icon: ScanLine, title: 'A sharper, larger version', run: () => upscale(asset, item) })
    if (image)
      out.push({ id: 'removeBg', label: 'Remove BG', icon: Scissors, title: `Cut it out on a transparent background${cutout ? ` (${cutout})` : ''}`, run: () => removeBackground(asset, item) })
    if (image) out.push({ id: 'startFrame', label: 'Start frame', icon: ImagePlay, title: 'Use as the start frame of a new clip — write the motion, then Generate', run: () => startFrame(asset, item) })
    out.push({ id: 'toTimeline', label: 'To timeline', icon: Clapperboard, title: editor.workspace === 'edit' ? 'Add it at the playhead' : 'Add it to the end of the timeline', run: () => toTimeline([asset.id]) })
    return out
  }

  return { vary, reuse, editAndRetry, setRating, animate, extend, upscale, removeBackground, startFrame, toTimeline, newTake, actionsFor }
}
