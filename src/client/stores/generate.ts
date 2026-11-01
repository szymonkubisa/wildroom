import type { GenKind } from '@shared/types/jobs'
import type { ParamValues } from '@shared/models/types'
import type { Quality } from '@shared/presets/auto'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { ref, shallowRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { getModel } from '@shared/models/registry'
import type { Look } from '@/features/generate/look'
import { useEditorStore } from './editor'
import { useJobsStore } from './jobs'
import { useProjectStore } from './project'

export interface GenerateTarget {
  /** Put the result into this timeline clip as a new take. */
  clipId?: string
  /** Create a placeholder at this frame (connected/primary decided by the caller). */
  frame?: number
  /** Replace this storyline gap with the result (it takes the gap's length). */
  gapId?: string
  /** Place the result right after this clip (generative extend). */
  afterClipId?: string
  /** Place the result right before this clip, ending where the clip starts (extend backwards). */
  beforeClipId?: string
  /** Short description shown in the Composer ("Result goes to …"). */
  label?: string
  /** After the (image) result arrives, open a video generation that animates it into this clip as a new take. */
  chain?: ChainAnimate
  /** Put the result on a canvas board (next to the selection, or inside a frame). */
  canvas?: CanvasTarget
  /** Edit's default target (`frame` = the playhead): the user can switch it off (`toPlayhead`) to keep results in Assets. */
  playhead?: boolean
}

export interface CanvasTarget {
  boardId: string
  /** Fill this frame: the result takes the frame's position and size. */
  frameId?: string
  /** Top-left corner (board units) of the first result when there is no frame. */
  anchor?: { x: number; y: number }
  /** Width the results are shown at on the board (height follows the image). */
  width?: number
}

export interface ChainAnimate {
  clipId: string
  prompt: string
  videoModelId?: string
  seconds?: number
  /** The video must end on this image (the generated image becomes its start frame). */
  lastFrame?: string
  /** Where the video goes; default: a new take of `clipId`. */
  target?: GenerateTarget
  /** Toast shown when the image is ready. */
  readyMessage?: string
}

export interface GenerateRequest {
  kind: GenKind
  /** Start from this preset (its best ready model and settings); `params` still go on top. */
  presetId?: string
  modelId?: string
  params?: ParamValues
  target?: GenerateTarget
  /** Pick the model's shortest duration option that covers this many seconds. */
  fitSeconds?: number
  /** Bump to re-apply the same request. */
  nonce: number
}

/**
 * The Composer's state — the one generation form at the bottom of Create and Edit. Any part of the UI can open
 * it pre-filled (Animate, Extend, New take…) with `open()`; it lives here, not in the component, so switching
 * workspaces (each mounts its own Composer) keeps what the user set up.
 */
export const useGenerateStore = defineStore('generate', () => {
  const request = ref<GenerateRequest>()
  /** The request a Composer last took in: one made while none was mounted is applied when one mounts. */
  const appliedNonce = ref<number>()
  /** The kind the Composer is on: kept across reloads (the last one used). */
  const kind = useLocalStorage<GenKind>('composer.kind', 'video')
  /** What a picture was last generated into (Generate from this…): its next picture opens on that kind. */
  const fromPictureKind = useLocalStorage<'image' | 'video' | null>('composer.fromPicture', null)
  // The panel's form lives here, not in the component: switching workspaces remounts the panel, and a remount must
  // not drop the reference images or the target the user just set up.
  const modelId = ref<string>()
  const values = ref<ParamValues>({})
  const variants = useLocalStorage('composer.variants', '1')
  const target = ref<GenerateTarget>()
  const presetId = ref<string>()
  /** Where a result goes when the form has no explicit target (the active workspace decides, e.g. the canvas). */
  const defaultTarget = shallowRef<() => GenerateTarget | undefined>()
  /** In Edit, results without a target land on the timeline at the playhead; off, they only go to Assets. */
  const toPlayhead = ref(readFlag(TO_PLAYHEAD_KEY, true))
  watch(toPlayhead, (on) => writeFlag(TO_PLAYHEAD_KEY, on))
  /** Create: the result goes only to the Library, not to the board (Edit's switch is `toPlayhead`). */
  const libraryOnly = ref(false)
  /** "Auto": the model follows what is attached (see @shared/presets/auto); picking a model switches it off. */
  const auto = ref(readFlag(AUTO_KEY, true))
  watch(auto, (on) => writeFlag(AUTO_KEY, on))
  /** Draft (the cheap draft presets) or Final. */
  const quality = ref<Quality>(readQuality())
  watch(quality, (q) => writeText(QUALITY_KEY, q))
  /** The look tiles (Camera · Lighting · Color): what is picked goes with every image or clip prompt; unset is Auto. */
  const look = useLocalStorage<Look>('composer.look', {})
  /** Bumped to bring the Composer's prompt into focus (open(), ⌘G). */
  const focusNonce = ref(0)
  /** A focus asked for before a Composer was there to take it (Plan → Create): the next Composer to mount takes it. */
  const focusPending = ref(false)

  // Another project: its targets (clips, frames) and input assets don't exist there — keep only the settings.
  watch(
    () => useProjectStore().id,
    (id, previous) => {
      if (!previous || id === previous) return
      target.value = undefined
      request.value = undefined
      libraryOnly.value = false
      const m = modelId.value ? getModel(modelId.value) : undefined
      const assetKeys = new Set(m?.params.filter((p) => ['image', 'images', 'audio', 'video', 'elements'].includes(p.ui.control)).map((p) => p.key))
      values.value = Object.fromEntries(Object.entries(values.value).filter(([k]) => !assetKeys.has(k)))
    },
  )

  function open(
    kindValue: GenKind,
    opts: { presetId?: string; modelId?: string; params?: ParamValues; target?: GenerateTarget; fitSeconds?: number } = {},
  ) {
    kind.value = kindValue
    request.value = { kind: kindValue, ...opts, nonce: Date.now() + Math.random() }
    focus(opts.target)
  }

  /** Brings the Composer's prompt into focus. */
  function focus(t?: GenerateTarget) {
    toComposer(t)
    focusPending.value = true
    focusNonce.value++
  }

  /**
   * Plan has no Composer (an open shot card has its own prompts and renders): asked for one there, it opens in Create —
   * or in Edit for a place on the timeline. The request waits in the store for that workspace's Composer.
   */
  function toComposer(t?: GenerateTarget) {
    const editor = useEditorStore()
    if (editor.workspace !== 'story') return
    const onTimeline = t && (t.frame !== undefined || t.clipId || t.gapId || t.afterClipId || t.beforeClipId || t.chain)
    editor.workspace = onTimeline ? 'edit' : 'canvas'
  }

  // Two-step edits (edit a frame, then re-animate the shot): generation id → what to do when it succeeds.
  const chains = new Map<string, ChainAnimate>()

  function registerChain(generationIds: string[], chain: ChainAnimate) {
    for (const id of generationIds) chains.set(id, chain)
  }

  useJobsStore().onFinished((job) => {
    const chain = chains.get(job.id)
    if (!chain) return
    // One result is enough: drop the chain for sibling takes too.
    for (const [id, c] of chains) if (c === chain) chains.delete(id)
    const frame = job.outputAssetIds[0]
    if (job.status !== 'succeeded' || !frame) return
    open('video', {
      modelId: chain.videoModelId,
      params: { firstFrame: frame, prompt: chain.prompt, ...(chain.lastFrame ? { lastFrame: chain.lastFrame } : {}) },
      target: chain.target ?? { clipId: chain.clipId, label: 'Re-animates the edited frame as a new take of the shot' },
      fitSeconds: chain.seconds,
    })
    toast.success(chain.readyMessage ?? 'Edited frame ready', { description: 'Check it, then generate the video in the Composer.' })
  })

  return {
    request,
    appliedNonce,
    kind,
    fromPictureKind,
    modelId,
    values,
    variants,
    target,
    presetId,
    defaultTarget,
    toPlayhead,
    libraryOnly,
    auto,
    quality,
    look,
    focusNonce,
    focusPending,
    open,
    focus,
    registerChain,
  }
})

const TO_PLAYHEAD_KEY = 'gen.toPlayhead'
const AUTO_KEY = 'gen.auto'
const QUALITY_KEY = 'gen.quality'

function readQuality(): Quality {
  try {
    return localStorage.getItem(QUALITY_KEY) === 'draft' ? 'draft' : 'final'
  } catch {
    return 'final'
  }
}

function writeText(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage unavailable: the choice holds until the page closes.
  }
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    // Storage unavailable: the switch holds until the page closes.
  }
}
