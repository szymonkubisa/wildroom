import { fitParams, nearestAspect } from '@shared/models/fit'
import { allModels } from '@shared/models/registry'
import type { ModelSpec, ParamValues } from '@shared/models/types'
import type { AssetDTO } from '@shared/types/assets'
import type { CanvasAssetItem } from '@shared/types/canvas'
import { shallowRef } from 'vue'
import { toast } from 'vue-sonner'
import { placeGenerations } from '@/features/canvas/useCanvasDoc'
import { errorMessage } from '@/lib/api'
import { useAssetsStore } from '@/stores/assets'
import { useCanvasStore } from '@/stores/canvas'
import { useJobsStore } from '@/stores/jobs'
import { useSettingsStore } from '@/stores/settings'
import { type CoverageAngle, coveragePrompt } from './coverage'
import { toolModel } from './resultActions'

/**
 * Shots from an image in Create (a board item, a Feed tile): the picker in a dialog, then one image per angle drawn
 * from it — beside it on the board, or in the Feed.
 */
export const coverageFor = shallowRef<{ asset: AssetDTO; item?: CanvasAssetItem }>()

export function openCoverage(asset: AssetDTO, item?: CanvasAssetItem) {
  coverageFor.value = { asset, item }
}

const takesReferences = (m: ModelSpec) => m.params.some((p) => p.key === 'referenceImages')

/** The image model that draws them: the one last used for images when it takes a reference picture, else the first ready one that does. */
export function coverageModel(): ModelSpec | undefined {
  const last = toolModel('image')
  if (last && takesReferences(last)) return last
  const settings = useSettingsStore()
  return allModels().find((m) => m.kind === 'image' && !m.demoOnly && takesReferences(m) && settings.modelReady(m))
}

/** One angle's params: the picture as the reference, its own shape kept. */
export function coverageParams(model: ModelSpec, asset: AssetDTO, angle: CoverageAngle): ParamValues {
  const auto = model.params.find((p) => p.key === 'aspectRatio')?.ui.options?.some((o) => o.value === 'auto')
  const aspectRatio = auto ? 'auto' : asset.width && asset.height ? nearestAspect(model, asset.width, asset.height) : undefined
  return fitParams(model, { prompt: coveragePrompt(angle, asset.generation?.prompt), referenceImages: [asset.id], ...(aspectRatio ? { aspectRatio } : {}) })
}

/** One picture's price with this model (null: unknown). */
export function coverageCostEach(model: ModelSpec | undefined, asset: AssetDTO): number | null | undefined {
  if (!model) return undefined
  try {
    return model.estimateCost(coverageParams(model, asset, { id: 'x', label: '', shotType: '', instruction: '', preview: {} })).usd ?? null
  } catch {
    return null
  }
}

/** Starts one image per angle; on the board they land in a row beside the picture. */
export async function runCoverage(asset: AssetDTO, angles: CoverageAngle[], item?: CanvasAssetItem): Promise<number> {
  const model = coverageModel()
  const projectId = useAssetsStore().projectId
  if (!model || !projectId) return 0
  const jobs = useJobsStore()
  const boardId = useCanvasStore().board.id
  const created = []
  for (const angle of angles) {
    try {
      created.push(...(await jobs.create({ projectId, modelId: model.id, params: coverageParams(model, asset, angle), variants: 1, label: `${angle.label} · ${asset.name}` })))
    } catch (err) {
      toast.error(`Could not start ${model.label}`, { description: errorMessage(err) })
      break
    }
  }
  if (item && created.length) placeGenerations({ boardId, anchor: { x: item.x + item.w + 40, y: item.y }, width: item.w }, created)
  if (created.length) toast.success(`Drawing ${created.length} shot${created.length === 1 ? '' : 's'} from ${asset.name}`, { description: `${model.label}${item ? ' · beside it on the board' : ' · in the Feed'}` })
  return created.length
}
