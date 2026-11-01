<script setup lang="ts">
import { Camera, Frame, Group as GroupIcon, Image, Link2, Shapes, Square, Type, Unlink, Video, Wand2 } from '@lucide/vue'
import {
  type AnimItem,
  type PresetId,
  PRESETS,
  applyPreset,
  cleanTrack,
  presetDef,
  presetTrack,
  snapshotFrame,
  staggerTracks,
  trackValues,
  zoomToItem,
} from '@shared/motion/edit'
import { DEFAULT_CAMERA, isMotionItem, motionSource, motionTime } from '@shared/motion/evaluate'
import * as ops from '@shared/timeline'
import type { TimelineRecipe as Recipe } from '@shared/timeline'
import type {
  KeyEase,
  Keyframe,
  MotionBehavior,
  MotionBehaviorKind,
  MotionCamera,
  MotionClip,
  MotionItemTransform,
  MotionTrack,
  MotionWordAnchor,
  RevealMode,
} from '@shared/types/project-doc'
import { anchorFrame, anchorShifts, anchoredClip, unanchorTracks, voiceTimings } from '@shared/motion/anchors'
import { formatTimecode } from '@shared/time/timecode'
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { transport } from '@/features/editor/transport'
import { openInCanvas } from '@/features/canvas/animate'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { useProjectStore } from '@/stores/project'
import InspectorSlider from './InspectorSlider.vue'
import KeyframeBar from './KeyframeBar.vue'

/**
 * A motion clip in the inspector: its frame's elements with one-click animations and keys at the playhead, scene-wide
 * presets and the camera. Keys are animation frames (the clip's frame + its offset), so blades don't move them.
 */
const props = defineProps<{ clip: MotionClip; localFrame: number; clipStart: number }>()

const project = useProjectStore()
const assets = useAssetsStore()
const fps = computed(() => project.doc.settings.fps)

const source = computed(() => motionSource(props.clip, project.doc.canvas))
/**
 * The clip as it plays: tracks timed to the voice-over moved onto their words. The inspector shows and edits that;
 * `shifts` turns edits back into the keys as stored.
 */
const voices = computed(() => voiceTimings(project.layout, (id) => assets.get(id)?.alignment?.words))
const shifts = computed(() => anchorShifts(props.clip, props.clipStart, voices.value, fps.value))
const shown = computed(() => anchoredClip(props.clip, shifts.value))
/** Elements and groups of the frame, each group followed by its members (indented by `depth`). */
const rows = computed(() => {
  const all = source.value.items.filter((i): i is AnimItem => isMotionItem(i) || i.kind === 'group')
  const ids = new Set(all.map((i) => i.id))
  const out: { item: AnimItem; depth: number }[] = []
  const add = (parent: string | undefined, depth: number) => {
    for (const i of all) {
      const p = i.groupId && ids.has(i.groupId) ? i.groupId : undefined
      if (p !== parent) continue
      out.push({ item: i, depth })
      if (i.kind === 'group') add(i.id, depth + 1)
    }
  }
  add(undefined, 0)
  return out
})
const items = computed(() => rows.value.map((r) => r.item))
/** What "Stagger in all" runs over: groups as one, plus everything outside a group. */
const topLevel = computed(() => rows.value.filter((r) => r.depth === 0).map((r) => r.item))
const t = computed(() => motionTime(props.clip, props.localFrame))
const selectedId = ref<string>()
watch(
  () => [props.clip.id, items.value.map((i) => i.id).join()],
  () => {
    if (!items.value.some((i) => i.id === selectedId.value)) selectedId.value = items.value[0]?.id
  },
  { immediate: true },
)
const selected = computed(() => items.value.find((i) => i.id === selectedId.value))
const track = computed(() => (selectedId.value ? shown.value.tracks[selectedId.value] : undefined))
const now = computed(() => trackValues(track.value, t.value))

// Timing of one-click animations, in seconds (kept while you click through elements).
const length = ref(0.6)
const delay = ref(0)
const step = ref(0.25)
const staggerPreset = ref<PresetId>('slide-up-in')
const timing = () => ({ frames: Math.round(length.value * fps.value), delay: Math.round(delay.value * fps.value) })

// ---- writing: sliders preview live and commit one history entry; buttons commit at once
function live(label: string, recipe: Recipe) {
  if (!project.dragging()) project.beginDrag(label)
  project.previewDrag(recipe)
}
const commit = () => project.commitDrag()

function tracksWith(id: string, next: MotionTrack | undefined): MotionClip['tracks'] {
  const tracks = { ...shown.value.tracks }
  const clean = next && cleanTrack(next)
  if (clean) tracks[id] = clean
  else delete tracks[id]
  return unanchorTracks(tracks, shifts.value)
}
function writeTrack(label: string, id: string, next: MotionTrack | undefined, liveEdit = false) {
  const recipe = ops.setProps(props.clip.id, { tracks: tracksWith(id, next) })
  if (liveEdit) live(label, recipe)
  else project.apply(recipe, label)
}

function preset(id: PresetId) {
  const item = selected.value
  const frame = source.value.frame
  if (!item || !frame) return
  const routeId = items.value.find((i) => i.kind === 'shape' && i.id !== item.id)?.id
  writeTrack(presetDef(id).label, item.id, applyPreset(track.value, presetTrack(id, props.clip, timing(), frame.h, { item, routeId }), presetDef(id).side, props.clip))
}
function staggerAll() {
  const frame = source.value.frame
  if (!frame) return
  const tracks = staggerTracks(shown.value.tracks, topLevel.value, staggerPreset.value, props.clip, { ...timing(), step: Math.round(step.value * fps.value) }, frame.h)
  project.apply(ops.setProps(props.clip.id, { tracks: unanchorTracks(tracks, shifts.value) }), 'Stagger in all')
}
function clearAnimation() {
  if (selected.value) writeTrack('Clear animation', selected.value.id, undefined)
}

// ---- keys of the selected element at the playhead
type Prop = 'opacity' | 'transform' | 'reveal' | 'trim' | 'stretch' | 'color' | 'blur'
const keys = (prop: Prop) => (track.value?.[prop] ?? []) as Keyframe<unknown>[]
/** The element's colour as the board has it: text colour, a solid fill, else the outline. */
const baseColor = computed(() => {
  const it = selected.value
  if (it?.kind === 'text') return it.color
  if (it?.kind === 'shape') return typeof it.fill === 'string' && it.fill !== 'none' ? it.fill : (it.stroke?.color ?? '#ffffff')
  return '#ffffff'
})
const colorNow = computed(() => now.value.color ?? baseColor.value)
function valueNow(prop: Prop): unknown {
  if (prop === 'transform') return { ...now.value.transform }
  if (prop === 'trim') return { ...now.value.trim }
  if (prop === 'stretch') return { ...now.value.stretch }
  if (prop === 'color') return colorNow.value
  return now.value[prop]
}
function withKeys(prop: Prop, list: Keyframe<unknown>[]): MotionTrack {
  return { ...track.value, [prop]: list }
}
function toggleKey(prop: Prop) {
  const id = selectedId.value
  if (!id) return
  const list = keys(prop)
  if (ops.keyAt(list, t.value)) writeTrack('Remove keyframe', id, withKeys(prop, ops.removeKey(list, t.value)))
  else writeTrack('Add keyframe', id, withKeys(prop, ops.upsertKey(list, t.value, valueNow(prop))))
}
function setEase(prop: Prop, ease: KeyEase) {
  const id = selectedId.value
  if (id) writeTrack('Keyframe easing', id, withKeys(prop, keys(prop).map((k) => (k.frame === t.value ? { ...k, ease } : k))))
}
function clearKeys(prop: Prop) {
  const id = selectedId.value
  if (id) writeTrack('Clear keyframes', id, withKeys(prop, []))
}
/** A slider writes a key at the playhead (the first one makes the property animated from a constant). */
function setValue(prop: 'opacity' | 'reveal', value: number) {
  const id = selectedId.value
  if (id) writeTrack(prop === 'opacity' ? 'Opacity' : 'Reveal', id, withKeys(prop, ops.upsertKey(keys(prop), t.value, value)), true)
}
function setTransform(field: keyof MotionItemTransform, value: number) {
  const id = selectedId.value
  if (id) writeTrack('Move element', id, withKeys('transform', ops.upsertKey(keys('transform'), t.value, { ...now.value.transform, [field]: value })), true)
}
function setStretch(field: 'x' | 'y', value: number) {
  const id = selectedId.value
  if (id) writeTrack('Stretch', id, withKeys('stretch', ops.upsertKey(keys('stretch'), t.value, { ...now.value.stretch, [field]: value })), true)
}
function setColor(value: string) {
  const id = selectedId.value
  if (id) writeTrack('Colour', id, withKeys('color', ops.upsertKey(keys('color'), t.value, value)))
}
function setBlur(value: number) {
  const id = selectedId.value
  if (id) writeTrack('Blur', id, withKeys('blur', ops.upsertKey(keys('blur'), t.value, value)), true)
}
// ---- behaviours and looping keys
const BEHAVIORS: { kind: MotionBehaviorKind; label: string; amount: number; period: number; unit: string }[] = [
  { kind: 'float', label: 'Float', amount: 20, period: 2, unit: 'px' },
  { kind: 'wiggle', label: 'Wiggle', amount: 15, period: 0.5, unit: 'px' },
  { kind: 'shake', label: 'Shake', amount: 12, period: 0.08, unit: 'px' },
  { kind: 'spin', label: 'Spin', amount: 360, period: 4, unit: '°/cycle' },
  { kind: 'orbit', label: 'Orbit', amount: 40, period: 3, unit: 'px' },
  { kind: 'pulse', label: 'Pulse', amount: 0.08, period: 1, unit: '×' },
]
const behaviorDef = (kind: MotionBehaviorKind) => BEHAVIORS.find((b) => b.kind === kind)!
const behaviors = computed(() => track.value?.behaviors ?? [])
function writeBehaviors(list: MotionBehavior[], label: string) {
  const id = selectedId.value
  if (id) writeTrack(label, id, { ...track.value, behaviors: list.length ? list : undefined })
}
function addBehavior(kind: unknown) {
  const def = behaviorDef(kind as MotionBehaviorKind)
  writeBehaviors([...behaviors.value, { kind: def.kind, amount: def.amount, period: Math.max(1, Math.round(def.period * fps.value)), seed: behaviors.value.length + 1 }], def.label)
}
function patchBehavior(i: number, p: Partial<MotionBehavior>) {
  writeBehaviors(behaviors.value.map((b, j) => (j === i ? { ...b, ...p } : b)), 'Behaviour')
}
/** Repeats the element's keys from its first key to its last, for the rest of the clip. */
function toggleLoop(on: boolean) {
  const id = selectedId.value
  if (!id || !track.value) return
  const frames = (['opacity', 'transform', 'reveal', 'trim', 'stretch', 'color', 'blur'] as Prop[]).flatMap((p) => keys(p).map((k) => k.frame))
  if (on && frames.length < 2) return
  writeTrack('Loop keys', id, { ...track.value, loop: on ? { from: Math.min(...frames), to: Math.max(...frames) } : undefined })
}

// ---- following a route
const routes = computed(() => items.value.filter((i) => i.kind === 'shape' && i.id !== selectedId.value))
const followKeys = computed(() => track.value?.follow?.progress ?? [])
const followNow = computed(() => ops.keyframeValue(followKeys.value, t.value, 0))
function setFollow(pathId: string) {
  const id = selectedId.value
  if (!id) return
  if (pathId === 'none') return writeTrack('Stop following', id, { ...track.value, follow: undefined })
  // A route starts as a ride over the whole clip.
  const { start, end } = { start: props.clip.offset ?? 0, end: (props.clip.offset ?? 0) + props.clip.duration - 1 }
  const progress = track.value?.follow?.progress.length
    ? track.value.follow.progress
    : [
        { frame: start, value: 0, ease: 'ease-in-out' as const },
        { frame: end, value: 1 },
      ]
  writeTrack('Follow path', id, { ...track.value, follow: { ...track.value?.follow, pathId, progress } })
}
function patchFollow(patch: Partial<NonNullable<MotionTrack['follow']>>, label: string, liveEdit = false) {
  const id = selectedId.value
  const f = track.value?.follow
  if (id && f) writeTrack(label, id, { ...track.value, follow: { ...f, ...patch } }, liveEdit)
}
function toggleFollowKey() {
  const list = followKeys.value
  patchFollow({ progress: ops.keyAt(list, t.value) ? ops.removeKey(list, t.value) : ops.upsertKey(list, t.value, followNow.value) }, 'Keyframe')
}

function setTrim(field: 'start' | 'end', value: number) {
  const id = selectedId.value
  if (id) writeTrack('Trim', id, withKeys('trim', ops.upsertKey(keys('trim'), t.value, { ...now.value.trim, [field]: value })), true)
}
function setRevealMode(mode: RevealMode) {
  const id = selectedId.value
  if (id) writeTrack('Reveal', id, { ...track.value, revealMode: mode, reveal: track.value?.reveal ?? [] })
}
/** Moves the playhead to an animation frame of this clip. */
function seekAnim(frame: number | undefined) {
  if (frame !== undefined) transport.seek(props.clipStart + frame - (props.clip.offset ?? 0))
}

// ---- camera
const cameraKeys = computed(() => props.clip.camera ?? [])
const cameraNow = computed(() => ops.keyframeObject(cameraKeys.value, t.value, { ...DEFAULT_CAMERA }))
function writeCamera(label: string, list: Keyframe<MotionCamera>[], liveEdit = false) {
  const recipe = ops.setProps(props.clip.id, { camera: list.length ? list : null })
  if (liveEdit) live(label, recipe)
  else project.apply(recipe, label)
}
function toggleCameraKey() {
  const list = cameraKeys.value
  if (ops.keyAt(list, t.value)) writeCamera('Remove keyframe', ops.removeKey(list, t.value))
  else writeCamera('Add keyframe', ops.upsertKey(list, t.value, { ...cameraNow.value }))
}
function setCamera(field: keyof MotionCamera, value: number) {
  writeCamera('Camera', ops.upsertKey(cameraKeys.value, t.value, { ...cameraNow.value, [field]: value }), true)
}
function zoomTo(itemId: unknown) {
  const frame = source.value.frame
  const item = items.value.find((i) => i.id === itemId)
  if (frame && item) writeCamera('Camera: zoom to element', zoomToItem(props.clip.camera, frame, item, t.value, Math.round(length.value * fps.value)))
}

// ---- timed to the voice-over
const anchorAt = computed(() => {
  const a = track.value?.anchor
  if (!a) return undefined
  const pool = a.clipId ? voices.value.filter((v) => v.clipId === a.clipId) : voices.value.filter((v) => v.end > props.clipStart && v.start < props.clipStart + props.clip.duration)
  return { said: anchorFrame(a, pool, fps.value), voiced: pool.length > 0 }
})
function setAnchor(patch: Partial<MotionWordAnchor> | null) {
  const id = selectedId.value
  if (!id || !track.value) return
  const next = patch && { text: '', ...track.value.anchor, ...patch }
  writeTrack(next?.text?.trim() ? 'Time to the voice-over' : 'Stop timing to the voice-over', id, { ...track.value, anchor: next?.text?.trim() ? { ...next, text: next.text.trim() } : undefined })
}

// ---- over the whole timeline, and following the clip's progress
const connected = computed(() => project.doc.connected.some((c) => c.id === props.clip.id))
function setSpan(on: boolean) {
  project.apply(ops.setProps(props.clip.id, { span: on ? 'timeline' : null }), on ? 'Cover the whole timeline' : 'Stop covering the timeline')
}
function setProgress(v: string) {
  const id = selectedId.value
  if (id) writeTrack('Follow the progress', id, { ...track.value, progress: v === 'none' ? undefined : (v as 'reveal' | 'trim') })
}

// ---- following the board or not
function detach() {
  const snapshot = snapshotFrame(source.value)
  if (snapshot) project.apply(ops.setProps(props.clip.id, { detached: snapshot }), 'Detach from board')
}
function follow() {
  project.apply(ops.setProps(props.clip.id, { detached: null }), 'Follow the board again')
}

// ---- labels
function itemLabel(item: AnimItem): string {
  if (item.name) return item.name
  if (item.kind === 'group') return 'Group'
  if (item.kind === 'text') return item.text.trim().split('\n')[0]!.slice(0, 40) || 'Text'
  if (item.kind === 'shape') return item.shape === 'rect' ? 'Rectangle' : item.shape[0]!.toUpperCase() + item.shape.slice(1)
  return assets.get(item.assetId)?.name ?? 'Picture'
}
function itemIcon(item: AnimItem) {
  if (item.kind === 'group') return GroupIcon
  if (item.kind === 'text') return Type
  if (item.kind === 'shape') return Square
  return assets.get(item.assetId)?.kind === 'video' ? Video : Image
}
const keyCount = (id: string) => {
  const tr = shown.value.tracks[id]
  return ['opacity', 'transform', 'reveal', 'trim', 'stretch', 'color', 'blur'].reduce((n, k) => n + ((tr?.[k as Prop] as unknown[] | undefined)?.length ?? 0), 0)
}
const seconds = (v: number) => `${v.toFixed(2)}s`
const TEXT = (i: AnimItem) => i.kind === 'text'
const REVEALS: { value: RevealMode; label: string; fits?: (i: AnimItem) => boolean }[] = [
  { value: 'typewriter', label: 'Typewriter', fits: TEXT },
  { value: 'words', label: 'Words', fits: TEXT },
  { value: 'words-rise', label: 'Words rise', fits: TEXT },
  { value: 'words-pop', label: 'Words pop', fits: TEXT },
  { value: 'words-blur', label: 'Words unblur', fits: TEXT },
  { value: 'letters-rise', label: 'Letters rise', fits: TEXT },
  { value: 'letters-fade', label: 'Letters fade', fits: TEXT },
  { value: 'highlight-sweep', label: 'Highlight sweep', fits: TEXT },
  { value: 'roll', label: 'Count up (numbers)', fits: TEXT },
  { value: 'wipe-left', label: 'Wipe left' },
  { value: 'wipe-up', label: 'Wipe up' },
  { value: 'draw', label: 'Draw outline', fits: (i) => i.kind === 'shape' },
]
function setRollFrom(v: number) {
  const id = selectedId.value
  if (id) writeTrack('Count from', id, { ...track.value, rollFrom: v || undefined })
}
</script>

<template>
  <section class="grid gap-2.5">
    <div class="flex items-center justify-between">
      <span class="flex items-center gap-2 text-[13px] font-semibold tracking-tight"><Shapes class="size-4 text-muted-foreground" /> Motion</span>
      <div class="flex items-center gap-1">
        <Button v-if="!clip.detached && source.frame" size="xs" variant="outline" title="Animate on the board, with a scrubber" @click="openInCanvas(clip.id)"><Frame /> Open in Canvas</Button>
        <Button v-if="!clip.detached && source.frame" size="xs" variant="ghost" title="Keep a copy of the frame: changes on the board no longer show here" @click="detach"><Unlink /> Detach</Button>
        <Button v-if="clip.detached" size="xs" variant="outline" title="Play the frame as it is on the board again" @click="follow"><Link2 /> Follow board</Button>
      </div>
    </div>
    <p v-if="!source.frame" class="rounded-lg bg-field px-2.5 py-2 text-[11px] text-muted-foreground">
      The frame was deleted from the board, so the clip shows “Missing frame”. Undo the deletion to bring it back.
    </p>
    <p v-else-if="clip.detached" class="text-[11px] text-muted-foreground">Detached: plays its own copy of “{{ source.frame.name ?? 'Frame' }}”.</p>

    <template v-if="source.frame">
      <label v-if="connected" class="flex items-center gap-2 text-[11px] text-muted-foreground">
        <input type="checkbox" :checked="clip.span === 'timeline'" @change="(e) => setSpan((e.target as HTMLInputElement).checked)" />
        Over the whole timeline (a header or a progress bar, on top of everything)
      </label>
      <!-- Timing for one-click animations -->
      <InspectorSlider label="Length" :value="length" :min="0.1" :max="3" :step="0.05" :reset-to="0.6" :format="seconds" @live="(v) => (length = v)" @commit="() => {}" />
      <InspectorSlider label="Delay" :value="delay" :min="0" :max="Math.max(0.1, clip.duration / fps / 2)" :step="0.05" :reset-to="0" :format="seconds" @live="(v) => (delay = v)" @commit="() => {}" />
      <p class="-mt-1 text-[10px] leading-snug text-muted-foreground">Entrances start this long after the clip starts; exits end this long before it ends.</p>

      <!-- Scene -->
      <div class="grid grid-cols-[1fr_auto] items-center gap-1.5">
        <Select v-model="staggerPreset">
          <SelectTrigger class="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem v-for="p in PRESETS.filter((p) => p.side === 'in')" :key="p.id" :value="p.id">{{ p.label }}</SelectItem></SelectContent>
        </Select>
        <Button size="xs" variant="outline" @click="staggerAll"><Wand2 /> Stagger in all</Button>
      </div>
      <InspectorSlider label="Stagger step" :value="step" :min="0" :max="1.5" :step="0.05" :reset-to="0.25" :format="seconds" @live="(v) => (step = v)" @commit="() => {}" />

      <!-- Elements -->
      <div class="grid gap-1">
        <span class="text-[11px] font-medium text-muted-foreground">Elements</span>
        <button
          v-for="{ item, depth } in rows"
          :key="item.id"
          type="button"
          :class="cn('flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors', item.id === selectedId ? 'bg-selection/15 ring-1 ring-selection' : 'bg-field hover:bg-field/70')"
          :style="{ marginLeft: `${depth * 14}px` }"
          @click="selectedId = item.id"
        >
          <component :is="itemIcon(item)" class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate">{{ itemLabel(item) }}</span>
          <span v-if="keyCount(item.id)" class="shrink-0 rounded bg-role-motion/20 px-1 text-[10px] text-foreground/80">{{ keyCount(item.id) }} keys</span>
        </button>
        <p v-if="!items.length" class="text-[11px] text-muted-foreground">The frame is empty: add text, shapes or pictures to it on the board.</p>
      </div>

      <!-- Selected element -->
      <div v-if="selected" class="grid gap-2 rounded-xl bg-field/60 p-2.5">
        <div class="flex flex-wrap gap-1">
          <Button v-for="p in PRESETS.filter((p) => p.fits(selected!) && (!p.route || routes.length))" :key="p.id" size="xs" variant="outline" @click="preset(p.id)">{{ p.label }}</Button>
          <Button size="xs" variant="ghost" :disabled="!track" @click="clearAnimation">Clear</Button>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-medium text-muted-foreground">Opacity</span>
          <KeyframeBar
            :count="keys('opacity').length"
            :on-key="Boolean(ops.keyAt(keys('opacity'), t))"
            :ease="ops.keyAt(keys('opacity'), t)?.ease"
            :has-prev="ops.adjacentKey(keys('opacity'), t, -1) !== undefined"
            :has-next="ops.adjacentKey(keys('opacity'), t, 1) !== undefined"
            @toggle="toggleKey('opacity')"
            @prev="seekAnim(ops.adjacentKey(keys('opacity'), t, -1))"
            @next="seekAnim(ops.adjacentKey(keys('opacity'), t, 1))"
            @ease="(e) => setEase('opacity', e)"
            @clear="clearKeys('opacity')"
          />
        </div>
        <InspectorSlider label="Opacity" :value="now.opacity" :min="0" :max="1" :step="0.01" :reset-to="1" :format="(v) => `${Math.round(v * 100)}%`" @live="(v) => setValue('opacity', v)" @commit="commit" />
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-medium text-muted-foreground">Move</span>
          <KeyframeBar
            :count="keys('transform').length"
            :on-key="Boolean(ops.keyAt(keys('transform'), t))"
            :ease="ops.keyAt(keys('transform'), t)?.ease"
            :has-prev="ops.adjacentKey(keys('transform'), t, -1) !== undefined"
            :has-next="ops.adjacentKey(keys('transform'), t, 1) !== undefined"
            @toggle="toggleKey('transform')"
            @prev="seekAnim(ops.adjacentKey(keys('transform'), t, -1))"
            @next="seekAnim(ops.adjacentKey(keys('transform'), t, 1))"
            @ease="(e) => setEase('transform', e)"
            @clear="clearKeys('transform')"
          />
        </div>
        <InspectorSlider label="Offset X" :value="now.transform.x" :min="-source.frame.w" :max="source.frame.w" :step="1" :reset-to="0" :format="(v) => `${Math.round(v)}`" @live="(v) => setTransform('x', v)" @commit="commit" />
        <InspectorSlider label="Offset Y" :value="now.transform.y" :min="-source.frame.h" :max="source.frame.h" :step="1" :reset-to="0" :format="(v) => `${Math.round(v)}`" @live="(v) => setTransform('y', v)" @commit="commit" />
        <InspectorSlider label="Scale" :value="now.transform.scale" :min="0" :max="3" :step="0.01" :reset-to="1" :format="(v) => `${Math.round(v * 100)}%`" @live="(v) => setTransform('scale', v)" @commit="commit" />
        <InspectorSlider label="Rotation" :value="now.transform.rotation" :min="-180" :max="180" :step="0.5" :reset-to="0" :format="(v) => `${v}°`" @live="(v) => setTransform('rotation', v)" @commit="commit" />
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-medium text-muted-foreground">Stretch</span>
          <KeyframeBar
            :count="keys('stretch').length"
            :on-key="Boolean(ops.keyAt(keys('stretch'), t))"
            :ease="ops.keyAt(keys('stretch'), t)?.ease"
            :has-prev="ops.adjacentKey(keys('stretch'), t, -1) !== undefined"
            :has-next="ops.adjacentKey(keys('stretch'), t, 1) !== undefined"
            @toggle="toggleKey('stretch')"
            @prev="seekAnim(ops.adjacentKey(keys('stretch'), t, -1))"
            @next="seekAnim(ops.adjacentKey(keys('stretch'), t, 1))"
            @ease="(e) => setEase('stretch', e)"
            @clear="clearKeys('stretch')"
          />
        </div>
        <InspectorSlider label="Width" :value="now.stretch.x" :min="-2" :max="3" :step="0.01" :reset-to="1" :format="(v) => `${Math.round(v * 100)}%`" @live="(v) => setStretch('x', v)" @commit="commit" />
        <InspectorSlider label="Height" :value="now.stretch.y" :min="-2" :max="3" :step="0.01" :reset-to="1" :format="(v) => `${Math.round(v * 100)}%`" @live="(v) => setStretch('y', v)" @commit="commit" />
        <div v-if="selected.kind === 'text' || selected.kind === 'shape'" class="flex items-center justify-between gap-2">
          <label class="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
            Colour
            <input type="color" :value="colorNow.slice(0, 7)" class="h-6 w-10 cursor-pointer rounded border bg-transparent" @change="(e) => setColor((e.target as HTMLInputElement).value)" />
          </label>
          <KeyframeBar
            :count="keys('color').length"
            :on-key="Boolean(ops.keyAt(keys('color'), t))"
            :ease="ops.keyAt(keys('color'), t)?.ease"
            :has-prev="ops.adjacentKey(keys('color'), t, -1) !== undefined"
            :has-next="ops.adjacentKey(keys('color'), t, 1) !== undefined"
            @toggle="toggleKey('color')"
            @prev="seekAnim(ops.adjacentKey(keys('color'), t, -1))"
            @next="seekAnim(ops.adjacentKey(keys('color'), t, 1))"
            @ease="(e) => setEase('color', e)"
            @clear="clearKeys('color')"
          />
        </div>
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-medium text-muted-foreground">Blur</span>
          <KeyframeBar
            :count="keys('blur').length"
            :on-key="Boolean(ops.keyAt(keys('blur'), t))"
            :ease="ops.keyAt(keys('blur'), t)?.ease"
            :has-prev="ops.adjacentKey(keys('blur'), t, -1) !== undefined"
            :has-next="ops.adjacentKey(keys('blur'), t, 1) !== undefined"
            @toggle="toggleKey('blur')"
            @prev="seekAnim(ops.adjacentKey(keys('blur'), t, -1))"
            @next="seekAnim(ops.adjacentKey(keys('blur'), t, 1))"
            @ease="(e) => setEase('blur', e)"
            @clear="clearKeys('blur')"
          />
        </div>
        <InspectorSlider label="Blur" :value="now.blur" :min="0" :max="80" :step="0.5" :reset-to="0" :format="(v) => `${v}`" @live="(v) => setBlur(v)" @commit="commit" />
        <InspectorSlider
          label="Motion blur"
          :value="track?.motionBlur ?? 0"
          :min="0"
          :max="1"
          :step="0.05"
          :reset-to="0"
          :format="(v) => (v ? `${Math.round(v * 360)}°` : 'Off')"
          @live="(v) => selectedId && writeTrack('Motion blur', selectedId, { ...track, motionBlur: v || undefined }, true)"
          @commit="commit"
        />
        <!-- Timed to the voice-over: the keys move together onto the words -->
        <div v-if="track" class="grid gap-1">
          <label class="grid grid-cols-[auto_1fr] items-center gap-2 text-[11px] text-muted-foreground">
            Starts on
            <input
              type="text"
              :value="track.anchor?.text ?? ''"
              placeholder="words in the voice-over…"
              class="h-6 rounded-md border bg-transparent px-1.5 text-xs text-foreground"
              @change="(e) => setAnchor({ text: (e.target as HTMLInputElement).value })"
            />
          </label>
          <div v-if="track.anchor" class="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span v-if="anchorAt?.said !== undefined">Said at {{ formatTimecode(anchorAt!.said!, fps) }}</span>
            <span v-else-if="anchorAt?.voiced" class="text-destructive">Not said in this clip's voice-over</span>
            <span v-else class="text-destructive">No voice-over with word timings under this clip</span>
            <label class="flex items-center gap-1">
              frames
              <input
                type="number"
                :value="track.anchor.offset ?? 0"
                class="h-5 w-12 rounded border bg-transparent px-1 text-right text-[10px] text-foreground"
                @change="(e) => setAnchor({ offset: Math.round(Number((e.target as HTMLInputElement).value) || 0) || undefined })"
              />
            </label>
          </div>
        </div>
        <!-- Behaviours: motion from time and a seed, no keys -->
        <div class="grid gap-1.5">
          <div class="flex items-center justify-between gap-2">
            <span class="text-[11px] font-medium text-muted-foreground">Behaviours</span>
            <Select :model-value="''" @update:model-value="addBehavior">
              <SelectTrigger class="h-6 w-auto gap-1 px-1.5 text-[11px]"><SelectValue placeholder="Add…" /></SelectTrigger>
              <SelectContent><SelectItem v-for="b in BEHAVIORS" :key="b.kind" :value="b.kind">{{ b.label }}</SelectItem></SelectContent>
            </Select>
          </div>
          <div v-for="(b, i) in behaviors" :key="i" class="grid grid-cols-[1fr_4.5rem_4.5rem_auto] items-center gap-1.5 text-[11px]">
            <span>{{ behaviorDef(b.kind).label }}</span>
            <input
              type="number"
              :title="`Amount (${behaviorDef(b.kind).unit})`"
              :value="b.amount"
              :step="b.kind === 'pulse' ? 0.01 : 1"
              class="h-6 rounded-md border bg-transparent px-1 text-right text-xs"
              @change="(e) => patchBehavior(i, { amount: Number((e.target as HTMLInputElement).value) || 0 })"
            />
            <input
              type="number"
              title="Seconds per cycle"
              :value="+(b.period / fps).toFixed(2)"
              step="0.05"
              min="0.05"
              class="h-6 rounded-md border bg-transparent px-1 text-right text-xs"
              @change="(e) => patchBehavior(i, { period: Math.max(1, Math.round((Number((e.target as HTMLInputElement).value) || 1) * fps)) })"
            />
            <button type="button" class="px-1 text-muted-foreground hover:text-foreground" title="Remove" @click="writeBehaviors(behaviors.filter((_, j) => j !== i), 'Remove behaviour')">×</button>
          </div>
          <label class="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input type="checkbox" :checked="Boolean(track?.loop)" :disabled="!track" @change="(e) => toggleLoop((e.target as HTMLInputElement).checked)" /> Repeat the keys
          </label>
        </div>
        <div class="flex items-center justify-between gap-2">
          <Select :model-value="track?.follow?.pathId ?? 'none'" @update:model-value="(v) => setFollow(String(v))">
            <SelectTrigger class="h-6 w-auto gap-1 px-1.5 text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Stays in place</SelectItem>
              <SelectItem v-for="r in routes" :key="r.id" :value="r.id">Follows {{ itemLabel(r) }}</SelectItem>
            </SelectContent>
          </Select>
          <KeyframeBar
            v-if="track?.follow"
            :count="followKeys.length"
            :on-key="Boolean(ops.keyAt(followKeys, t))"
            :ease="ops.keyAt(followKeys, t)?.ease"
            :has-prev="ops.adjacentKey(followKeys, t, -1) !== undefined"
            :has-next="ops.adjacentKey(followKeys, t, 1) !== undefined"
            @toggle="toggleFollowKey"
            @prev="seekAnim(ops.adjacentKey(followKeys, t, -1))"
            @next="seekAnim(ops.adjacentKey(followKeys, t, 1))"
            @ease="(e) => patchFollow({ progress: followKeys.map((k) => (k.frame === t ? { ...k, ease: e } : k)) }, 'Keyframe easing')"
            @clear="patchFollow({ progress: [] }, 'Clear keyframes')"
          />
        </div>
        <template v-if="track?.follow">
          <InspectorSlider label="Along" :value="followNow" :min="0" :max="1" :step="0.005" :reset-to="0" :format="(v) => `${Math.round(v * 100)}%`" @live="(v) => patchFollow({ progress: ops.upsertKey(followKeys, t, v) }, 'Along the path', true)" @commit="commit" />
          <label class="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input type="checkbox" :checked="Boolean(track.follow.orient)" @change="(e) => patchFollow({ orient: (e.target as HTMLInputElement).checked || undefined }, 'Turn with the path')" /> Turn with the path
          </label>
        </template>
        <label v-if="selected.kind !== 'group'" class="grid grid-cols-[1fr_auto] items-center gap-2 text-[11px] text-muted-foreground">
          Follows the clip's progress
          <Select :model-value="track?.progress ?? 'none'" @update:model-value="(v) => setProgress(String(v))">
            <SelectTrigger class="h-6 w-auto gap-1 px-1.5 text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No</SelectItem>
              <SelectItem value="reveal">Its reveal (a bar filling up)</SelectItem>
              <SelectItem v-if="selected.kind === 'shape'" value="trim">Its outline (a line drawing on)</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <div v-if="selected.kind !== 'group'" class="flex items-center justify-between gap-2">
          <Select :model-value="track?.revealMode ?? ''" @update:model-value="(v) => setRevealMode(v as RevealMode)">
            <SelectTrigger class="h-6 w-auto gap-1 px-1.5 text-[11px]"><SelectValue placeholder="Reveal…" /></SelectTrigger>
            <SelectContent><SelectItem v-for="r in REVEALS.filter((r) => !r.fits || r.fits(selected!))" :key="r.value" :value="r.value">{{ r.label }}</SelectItem></SelectContent>
          </Select>
          <KeyframeBar
            v-if="track?.revealMode"
            :count="keys('reveal').length"
            :on-key="Boolean(ops.keyAt(keys('reveal'), t))"
            :ease="ops.keyAt(keys('reveal'), t)?.ease"
            :has-prev="ops.adjacentKey(keys('reveal'), t, -1) !== undefined"
            :has-next="ops.adjacentKey(keys('reveal'), t, 1) !== undefined"
            @toggle="toggleKey('reveal')"
            @prev="seekAnim(ops.adjacentKey(keys('reveal'), t, -1))"
            @next="seekAnim(ops.adjacentKey(keys('reveal'), t, 1))"
            @ease="(e) => setEase('reveal', e)"
            @clear="clearKeys('reveal')"
          />
        </div>
 <template v-if="selected.kind === 'shape'">
          <div class="flex items-center justify-between">
            <span class="text-[11px] font-medium text-muted-foreground">Trim outline</span>
            <KeyframeBar
              :count="keys('trim').length"
              :on-key="Boolean(ops.keyAt(keys('trim'), t))"
              :ease="ops.keyAt(keys('trim'), t)?.ease"
              :has-prev="ops.adjacentKey(keys('trim'), t, -1) !== undefined"
              :has-next="ops.adjacentKey(keys('trim'), t, 1) !== undefined"
              @toggle="toggleKey('trim')"
              @prev="seekAnim(ops.adjacentKey(keys('trim'), t, -1))"
              @next="seekAnim(ops.adjacentKey(keys('trim'), t, 1))"
              @ease="(e) => setEase('trim', e)"
              @clear="clearKeys('trim')"
            />
          </div>
          <InspectorSlider label="Trim start" :value="now.trim.start" :min="0" :max="1" :step="0.01" :reset-to="0" :format="(v) => `${Math.round(v * 100)}%`" @live="(v) => setTrim('start', v)" @commit="commit" />
          <InspectorSlider label="Trim end" :value="now.trim.end" :min="0" :max="1" :step="0.01" :reset-to="1" :format="(v) => `${Math.round(v * 100)}%`" @live="(v) => setTrim('end', v)" @commit="commit" />
        </template>
        <label v-if="track?.revealMode === 'roll'" class="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          Count from
          <input
            type="number"
            :value="track.rollFrom ?? 0"
            class="h-6 w-24 rounded-md border bg-transparent px-1.5 text-right text-xs text-foreground"
            @change="(e) => setRollFrom(Number((e.target as HTMLInputElement).value) || 0)"
          />
        </label>
        <InspectorSlider v-if="track?.revealMode" label="Reveal" :value="now.reveal" :min="0" :max="1" :step="0.01" :reset-to="1" :format="(v) => `${Math.round(v * 100)}%`" @live="(v) => setValue('reveal', v)" @commit="commit" />
      </div>

      <!-- Camera -->
      <div class="flex items-center justify-between">
        <span class="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"><Camera class="size-3.5" /> Camera</span>
        <KeyframeBar
          :count="cameraKeys.length"
          :on-key="Boolean(ops.keyAt(cameraKeys, t))"
          :ease="ops.keyAt(cameraKeys, t)?.ease"
          :has-prev="ops.adjacentKey(cameraKeys, t, -1) !== undefined"
          :has-next="ops.adjacentKey(cameraKeys, t, 1) !== undefined"
          @toggle="toggleCameraKey"
          @prev="seekAnim(ops.adjacentKey(cameraKeys, t, -1))"
          @next="seekAnim(ops.adjacentKey(cameraKeys, t, 1))"
          @ease="(e) => writeCamera('Keyframe easing', cameraKeys.map((k) => (k.frame === t ? { ...k, ease: e } : k)))"
          @clear="writeCamera('Reset camera', [])"
        />
      </div>
      <Select :model-value="''" @update:model-value="zoomTo">
        <SelectTrigger class="h-7 w-full text-xs"><SelectValue placeholder="Zoom to element at the playhead…" /></SelectTrigger>
        <SelectContent><SelectItem v-for="item in items" :key="item.id" :value="item.id">{{ itemLabel(item) }}</SelectItem></SelectContent>
      </Select>
      <InspectorSlider label="Zoom" :value="cameraNow.zoom" :min="0.5" :max="4" :step="0.01" :reset-to="1" :format="(v) => `${Math.round(v * 100)}%`" @live="(v) => setCamera('zoom', v)" @commit="commit" />
      <InspectorSlider label="Pan X" :value="cameraNow.x" :min="-source.frame.w / 2" :max="source.frame.w / 2" :step="1" :reset-to="0" :format="(v) => `${Math.round(v)}`" @live="(v) => setCamera('x', v)" @commit="commit" />
      <InspectorSlider label="Pan Y" :value="cameraNow.y" :min="-source.frame.h / 2" :max="source.frame.h / 2" :step="1" :reset-to="0" :format="(v) => `${Math.round(v)}`" @live="(v) => setCamera('y', v)" @commit="commit" />
    </template>
  </section>
</template>
