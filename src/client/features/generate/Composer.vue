<script setup lang="ts">
import {
  ArrowRight,
  AtSign,
  AudioLines,
  ChevronDown,
  ChevronUp,
  Film,
  History,
  Image as ImageIcon,
  ImagePlus,
  KeyRound,
  ListPlus,
  Loader2,
  MapPin,
  Palette,
  SlidersHorizontal,
  Sparkles,
  Wand2,
  X,
} from '@lucide/vue'
import { KIND_LABELS } from '@shared/models/registry'
import { formatTimecode } from '@shared/time/timecode'
import type { ModelSpec, ParamDef } from '@shared/models/types'
import { formatPerSecond, perSecondUsd } from '@shared/models/info'
import { type Mentionable, completeMention, matchMentions, mentionQuery, unmention } from '@shared/prompt/mentions'
import type { AssetDTO } from '@shared/types/assets'
import type { GenKind } from '@shared/types/jobs'
import { useEventListener, useLocalStorage } from '@vueuse/core'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { readAssetDrag } from '@/features/assets/drag'
import { useLibrary } from '@/features/library/library'
import { useStory } from '@/features/story/useStory'
import { formatEta, formatUsd } from '@/lib/format'
import { isTyping } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { useEditorStore } from '@/stores/editor'
import { useGenerateStore } from '@/stores/generate'
import { useProjectStore } from '@/stores/project'
import CameraMovePreview from './CameraMovePreview.vue'
import CameraPresetPicker from './CameraPresetPicker.vue'
import ComposerSlots from './ComposerSlots.vue'
import ComposerTile from './ComposerTile.vue'
import { useFavorites } from './favorites'
import { CAMERA_FAMILY_LABELS, cameraFamily, cameraMatch, withCamera } from './camera'
import { LOOK_TILES, lookAxesFor, lookOption } from './look'
import LookOptions from './LookOptions.vue'
import LookThumb from './LookThumb.vue'
import LookTile from './LookTile.vue'
import ModelPicker, { type ModelStatus } from './ModelPicker.vue'
import ParamField from './ParamField.vue'
import PromptHistory from './PromptHistory.vue'
import PresetPicker from './PresetPicker.vue'
import { AUDIO_KINDS, TOOL_KINDS, useGenerateForm } from './useGenerateForm'

/**
 * The Composer: one prompt bar at the bottom of Create and Edit (asked for in Plan, it opens in Create). A row of
 * tiles above the prompt — the pictures the model takes (frames, References n/max), the camera move or framing,
 * Lighting and Color (Auto until picked) — with what else goes with the prompt as chips (@mentioned characters and
 * places, the brand look, inputs kept for another model) and where the result goes (click: Library only); the
 * prompt with @-autocomplete; then one row: the kind (Image · Video · Audio · Tools), the model (Auto, or picked
 * with cost, time and readiness), a few pills (aspect, resolution, length, takes, Draft/Final), everything else
 * under Advanced, and the cost and wait before Generate (⌘↵).
 */
withDefaults(defineProps<{ floating?: boolean }>(), { floating: false })
/** The project's prompt history (the button outside the Composer's left edge, when it floats). */
const historyOpen = ref(false)

const form = useGenerateForm()
const generate = useGenerateStore()
const assets = useAssetsStore()
const editor = useEditorStore()
const story = useStory()
const library = useLibrary()
const project = useProjectStore()

const root = ref<HTMLElement>()
const prompt = ref<HTMLTextAreaElement>()

// ------------------------------------------------------------------------------------ kinds

type Group = 'image' | 'video' | 'audio' | 'tools'
const GROUPS: { id: Group; label: string; icon: unknown }[] = [
  { id: 'image', label: 'Image', icon: ImageIcon },
  { id: 'video', label: 'Video', icon: Film },
  { id: 'audio', label: 'Audio', icon: AudioLines },
  { id: 'tools', label: 'Tools', icon: Wand2 },
]
const groupOf = (k: GenKind): Group => (k === 'image' || k === 'video' ? k : AUDIO_KINDS.includes(k) ? 'audio' : 'tools')
const group = computed(() => groupOf(generate.kind))
const audioKinds = computed(() => AUDIO_KINDS.filter((k) => form.kinds.value.includes(k)))
const toolKinds = computed(() => TOOL_KINDS.filter((k) => form.kinds.value.includes(k)))
const groups = computed(() => GROUPS.filter((g) => (g.id === 'audio' ? audioKinds.value.length : g.id === 'tools' ? toolKinds.value.length : form.kinds.value.includes(g.id))))

function remembered(key: string, list: GenKind[]): GenKind | undefined {
  try {
    const saved = localStorage.getItem(key) as GenKind | null
    return saved && list.includes(saved) ? saved : list[0]
  } catch {
    return list[0]
  }
}
function setGroup(g: Group) {
  if (g === group.value) return
  const k = g === 'audio' ? remembered('gen.audioKind', audioKinds.value) : g === 'tools' ? remembered('gen.toolKind', toolKinds.value) : g
  if (k) generate.kind = k
}
watch(
  () => generate.kind,
  (k) => {
    try {
      if (AUDIO_KINDS.includes(k)) localStorage.setItem('gen.audioKind', k)
      if (TOOL_KINDS.includes(k)) localStorage.setItem('gen.toolKind', k)
    } catch {
      // Storage off: Audio and Tools open on their first kind.
    }
  },
)

const TOOL_NEEDS: Partial<Record<GenKind, string>> = {
  upscale: 'an image or a clip',
  cutout: 'an image',
  vectorize: 'an image',
  lipsync: 'a clip and a voice line',
}
/** A tool's cost with its usual model (the first that can run). */
function toolCost(k: GenKind): string {
  const m = form.modelsOf(k).find((x) => form.isReady(x))
  if (!m) return 'needs a key'
  const usd = form.costOf(m)
  return usd === undefined ? '' : usd === null ? 'plan price' : formatUsd(usd)
}

// ------------------------------------------------------------------------------------ where it goes

const target = computed(() => generate.target)
const destinationLabel = computed(() => {
  const t = target.value
  if (t) return t.label ?? (t.clipId ? 'A new take of the clip' : t.canvas ? 'Board' : t.frame !== undefined ? `Timeline at ${formatTimecode(t.frame, project.doc.settings.fps)}` : 'Timeline')
  if (form.libraryOnly.value) return 'Library only'
  const f = form.fallback.value
  if (!f) return 'Library'
  return f.label ?? 'Library'
})
const destinationHint = computed(() => {
  if (target.value) return undefined
  if (form.libraryOnly.value) return form.fallback.value ? 'click to send it back' : undefined
  if (form.destinationFrame.value) return `${form.destinationFrame.value.w}×${form.destinationFrame.value.h}`
  return undefined
})
function toggleDestination() {
  if (target.value || !form.fallback.value) return
  form.libraryOnly.value = !form.libraryOnly.value
}

// ------------------------------------------------------------------------------------ chips

type Role = 'start' | 'end' | 'ref' | 'input' | 'clip' | 'audio'
interface AttachChip {
  key: string
  id: string
  role: Role
  index: number
  asset?: AssetDTO
  /** The model takes it (else it is kept for a model that does). */
  used: boolean
  /** Why it isn't used, when it isn't. */
  why?: string
}
const ROLE_LABEL: Record<Role, string> = { start: 'Start', end: 'End', ref: 'Ref', input: 'Input', clip: 'Clip', audio: 'Audio' }
const takes = (key: string) => Boolean(form.model.value?.params.some((p) => p.key === key))

/** The pictures, clips and sounds this model takes, as slots on the Composer (another model, other slots). */
const ASSET_CONTROLS = new Set(['image', 'images', 'video', 'audio'])
const slotParams = computed(() => form.visible.value.filter((p) => ASSET_CONTROLS.has(p.ui.control) && !p.ui.advanced))
const slotKeys = computed(() => new Set(slotParams.value.map((p) => p.key)))

const attachChips = computed<AttachChip[]>(() => {
  const v = form.values.value
  const out: AttachChip[] = []
  const model = form.model.value?.label ?? 'This model'
  const add = (key: string, id: unknown, role: Role, index = 0) => {
    if (typeof id !== 'string' || !id) return
    const over = key === 'referenceImages' && takes(key) && index >= refMax.value
    const used = takes(key) && !over
    const why = used ? undefined : over ? `${model} takes up to ${refMax.value} — kept for a model that takes more` : `${model} doesn’t take this — kept for a model that does`
    out.push({ key, id, role, index, asset: assets.get(id), used, why })
  }
  add('firstFrame', v.firstFrame, 'start')
  add('lastFrame', v.lastFrame, 'end')
  if (Array.isArray(v.referenceImages)) v.referenceImages.forEach((id, i) => add('referenceImages', id, 'ref', i))
  if (takes('image')) add('image', v.image, 'input')
  add('video', v.video, 'clip')
  add('audioClip', v.audioClip, 'audio')
  // What the model takes is in its slots; the chips are what it doesn't (kept for a model that does, or over its limit).
  const unslotted = out.filter((c) => !c.used || !slotKeys.value.has(c.key))
  // In a kind that uses none of them, kept inputs stay out of sight until a picture kind is back.
  return form.model.value && !['image', 'video'].includes(form.model.value.kind) ? unslotted.filter((c) => c.used) : unslotted
})

const posterOf = (a?: AssetDTO) =>
  !a ? undefined : a.variants.poster ? `/media/${a.id}/poster` : a.variants.display ? `/media/${a.id}/display` : a.kind === 'image' ? `/media/${a.id}/original` : undefined

/** The model's list of reference pictures and how many it takes. */
const refParam = computed(() => form.model.value?.params.find((p) => p.key === 'referenceImages' && p.ui.control === 'images'))
const refMax = computed(() => refParam.value?.ui.maxItems ?? 4)
const refIds = computed(() => (Array.isArray(form.values.value.referenceImages) ? (form.values.value.referenceImages as string[]) : []))

function removeChip(c: AttachChip) {
  const v = { ...form.values.value }
  if (c.key === 'referenceImages') v.referenceImages = (v.referenceImages as string[]).filter((_, i) => i !== c.index)
  else delete v[c.key]
  form.values.value = v
}

/** A picture's role, clicked: start → end → reference → start. A frame role on an image job makes it a video. */
function cycleRole(c: AttachChip) {
  if (!['start', 'end', 'ref'].includes(c.role)) return
  const next: Role = c.role === 'start' ? 'end' : c.role === 'end' ? 'ref' : 'start'
  const v = { ...form.values.value }
  const refs = Array.isArray(v.referenceImages) ? [...(v.referenceImages as string[])] : []
  if (c.key === 'referenceImages') refs.splice(c.index, 1)
  else delete v[c.key]
  if (next === 'ref') refs.push(c.id)
  else {
    const key = next === 'start' ? 'firstFrame' : 'lastFrame'
    const had = v[key]
    if (typeof had === 'string' && had && had !== c.id) refs.push(had)
    v[key] = c.id
  }
  v.referenceImages = refs
  form.values.value = v
  if (next !== 'ref' && generate.kind !== 'video') generate.kind = 'video'
}

/** Pictures dropped on the Composer (from the Library, the board, Finder via the Library): by kind, as inputs. */
function attach(ids: string[]) {
  const v = { ...form.values.value }
  for (const id of ids) {
    const a = assets.get(id)
    if (!a) continue
    if (a.kind === 'video') v.video = id
    else if (a.kind === 'audio') v.audioClip = id
    else if (generate.kind === 'video' && !v.firstFrame) v.firstFrame = id
    else if (takes('image') && !v.image) v.image = id
    else {
      const refs = Array.isArray(v.referenceImages) ? (v.referenceImages as string[]) : []
      if (!refs.includes(id)) v.referenceImages = [...refs, id]
    }
  }
  form.values.value = v
}
const dropping = ref(false)
function onDragOver(e: DragEvent) {
  if (!e.dataTransfer?.types.includes('application/x-studio-asset')) return
  e.preventDefault()
  dropping.value = true
  folded.value = false
}
function onDrop(e: DragEvent) {
  dropping.value = false
  const ids = readAssetDrag(e.dataTransfer)
  if (!ids) return
  e.preventDefault()
  attach(ids)
  prompt.value?.focus()
}

function dropMention(m: Mentionable) {
  const key = form.promptParam.value?.key
  if (!key) return
  form.setValue(key, unmention(String(form.values.value[key] ?? ''), m))
}

function brandOff() {
  form.brandOn.value = false
  toast('The look is off', { description: 'Turn it back on here or in Library › Brand.', action: { label: 'Turn on', onClick: () => (form.brandOn.value = true) } })
}

// ------------------------------------------------------------------------------------ the prompt

const promptText = computed({
  get: () => {
    const key = form.promptParam.value?.key
    return key ? String(form.values.value[key] ?? '') : ''
  },
  set: (text: string) => {
    if (form.promptParam.value) form.setValue(form.promptParam.value.key, text)
  },
})
const hasPrompt = computed(() => Boolean(form.promptParam.value))

const placeholder = computed(() => {
  switch (generate.kind) {
    case 'speech':
      return 'What should they say?'
    case 'music':
      return 'Describe the music, e.g. quiet morning piano, warm strings at the end'
    case 'sfx':
      return 'Describe the sound, e.g. reel clicking, a small splash'
    case 'foley':
      return 'Describe the sounds of the clip, e.g. sneakers on wet planks'
  }
  if (TOOL_KINDS.includes(generate.kind)) return 'Optional: what to keep or change…'
  if (!form.preset.value || generate.auto) {
    if (editor.workspace === 'edit') return 'Describe a shot to drop at the playhead… type @ for cast and places'
    if (editor.workspace === 'canvas')
      return form.selectionIds.value.length ? 'What should change? The selection is the reference…' : 'Describe an image or a clip… type @ for cast, places and the look'
    return 'Describe what to make… type @ for cast, places and the look'
  }
  return form.preset.value.promptExample ?? 'Describe what to make…'
})

// The prompt starts about three lines tall and grows with the text up to PROMPT_AUTO_MAX. Dragging the grip on the Composer's top edge
// sets its height by hand, kept across views and restarts; double-click the grip to go back to auto.
const PROMPT_AUTO_MIN = 64
const PROMPT_AUTO_MAX = 132
const PROMPT_MIN = 30
const promptHeight = useLocalStorage('composer.promptHeight', 0) // 0: auto
const promptMaxHeight = () => Math.max(PROMPT_AUTO_MAX, Math.round(window.innerHeight * 0.6))
const clampPromptHeight = (h: number) => Math.round(Math.min(promptMaxHeight(), Math.max(PROMPT_MIN, h)))

function autosize() {
  const el = prompt.value
  if (!el) return
  if (promptHeight.value) {
    el.style.height = `${clampPromptHeight(promptHeight.value)}px`
    return
  }
  el.style.height = 'auto'
  el.style.height = `${Math.max(PROMPT_AUTO_MIN, Math.min(PROMPT_AUTO_MAX, el.scrollHeight))}px`
}
watch([promptText, promptHeight, prompt], () => nextTick(autosize))
useEventListener(window, 'resize', () => promptHeight.value && autosize())

const resizing = ref(false)
function startResize(e: PointerEvent) {
  const el = prompt.value
  if (!el || e.button !== 0) return
  e.preventDefault()
  const grip = e.currentTarget as HTMLElement
  const startY = e.clientY
  const startH = el.offsetHeight
  grip.setPointerCapture(e.pointerId)
  resizing.value = true
  const move = (ev: PointerEvent) => (promptHeight.value = clampPromptHeight(startH + startY - ev.clientY))
  const end = () => {
    resizing.value = false
    grip.removeEventListener('pointermove', move)
    grip.removeEventListener('pointerup', end)
    grip.removeEventListener('pointercancel', end)
  }
  grip.addEventListener('pointermove', move)
  grip.addEventListener('pointerup', end)
  grip.addEventListener('pointercancel', end)
}
function resizeByKey(e: KeyboardEvent) {
  const step = e.key === 'ArrowUp' ? 24 : e.key === 'ArrowDown' ? -24 : 0
  if (!step || !prompt.value) return
  e.preventDefault()
  promptHeight.value = clampPromptHeight(prompt.value.offsetHeight + step)
}

// @-autocomplete: Cast, Places, the brand look and pictures from the Library, grouped.
interface MentionItem {
  group: 'Cast' | 'Places' | 'Brand' | 'Media'
  key: string
  name: string
  handle: string
  sub: string
  picture?: string
  pick: () => void
}
const query = ref<{ start: number; query: string }>()
const active = ref(0)
const menuPos = ref<{ left: number; bottom: number }>()

const mentionItems = computed<MentionItem[]>(() => {
  const q = query.value?.query ?? ''
  const s = story.story.value
  const look = (id: string, kind: 'character' | 'place') =>
    ((kind === 'character' ? s.characters.find((c) => c.id === id)?.description : s.places?.find((p) => p.id === id)?.description) ?? '').split(/[.;]/)[0]!.trim()
  const elements = matchMentions(form.mentionTargets.value, q).map<MentionItem>((m) => ({
    group: m.kind === 'character' ? 'Cast' : 'Places',
    key: `${m.kind}:${m.id}`,
    name: m.name,
    handle: m.handle,
    sub: look(m.id, m.kind) || (m.views.length ? '' : 'No picture yet — named in words'),
    picture: posterOf(assets.get(m.views[0])),
    pick: () => complete(m.handle),
  }))
  const brand = form.brand.value
  const brandItem: MentionItem[] =
    brand && form.brandApplies.value
      ? matchMentions([{ name: 'Look', handle: 'Look' }], q).map(() => ({
          group: 'Brand',
          key: 'brand',
          name: `Look${brand.name ? ` · ${brand.name}` : ''}`,
          handle: 'Look',
          sub: form.brandOn.value ? 'On — style and palette go with every generation' : 'Turn the brand look on',
          pick: () => {
            form.brandOn.value = true
            complete('')
          },
        }))
      : []
  const media = matchMentions(
    assets.list.filter((a) => a.kind === 'image' && a.status === 'ready' && a.rating !== -1).map((a) => ({ a, name: a.name, handle: a.name })),
    q,
  )
    .slice(0, 6)
    .map<MentionItem>(({ a }) => ({
      group: 'Media',
      key: `media:${a.id}`,
      name: a.name,
      handle: a.name,
      sub: a.generation?.modelLabel ?? 'Imported',
      picture: posterOf(a),
      pick: () => {
        complete('')
        attach([a.id])
      },
    }))
  return [...elements, ...brandItem, ...media]
})

function updateQuery() {
  const el = prompt.value
  if (!el || document.activeElement !== el) return void (query.value = undefined)
  const q = mentionQuery(el.value, el.selectionStart ?? 0)
  if (q?.query !== query.value?.query || q?.start !== query.value?.start) active.value = 0
  query.value = q
  if (q) {
    const r = el.getBoundingClientRect()
    menuPos.value = { left: Math.max(8, r.left - 4), bottom: window.innerHeight - r.top + 10 }
  }
}

function complete(handle: string) {
  const el = prompt.value
  if (!el) return
  const out = completeMention(promptText.value, el.selectionStart ?? promptText.value.length, handle)
  promptText.value = out.text
  query.value = undefined
  void nextTick(() => {
    el.focus()
    el.setSelectionRange(out.caret, out.caret)
  })
}

function onPromptKey(e: KeyboardEvent) {
  const items = mentionItems.value
  if (query.value && items.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      active.value = (active.value + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      return
    }
    if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
      e.preventDefault()
      items[active.value]?.pick()
      return
    }
  }
  if (query.value && e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    query.value = undefined
  }
}
/** Leaving the prompt closes the menu (after a click on one of its items has landed). */
function onPromptBlur() {
  setTimeout(() => {
    if (document.activeElement !== prompt.value) query.value = undefined
  }, 150)
}
const groupedItems = computed(() => {
  const out: { group: string; items: (MentionItem & { i: number })[] }[] = []
  mentionItems.value.forEach((item, i) => {
    const last = out.at(-1)
    if (last?.group === item.group) last.items.push({ ...item, i })
    else out.push({ group: item.group, items: [{ ...item, i }] })
  })
  return out
})

// ------------------------------------------------------------------------------------ camera moves (video)

const cameraOpen = ref(false)
const activeCamera = computed(() => (generate.kind === 'video' ? cameraMatch(promptText.value) : undefined))
function setCamera(phrase: string | undefined) {
  const same = phrase && activeCamera.value?.phrase.toLowerCase() === phrase.toLowerCase()
  promptText.value = withCamera(promptText.value, same ? undefined : phrase)
  cameraOpen.value = false
}
const cameraWording = computed(() => {
  const family = cameraFamily(form.model.value)
  return family ? `Worded for ${CAMERA_FAMILY_LABELS[family]}` : 'Generic wording'
})
/** The look tiles this kind takes, each with the axes it holds (a clip's camera is the move tile, its lens a tab there). */
const lookTiles = computed(() => {
  if (!hasPrompt.value) return []
  const axes = lookAxesFor(generate.kind)
  return LOOK_TILES.filter((t) => axes.includes(t.axis)).map((t) => ({ ...t, tabs: t.tabs.filter((a) => axes.includes(a)) }))
})
const takesLens = computed(() => lookAxesFor(generate.kind).includes('lens'))
const cameraTab = ref<'move' | 'lens'>('move')
watch(cameraOpen, (on) => on && (cameraTab.value = 'move'))
const videoLens = computed(() => (generate.kind === 'video' ? lookOption('lens', generate.look.lens) : undefined))

const enhancing = ref(false)
async function enhance() {
  if (enhancing.value) return
  enhancing.value = true
  try {
    await form.enhancePrompt()
  } finally {
    enhancing.value = false
  }
}

// ------------------------------------------------------------------------------------ model

const favorites = useFavorites()
const modelLabel = computed(() => form.model.value?.label ?? 'No model ready')

function statusOf(m: ModelSpec): ModelStatus {
  if (form.isReady(m)) return { ready: true, text: m.provider === 'local' ? 'On this Mac' : m.provider === 'mock' ? 'Free demo' : 'Ready' }
  if (m.provider === 'mock') return { ready: false, text: 'Demo mode' }
  if (m.provider === 'local') return { ready: false, text: 'Install' }
  return { ready: false, text: 'Add key' }
}
/** A note per model: per-second price for video, else its first badges (what the catalog says it is good at). */
function hintOf(m: ModelSpec): string {
  const per = m.kind === 'video' ? perSecondUsd(m) : undefined
  const via = m.provider === 'local' || m.provider === 'mock' ? '' : m.vendor
  const parts = [via, per ? formatPerSecond(per) : '', ...m.badges.slice(0, 2)].filter(Boolean)
  return [...new Set(parts)].join(' · ')
}
function setup(m: ModelSpec) {
  form.openKeySettings(m)
}

// ------------------------------------------------------------------------------------ pills and Advanced

const aspectParam = computed(() => form.visible.value.find((p) => p.key === 'aspectRatio' && p.ui.options?.length))
const durationParam = computed(() => form.visible.value.find((p) => (p.key === 'duration' || p.key === 'durationSeconds') && !p.ui.advanced))
// On the bar, not under Advanced: a resolution remembered from last time (4K, hours on a GPU) must not go unseen.
const resolutionParam = computed(() =>
  form.visible.value.find((p) => (p.key === 'resolution' || p.ui.label === 'Resolution') && p.ui.options?.length && !p.ui.advanced),
)
const NICE_SECONDS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 45, 60, 90, 120, 180]
function durationStops(p: ParamDef): number[] {
  const opts = (p.ui.options ?? []).map((o) => Number(o.value)).filter(Number.isFinite)
  if (opts.length) return opts
  const lo = p.ui.min ?? 1
  const hi = p.ui.max ?? 60
  return NICE_SECONDS.filter((s) => s >= lo && s <= hi)
}
function cycle(p: ParamDef, backwards = false) {
  const current = form.values.value[p.key] ?? p.default
  if (p.key === 'aspectRatio' || p === resolutionParam.value) {
    const opts = (p.ui.options ?? []).map((o) => o.value)
    const i = opts.findIndex((o) => String(o) === String(current))
    return form.setValue(p.key, opts[(i + (backwards ? -1 : 1) + opts.length) % opts.length])
  }
  const stops = durationStops(p)
  const now = Number(current)
  const next = backwards ? [...stops].reverse().find((s) => s < now - 0.01) ?? stops.at(-1) : stops.find((s) => s > now + 0.01) ?? stops[0]
  form.setValue(p.key, next)
}
const aspectLabel = computed(() => {
  const p = aspectParam.value
  if (!p) return ''
  const v = form.values.value[p.key] ?? p.default
  return p.ui.options?.find((o) => String(o.value) === String(v))?.label ?? String(v ?? '')
})
const resolutionLabel = computed(() => {
  const p = resolutionParam.value
  if (!p) return ''
  const v = form.values.value[p.key] ?? p.default
  return p.ui.options?.find((o) => String(o.value) === String(v))?.label ?? String(v ?? '')
})
const durationLabel = computed(() => {
  const p = durationParam.value
  const v = p ? Number(form.values.value[p.key] ?? p.default) : NaN
  return Number.isFinite(v) ? `${Math.round(v * 10) / 10} s` : ''
})
function cycleTakes(backwards = false) {
  const n = Number(generate.variants)
  const max = form.maxVariants.value
  generate.variants = String(backwards ? (n <= 1 ? max : n - 1) : n >= max ? 1 : n + 1)
}
/** Draft/Final: what Auto picks for. */
const showQuality = computed(() => generate.auto && (generate.kind === 'image' || generate.kind === 'video'))

/** Inline above the prompt for sound: who speaks (the voice) and the dialogue lines don't fit a pill. */
const inlineParams = computed(() => form.visible.value.filter((p) => !p.ui.advanced && (p.ui.control === 'voice' || p.key === 'lines')))
/** Everything else the model takes, under Advanced. */
const advancedParams = computed(() => {
  const pills = new Set([aspectParam.value?.key, durationParam.value?.key, resolutionParam.value?.key, ...inlineParams.value.map((p) => p.key), ...slotKeys.value])
  return form.visible.value.filter((p) => p.ui.control !== 'prompt' && !pills.has(p.key))
})
const advancedOpen = ref(false)
const firstError = computed(() => Object.values(form.errors.value)[0])

// ------------------------------------------------------------------------------------ cost, time, Generate

const costText = computed(() => {
  const e = form.estimate.value
  if (!e) return undefined
  return e.total === null ? 'plan price' : formatUsd(e.total)
})
const etaText = computed(() => (form.eta.value ? formatEta(form.eta.value.seconds) : undefined))
const canRun = computed(() => Boolean(form.model.value && form.available.value))

function run() {
  query.value = undefined
  void form.submit()
}

// ⌘↵ (Ctrl+↵ off a Mac) from the prompt, or from anywhere not typing into something else.
useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.repeat || e.defaultPrevented) return
  // Typing somewhere else (a canvas note, a script, a dialog) must not start a paid job.
  const focused = document.activeElement
  if (isTyping(focused) && !root.value?.contains(focused)) return
  e.preventDefault()
  run()
})

// ------------------------------------------------------------------------------------ folded

/**
 * Folded, the Composer is one slim bar — what the prompt says, the model, Generate — so the board, the steps or the
 * viewer get the room. Per workspace (Edit starts folded: its viewer needs the height). It unfolds on a click, ⌘G,
 * anything that loads it (Animate, Reuse, a recipe…) or a drop.
 */
const foldedBy = useLocalStorage<Record<string, boolean>>('composer.folded', { edit: true })
const folded = computed({
  get: () => Boolean(foldedBy.value[editor.workspace]),
  set: (v: boolean) => (foldedBy.value = { ...foldedBy.value, [editor.workspace]: v }),
})
function unfold() {
  folded.value = false
  void nextTick(() => prompt.value?.focus())
}
const foldedKind = computed(() => GROUPS.find((g) => g.id === group.value))

// open() and ⌘G bring the prompt into focus, with a short flash so the eye finds it — also when asked before this
// Composer mounted (from Plan, which has none).
const flash = ref(false)
watch(
  () => generate.focusNonce,
  async () => {
    generate.focusPending = false
    folded.value = false
    await nextTick()
    const el = prompt.value
    if (el) {
      el.focus()
      // A prompt to finish, just brought in (a recipe's "[your product]"): its first [bracket] selected, so typing
      // replaces it. Not on ⌘G over the user's own prompt, whose brackets are theirs.
      const brought = generate.request?.params?.prompt === el.value
      const blank = brought ? /\[[^\]\n]+\]/.exec(el.value) : null
      if (blank) el.setSelectionRange(blank.index, blank.index + blank[0].length)
      else el.setSelectionRange(el.value.length, el.value.length)
    } else root.value?.focus()
    flash.value = true
    setTimeout(() => (flash.value = false), 700)
  },
)
onMounted(() => {
  if (generate.focusPending) generate.focusNonce++
})
</script>

<template>
  <div
    ref="root"
    tabindex="-1"
    :class="
      cn(
        'pointer-events-auto relative w-full max-w-[880px] rounded-[18px] border bg-card px-2.5 outline-none transition-[box-shadow,border-color] focus-within:border-foreground/20',
        folded ? 'py-1.5' : 'pt-2 pb-2.5',
        floating && 'shadow-[0_22px_60px_-12px_rgb(0_0_0/0.55)]',
        (dropping || flash) && 'border-selection ring-3 ring-selection/25',
      )
    "
    data-tour="composer"
    data-composer=""
    @dragover="onDragOver"
    @dragleave="dropping = false"
    @drop="onDrop"
  >
    <!-- Outside the left edge, at the bottom: every prompt of the project, to copy, reuse or run again. -->
    <button
      v-if="floating"
      type="button"
      class="absolute right-full bottom-0 mr-2 grid size-10 place-items-center rounded-full border bg-card text-muted-foreground shadow-[0_10px_30px_-10px_rgb(0_0_0/0.45)] transition-colors hover:text-foreground"
      title="Prompt history"
      aria-label="Prompt history"
      data-composer-history=""
      @click="historyOpen = true"
    >
      <History class="size-4.5" />
    </button>
    <PromptHistory v-if="floating" v-model:open="historyOpen" />
    <!-- Folded: one bar — the prompt so far, the model, Generate. -->
    <div v-if="folded" class="flex items-center gap-2" data-composer-folded="">
      <button type="button" class="flex min-w-0 flex-1 items-center gap-2.5 rounded-full py-1 pr-1 pl-1.5 text-left" title="Open the Composer (⌘G)" data-composer-unfold="" @click="unfold">
        <component :is="foldedKind?.icon ?? Sparkles" class="size-4 shrink-0 text-muted-foreground" />
        <span :class="cn('truncate text-[13.5px]', !promptText && 'text-muted-foreground/70')">{{ promptText || placeholder }}</span>
      </button>
      <span class="hidden h-7 max-w-52 shrink-0 items-center gap-1 truncate rounded-full border px-2.5 text-xs font-medium md:inline-flex">
        <span v-if="generate.auto" class="text-violet-400">Auto ·</span><span class="truncate">{{ modelLabel }}</span>
      </span>
      <Button :disabled="form.submitting.value || !canRun" class="h-8 shrink-0 rounded-full bg-brand px-3.5 text-brand-foreground hover:bg-brand/90" data-composer-generate="" @click="run">
        <Loader2 v-if="form.submitting.value" class="animate-spin" /><ListPlus v-else-if="form.queueing.value" /><Sparkles v-else />
        {{ form.queueing.value ? 'Queue' : 'Generate' }}<span v-if="costText" class="font-mono text-[11.5px] opacity-75">· {{ costText }}</span>
      </Button>
      <button type="button" class="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Open the Composer" @click="unfold">
        <ChevronUp class="size-4" />
      </button>
    </div>
    <template v-else>
    <!-- Drag up or down to make the prompt taller or shorter; double-click for auto height. -->
    <div
      v-if="hasPrompt"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the prompt"
      tabindex="0"
      title="Drag to resize · double-click for auto height"
      class="group absolute -top-1.5 left-1/2 z-10 flex h-3 w-20 -translate-x-1/2 cursor-ns-resize touch-none items-center justify-center outline-none"
      data-composer-grip=""
      @pointerdown="startResize"
      @dblclick="promptHeight = 0"
      @keydown="resizeByKey"
    >
      <span :class="cn('h-1 w-9 rounded-full bg-foreground/15 transition-colors group-hover:bg-foreground/40 group-focus-visible:bg-foreground/40', resizing && 'bg-foreground/50')" />
    </div>

    <!--
      One row above the prompt: the pictures the model takes and the look as tiles, what else goes with the prompt as
      chips (@mentions, the brand, inputs kept for another model), and where the result goes.
    -->
    <div class="flex flex-wrap items-center gap-1.5 px-0.5 pb-2" data-composer-top="" data-composer-chips="">
      <ComposerSlots v-if="slotParams.length" :params="slotParams" :values="form.values.value" :errors="form.errors.value" @set="(key, v) => form.setValue(key, v)" />

      <!-- A clip's camera move: the move picker (worded for the model, in the prompt itself). -->
      <Popover v-if="generate.kind === 'video' && hasPrompt" v-model:open="cameraOpen">
        <PopoverTrigger as-child>
          <ComposerTile
            label="Camera"
            :value="[activeCamera?.preset.label, activeCamera ? (videoLens?.short ?? videoLens?.label) : videoLens?.label].filter(Boolean).join(' · ') || 'Auto'"
            :active="Boolean(activeCamera || videoLens)"
            :title="[activeCamera ? `Camera: ${activeCamera.phrase}` : 'Camera: Auto — add a move', videoLens ? `Lens: ${videoLens.phrase}` : ''].filter(Boolean).join(' · ')"
            data-composer-look="camera"
          >
            <template #thumb>
              <CameraMovePreview v-if="activeCamera" :preset-id="activeCamera.preset.id" />
              <LookThumb v-else axis="lens" :id="videoLens?.id" />
            </template>
          </ComposerTile>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" :class="cn('p-2.5', cameraTab === 'lens' ? 'w-[25rem]' : 'w-[22rem]')">
          <div class="mb-2 flex items-center justify-between gap-2">
            <div v-if="takesLens" class="flex gap-0.5 rounded-lg bg-field p-0.5" role="tablist">
              <button
                v-for="t in [{ id: 'move', label: 'Move', on: activeCamera }, { id: 'lens', label: 'Lens', on: videoLens }] as const"
                :key="t.id"
                type="button"
                role="tab"
                :aria-selected="cameraTab === t.id"
                :class="cn('rounded-md px-2.5 py-1 text-xs font-medium transition-colors', cameraTab === t.id ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')"
                :data-look-tab="t.id"
                @click="cameraTab = t.id"
              >
                {{ t.label }}<span v-if="t.on" class="ml-1 inline-block size-1.5 rounded-full bg-brand align-middle" />
              </button>
            </div>
            <span v-else class="text-xs font-medium">Camera move</span>
            <span class="text-[10px] text-muted-foreground">{{ cameraTab === 'lens' ? 'Goes with the prompt as it is sent' : cameraWording }}</span>
          </div>
          <LookOptions v-if="cameraTab === 'lens'" axis="lens" @picked="cameraOpen = false" />
          <CameraPresetPicker v-else :model="form.model.value" :active="activeCamera?.preset.id" :active-phrase="activeCamera?.phrase" @select="(phrase) => setCamera(phrase)" />
        </PopoverContent>
      </Popover>
      <LookTile v-for="t in lookTiles" :key="t.axis" :axis="t.axis" :tabs="t.tabs" />

      <span
        v-for="c in attachChips"
        :key="`${c.key}:${c.index}`"
        :class="cn('inline-flex h-7 max-w-64 items-center gap-1.5 rounded-full border bg-field pr-0.5 pl-0.5 text-xs', !c.used && 'opacity-50')"
        :title="c.used ? c.asset?.name : c.why"
        data-composer-chip="attachment"
        :data-role="c.role"
      >
        <img v-if="posterOf(c.asset)" :src="posterOf(c.asset)" alt="" class="h-5 w-8 shrink-0 rounded-[5px] object-cover" />
        <span v-else class="grid h-5 w-8 shrink-0 place-items-center rounded-[5px] bg-muted"><ImagePlus class="size-3 text-muted-foreground" /></span>
        <button
          v-if="['start', 'end', 'ref'].includes(c.role)"
          type="button"
          class="font-mono text-[9.5px] font-medium tracking-wider text-brand uppercase hover:underline"
          title="How it’s used: start frame, end frame or reference — click to change"
          data-composer-role=""
          @click="cycleRole(c)"
        >
          {{ ROLE_LABEL[c.role] }}
        </button>
        <span v-else class="font-mono text-[9.5px] font-medium tracking-wider text-brand uppercase">{{ ROLE_LABEL[c.role] }}</span>
        <span class="truncate">{{ c.asset?.name ?? 'Picture' }}</span>
        <button type="button" class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" :aria-label="`Remove ${c.asset?.name ?? 'it'}`" @click="removeChip(c)">
          <X class="size-3" />
        </button>
      </span>
      <span
        v-for="m in form.mentioned.value"
        :key="`m:${m.id}`"
        class="inline-flex h-7 max-w-56 items-center gap-1.5 rounded-full border bg-field pr-0.5 pl-0.5 text-xs"
        :title="m.views.length ? 'Its picture goes with the prompt where the model takes one' : 'No picture yet — named and described in words'"
        data-composer-chip="mention"
      >
        <img v-if="posterOf(assets.get(m.views[0]))" :src="posterOf(assets.get(m.views[0]))" alt="" class="size-5.5 shrink-0 rounded-full object-cover" />
        <span v-else class="grid size-5.5 shrink-0 place-items-center rounded-full bg-muted"><AtSign class="size-3 text-muted-foreground" /></span>
        <span v-if="m.kind === 'place'" class="font-mono text-[9.5px] font-medium tracking-wider text-brand uppercase">Place</span>
        <span class="truncate">@{{ m.name }}</span>
        <button type="button" class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" :aria-label="`Remove @${m.handle}`" @click="dropMention(m)">
          <X class="size-3" />
        </button>
      </span>
      <span
        v-if="form.brandApplies.value && form.brandOn.value && form.brand.value"
        class="inline-flex h-7 max-w-60 items-center gap-1.5 rounded-full border border-violet-500/30 bg-field pr-0.5 pl-2 text-xs"
        title="The brand look: its style and palette go with the prompt (Library › Brand)"
        data-composer-chip="brand"
      >
        <span class="flex shrink-0 -space-x-1">
          <span v-for="(c, i) in form.brand.value.colors.slice(0, 3)" :key="i" class="size-3 rounded-full border border-card" :style="{ background: c.hex }" />
          <Palette v-if="!form.brand.value.colors.length" class="size-3.5 text-violet-400" />
        </span>
        <span class="truncate">Look{{ form.brand.value.name ? ` · ${form.brand.value.name}` : '' }}</span>
        <button type="button" class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Turn the look off" @click="brandOff">
          <X class="size-3" />
        </button>
      </span>
      <button
        v-if="!form.selectionApplied.value && form.selectionParam.value"
        type="button"
        class="inline-flex h-7 items-center gap-1.5 rounded-full border border-dashed border-brand/50 px-2.5 text-xs text-brand hover:bg-brand/10"
        data-composer-use-selection=""
        @click="form.useSelection"
      >
        <ImagePlus class="size-3.5" /> {{ form.selectionParam.value.ui.control === 'images' && refIds.length ? 'Add' : 'Use' }} the
        {{ form.selectionIds.value.length === 1 ? 'selected image' : `${form.selectionIds.value.length} selected` }}
      </button>

      <!-- Where the result goes: click for Library only (and back). -->
      <div class="ml-auto flex shrink-0 items-center gap-1 pl-1 text-[11.5px] text-muted-foreground" data-composer-target="">
        <ArrowRight class="size-3.5 shrink-0" />
        <button
          type="button"
          :class="cn('max-w-56 truncate border-b border-dashed border-muted-foreground/50 leading-tight font-medium text-foreground', form.fallback.value && !target ? 'hover:border-foreground' : 'cursor-default')"
          :title="[`Result goes to ${destinationLabel}${destinationHint ? ` · ${destinationHint}` : ''}`, target ? '' : form.fallback.value ? (form.libraryOnly.value ? 'click to send it back here' : 'click to send it to the Library only') : 'everything lands in the Library'].filter(Boolean).join(' — ')"
          data-composer-destination=""
          @click="toggleDestination"
        >
          {{ destinationLabel }}
        </button>
        <button v-if="target" type="button" class="rounded p-0.5 hover:bg-accent hover:text-foreground" title="Forget this destination" @click="generate.target = undefined">
          <X class="size-3" />
        </button>
        <button type="button" class="grid size-6 place-items-center rounded-full hover:bg-accent hover:text-foreground" title="Fold the Composer into one bar" aria-label="Fold the Composer" data-composer-fold="" @click="folded = true">
          <ChevronDown class="size-3.5" />
        </button>
      </div>
    </div>

    <!-- Audio: which sound; Tools: which tool. -->
    <div v-if="group === 'audio' && audioKinds.length > 1" class="flex flex-wrap items-center gap-1.5 px-0.5 pb-2" data-composer-audio="">
      <div class="inline-flex rounded-full bg-field p-0.5">
        <button
          v-for="k in audioKinds"
          :key="k"
          type="button"
          :class="cn('h-6 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground', generate.kind === k && 'bg-card text-foreground shadow-sm')"
          :aria-pressed="generate.kind === k"
          @click="generate.kind = k"
        >
          {{ KIND_LABELS[k] }}
        </button>
      </div>
      <span v-if="inlineParams.some((p) => p.ui.control === 'voice')" class="text-[11px] text-muted-foreground">Pick the voice below — the characters’ voices are in Library › Cast</span>
    </div>
    <div v-else-if="group === 'tools'" class="flex flex-wrap gap-1.5 px-0.5 pb-2" data-composer-tools="">
      <button
        v-for="k in toolKinds"
        :key="k"
        type="button"
        :class="cn('flex min-w-28 flex-col items-start gap-px rounded-[10px] border bg-field px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-field-hover', generate.kind === k && 'border-foreground/60 bg-card')"
        :aria-pressed="generate.kind === k"
        @click="generate.kind = k"
      >
        <span class="font-medium">{{ KIND_LABELS[k] }}</span>
        <span class="text-[10.5px] text-muted-foreground">{{ toolCost(k) }} · needs {{ TOOL_NEEDS[k] }}</span>
      </button>
    </div>

    <div v-if="inlineParams.length" class="grid gap-2 px-1 pb-2">
      <ParamField
        v-for="p in inlineParams"
        :key="`${form.model.value?.id}.${p.key}`"
        :param="p"
        :error="form.errors.value[p.key]"
        :model-value="form.values.value[p.key]"
        @update:model-value="(v) => form.setValue(p.key, v)"
      />
    </div>

    <!-- The prompt, with @-autocomplete. -->
    <div v-if="hasPrompt" class="relative flex items-start gap-1">
      <label class="sr-only" for="composer-prompt">What to make</label>
      <textarea
        id="composer-prompt"
        ref="prompt"
        v-model="promptText"
        rows="1"
        spellcheck="false"
        class="block min-h-[30px] w-full resize-none border-0 bg-transparent px-1 pt-1 pb-2 text-[14px] leading-[1.45] outline-none placeholder:text-muted-foreground/70"
        :placeholder="placeholder"
        data-composer-prompt=""
        @input="updateQuery"
        @click="updateQuery"
        @keyup="(e) => !['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key) && updateQuery()"
        @keydown="onPromptKey"
        @blur="onPromptBlur"
      />
      <div class="flex shrink-0 items-center gap-0.5 pt-0.5">
        <button
          v-if="form.canEnhance.value"
          type="button"
          class="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          :disabled="enhancing || !promptText.trim()"
          title="Rewrite the prompt for this model (the Director)"
          @click="enhance"
        >
          <Loader2 v-if="enhancing" class="size-4 animate-spin" /><Sparkles v-else class="size-4" />
        </button>
      </div>
    </div>
    <p v-else-if="group === 'tools' && !attachChips.some((c) => c.used)" class="px-1 pt-0.5 pb-2 text-[12px] text-muted-foreground">
      Pick what to work on: select it on the board, drop it here, or use a result’s actions.
    </p>

    <Teleport to="body">
      <div
        v-if="query && mentionItems.length && menuPos"
        class="fixed z-50 max-h-[min(420px,60vh)] w-[min(460px,calc(100vw-32px))] overflow-y-auto rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-pop"
        :style="{ left: `${menuPos.left}px`, bottom: `${menuPos.bottom}px` }"
        data-mention-menu=""
        @mousedown.prevent
      >
        <template v-for="g in groupedItems" :key="g.group">
          <div class="px-2.5 pt-2 pb-1 font-mono text-[10px] font-medium tracking-widest text-muted-foreground uppercase">{{ g.group }}</div>
          <button
            v-for="item in g.items"
            :key="item.key"
            type="button"
            :class="cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left', item.i === active && 'bg-accent')"
            :data-mention-item="item.key"
            @mouseenter="active = item.i"
            @click="item.pick()"
          >
            <img v-if="item.picture" :src="item.picture" alt="" class="size-8 shrink-0 rounded-lg object-cover" />
            <span v-else class="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-violet-400">
              <Palette v-if="item.group === 'Brand'" class="size-4" /><MapPin v-else-if="item.group === 'Places'" class="size-4" /><AtSign v-else class="size-4" />
            </span>
            <span class="grid min-w-0">
              <span class="truncate text-[13px] font-medium">{{ item.name }}</span>
              <span v-if="item.sub" class="truncate text-[11px] text-muted-foreground">{{ item.sub }}</span>
            </span>
          </button>
        </template>
        <div class="mt-1 border-t px-2.5 pt-2 pb-1 text-[11px] text-muted-foreground">↑ ↓ to move · Enter to add · Esc to close</div>
      </div>
    </Teleport>

    <div v-if="form.model.value && !form.available.value" class="mx-1 mb-2 flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-1.5 text-xs" data-composer-setup="">
      <KeyRound class="size-3.5 shrink-0 text-muted-foreground" />
      <span class="min-w-0 flex-1 truncate">
        <template v-if="form.localSetup.value">{{ form.localSetup.value }}</template>
        <template v-else-if="form.model.value.provider === 'mock'">Turn on demo mode in Settings to use {{ form.model.value.label }}.</template>
        <template v-else>{{ form.providerName.value }} isn’t connected yet — {{ form.model.value.label }} needs its key.</template>
      </span>
      <Button size="xs" variant="outline" @click="form.openKeySettings()">{{ form.localSetup.value ? 'Settings' : 'Add key' }}</Button>
    </div>
    <p v-if="firstError" class="px-1 pb-1.5 text-[11px] text-destructive">{{ firstError }}</p>

    <!-- Kind · model · pills — cost · Generate. -->
    <div class="flex flex-wrap items-center gap-2">
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        <div class="inline-flex rounded-full bg-field p-0.5" role="group" aria-label="What to make" data-composer-kinds="">
          <button
            v-for="g in groups"
            :key="g.id"
            type="button"
            :class="cn('flex h-7 items-center gap-1.5 rounded-full px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground', group === g.id && 'bg-card px-2.5 text-foreground shadow-sm')"
            :aria-pressed="group === g.id"
            :aria-label="g.label"
            :title="g.label"
            :data-kind="g.id"
            @click="setGroup(g.id)"
          >
            <component :is="g.icon" class="size-3.5" /><span v-if="group === g.id">{{ g.label }}</span>
          </button>
        </div>

        <ModelPicker
          heading="Model"
          :models="form.kindModels.value"
          :auto="{ on: generate.auto, reason: form.autoChoice.value?.reason, model: form.autoChoice.value?.model }"
          :selected="form.model.value?.id"
          :cost-of="form.costOf"
          :eta-of="form.etaOf"
          :hint-of="hintOf"
          :status-of="statusOf"
          side="top"
          wide
          grouped
          :favorites="favorites.list.value"
          @auto="form.useAuto"
          @pick="(id) => id && form.pickModelByHand(id)"
          @setup="setup"
          @favorite="favorites.toggle"
        >
          <button type="button" class="flex h-7 max-w-64 items-center gap-1 rounded-full border px-2.5 text-xs font-medium hover:bg-field" :title="generate.auto ? form.autoChoice.value?.reason : undefined" data-composer-model="">
            <template v-if="generate.auto"><span class="text-violet-400">Auto</span><span class="text-muted-foreground">·</span></template>
            <span :class="cn('truncate', !form.available.value && 'text-muted-foreground')">{{ modelLabel }}</span>
            <KeyRound v-if="form.model.value && !form.available.value" class="size-3 shrink-0 text-muted-foreground" />
            <ChevronDown class="size-3.5 shrink-0 opacity-60" />
          </button>
        </ModelPicker>

        <button v-if="aspectParam" type="button" class="h-7 rounded-full border px-2.5 text-xs tabular hover:bg-field" title="Aspect ratio — click for the next (⇧-click: back)" data-composer-pill="aspect" @click="(e) => cycle(aspectParam!, e.shiftKey)">
            {{ aspectLabel }}
          </button>
          <button
            v-if="resolutionParam"
            type="button"
            class="h-7 rounded-full border px-2.5 text-xs tabular hover:bg-field"
            :title="`Resolution: ${resolutionLabel} — click for the next (⇧-click: back)${resolutionParam.ui.help ? `\n${resolutionParam.ui.help}` : ''}`"
            data-composer-pill="resolution"
            @click="(e) => cycle(resolutionParam!, e.shiftKey)"
          >
            {{ resolutionLabel.replace(/\s*\(.*\)$/, '') }}
          </button>
          <button v-if="durationParam" type="button" class="h-7 rounded-full border px-2.5 text-xs tabular hover:bg-field" title="Length — click for the next (⇧-click: back)" data-composer-pill="length" @click="(e) => cycle(durationParam!, e.shiftKey)">
            {{ durationLabel }}
          </button>
        <button
          v-if="form.maxVariants.value > 1"
          type="button"
          class="h-7 rounded-full border px-2.5 text-xs tabular hover:bg-field"
          title="How many versions — click for more (⇧-click: fewer)"
          data-composer-pill="takes"
          @click="(e) => cycleTakes(e.shiftKey)"
        >
          ×{{ generate.variants }}
        </button>
        <div v-if="showQuality" class="inline-flex rounded-full bg-field p-0.5" role="group" aria-label="Quality" data-composer-quality="">
          <button
            v-for="q in (['draft', 'final'] as const)"
            :key="q"
            type="button"
            :class="cn('h-6 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground', generate.quality === q && 'bg-card text-foreground shadow-sm')"
            :aria-pressed="generate.quality === q"
            :title="q === 'draft' ? 'Cheap, quick previews first' : 'The best model for the job'"
            @click="generate.quality = q"
          >
            {{ q === 'draft' ? 'Draft' : 'Final' }}
          </button>
        </div>

        <Popover v-if="advancedParams.length" v-model:open="advancedOpen">
          <PopoverTrigger as-child>
            <button type="button" class="grid size-7 place-items-center rounded-full border text-muted-foreground hover:bg-field hover:text-foreground" title="Advanced: everything else the model takes" data-composer-advanced="">
              <SlidersHorizontal class="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" class="max-h-[min(34rem,70vh)] w-80 overflow-y-auto p-3">
            <div class="grid grid-cols-[minmax(0,1fr)] gap-3.5">
              <div class="text-xs font-medium">{{ form.model.value?.label }}</div>
              <PresetPicker
                v-if="generate.kind === 'image' || generate.kind === 'video'"
                :kind="generate.kind"
                :preset-id="generate.auto ? undefined : form.preset.value?.id"
                @select="(p) => form.applyPreset(p)"
              />
              <ParamField
                v-for="p in advancedParams"
                :key="`${form.model.value?.id}.${p.key}`"
                :param="p"
                :error="form.errors.value[p.key]"
                :model-value="form.values.value[p.key]"
                @update:model-value="(v) => form.setValue(p.key, v)"
              />
              <button v-if="editor.workspace !== 'edit'" type="button" class="justify-self-start text-[11px] text-muted-foreground hover:text-foreground" @click="library.show('media')">Pictures and clips: Library › Media (drag them onto the Composer)</button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div class="ml-auto flex items-center gap-2.5">
        <div class="text-right font-mono text-[11.5px] leading-tight text-muted-foreground tabular" :title="form.estimate.value?.detail" data-composer-cost="">
          <template v-if="form.model.value">
            <template v-if="etaText">{{ etaText }}</template><template v-else-if="!costText">—</template>
            <div v-if="form.eta.value?.gpuStart" class="text-[10.5px] text-role-effects" title="The rented GPU is off: starting it is in the time (and adds a little to the cost, see the estimate)">GPU starts first</div>
          </template>
          <span v-else>Connect a provider</span>
        </div>
        <Button
          :disabled="form.submitting.value || !canRun"
          class="h-[34px] shrink-0 rounded-full bg-brand px-4 text-brand-foreground shadow-[0_4px_14px_-4px_var(--brand)] hover:bg-brand/90"
          :title="`${form.queueing.value ? 'Add to queue' : 'Generate'} (⌘↵)`"
          data-composer-generate=""
          @click="run"
        >
          <Loader2 v-if="form.submitting.value" class="animate-spin" />
          <ListPlus v-else-if="form.queueing.value" />
          <Sparkles v-else />
          {{ form.queueing.value ? 'Add to queue' : 'Generate' }}<span v-if="costText" class="-ml-0.5 font-mono text-[12px] opacity-75" data-composer-cost-button="">· {{ costText }}</span>
        </Button>
      </div>
    </div>
    </template>
  </div>
</template>
