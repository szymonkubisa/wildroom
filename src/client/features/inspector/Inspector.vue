<script setup lang="ts">
import { ArrowLeftToLine, ArrowRightToLine, AudioLines, Blend, Clapperboard, Copy, Crosshair, Film, FolderSearch, Gauge, Info, Layers, Palette, Plus, Sparkles, Trash2, Type, Wand2, Wrench } from '@lucide/vue'
import * as ops from '@shared/timeline'
import type { TimelineRecipe as Recipe } from '@shared/timeline'
import { flicksToSeconds } from '@shared/time/flicks'
import { formatDuration, formatTimecode } from '@shared/time/timecode'
import {
  type AudioProps,
  type Clip,
  type Conform,
  type KeyEase,
  type Keyframe,
  type Transform,
  type TitleAnimation,
  type TitleStyle,
  type TitleTemplate,
  type TransitionType,
  type VideoProps,
  activeTake,
} from '@shared/types/project-doc'
import { nanoid } from 'nanoid'
import { computed, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTimelineCommands } from '@/features/timeline/commands'
import { api, errorMessage } from '@/lib/api'
import { formatUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { useEditorStore } from '@/stores/editor'
import { useProjectStore } from '@/stores/project'
import { EFFECTS, effectDef, newEffect } from './effects'
import InspectorSlider from './InspectorSlider.vue'
import KeyframeBar from './KeyframeBar.vue'
import MotionInspector from './MotionInspector.vue'
import FontSelect from '@/features/canvas/FontSelect.vue'
import { useClipTools } from '@/features/tools/useClipTools'
import { transport } from '@/features/editor/transport'

const project = useProjectStore()
const editor = useEditorStore()
const assets = useAssetsStore()
const commands = useTimelineCommands()
const clipTools = useClipTools()

/** Other picture clips to match colour against. */
const colorRefs = computed(() =>
  [...project.layout.spine.map((s) => s.item), ...project.layout.connected.map((c) => c.item.clip)].filter(
    (c) => c.kind === 'media' && c.id !== clip.value?.id && c.video && assets.get(activeTake(c)?.assetId)?.kind !== 'audio',
  ),
)

const clip = computed<Clip | undefined>(() => (editor.selection.length === 1 ? commands.findClip(editor.selection[0]!) : undefined))
const isSpine = computed(() => Boolean(clip.value && project.doc.spine.some((s) => s.id === clip.value!.id)))
const layoutItem = computed(() => {
  const id = clip.value?.id
  if (!id) return undefined
  return project.layout.spine.find((s) => s.id === id) ?? project.layout.connected.find((c) => c.id === id)
})
const take = computed(() => (clip.value?.kind === 'media' ? activeTake(clip.value) : undefined))
const asset = computed(() => assets.get(take.value?.assetId))
const fps = computed(() => project.doc.settings.fps)

// ---- live editing: sliders preview from the drag base and commit one history entry
function live(label: string, recipe: Recipe) {
  if (!project.dragging()) project.beginDrag(label)
  project.previewDrag(recipe)
}
function commit() {
  project.commitDrag()
}
function set(label: string, recipe: Recipe) {
  project.apply(recipe, label)
}

// The name commits on change (blur), which comes after a click elsewhere already switched the selection: keep what
// was typed for the clip it was typed for, and commit it before the inspector moves on.
let renameDraft: { id: string; name: string } | undefined
function commitRename() {
  const draft = renameDraft
  renameDraft = undefined
  if (draft) set('Rename clip', ops.setProps(draft.id, { name: draft.name }))
}
watch(() => clip.value?.id, commitRename)

function videoPatch(patch: Partial<VideoProps>): Recipe {
  const id = clip.value!.id
  return ops.setProps(id, { video: patch })
}
function audioPatch(patch: Partial<AudioProps>): Recipe {
  const id = clip.value!.id
  return ops.setProps(id, { audio: patch })
}

const video = computed(() => (clip.value && 'video' in clip.value ? clip.value.video : undefined))
const audio = computed(() => (clip.value?.kind === 'media' ? clip.value.audio : undefined))

// ---- keyframes: frames are relative to the clip start; the playhead picks the key being edited
const localFrame = computed(() => {
  const item = layoutItem.value
  if (!item || !clip.value) return 0
  return Math.max(0, Math.min(clip.value.duration - 1, editor.playhead - item.start))
})
const opacityKeys = computed(() => ops.sortKeys(video.value?.opacityKeys))
const transformKeys = computed(() => ops.sortKeys(video.value?.transformKeys))
const opacityNow = computed(() => (video.value ? ops.keyframeValue(opacityKeys.value, localFrame.value, video.value.opacity) : 1))
const transformNow = computed<Transform>(() =>
  video.value ? ops.keyframeObject(transformKeys.value, localFrame.value, video.value.transform) : { x: 0, y: 0, scale: 1, rotation: 0 },
)

type Track = 'opacity' | 'transform'
function keysOf(track: Track): Keyframe<unknown>[] {
  return track === 'opacity' ? opacityKeys.value : transformKeys.value
}
function trackPatch(track: Track, keys: Keyframe<unknown>[]): Partial<VideoProps> {
  return track === 'opacity' ? { opacityKeys: keys as Keyframe<number>[] } : { transformKeys: keys as Keyframe<Transform>[] }
}
function toggleKey(track: Track) {
  const keys = keysOf(track)
  const f = localFrame.value
  if (ops.keyAt(keys, f)) return set('Remove keyframe', videoPatch(trackPatch(track, ops.removeKey(keys, f))))
  const value = track === 'opacity' ? opacityNow.value : { ...transformNow.value }
  set('Add keyframe', videoPatch(trackPatch(track, ops.upsertKey(keys, f, value))))
}
function setKeyEase(track: Track, ease: KeyEase) {
  const f = localFrame.value
  const keys = keysOf(track).map((k) => (k.frame === f ? { ...k, ease } : k))
  set('Keyframe easing', videoPatch(trackPatch(track, keys)))
}
function clearKeys(track: Track) {
  // Keep the look at the playhead as the static value.
  const patch: Partial<VideoProps> = track === 'opacity' ? { opacityKeys: [], opacity: opacityNow.value } : { transformKeys: [], transform: { ...transformNow.value } }
  set('Clear keyframes', videoPatch(patch))
}
function jumpKey(track: Track, dir: -1 | 1) {
  const f = ops.adjacentKey(keysOf(track), localFrame.value, dir)
  if (f !== undefined && layoutItem.value) transport.seek(layoutItem.value.start + f)
}

function setOpacity(value: number) {
  if (!video.value) return
  if (opacityKeys.value.length) live('Opacity keyframe', videoPatch({ opacityKeys: ops.upsertKey(opacityKeys.value, localFrame.value, value) }))
  else live('Opacity', videoPatch({ opacity: value }))
}

function setTransform(key: 'x' | 'y' | 'scale' | 'rotation', value: number) {
  if (!video.value) return
  if (transformKeys.value.length) {
    live('Transform keyframe', videoPatch({ transformKeys: ops.upsertKey(transformKeys.value, localFrame.value, { ...transformNow.value, [key]: value }) }))
  } else live('Transform', videoPatch({ transform: { ...video.value.transform, [key]: value } }))
}
function setCrop(key: 'left' | 'right' | 'top' | 'bottom', value: number) {
  if (!video.value) return
  live('Crop', videoPatch({ crop: { ...video.value.crop, [key]: value } }))
}
function addEffect(type: unknown) {
  if (!video.value) return
  set('Add effect', videoPatch({ effects: [...video.value.effects, newEffect(String(type), nanoid(8))] }))
}
function setEffectParam(effectId: string, key: string, value: number) {
  if (!video.value) return
  live('Effect', videoPatch({ effects: video.value.effects.map((e) => (e.id === effectId ? { ...e, params: { ...e.params, [key]: value } } : e)) }))
}
function toggleEffect(effectId: string, enabled: boolean) {
  if (!video.value) return
  set('Toggle effect', videoPatch({ effects: video.value.effects.map((e) => (e.id === effectId ? { ...e, enabled } : e)) }))
}
function removeEffect(effectId: string) {
  if (!video.value) return
  set('Remove effect', videoPatch({ effects: video.value.effects.filter((e) => e.id !== effectId) }))
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4]
const TEMPLATES: { value: TitleTemplate; label: string }[] = [
  { value: 'basic', label: 'Basic' },
  { value: 'centered', label: 'Centered' },
  { value: 'lower-third', label: 'Lower third' },
  { value: 'caption', label: 'Caption' },
]
const ANIMATIONS: { value: TitleAnimation; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade' },
  { value: 'slide-up', label: 'Slide up' },
  { value: 'typewriter', label: 'Typewriter' },
]

function titleStyle(patch: Partial<TitleStyle>): Recipe {
  const c = clip.value
  if (c?.kind !== 'title') return () => {}
  return ops.setProps(c.id, { style: { ...c.style, ...patch } })
}

const transition = computed(() => (clip.value && isSpine.value ? clip.value.transitionOut : undefined))
function setTransition(type: TransitionType | null, duration?: number) {
  const c = clip.value
  if (!c) return
  set('Transition', ops.setTransition(c.id, 'out', type ? { type, duration: duration ?? transition.value?.duration ?? Math.round(fps.value) } : null))
}

async function grabFrame() {
  try {
    const id = await commands.grabFrameAtPlayhead()
    if (id) toast.success('Frame added to Assets')
  } catch (err) {
    toast.error('Could not grab frame', { description: errorMessage(err) })
  }
}

function copyPrompt() {
  const prompt = asset.value?.generation?.prompt
  if (prompt) void navigator.clipboard.writeText(prompt).then(() => toast.success('Prompt copied'))
}

// ---- project settings (nothing selected)
const settings = computed(() => project.doc.settings)
const hasVideo = computed(() => project.doc.spine.some((s) => s.kind === 'media') || project.doc.connected.length > 0)
</script>

<template>
  <ScrollArea class="h-full">
    <!-- Nothing selected: project -->
    <div v-if="!editor.selection.length" class="grid gap-4 p-3">
      <div class="grid gap-2.5">
        <div class="flex items-center gap-2 text-[13px] font-semibold tracking-tight"><Clapperboard class="size-4 text-muted-foreground" /> Project</div>
        <Input :model-value="project.name" class="h-8" @change="(e: Event) => project.rename((e.target as HTMLInputElement).value)" />
      </div>
      <div class="grid grid-cols-2 gap-1.5 text-xs">
        <div class="rounded-lg bg-field px-2.5 py-2">
          <div class="text-muted-foreground">Resolution</div>
          <div class="font-medium">{{ settings.width }} × {{ settings.height }}</div>
        </div>
        <div class="rounded-lg bg-field px-2.5 py-2">
          <div class="text-muted-foreground">Frame rate</div>
          <div class="font-medium">{{ settings.fpsAuto ? `auto (${settings.fps})` : `${settings.fps} fps` }}</div>
        </div>
        <div class="rounded-lg bg-field px-2.5 py-2">
          <div class="text-muted-foreground">Duration</div>
          <div class="font-mono font-medium">{{ formatTimecode(project.layout.duration, settings.fps) }}</div>
        </div>
        <div class="rounded-lg bg-field px-2.5 py-2">
          <div class="text-muted-foreground">Clips</div>
          <div class="font-medium">{{ project.layout.spine.filter((s) => s.item.kind !== 'gap').length + project.layout.connected.length }}</div>
        </div>
      </div>
      <div v-if="!hasVideo" class="grid gap-1.5">
        <span class="text-[11px] font-medium text-muted-foreground">Frame rate</span>
        <Select :model-value="settings.fpsAuto ? 'auto' : String(settings.fps)" @update:model-value="(v) => project.updateSettings(v === 'auto' ? { fpsAuto: true } : { fps: Number(v), fpsAuto: false })">
          <SelectTrigger class="h-8 w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Automatic</SelectItem>
            <SelectItem v-for="f in [24, 25, 30, 48, 50, 60]" :key="f" :value="String(f)">{{ f }} fps</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p class="text-xs leading-relaxed text-muted-foreground">
        Select a clip on the timeline to adjust it. Tip: right-click an empty spot to generate a shot right there.
      </p>
    </div>

    <!-- Multiple selection -->
    <div v-else-if="!clip" class="grid gap-3 p-3 text-xs">
      <div class="font-medium">{{ editor.selection.length }} items selected</div>
      <div class="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" @click="commands.toggleEnabled()">Enable / disable</Button>
        <Button size="sm" variant="outline" @click="commands.deleteSelection('ripple')"><Trash2 /> Delete</Button>
      </div>
    </div>

    <!-- Single clip -->
    <div v-else class="grid divide-y divide-border px-3 pb-3 *:py-3.5 *:first:pt-2">
      <div class="grid gap-1.5">
        <Input
          :model-value="clip.kind === 'title' ? clip.text : (clip.name ?? asset?.name ?? '')"
          class="h-8 font-medium"
          :disabled="clip.kind === 'title' || clip.kind === 'gap'"
          @input="(e: Event) => (renameDraft = { id: clip!.id, name: (e.target as HTMLInputElement).value })"
          @change="commitRename"
        />
        <div class="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span class="capitalize">{{ clip.kind === 'media' ? (asset?.kind ?? 'pending') : clip.kind }}</span>
          <span>·</span>
          <span class="font-mono">{{ formatTimecode(clip.duration, fps) }}</span>
          <span v-if="layoutItem">· @ {{ formatTimecode(layoutItem.start, fps) }}</span>
          <span>· {{ isSpine ? 'Primary storyline' : 'Connected' }}</span>
        </div>
      </div>

      <!-- Takes / auditions -->
      <section v-if="clip.kind === 'media'" class="grid gap-2">
        <div class="flex items-center justify-between">
          <span class="flex items-center gap-2 text-[13px] font-semibold tracking-tight"><Layers class="size-4 text-muted-foreground" /> Takes</span>
          <Button size="xs" variant="outline" @click="commands.newTake(clip.id)"><Wand2 /> New take</Button>
        </div>
        <div class="grid grid-cols-3 gap-1.5">
          <button
            v-for="(t, i) in clip.takes"
            :key="t.id"
            type="button"
            :class="cn('overflow-hidden rounded-lg border border-transparent bg-field text-left transition-colors', i === clip.active ? 'border-selection ring-1 ring-selection' : 'hover:border-foreground/20')"
            @click="set('Switch take', ops.audition(clip!.id, { type: 'select', index: i }))"
          >
            <div class="flex aspect-video items-center justify-center bg-viewer">
              <img v-if="t.assetId && assets.get(t.assetId)?.variants.poster" :src="`/media/${t.assetId}/poster`" class="max-h-full max-w-full object-contain" alt="" />
              <Sparkles v-else class="size-3.5 animate-pulse text-brand" />
            </div>
            <div class="px-1.5 py-1 text-[10px] font-medium text-muted-foreground">Take {{ i + 1 }}</div>
          </button>
        </div>
        <Button v-if="clip.takes.length > 1" size="xs" variant="ghost" class="justify-self-start" @click="commands.finalizeAudition(clip.id)">
          Keep only take {{ clip.active + 1 }}
        </Button>
      </section>

      <!-- Title -->
      <section v-if="clip.kind === 'title'" class="grid gap-2.5">
        <div class="flex items-center gap-2 text-[13px] font-semibold tracking-tight"><Type class="size-4 text-muted-foreground" /> Title</div>
        <Textarea :model-value="clip.text" rows="2" class="min-h-0 text-sm" @update:model-value="(v) => live('Edit title', ops.setProps(clip!.id, { text: String(v) }))" @blur="commit" />
        <Input
          :model-value="clip.subtitle ?? ''"
          placeholder="Subtitle (optional)"
          class="h-8 text-xs"
          @update:model-value="(v) => live('Edit subtitle', ops.setProps(clip!.id, { subtitle: String(v) || undefined }))"
          @blur="commit"
        />
        <div class="grid grid-cols-2 gap-2">
          <Select :model-value="clip.template" @update:model-value="(v) => set('Title template', ops.setProps(clip!.id, { template: v as TitleTemplate }))">
            <SelectTrigger class="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem v-for="t in TEMPLATES" :key="t.value" :value="t.value">{{ t.label }}</SelectItem></SelectContent>
          </Select>
          <Select :model-value="clip.animation" @update:model-value="(v) => set('Title animation', ops.setProps(clip!.id, { animation: v as TitleAnimation }))">
            <SelectTrigger class="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem v-for="a in ANIMATIONS" :key="a.value" :value="a.value">{{ a.label }}</SelectItem></SelectContent>
          </Select>
        </div>
        <FontSelect :model-value="clip.style.fontFamily" trigger-class="h-8 w-full text-xs" @update:model-value="(f) => set('Font', titleStyle({ fontFamily: f }))" />
        <InspectorSlider label="Size" :value="clip.style.fontSize" :min="16" :max="240" :step="1" :reset-to="64" @live="(v) => live('Font size', titleStyle({ fontSize: v }))" @commit="commit" />
        <InspectorSlider label="Weight" :value="clip.style.fontWeight" :min="300" :max="900" :step="100" @live="(v) => live('Font weight', titleStyle({ fontWeight: v }))" @commit="commit" />
        <div class="flex items-center gap-2">
          <span class="w-[88px] text-[11px] font-medium text-muted-foreground">Color</span>
          <input type="color" :value="clip.style.color" class="h-7 w-10 cursor-pointer rounded border bg-transparent" @input="(e) => live('Title color', titleStyle({ color: (e.target as HTMLInputElement).value }))" @change="commit" />
          <ToggleGroup type="single" size="sm" variant="outline" :model-value="clip.style.align" @update:model-value="(v) => v && set('Align', titleStyle({ align: v as TitleStyle['align'] }))">
            <ToggleGroupItem value="left" class="h-7 px-2 text-xs">L</ToggleGroupItem>
            <ToggleGroupItem value="center" class="h-7 px-2 text-xs">C</ToggleGroupItem>
            <ToggleGroupItem value="right" class="h-7 px-2 text-xs">R</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-medium text-muted-foreground">Drop shadow</span>
          <Switch :model-value="clip.style.shadow" @update:model-value="(v) => set('Shadow', titleStyle({ shadow: Boolean(v) }))" />
        </div>
      </section>

      <!-- Generator -->
      <section v-if="clip.kind === 'generator'" class="grid gap-2.5">
        <div class="flex items-center gap-2 text-[13px] font-semibold tracking-tight"><Palette class="size-4 text-muted-foreground" /> Generator</div>
        <div class="flex items-center gap-2">
          <span class="w-[88px] text-[11px] font-medium text-muted-foreground">Color</span>
          <input type="color" :value="clip.params.color" class="h-7 w-10 cursor-pointer rounded border bg-transparent" @input="(e) => live('Color', ops.setProps(clip!.id, { params: { ...(clip as any).params, color: (e.target as HTMLInputElement).value } }))" @change="commit" />
        </div>
      </section>

      <MotionInspector v-if="clip.kind === 'motion' && layoutItem" :clip="clip" :local-frame="localFrame" :clip-start="layoutItem.start" />

      <!-- Video -->
      <section v-if="video" class="grid gap-2.5">
        <div class="flex items-center justify-between">
          <span class="flex items-center gap-2 text-[13px] font-semibold tracking-tight"><Film class="size-4 text-muted-foreground" /> Video</span>
          <Switch :model-value="video.enabled" @update:model-value="(v) => set('Video on/off', videoPatch({ enabled: Boolean(v) }))" />
        </div>
        <div class="grid grid-cols-[88px_1fr] items-center gap-2">
          <span class="text-[11px] font-medium text-muted-foreground">Conform</span>
          <ToggleGroup type="single" size="sm" variant="outline" class="w-full" :model-value="video.conform" @update:model-value="(v) => v && set('Conform', videoPatch({ conform: v as Conform }))">
            <ToggleGroupItem value="fit" class="h-7 flex-1 text-xs">Fit</ToggleGroupItem>
            <ToggleGroupItem value="fill" class="h-7 flex-1 text-xs">Fill</ToggleGroupItem>
            <ToggleGroupItem value="none" class="h-7 flex-1 text-xs">None</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-medium text-muted-foreground">Opacity</span>
          <KeyframeBar
            :count="opacityKeys.length"
            :on-key="Boolean(ops.keyAt(opacityKeys, localFrame))"
            :ease="ops.keyAt(opacityKeys, localFrame)?.ease"
            :has-prev="ops.adjacentKey(opacityKeys, localFrame, -1) !== undefined"
            :has-next="ops.adjacentKey(opacityKeys, localFrame, 1) !== undefined"
            @toggle="toggleKey('opacity')"
            @prev="jumpKey('opacity', -1)"
            @next="jumpKey('opacity', 1)"
            @ease="(e) => setKeyEase('opacity', e)"
            @clear="clearKeys('opacity')"
          />
        </div>
        <InspectorSlider label="Opacity" :value="opacityNow" :min="0" :max="1" :step="0.01" :reset-to="1" :format="(v) => `${Math.round(v * 100)}%`" @live="setOpacity" @commit="commit" />
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-medium text-muted-foreground">Transform</span>
          <KeyframeBar
            :count="transformKeys.length"
            :on-key="Boolean(ops.keyAt(transformKeys, localFrame))"
            :ease="ops.keyAt(transformKeys, localFrame)?.ease"
            :has-prev="ops.adjacentKey(transformKeys, localFrame, -1) !== undefined"
            :has-next="ops.adjacentKey(transformKeys, localFrame, 1) !== undefined"
            @toggle="toggleKey('transform')"
            @prev="jumpKey('transform', -1)"
            @next="jumpKey('transform', 1)"
            @ease="(e) => setKeyEase('transform', e)"
            @clear="clearKeys('transform')"
          />
        </div>
        <InspectorSlider label="Scale" :value="transformNow.scale" :min="0.1" :max="4" :step="0.01" :reset-to="1" :format="(v) => `${Math.round(v * 100)}%`" @live="(v) => setTransform('scale', v)" @commit="commit" />
        <InspectorSlider label="Position X" :value="transformNow.x" :min="-1" :max="1" :step="0.005" :reset-to="0" :format="(v) => `${Math.round(v * 100)}%`" @live="(v) => setTransform('x', v)" @commit="commit" />
        <InspectorSlider label="Position Y" :value="transformNow.y" :min="-1" :max="1" :step="0.005" :reset-to="0" :format="(v) => `${Math.round(v * 100)}%`" @live="(v) => setTransform('y', v)" @commit="commit" />
        <InspectorSlider label="Rotation" :value="transformNow.rotation" :min="-180" :max="180" :step="0.5" :reset-to="0" :format="(v) => `${v}°`" @live="(v) => setTransform('rotation', v)" @commit="commit" />
        <InspectorSlider
          v-for="side in ['left', 'right', 'top', 'bottom'] as const"
          :key="side"
          :label="`Crop ${side}`"
          :value="video.crop[side]"
          :min="0"
          :max="0.45"
          :step="0.005"
          :reset-to="0"
          :format="(v) => `${Math.round(v * 100)}%`"
          @live="(v) => setCrop(side, v)"
          @commit="commit"
        />
        <div class="mt-1 flex items-center justify-between">
          <span class="flex items-center gap-2 text-[12px] font-semibold"><Sparkles class="size-3.5 text-muted-foreground" /> Effects</span>
          <Select @update:model-value="addEffect">
            <SelectTrigger size="sm" class="h-7 w-auto gap-1 text-xs"><Plus class="size-3.5" /> Add</SelectTrigger>
            <SelectContent><SelectItem v-for="fx in EFFECTS.filter((e) => e.type !== 'balance' || clip?.kind === 'media')" :key="fx.type" :value="fx.type">{{ fx.label }}</SelectItem></SelectContent>
          </Select>
        </div>
        <div v-for="fx in video.effects" :key="fx.id" class="grid gap-2 rounded-xl bg-field p-2.5">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium">{{ effectDef(fx.type)?.label ?? fx.type }}</span>
            <div class="flex items-center gap-1">
              <Switch :model-value="fx.enabled" @update:model-value="(v) => toggleEffect(fx.id, Boolean(v))" />
              <Button variant="ghost" size="icon-xs" @click="removeEffect(fx.id)"><Trash2 /></Button>
            </div>
          </div>
          <InspectorSlider
            v-for="p in effectDef(fx.type)?.params ?? []"
            :key="p.key"
            :label="p.label"
            :value="Number(fx.params[p.key] ?? p.default)"
            :min="p.min"
            :max="p.max"
            :step="p.step"
            :reset-to="p.default"
            :format="p.format"
            @live="(v) => setEffectParam(fx.id, p.key, v)"
            @commit="commit"
          />
        </div>
      </section>

      <!-- Audio -->
      <section v-if="audio" class="grid gap-2.5">
        <div class="flex items-center justify-between">
          <span class="flex items-center gap-2 text-[13px] font-semibold tracking-tight"><AudioLines class="size-4 text-muted-foreground" /> Audio</span>
          <Switch :model-value="audio.enabled" @update:model-value="(v) => set('Audio on/off', audioPatch({ enabled: Boolean(v) }))" />
        </div>
        <div class="grid grid-cols-[88px_1fr] items-center gap-2">
          <span class="text-[11px] font-medium text-muted-foreground">Role</span>
          <Select :model-value="audio.role.split('.')[0]" @update:model-value="(v) => set('Audio role', audioPatch({ role: String(v) }))">
            <SelectTrigger class="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="dialogue">Dialogue</SelectItem>
              <SelectItem value="music">Music</SelectItem>
              <SelectItem value="effects">Effects</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div v-if="audio.gainKeys?.length" class="flex items-center justify-between rounded-lg bg-field px-2.5 py-1.5 text-[11px]">
          <span>{{ audio.gainKeys.length }} volume keyframe{{ audio.gainKeys.length === 1 ? '' : 's' }} — drag them on the timeline (⌥-click the line to add)</span>
          <Button size="xs" variant="ghost" @click="set('Clear volume keyframes', audioPatch({ gainKeys: [] }))">Clear</Button>
        </div>
        <InspectorSlider v-else label="Volume" :value="audio.gainDb" :min="-60" :max="12" :step="0.5" :reset-to="0" :format="(v) => (v <= -60 ? '-∞' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`)" @live="(v) => live('Volume', audioPatch({ gainDb: v }))" @commit="commit" />
        <InspectorSlider label="Pan" :value="audio.pan" :min="-1" :max="1" :step="0.01" :reset-to="0" :format="(v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)" @live="(v) => live('Pan', audioPatch({ pan: v }))" @commit="commit" />
        <InspectorSlider label="Fade in" :value="audio.fadeIn / fps" :min="0" :max="Math.min(10, clip.duration / fps)" :step="0.05" :reset-to="0" :format="(v) => `${v.toFixed(2)}s`" @live="(v) => live('Fade in', audioPatch({ fadeIn: Math.round(v * fps) }))" @commit="commit" />
        <InspectorSlider label="Fade out" :value="audio.fadeOut / fps" :min="0" :max="Math.min(10, clip.duration / fps)" :step="0.05" :reset-to="0" :format="(v) => `${v.toFixed(2)}s`" @live="(v) => live('Fade out', audioPatch({ fadeOut: Math.round(v * fps) }))" @commit="commit" />
      </section>

      <!-- Clip tools -->
      <section v-if="clip.kind === 'media' && asset" class="grid gap-2.5">
        <div class="flex items-center gap-2 text-[13px] font-semibold tracking-tight"><Wrench class="size-4 text-muted-foreground" /> Tools</div>
        <div class="flex flex-wrap gap-1.5">
          <Button v-if="asset.kind === 'video'" size="xs" variant="outline" title="Generate a lead-in that ends on the first frame" @click="clipTools.extendBeforeClip(clip.id)"><ArrowLeftToLine /> Extend before</Button>
          <Button v-if="asset.kind === 'video'" size="xs" variant="outline" title="Generate a continuation from the last frame" @click="clipTools.extendClip(clip.id)">Extend after <ArrowRightToLine /></Button>
          <Button v-if="asset.kind === 'video'" size="xs" variant="outline" @click="editor.dialog = 'edit-shot'">Edit inside</Button>
          <Button v-if="asset.kind === 'video'" size="xs" variant="outline" @click="clipTools.freezeFrame()">Freeze frame</Button>
          <Button v-if="asset.kind !== 'image'" size="xs" variant="outline" @click="clipTools.reverseClip(clip.id)">Reverse</Button>
          <Button v-if="asset.hasAudio" size="xs" variant="outline" @click="clipTools.isolateVoice(clip.id)">Isolate voice</Button>
          <Button v-if="asset.hasAudio" size="xs" variant="outline" @click="clipTools.transcribeAsset(asset.id)">{{ asset.alignment?.words.length ? 'Re-transcribe' : 'Transcribe' }}</Button>
          <Button v-if="asset.hasAudio" size="xs" variant="outline" @click="clipTools.detectBeats(clip.id)">{{ asset.beats ? `${asset.beats.bpm} BPM` : 'Detect beats' }}</Button>
        </div>
        <div v-if="video && colorRefs.length" class="grid grid-cols-[88px_1fr] items-center gap-2">
          <span class="text-[11px] font-medium text-muted-foreground">Match colour</span>
          <Select @update:model-value="(v) => clipTools.matchColor(clip!.id, String(v))">
            <SelectTrigger class="h-7 w-full text-xs"><SelectValue placeholder="To another clip…" /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="c in colorRefs" :key="c.id" :value="c.id">{{ c.name ?? 'Clip' }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      <!-- Speed + transition -->
      <section v-if="clip.kind === 'media'" class="grid grid-cols-[88px_1fr] items-center gap-2">
        <span class="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"><Gauge class="size-3.5" /> Speed</span>
        <Select :model-value="String(clip.speed)" @update:model-value="(v) => set('Retime', ops.setSpeed(clip!.id, Number(v)))">
          <SelectTrigger class="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem v-for="s in SPEEDS" :key="s" :value="String(s)">{{ Math.round(s * 100) }}%</SelectItem></SelectContent>
        </Select>
      </section>
      <section v-if="isSpine && clip.kind !== 'gap'" class="grid gap-2">
        <div class="grid grid-cols-[88px_1fr] items-center gap-2">
          <span class="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"><Blend class="size-3.5" /> Transition out</span>
          <Select :model-value="transition?.type ?? 'none'" @update:model-value="(v) => setTransition(v === 'none' ? null : (v as TransitionType))">
            <SelectTrigger class="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None (cut)</SelectItem>
              <SelectItem value="dissolve">Cross dissolve</SelectItem>
              <SelectItem value="dip-black">Dip to black</SelectItem>
              <SelectItem value="dip-white">Dip to white</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <InspectorSlider
          v-if="transition"
          label="Duration"
          :value="transition.duration / fps"
          :min="0.1"
          :max="3"
          :step="0.05"
          :format="(v) => `${v.toFixed(2)}s`"
          @live="(v) => live('Transition duration', ops.setTransition(clip!.id, 'out', { type: transition!.type, duration: Math.max(1, Math.round(v * fps)) }))"
          @commit="commit"
        />
      </section>

      <!-- Info -->
      <section v-if="asset" class="grid gap-2.5 text-xs">
        <div class="flex items-center gap-2 text-[13px] font-semibold tracking-tight"><Info class="size-4 text-muted-foreground" /> Media</div>
        <div class="grid grid-cols-[80px_1fr] gap-x-2 gap-y-1.5 rounded-xl bg-field p-2.5 text-[11px]">
          <span class="text-muted-foreground">File</span><span class="truncate">{{ asset.name }}</span>
          <template v-if="asset.width"><span class="text-muted-foreground">Size</span><span>{{ asset.width }}×{{ asset.height }}<template v-if="asset.fps"> · {{ Math.round(asset.fps * 100) / 100 }} fps</template></span></template>
          <template v-if="asset.durationFlicks"><span class="text-muted-foreground">Length</span><span>{{ formatDuration(flicksToSeconds(asset.durationFlicks)) }}</span></template>
          <template v-if="asset.generation">
            <span class="text-muted-foreground">Model</span><span>{{ asset.generation.modelLabel }}</span>
            <span class="text-muted-foreground">Cost</span><span>{{ formatUsd(asset.generation.costUsd) }}</span>
          </template>
        </div>
        <p v-if="asset.generation?.prompt" class="line-clamp-4 rounded-xl bg-field p-2.5 text-[11px] leading-snug text-muted-foreground">{{ asset.generation.prompt }}</p>
        <div class="flex flex-wrap gap-1.5">
          <Button v-if="asset.generation?.prompt" size="xs" variant="outline" @click="copyPrompt"><Copy /> Prompt</Button>
          <Button v-if="asset.kind === 'video'" size="xs" variant="outline" @click="grabFrame"><Crosshair /> Frame at playhead</Button>
          <Button size="xs" variant="outline" @click="api.assets.reveal(asset!.id)"><FolderSearch /> Reveal</Button>
          <Button size="xs" variant="outline" @click="commands.fitToMedia(clip!.id)">Fit to media</Button>
        </div>
      </section>
    </div>
  </ScrollArea>
</template>
