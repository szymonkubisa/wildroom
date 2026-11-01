import { framePreset } from '@shared/canvas/framePresets'
import { fitParams, nearestAspect } from '@shared/models/fit'
import type { ModelSpec, ParamValues } from '@shared/models/types'
import { PRESETS } from '@shared/presets/catalog'
import { resolvePreset } from '@shared/presets/resolve'
import type { AssetPlan, AssetPlanItem, AssetSetRequest } from '@shared/types/assetSet'
import { deliverable } from '@shared/types/assetSet'
import { type BrandKit, hasBrand, styleRefSlot, withBrand, withStyleRefs } from '@shared/types/brand'
import { type CanvasItem, DEFAULT_TEXT } from '@shared/types/canvas'
import type { GenerationDTO } from '@shared/types/jobs'
import { watch } from 'vue'
import { toast } from 'vue-sonner'
import { errorMessage } from '@/lib/api'
import { formatUsd } from '@/lib/format'
import { useAssetsStore } from '@/stores/assets'
import { useCanvasStore } from '@/stores/canvas'
import { useJobsStore } from '@/stores/jobs'
import { useProjectStore } from '@/stores/project'
import { useSettingsStore } from '@/stores/settings'
import { luminance } from '@/features/brand/palette'
import { fitText } from './textFit'
import { addBoard, editBoard, newItemId } from './useCanvasDoc'

/** What the brand kit tells the planner. */
export function brandForPlanner(b: BrandKit | undefined): AssetSetRequest['brand'] {
  if (!hasBrand(b)) return undefined
  return {
    name: b.name || undefined,
    description: [b.tagline, b.description].filter(Boolean).join(' — ') || undefined,
    style: b.styleText || undefined,
    avoid: b.avoidText || undefined,
    tone: b.tone || undefined,
    colors: b.colors.map((c) => (c.name ? `${c.name} ${c.hex}` : c.hex)),
  }
}

export interface ResolvedItem {
  model: ModelSpec
  params: ParamValues
  usd: number | null
  ready: boolean
}

/**
 * The generation for one planned item: its deliverable's preset picks the model, the frame's shape picks the aspect,
 * the set's style (and the brand kit) go into the prompt, brand style images into the references.
 */
export function resolveItem(item: AssetPlanItem, plan: AssetPlan, brand: BrandKit | undefined, extraRefs: string[] = []): ResolvedItem | undefined {
  const settings = useSettingsStore()
  const assets = useAssetsStore()
  const d = deliverable(item.deliverable)
  const preset = d && PRESETS.find((p) => p.id === d.presetId)
  const frame = d && framePreset(d.framePresetId)
  if (!preset || !frame) return undefined
  const resolved = resolvePreset(preset, (m) => settings.modelReady(m) && !m.demoOnly)
  if (!resolved) return undefined
  const model = resolved.model
  const prompt = withBrand(plan.style ? `${item.prompt} ${plan.style}` : item.prompt, brand)
  const refs = [...extraRefs, ...(brand?.refAssetIds ?? [])].filter((id) => assets.get(id)?.status === 'ready')
  const fitted = fitParams(model, { ...resolved.params, prompt, aspectRatio: nearestAspect(model, frame.w, frame.h) })
  const params = withStyleRefs(model, fitted, refs)
  let usd: number | null = null
  try {
    usd = model.estimateCost(params).usd
  } catch {
    usd = null
  }
  return { model, params, usd, ready: resolved.ready }
}

/** Total of the known prices, and whether some items have no fixed price. */
export function planCost(resolved: (ResolvedItem | undefined)[]): { usd: number; partial: boolean } {
  return resolved.reduce<{ usd: number; partial: boolean }>((acc, r) => ({ usd: acc.usd + (r?.usd ?? 0), partial: acc.partial || r?.usd == null }), {
    usd: 0,
    partial: false,
  })
}

/**
 * Starts a planned placeholder (from a brief) that has no generation yet — e.g. the rest of a set whose style anchor
 * finished after a reload. A finished planned image on the same board serves as the style reference.
 */
export async function startPlanned(itemId: string) {
  const canvas = useCanvasStore()
  const jobs = useJobsStore()
  const projectId = useAssetsStore().projectId
  const item = canvas.byId.get(itemId)
  // The board it's on now: the user may switch boards while the job is being created.
  const boardId = canvas.board.id
  if (item?.kind !== 'asset' || !item.planned || !projectId) return
  const anchor = canvas.items.find((i) => i.kind === 'asset' && i.planned && i.assetId && i.id !== item.id)
  const anchorAsset = anchor?.kind === 'asset' ? anchor.assetId : undefined
  const brand = useProjectStore().doc.brand
  const r = resolveItem(
    { deliverable: item.planned.deliverable, prompt: item.planned.prompt, title: '', headline: '', subline: '', textArea: 'left' },
    { title: '', style: '', items: [] },
    hasBrand(brand) ? brand : undefined,
    item.planned.deliverable === 'logo' || !anchorAsset ? [] : [anchorAsset],
  )
  if (!r?.ready) {
    toast.error('No model is ready for this item', { description: 'Add the provider key in Settings, or generate it from the panel.' })
    return
  }
  try {
    const [job] = await jobs.create({ projectId, modelId: r.model.id, params: r.params, variants: 1 })
    if (!job) return
    editBoard(boardId, 'Generate planned item', (b) => {
      const target = b.items.find((i) => i.id === itemId)
      if (target?.kind === 'asset') {
        target.generationId = job.id
        delete target.assetId
      }
    })
    useProjectStore().resolvePendingTakes()
  } catch (err) {
    toast.error('Could not start the generation', { description: errorMessage(err) })
  }
}

/**
 * Where the headline and subline go in a frame: in the calm area the prompt left free (top, bottom, left, right or
 * centre), sized to the frame. Offsets are relative to the frame's corner.
 */
export function copyBlock(it: Pick<AssetPlanItem, 'headline' | 'subline' | 'textArea'>, frame: { w: number; h: number }) {
  const unit = Math.min(frame.w, frame.h)
  const pad = Math.round(unit * 0.07)
  const side = it.textArea === 'left' || it.textArea === 'right'
  const w = Math.round(side ? frame.w * 0.46 : frame.w - 2 * pad)
  const hSize = Math.round(unit * (side ? 0.075 : 0.085))
  const sSize = Math.max(14, Math.round(hSize * 0.42))
  const line = DEFAULT_TEXT.lineHeight
  const hLines = it.headline ? Math.max(1, Math.ceil((it.headline.length * hSize * 0.55) / w)) : 0
  const sLines = it.subline ? Math.max(1, Math.ceil((it.subline.length * sSize * 0.5) / w)) : 0
  const hHeight = Math.round(hSize * line * hLines)
  const gap = hLines && sLines ? Math.round(sSize * 0.8) : 0
  const sHeight = Math.round(sSize * line * sLines)
  const total = hHeight + gap + sHeight
  const x = it.textArea === 'right' ? frame.w - pad - w : pad
  const y = it.textArea === 'bottom' ? frame.h - pad - total : it.textArea === 'center' || side ? Math.round((frame.h - total) / 2) : pad
  return { x, y, w, hSize, sSize, hHeight, sHeight, subY: y + hHeight + gap, align: it.textArea === 'center' ? ('center' as const) : ('left' as const) }
}

const ROW_GAP = 240
const COL_GAP = 120

/**
 * Lays the plan out on a new board — one row per deliverable, a frame per item with a placeholder for its image and
 * the copy on top as editable text — then starts the generations. With `anchor`, the first image goes alone and
 * the rest follow with it as a style reference, so the set matches.
 */
export async function runPlan(plan: AssetPlan, opts: { brand?: BrandKit; anchor: boolean }) {
  const canvas = useCanvasStore()
  const jobs = useJobsStore()
  const project = useProjectStore()
  const projectId = useAssetsStore().projectId
  const projectAtStart = project.id
  if (!projectId) return
  const boardId = addBoard(plan.title)
  // The planner leaves calm (usually light) space for the copy: dark text reads best there.
  const darkest = [...(opts.brand?.colors ?? [])].sort((a, b) => luminance(a.hex) - luminance(b.hex))[0]
  const textColor = opts.brand?.colors.find((c) => c.role === 'text')?.hex ?? (darkest && luminance(darkest.hex) < 0.2 ? darkest.hex : '#111111')
  const heading = opts.brand?.fonts.find((f) => f.role === 'heading')?.family ?? DEFAULT_TEXT.fontFamily
  const body = opts.brand?.fonts.find((f) => f.role === 'body')?.family ?? heading

  const items: CanvasItem[] = []
  const slots: { item: AssetPlanItem; placeholderId: string }[] = []
  let y = 0
  const rows = new Map<string, AssetPlanItem[]>()
  for (const it of plan.items) rows.set(it.deliverable, [...(rows.get(it.deliverable) ?? []), it])
  for (const [id, rowItems] of rows) {
    const frameSize = framePreset(deliverable(id)!.framePresetId)!
    let x = 0
    for (const it of rowItems) {
      const frameId = newItemId()
      const placeholderId = newItemId()
      items.push({ kind: 'frame', id: frameId, name: it.title, presetId: frameSize.id, fill: '#ffffff', x, y, w: frameSize.w, h: frameSize.h })
      items.push({
        kind: 'asset',
        id: placeholderId,
        x,
        y,
        w: frameSize.w,
        h: frameSize.h,
        frameId,
        planned: { deliverable: it.deliverable, prompt: plan.style ? `${it.prompt} ${plan.style}` : it.prompt },
      })
      if (it.headline || it.subline) {
        const block = copyBlock(it, frameSize)
        if (it.headline) {
          items.push({ kind: 'text', id: newItemId(), text: it.headline, ...DEFAULT_TEXT, fontFamily: heading, fontSize: block.hSize, fontWeight: 800, color: textColor, align: block.align, x: x + block.x, y: y + block.y, w: block.w, h: block.hHeight, frameId })
        }
        if (it.subline) {
          items.push({ kind: 'text', id: newItemId(), text: it.subline, ...DEFAULT_TEXT, fontFamily: body, fontSize: block.sSize, fontWeight: 500, color: textColor, align: block.align, x: x + block.x, y: y + block.subY, w: block.w, h: block.sHeight, frameId })
        }
      }
      slots.push({ item: it, placeholderId })
      x += frameSize.w + COL_GAP
    }
    y += frameSize.h + ROW_GAP
  }
  for (const it of items) fitText(it)
  editBoard(boardId, `Brief: ${plan.title}`, (b) => b.items.push(...items))
  canvas.requestZoom('fit')

  /** Starts the generations for these slots and links each placeholder to its job. */
  async function start(batch: typeof slots, refs: string[] = []) {
    const links = new Map<string, string>()
    // The project changed or the board was undone meanwhile: start nothing (nothing would show the results).
    if (project.id !== projectAtStart || !canvas.boards.some((b) => b.id === boardId)) return links
    let failed = 0
    for (const s of batch) {
      const r = resolveItem(s.item, plan, opts.brand, refs)
      if (!r?.ready) {
        failed++
        continue
      }
      try {
        const [job] = await jobs.create({ projectId: projectId!, modelId: r.model.id, params: r.params, variants: 1 })
        if (job) links.set(s.placeholderId, job.id)
      } catch (err) {
        failed++
        toast.error(`Could not start “${s.item.title}”`, { description: errorMessage(err) })
      }
    }
    if (links.size) {
      editBoard(boardId, `Generate ${links.size} assets`, (b) => {
        for (const item of b.items) if (item.kind === 'asset' && links.has(item.id)) item.generationId = links.get(item.id)
      })
      // Jobs can finish before they are linked.
      project.resolvePendingTakes()
    }
    if (failed) toast.warning(`${failed} item${failed === 1 ? '' : 's'} could not start`, { description: 'A model for it needs its provider key — see Settings.' })
    return links
  }

  const total = planCost(slots.map((s) => resolveItem(s.item, plan, opts.brand)))
  const cost = total.usd ? `${total.partial ? 'from ' : ''}${formatUsd(total.usd)}` : undefined
  const firstWithModel = slots.findIndex((s) => {
    const model = s.item.deliverable === 'logo' ? undefined : resolveItem(s.item, plan, opts.brand)?.model
    return Boolean(model && styleRefSlot(model))
  })
  if (!opts.anchor || firstWithModel < 0 || slots.length < 2) {
    await start(slots)
    toast.success(`Generating ${slots.length} assets`, { description: cost ? `Estimated ${cost}` : undefined })
    return
  }
  // Style anchor: one image first; the rest use it as a reference once it's done.
  const [anchorSlot] = slots.splice(firstWithModel, 1)
  const links = await start([anchorSlot!])
  const anchorJob = links.get(anchorSlot!.placeholderId)
  toast.success('Generating the style anchor first', { description: `The other ${slots.length} follow its look once it's ready${cost ? ` · estimated ${cost}` : ''}` })
  if (!anchorJob) return void start(slots)
  const stopWatching = watch(
    () => project.id,
    () => stop(),
  )
  let followed = false
  function follow(job: GenerationDTO) {
    if (followed) return
    followed = true
    stop()
    const out = job.status === 'succeeded' ? job.outputAssetIds[0] : undefined
    void start(slots, out ? [out] : [])
  }
  const off = jobs.onFinished((job) => job.id === anchorJob && follow(job))
  // A fast anchor can finish before anyone listened (its update arrived before the create response).
  const known = jobs.byId[anchorJob]
  if (known && jobs.isTerminal(known)) follow(known)
  function stop() {
    off()
    stopWatching()
  }
}

