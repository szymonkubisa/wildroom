import { firstFavorite } from '@shared/models/favorites'
import { isBlank, nearestAspect } from '@shared/models/fit'
import { defaultValues, parseParams, visibleParams } from '@shared/models/params'
import { RUNPOD_WARMUP_SECONDS } from '@shared/models/catalog/runpod'
import { allModels, getModel } from '@shared/models/registry'
import type { ModelSpec, ParamValues } from '@shared/models/types'
import { type AutoChoice, attachedOf, chooseAuto } from '@shared/presets/auto'
import { PRESETS } from '@shared/presets/catalog'
import { type PresetOption, presetOptions, presetParams, resolvePreset } from '@shared/presets/resolve'
import type { GenPreset, PresetInput } from '@shared/presets/types'
import { enhanceReferences } from '@shared/prompt/enhanceRefs'
import { compileMentions, mentionables, mentionsIn } from '@shared/prompt/mentions'
import { brandPromptSuffix, hasBrand, withBrand, withStyleRefs } from '@shared/types/brand'
import { ENHANCE_KINDS, type EnhanceKind } from '@shared/types/api'
import type { GenerationDTO, GenKind } from '@shared/types/jobs'
import { isOwnLane } from '@shared/types/jobs'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { useBrandSwitch } from '@/features/brand/brandSwitch'
import { placeGenerations } from '@/features/canvas/useCanvasDoc'
import { openSettings } from '@/features/settings/settingsSheet'
import { directorApi, useStory } from '@/features/story/useStory'
import { useTimelineCommands } from '@/features/timeline/commands'
import { errorMessage } from '@/lib/api'
import { formatUsd } from '@/lib/format'
import { PROVIDER_NAMES, groupByProvider } from '@/lib/providers'
import { useAssetsStore } from '@/stores/assets'
import { useCanvasStore } from '@/stores/canvas'
import { useEditorStore } from '@/stores/editor'
import { type GenerateTarget, useGenerateStore } from '@/stores/generate'
import { useGpuStore } from '@/stores/gpu'
import { useJobsStore } from '@/stores/jobs'
import { useProjectStore } from '@/stores/project'
import { useSettingsStore } from '@/stores/settings'
import { swapFrameRole } from './frameRole'
import { withLook } from './look'
import { useImageModels } from './openrouterImages'

/** The kinds in the order the old panel listed them (the Composer groups them: Image · Video · Audio · Tools). */
export const KIND_ORDER: GenKind[] = ['video', 'image', 'speech', 'dialogue', 'music', 'sfx', 'lipsync', 'foley', 'upscale', 'cutout', 'vectorize']
export const AUDIO_KINDS: GenKind[] = ['speech', 'dialogue', 'music', 'sfx', 'foley']
export const TOOL_KINDS: GenKind[] = ['upscale', 'cutout', 'vectorize', 'lipsync']
/** Kinds that work on pictures: the prompt and what is attached carry over between them. */
const VISUAL_KINDS = new Set<GenKind>(['image', 'video', 'upscale', 'cutout', 'vectorize', 'lipsync'])

const ASSET_CONTROLS = new Set(['image', 'images', 'audio', 'video', 'elements'])
/** Inputs kept by role across models (a start frame stays one when the model changes). */
export const ATTACH_KEYS = ['firstFrame', 'lastFrame', 'referenceImages', 'video', 'image', 'audioClip'] as const

const NEED_LABELS: Record<PresetInput, string> = {
  firstFrame: 'a start frame',
  lastFrame: 'an end frame',
  referenceImages: 'reference images',
  video: 'a video',
}

/** How long renders of a model took here (median of the finished ones), when there are enough to say. */
export function medianSeconds(jobs: readonly GenerationDTO[], modelId: string): number | undefined {
  const times = jobs
    .filter((j) => j.modelId === modelId && j.status === 'succeeded' && j.startedAt && j.finishedAt)
    .map((j) => (Date.parse(j.finishedAt!) - Date.parse(j.startedAt!)) / 1000)
    .filter((s) => Number.isFinite(s) && s > 0)
    .sort((a, b) => a - b)
  if (times.length < 2) return undefined
  const mid = Math.floor(times.length / 2)
  return times.length % 2 ? times[mid]! : (times[mid - 1]! + times[mid]!) / 2
}

/**
 * The generation form — the Composer's logic, its state in stores/generate (so every workspace's Composer and every
 * `generate.open()` share it): the kind and its model (Auto: chosen from what is attached; or picked), the values,
 * presets, the brand look and @mentions applied as sent, cost and time before running, where the result goes, and
 * submit — a job of the model.
 */
export function useGenerateForm(opts: { onGenerated?: () => void } = {}) {
  const settings = useSettingsStore()
  const jobs = useJobsStore()
  const assets = useAssetsStore()
  const generate = useGenerateStore()
  const commands = useTimelineCommands()
  const editor = useEditorStore()
  const canvasStore = useCanvasStore()
  const project = useProjectStore()
  const gpu = useGpuStore()
  const story = useStory()

  const { modelId, values, variants, target, presetId } = storeToRefs(generate)
  const errors = ref<Record<string, string>>({})
  const submitting = ref(false)

  const demoMode = computed(() => Boolean(settings.app?.demoMode))
  const visibleModels = computed(() => allModels().filter((m) => !m.demoOnly || demoMode.value))
  const kinds = computed(() => KIND_ORDER.filter((k) => visibleModels.value.some((m) => m.kind === k)))
  const modelsOf = (kind: GenKind) =>
    visibleModels.value.filter((m) => m.kind === kind).sort((a, b) => Number(settings.modelReady(b)) - Number(settings.modelReady(a)))
  const kindModels = computed(() => modelsOf(generate.kind))
  /** The model menu by provider (the same model can come from fal.ai and OpenRouter); connected providers first. */
  const modelGroups = computed(() => groupByProvider(kindModels.value, { keepOrder: true }).map((g) => ({ provider: g.provider, label: g.name, models: g.models })))

  const model = computed(() => (modelId.value ? getModel(modelId.value) : undefined))
  const providerName = computed(() => (model.value ? (PROVIDER_NAMES[model.value.provider] ?? model.value.provider) : ''))
  const isReady = (m: ModelSpec) => settings.modelReady(m) && (!m.demoOnly || demoMode.value)
  const available = computed(() => (model.value ? settings.modelReady(model.value) : false))

  /** "Add key": Settings over the editor, on the model's provider (demo models: General, where demo mode is). */
  function openKeySettings(m: ModelSpec | undefined = model.value) {
    const provider = m?.provider
    if (!provider || provider === 'mock') openSettings({ tab: 'general' })
    else openSettings({ provider })
  }
  /** Why a model that runs on this Mac can't run yet (e.g. weights not downloaded), as the server reports it. */
  function localSetupOf(m: ModelSpec | undefined): string | undefined {
    if (m?.provider !== 'local') return undefined
    const status = settings.providers.find((p) => p.id === 'local')
    return status?.models?.[m.id]?.detail ?? status?.detail ?? 'Not installed on this Mac yet'
  }
  const localSetup = computed(() => localSetupOf(model.value))

  const visible = computed(() => (model.value ? visibleParams(model.value, values.value).filter((p) => !p.ui.hidden) : []))
  const promptParam = computed(() => model.value?.params.find((p) => p.ui.control === 'prompt'))
  const maxVariants = computed(() => Math.min(4, model.value?.maxVariants ?? 4))

  // ------------------------------------------------------------------------------------ presets

  const preset = computed(() => PRESETS.find((p) => p.id === presetId.value && p.kind === generate.kind))
  const presetChoices = computed(() => (preset.value ? presetOptions(preset.value, isReady) : []))
  const missingNeeds = computed(() =>
    (preset.value?.needs ?? []).filter((k) => model.value?.params.some((p) => p.key === k) && isBlank(values.value[k])),
  )

  function savedPreset(kind: GenKind): GenPreset | undefined {
    const id = localStorage.getItem(`gen.preset.${kind}`)
    return PRESETS.find((p) => p.id === id && p.kind === kind)
  }

  const promptKeyOf = (m: ModelSpec | undefined) => m?.params.find((p) => p.ui.control === 'prompt')?.key

  /**
   * What goes along to the next model: the prompt and the inputs (frames, references…) — by role, so a start frame
   * stays one even through a model that doesn't take it (an image model keeps it for the next video); a tool gets the
   * picture to work on from what is attached.
   */
  function carriedValues(next: ModelSpec, from: ParamValues = values.value, fromModel: ModelSpec | undefined = model.value): ParamValues {
    const keep: ParamValues = {}
    for (const k of ATTACH_KEYS) if (!isBlank(from[k])) keep[k] = from[k]
    for (const p of next.params) {
      const v = from[p.key]
      if (isBlank(v) || (p.ui.control !== 'prompt' && !ASSET_CONTROLS.has(p.ui.control))) continue
      keep[p.key] = Array.isArray(v) && p.ui.maxItems ? v.slice(0, p.ui.maxItems) : v
    }
    const fromKey = promptKeyOf(fromModel)
    const toKey = promptKeyOf(next)
    if (fromKey && toKey && fromKey !== toKey && !isBlank(from[fromKey])) keep[toKey] = from[fromKey]
    const image = next.params.find((p) => p.key === 'image' && p.ui.control === 'image')
    const refs = Array.isArray(from.referenceImages) ? (from.referenceImages as string[]) : []
    if (image && isBlank(keep.image)) {
      const picture = (from.firstFrame as string | undefined) || refs[0]
      if (picture) keep.image = picture
    }
    return keep
  }

  function usePresetOption(p: GenPreset, option: Pick<PresetOption, 'model' | 'candidate'>) {
    loadModel(option.model.id, { ...presetParams(p, option), ...carriedValues(option.model) })
  }

  /** Switches to a preset (or none): its best ready model with the preset's settings, keeping the prompt and inputs. */
  function applyPreset(p: GenPreset | undefined) {
    if (!p) return clearPreset()
    generate.auto = false
    presetId.value = p.id
    localStorage.setItem(`gen.preset.${p.kind}`, p.id)
    const resolved = resolvePreset(p, isReady)
    if (resolved) usePresetOption(p, resolved)
  }

  function clearPreset() {
    presetId.value = undefined
    localStorage.removeItem(`gen.preset.${generate.kind}`)
  }

  /**
   * Back on a kind (Auto off): its saved preset with the model last used under it, as the user left it (saved values).
   * Only a model the preset hasn't been used with yet gets the preset's settings. `carried`: what comes along from the
   * kind before (a picture kind's prompt and inputs).
   */
  function restoreKind(kind: GenKind, carried: ParamValues = {}) {
    const saved = savedPreset(kind)
    const lastId = localStorage.getItem(`gen.model.${kind}`) ?? undefined
    const resolved = saved && resolvePreset(saved, isReady, lastId)
    presetId.value = resolved && saved?.id
    if (!resolved) loadModel(pickModel(kind), carried)
    else loadModel(resolved.model.id, { ...(resolved.model.id === lastId ? {} : resolved.params), ...carried })
  }

  function savedValues(id: string): ParamValues {
    try {
      return JSON.parse(localStorage.getItem(`gen.values.${id}`) ?? '{}') as ParamValues
    } catch {
      return {}
    }
  }

  function persistValues() {
    const m = model.value
    if (!m) return
    const keep: ParamValues = {}
    for (const p of m.params) if (!ASSET_CONTROLS.has(p.ui.control) && values.value[p.key] !== undefined) keep[p.key] = values.value[p.key]
    localStorage.setItem(`gen.values.${m.id}`, JSON.stringify(keep))
  }

  /** The kind's first starred model that can run now: picked whenever the Composer starts on that kind. */
  const favoriteOf = (kind: GenKind, needs: string[] = []) =>
    firstFavorite(settings.app?.favoriteModels ?? [], kind, (m) => isReady(m) && needs.every((k) => m.params.some((p) => p.key === k)))

  /** The model last picked by hand for the kind, while it can run and takes `needs`: it stays the kind's model. */
  function handPicked(kind: GenKind, needs: string[] = []): ModelSpec | undefined {
    const id = localStorage.getItem(`gen.picked.${kind}`)
    const m = id ? getModel(id) : undefined
    return m && m.kind === kind && isReady(m) && needs.every((k) => m.params.some((p) => p.key === k)) ? m : undefined
  }

  function pickModel(kind: GenKind, needs: string[] = []): string | undefined {
    // The user's own last pick first, then the star, then a free model on this Mac, then the last one used.
    const picked = handPicked(kind, needs)
    if (picked) return picked.id
    const favorite = favoriteOf(kind, needs)
    if (favorite) return favorite.id
    const candidates = visibleModels.value.filter((m) => m.kind === kind && needs.every((k) => m.params.some((p) => p.key === k)))
    const ready = candidates.filter((m) => settings.modelReady(m))
    // A model running on this Mac is free, so it wins over the last-used paid one; picking another model still holds
    // while the Composer stays on this kind.
    const local = ready.find((m) => m.provider === 'local')
    if (local) return local.id
    const saved = localStorage.getItem(`gen.model.${kind}`)
    if (saved && ready.some((m) => m.id === saved)) return saved
    return (ready[0] ?? candidates[0])?.id
  }

  function loadModel(id: string | undefined, extra: ParamValues = {}) {
    modelId.value = id
    const m = id ? getModel(id) : undefined
    values.value = m ? { ...defaultValues(m), ...savedValues(m.id), ...extra } : {}
    errors.value = {}
    if (m) localStorage.setItem(`gen.model.${m.kind}`, m.id)
    if (Number(variants.value) > maxVariants.value) variants.value = '1'
  }

  // ------------------------------------------------------------------------------------ Auto

  function autoChoiceFor(kind: GenKind, from: ParamValues): AutoChoice | undefined {
    return chooseAuto({
      kind,
      attached: attachedOf(from),
      quality: generate.quality,
      isReady,
      demo: demoMode.value,
      fallback: (k, needs) => {
        const id = pickModel(k, needs)
        return id ? getModel(id) : undefined
      },
    })
  }
  /** What Auto picks now, and why (shown on the model button and in the picker). */
  const autoChoice = computed(() => autoChoiceFor(generate.kind, values.value))

  /**
   * Loads Auto's pick for `kind` from `from` (the values, or a request's): only when the model or its preset changes —
   * a re-pick of the same model keeps what the user set. Leaving a preset puts back the model defaults it had changed
   * (a draft's low resolution doesn't stay for the final).
   */
  function applyAuto(kind: GenKind = generate.kind, from: ParamValues = values.value, extra: ParamValues = {}) {
    const choice = autoChoiceFor(kind, from)
    const id = choice?.model.id ?? pickModel(kind)
    if (!id) return loadModel(undefined)
    const next = getModel(id)!
    const nextPreset = choice?.preset?.id
    if (model.value?.id === id && presetId.value === nextPreset && !Object.keys(extra).length) return
    const left = preset.value && preset.value.id !== nextPreset ? Object.keys(preset.value.params ?? {}) : []
    const defaults = defaultValues(next)
    const reset = Object.fromEntries(left.filter((k) => k in defaults).map((k) => [k, defaults[k]]))
    const carried = model.value ? carriedValues(next, from) : from
    loadModel(id, { ...reset, ...(choice?.params ?? {}), ...carried, ...extra })
    presetId.value = nextPreset
  }

  /** "Auto" in the picker. */
  function useAuto() {
    generate.auto = true
    applyAuto()
  }

  /** A model picked by hand: Auto goes off; a preset stays while the model is one of its candidates. */
  function pickModelByHand(id: string) {
    generate.auto = false
    const picked = getModel(id)
    if (picked) localStorage.setItem(`gen.picked.${picked.kind}`, picked.id)
    const option = presetChoices.value.find((o) => o.model.id === id)
    if (preset.value && option) return usePresetOption(preset.value, option)
    if (preset.value) presetId.value = undefined
    const next = getModel(id)
    loadModel(id, next ? carriedValues(next) : {})
  }

  watch(
    () => generate.kind,
    (kind, previous) => {
      if (model.value?.kind === kind) return
      const carried = previous && VISUAL_KINDS.has(previous) && VISUAL_KINDS.has(kind) ? swapFrameRole(values.value, previous, kind) : {}
      // A starred model is the kind's default, over Auto and the last one used — until another is picked by hand.
      const favorite = handPicked(kind) ? undefined : favoriteOf(kind)
      if (favorite) {
        generate.auto = false
        presetId.value = undefined
        return loadModel(favorite.id, Object.keys(carried).length ? carriedValues(favorite, carried) : {})
      }
      if (generate.auto) applyAuto(kind, carried)
      else {
        const next = getModel(pickModel(kind) ?? '')
        restoreKind(kind, next && Object.keys(carried).length ? carriedValues(next, carried) : {})
      }
    },
    { immediate: true },
  )

  // Auto follows what is attached, Draft/Final and which providers are connected.
  const attachedKey = computed(() => JSON.stringify(attachedOf(values.value)))
  watch(
    () => [generate.auto, generate.quality, attachedKey.value, settings.loaded, demoMode.value, settings.providers] as const,
    () => {
      if (generate.auto) applyAuto()
    },
  )

  watch(
    () => [settings.loaded, demoMode.value] as const,
    ([loaded], [wasLoaded]) => {
      // Settings (and the stars) arrive after the Composer mounts: the kind's starred model is then its default.
      const favorite = loaded && !wasLoaded && !handPicked(generate.kind) ? favoriteOf(generate.kind) : undefined
      if (favorite && model.value?.id !== favorite.id) {
        generate.auto = false
        presetId.value = undefined
        return loadModel(favorite.id, carriedValues(favorite))
      }
      if (generate.auto) return
      if (preset.value) {
        // Keys load after the Composer mounts: once we know which providers are connected, move off a preset model
        // that isn't. Later (a demo-mode toggle) a model the user picked stays, even without its key.
        if (loaded && !wasLoaded && !available.value) applyPreset(preset.value)
      } else if (!model.value || !kindModels.value.some((m) => m.id === model.value?.id)) loadModel(pickModel(generate.kind))
    },
  )

  watch(values, persistValues, { deep: true })

  // Pre-fill requests from elsewhere (Animate, Extend, New take…). Immediate: a request made while no Composer was
  // mounted is applied when one mounts — once, so a remount keeps the user's later edits. A request that names its
  // model (or preset) switches Auto off; one that only brings inputs lets Auto pick for them.
  watch(
    () => generate.request?.nonce,
    (nonce) => {
      const req = generate.request
      if (!req || nonce === generate.appliedNonce) return
      generate.appliedNonce = nonce
      const params = req.params ?? {}
      // A new generation starts on an empty prompt unless it brings one (Reuse, Animate with the picture's prompt).
      const clearPrompt = () => {
        const key = promptKeyOf(model.value)
        if (key && !isBlank(values.value[key]) && !Object.keys(params).some((k) => k === key || k === 'prompt')) setValue(key, '')
      }
      const asked = req.presetId ? PRESETS.find((p) => p.id === req.presetId && p.kind === req.kind) : undefined
      if (asked) {
        applyPreset(asked)
        for (const [k, v] of Object.entries(params)) if (model.value?.params.some((p) => p.key === k)) setValue(k, v)
        clearPrompt()
        target.value = req.target
        return
      }
      if (!req.modelId && generate.auto) {
        // The request's inputs replace what was attached; the prompt stays unless it brings one.
        const base = Object.fromEntries(Object.entries(values.value).filter(([k]) => !(ATTACH_KEYS as readonly string[]).includes(k)))
        applyAuto(req.kind, { ...base, ...params }, params)
      } else {
        if (req.modelId) generate.auto = false
        const needs = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== '')
        const id =
          req.modelId ??
          (model.value?.kind === req.kind && needs.every((k) => model.value?.params.some((p) => p.key === k)) ? model.value.id : (pickModel(req.kind, needs) ?? pickModel(req.kind)))
        // The request brings its own model and settings; keep the preset only while its model stays a candidate.
        if (preset.value && !presetChoices.value.some((o) => o.model.id === id)) presetId.value = undefined
        loadModel(id, params)
      }
      clearPrompt()
      target.value = req.target
      if (req.fitSeconds) fitDuration(req.fitSeconds)
    },
    { immediate: true },
  )

  /** Chooses the shortest duration the model offers that covers `seconds` (or its longest). */
  function fitDuration(seconds: number) {
    const param = model.value?.params.find((p) => p.key === 'duration' || p.key === 'durationSeconds')
    if (!param) return
    const opts = (param.ui.options ?? []).map((o) => Number(o.value)).filter(Number.isFinite).sort((a, b) => a - b)
    if (opts.length) return setValue(param.key, opts.find((o) => o >= seconds - 0.05) ?? opts.at(-1))
    const lo = param.ui.min ?? 1
    const hi = param.ui.max ?? 60
    setValue(param.key, Math.min(hi, Math.max(lo, Math.ceil(seconds))))
  }

  function setValue(key: string, value: unknown) {
    values.value = { ...values.value, [key]: value }
    if (errors.value[key]) {
      const { [key]: _, ...rest } = errors.value
      errors.value = rest
    }
  }

  /** The Director can rewrite this kind's prompt (pictures, clips, music, sound effects, foley — not speech's words). */
  const canEnhance = computed(() => Boolean(model.value && (ENHANCE_KINDS as readonly string[]).includes(model.value.kind)))

  // ------------------------------------------------------------------------------------ brand

  const brand = computed(() => (hasBrand(project.doc.brand) ? project.doc.brand : undefined))
  /** "Look" on: prompts get the kit's style and palette, image references its style images. Per project, the same switch as Library › Brand. */
  const { on: brandOn } = storeToRefs(useBrandSwitch())
  const brandApplies = computed(() => Boolean(brand.value && (generate.kind === 'image' || generate.kind === 'video')))
  const brandActive = computed(() => brandApplies.value && brandOn.value)

  const { models: openRouterImageModels } = useImageModels()

  /**
   * The form's values with the brand applied (what is sent and priced, not what is shown): style and palette in the
   * prompt, style images as references where the model takes them. "Any OpenRouter image model" decides at run time:
   * only as many as the picked model accepts, none while its limits are unknown.
   */
  function brandedValues(m: ModelSpec, v: ParamValues): ParamValues {
    const b = brand.value
    if (!brandActive.value || !b) return v
    const out = { ...v }
    const promptKey = promptKeyOf(m)
    if (promptKey && typeof out[promptKey] === 'string') out[promptKey] = withBrand(out[promptKey] as string, b)
    const brandRefs = b.refAssetIds.filter((id) => assets.get(id)?.status === 'ready')
    const maxRefs = m.id === 'or-image-any' ? (openRouterImageModels.value.find((x) => x.id === out.orModel)?.refs.max ?? 0) : Infinity
    return withStyleRefs(m, out, brandRefs, maxRefs)
  }

  // ------------------------------------------------------------------------------------ @mentions

  const mentionTargets = computed(() => mentionables(story.story.value, (id) => assets.get(id)?.status === 'ready'))
  /** The characters and places the prompt @-mentions now. */
  const mentioned = computed(() => {
    const key = promptKeyOf(model.value)
    const text = key ? String(values.value[key] ?? '') : ''
    return text.includes('@') ? mentionsIn(text, mentionTargets.value) : []
  })

  /** The values with the @mentions resolved for `m` (their pictures in its slots, its names for them in the prompt). */
  function withMentions(m: ModelSpec, v: ParamValues): ParamValues {
    const key = promptKeyOf(m)
    const text = key ? String(v[key] ?? '') : ''
    if (!key || !text.includes('@')) return v
    const found = mentionsIn(text, mentionTargets.value)
    if (!found.length) return v
    const out = compileMentions({
      model: m,
      values: v,
      prompt: text,
      mentioned: found,
      characters: story.story.value.characters,
      places: story.story.value.places,
      labelOf: (id) => {
        const name = assets.get(id)?.name
        return name ? `the picture “${name.replace(/\.[a-z0-9]{2,4}$/i, '')}”` : 'an attached picture'
      },
    })
    return { ...v, ...out.params, [key]: out.prompt }
  }

  /** The values with the look tiles' picks after the prompt (Camera · Lighting · Color; Auto adds nothing). */
  function withLookOf(m: ModelSpec, v: ParamValues): ParamValues {
    const key = promptKeyOf(m)
    // An empty prompt stays empty: the look alone isn't something to make.
    if (!key || typeof v[key] !== 'string' || !(v[key] as string).trim()) return v
    const prompt = withLook(v[key] as string, generate.look, m.kind)
    return prompt === v[key] ? v : { ...v, [key]: prompt }
  }

  /** What is sent for `m` (and priced): the values with the @mentions resolved, the look and the brand applied. */
  const sendable = (m: ModelSpec, v: ParamValues) => brandedValues(m, withLookOf(m, withMentions(m, v)))

  async function enhancePrompt() {
    const m = model.value
    const key = promptKeyOf(m)
    const prompt = key ? String(values.value[key] ?? '').trim() : ''
    if (!m || !key || !prompt || !canEnhance.value) return
    try {
      const visual = m.kind === 'image' || m.kind === 'video'
      const style = visual && brandActive.value ? brandPromptSuffix(brand.value) || undefined : undefined
      // The pictures in the slots go with it: the Director writes a prompt that fits them instead of a new picture.
      const references = visual ? enhanceReferences(m, values.value, visible.value).filter((r) => assets.get(r.assetId)?.kind === 'image') : []
      const res = await directorApi.enhance({ prompt, kind: m.kind as EnhanceKind, style, model: m.label, references })
      setValue(key, res.prompt)
    } catch (err) {
      toast.error('Could not enhance the prompt', { description: errorMessage(err) })
    }
  }

  // ------------------------------------------------------------------------------------ where the result goes

  /** The workspace's default target for this kind (the board, Edit's playhead). */
  const fallback = computed(() => generate.defaultTarget?.())
  /** "Library only": the result isn't placed (Edit's switch is the remembered `toPlayhead`). */
  const libraryOnly = computed({
    get: () => (fallback.value?.playhead ? !generate.toPlayhead : generate.libraryOnly),
    set: (on: boolean) => {
      if (fallback.value?.playhead) generate.toPlayhead = !on
      else generate.libraryOnly = on
    },
  })
  /** Where the result goes: the explicit target, else the workspace's default (unless "Library only"). */
  const destination = computed<GenerateTarget | undefined>(() => target.value ?? (libraryOnly.value ? undefined : fallback.value))
  const destinationFrame = computed(() => {
    const c = destination.value?.canvas
    const f = c?.frameId ? canvasStore.boards.find((b) => b.id === c.boardId)?.items.find((i) => i.id === c.frameId) : undefined
    return f?.kind === 'frame' ? f : undefined
  })
  // Filling a frame: the aspect follows the frame (nearest one the model offers).
  watch(
    () => [destinationFrame.value?.id, destinationFrame.value?.w, destinationFrame.value?.h, modelId.value] as const,
    () => {
      const f = destinationFrame.value
      const aspect = f && model.value ? nearestAspect(model.value, f.w, f.h) : undefined
      if (aspect && values.value.aspectRatio !== aspect) setValue('aspectRatio', aspect)
    },
  )

  /** Images selected on the board, offered as this model's reference / input images. */
  const selectionIds = computed(() => (editor.workspace === 'canvas' ? canvasStore.selectedImageIds : []))
  // The references first: a model's first picture list may be something else (RunPod LTX's frames in between).
  const selectionParam = computed(() => {
    const params = model.value?.params ?? []
    return (
      params.find((p) => p.key === 'referenceImages' && p.ui.control === 'images') ??
      params.find((p) => p.ui.control === 'images' && !p.ui.advanced) ??
      params.find((p) => p.ui.control === 'image')
    )
  })
  const selectionApplied = computed(() => {
    const p = selectionParam.value
    if (!p || !selectionIds.value.length) return true
    const v = values.value[p.key]
    const have = new Set(Array.isArray(v) ? v : v ? [v] : [])
    return (p.ui.control === 'images' ? selectionIds.value.slice(0, p.ui.maxItems ?? 4) : selectionIds.value.slice(0, 1)).every((id) => have.has(id))
  })
  /** The selection joins the pictures already there (a list keeps the newest up to the model's limit). */
  function useSelection() {
    const p = selectionParam.value
    if (!p) return
    const ids = selectionIds.value
    if (p.ui.control !== 'images') return setValue(p.key, ids[0])
    const max = p.ui.maxItems ?? 4
    const picked = ids.slice(0, max)
    const cur = values.value[p.key]
    const kept = (Array.isArray(cur) ? (cur as string[]) : []).filter((id) => !picked.includes(id))
    setValue(p.key, [...kept, ...picked].slice(-max))
  }

  // ------------------------------------------------------------------------------------ cost and time

  const estimate = computed(() => {
    if (!model.value) return undefined
    try {
      // Priced as sent: the brand and @mentions can add reference images that some models bill per input.
      const est = model.value.estimateCost(sendable(model.value, { ...defaultValues(model.value), ...values.value }))
      return { ...est, total: est.usd == null ? null : est.usd * Number(variants.value) }
    } catch {
      return undefined
    }
  })

  const history = computed(() => [...jobs.history, ...jobs.sharedHistory])
  /** About how long a run takes: the model's own estimate, else the median of its finished renders here. */
  function secondsOf(m: ModelSpec, v: ParamValues): { seconds: number; measured: boolean } | undefined {
    try {
      const own = m.estimateSeconds?.({ ...defaultValues(m), ...v })
      if (own !== undefined) return { seconds: own, measured: false }
    } catch {
      // No estimate for these values.
    }
    const median = medianSeconds(history.value, m.id)
    return median === undefined ? undefined : { seconds: median, measured: true }
  }
  /** The wait before the result: the run(s) — one after another on this Mac and the rented GPU — plus starting the GPU. */
  const eta = computed(() => {
    const m = model.value
    if (!m) return undefined
    const one = secondsOf(m, values.value)
    if (!one) return undefined
    const n = Number(variants.value)
    const gpuStart = m.provider === 'runpod' && !gpu.running
    return { seconds: (isOwnLane(m.provider) ? one.seconds * n : one.seconds) + (gpuStart ? RUNPOD_WARMUP_SECONDS : 0), gpuStart, measured: one.measured }
  })

  /** Each model's cost per run with this form (for the picker): USD, null (depends on the plan) or undefined. */
  function costOf(m: ModelSpec): number | null | undefined {
    try {
      const v = { ...defaultValues(m), ...savedValues(m.id), ...carriedValues(m) }
      const usd = m.estimateCost(sendable(m, v)).usd
      return usd == null ? null : usd * Math.min(Number(variants.value), Math.min(4, m.maxVariants ?? 4))
    } catch {
      return undefined
    }
  }
  function etaOf(m: ModelSpec): number | undefined {
    const one = secondsOf(m, { ...savedValues(m.id), ...carriedValues(m) })
    return one?.seconds
  }

  /**
   * Jobs that will run before a new one from this model, from every project (the queue is shared): local renders go
   * one by one, and so do cloud jobs unless the queue runs them in parallel.
   */
  const ahead = computed(() => {
    const m = model.value
    if (!m) return 0
    const all = [...jobs.sharedRunning, ...jobs.sharedQueued]
    if (isOwnLane(m.provider)) return all.filter((j) => j.provider === m.provider).length
    return settings.app?.cloudOneAtATime === false ? 0 : all.filter((j) => !isOwnLane(j.provider)).length
  })
  const queueing = computed(() => ahead.value > 0 || Boolean(settings.app?.queuePaused))

  // ------------------------------------------------------------------------------------ submit

  function announce(count: number, waiting: number) {
    const cost = estimate.value?.total ? `Estimated ${formatUsd(estimate.value.total)}` : undefined
    if (waiting || settings.app?.queuePaused) {
      const where = [waiting ? `${waiting} ahead` : '', settings.app?.queuePaused ? 'the queue is paused' : ''].filter(Boolean).join(' · ')
      toast.success(count > 1 ? `${count} takes queued in Activity` : 'Queued in Activity', { description: [where, cost].filter(Boolean).join(' · ') })
    } else {
      toast.success(count > 1 ? `${count} takes generating` : 'Generating…', { description: [cost, 'Follow it in Activity'].filter(Boolean).join(' · ') })
    }
  }

  async function submit() {
    if (submitting.value) return
    const m = model.value
    const projectId = assets.projectId
    if (!m || !projectId) return
    if (!available.value) {
      toast.error(localSetup.value ?? `Add your ${providerName.value} key in Settings first`, {
        action: { label: localSetup.value ? 'Settings' : 'Add key', onClick: () => openKeySettings(m) },
      })
      return
    }
    if (missingNeeds.value.length) {
      errors.value = Object.fromEntries(missingNeeds.value.map((k) => [k, `${preset.value?.label} needs this`]))
      toast.error(`${preset.value?.label} needs ${missingNeeds.value.map((k) => NEED_LABELS[k]).join(' and ')}`)
      return
    }
    const parsed = parseParams(m, sendable(m, values.value))
    if (!parsed.ok) {
      errors.value = parsed.errors
      toast.error(parsed.message)
      return
    }
    submitting.value = true
    const waiting = ahead.value
    try {
      // The destination is read now: Edit's follows the playhead.
      const t = target.value ?? (libraryOnly.value ? undefined : generate.defaultTarget?.())
      const created = await jobs.create({ projectId, modelId: m.id, params: parsed.values, variants: Number(variants.value) })
      if (t?.chain) generate.registerChain(created.map((g) => g.id), t.chain)
      else if (t?.canvas) placeGenerations(t.canvas, created)
      else if (t) commands.attachGenerations(t, created, m)
      target.value = undefined
      // From a picture (a start frame, references, the image to edit): Generate from this… opens on this kind next time.
      if ((m.kind === 'image' || m.kind === 'video') && ['firstFrame', 'referenceImages', 'image'].some((k) => !isBlank(values.value[k]))) generate.fromPictureKind = m.kind
      opts.onGenerated?.()
      announce(created.length, waiting)
    } catch (err) {
      toast.error('Could not start generation', { description: errorMessage(err) })
    } finally {
      submitting.value = false
    }
  }

  return {
    // models
    kinds,
    kindModels,
    modelGroups,
    modelsOf,
    model,
    providerName,
    available,
    isReady,
    localSetup,
    localSetupOf,
    openKeySettings,
    pickModelByHand,
    useAuto,
    autoChoice,
    // presets
    preset,
    applyPreset,
    // form
    values,
    variants,
    maxVariants,
    errors,
    visible,
    promptParam,
    setValue,
    fitDuration,
    canEnhance,
    enhancePrompt,
    // brand and mentions
    brand,
    brandOn,
    brandApplies,
    mentionTargets,
    mentioned,
    // destination
    fallback,
    destination,
    destinationFrame,
    libraryOnly,
    selectionIds,
    selectionParam,
    selectionApplied,
    useSelection,
    // cost and time
    estimate,
    eta,
    costOf,
    etaOf,
    queueing,
    // run
    submitting,
    submit,
  }
}

export type GenerateForm = ReturnType<typeof useGenerateForm>
