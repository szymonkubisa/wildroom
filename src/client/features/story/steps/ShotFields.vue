<script setup lang="ts">
import { AlertTriangle, Compass, MapPin, Video } from '@lucide/vue'
import { LENSES, SHOT_SIZES, splitFraming, withFraming } from '@shared/story/framing'
import { blockingOf, sceneLightOf, sceneOf } from '@shared/story/structure'
import { PLACE_VIEWS, type PlaceView, type StoryShot } from '@shared/types/story'
import { computed, ref, useId } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import CameraPresetPicker from '@/features/generate/CameraPresetPicker.vue'
import { type CameraPreset, cameraOf } from '@/features/generate/camera'
import { cn } from '@/lib/utils'
import { PLACE_VIEW_LABEL, placeViewPhoto, shotBackground } from '../references'
import { useStory } from '../useStory'

/**
 * What a shot is, field by field: what happens, its size and lens (the parts of its framing line), length, camera move
 * and position, who is in the frame, its place and the view of it, its light and positions — the scene's unless this
 * shot says otherwise — and its sound. Every field goes into its prompts (Show what the models get).
 */
const props = defineProps<{ shot: StoryShot }>()
const s = useStory()
const id = useId()

function edit(label: string, mutate: (shot: StoryShot) => void) {
  s.updateShot(props.shot.id, label, mutate)
}
const text = (e: Event) => (e.target as HTMLInputElement).value.trim()

// ---- framing: size and lens are parts of one line (StoryShot.shotType)
const framing = computed(() => splitFraming(props.shot.shotType))
const setFraming = (change: { size?: string; lens?: string }) => edit('Shot framing', (x) => (x.shotType = withFraming(x.shotType, change)))

// ---- length, within what the shot's video model renders
const maxSeconds = computed(() => s.workflowOf(props.shot).multishot.maxSeconds)
const videoModel = computed(() => s.modelForShot(props.shot))
const LENGTHS = [3, 4, 5, 6, 8, 10]
const lengths = computed(() => LENGTHS.filter((n) => n <= maxSeconds.value))
function setLength(seconds: number) {
  const n = Math.min(maxSeconds.value, Math.max(1, Math.round(seconds) || 5))
  if (n !== props.shot.duration) edit('Shot length', (x) => (x.duration = n))
  return n
}
function typedLength(e: Event) {
  const input = e.target as HTMLInputElement
  input.value = String(setLength(Number(input.value)))
}

// ---- camera move: the picker words it for the shot's video model
const activeCamera = computed(() => (props.shot.camera ? cameraOf(`Camera: ${props.shot.camera}`)?.id : undefined))
const cameraOpen = ref(false)
function pickCamera(phrase: string, preset: CameraPreset) {
  // The active tile again: take the move off.
  edit('Camera', (x) => (x.camera = preset.id === activeCamera.value ? undefined : phrase))
  cameraOpen.value = false
}

// ---- who is in the frame
/**
 * Not in the shot → in the shot (face) → from behind or in part (an over-the-shoulder's shoulder, hands) → only a
 * silhouette in the dark (no face reference, no lip sync) → not in it.
 */
function toggleCharacter(cid: string) {
  edit('Shot characters', (shot) => {
    if (shot.characterIds.includes(cid)) {
      shot.characterIds = shot.characterIds.filter((c) => c !== cid)
      shot.partialIds = [...(shot.partialIds ?? []), cid]
    } else if (shot.partialIds?.includes(cid)) {
      shot.partialIds = shot.partialIds.filter((c) => c !== cid)
      shot.hiddenIds = [...(shot.hiddenIds ?? []), cid]
    } else if (shot.hiddenIds?.includes(cid)) {
      shot.hiddenIds = shot.hiddenIds.filter((c) => c !== cid)
      if (!shot.hiddenIds.length) delete shot.hiddenIds
    } else {
      shot.characterIds = [...shot.characterIds, cid]
    }
  })
}
const presence = (cid: string) =>
  props.shot.characterIds.includes(cid) ? 'face' : props.shot.partialIds?.includes(cid) ? 'behind' : props.shot.hiddenIds?.includes(cid) ? 'hidden' : undefined
const PRESENCE_TITLE = {
  face: 'In the shot — click: seen only from behind or in part',
  behind: 'Seen from behind or in part (the shoulder of an over-the-shoulder shot, hands): their look goes along, no lip sync — click: only a silhouette',
  hidden: 'Only a dark outline in the shadow, face unreadable: no face reference, no lip sync — click: not in the shot',
  none: 'Not in the shot — click: in the shot',
}

// ---- where: the scene's place (or the shot's own), and which way the camera looks
const scene = computed(() => sceneOf(s.story.value, props.shot))
const place = computed(() => s.placeOf(props.shot))
const placeFromScene = computed(() => Boolean(props.shot.placeId && props.shot.placeId === scene.value?.placeId))
const hasView = (v: PlaceView) => Boolean(place.value && placeViewPhoto(place.value, v))
/** What the shot says, else what its camera position says ("looking northwest" → the left view). */
const background = computed(() => shotBackground(s.story.value, props.shot))
const viewMissing = computed(() => Boolean(background.value && place.value && !hasView(background.value)))

// ---- light and positions: the scene's (else the place's), unless this shot has its own
const sceneLight = computed(() => sceneLightOf(s.story.value, props.shot))
const sceneBlocking = computed(() => blockingOf(s.story.value, { ...props.shot, blocking: undefined }))
const lightOwn = computed(() => props.shot.light !== undefined)
const blockingOwn = computed(() => props.shot.blocking !== undefined)
function ownLight(on: boolean) {
  edit(on ? 'Light for this shot' : 'Scene’s light', (x) => {
    if (on) x.light = sceneLight.value ?? ''
    else delete x.light
  })
}
function ownBlocking(on: boolean) {
  edit(on ? 'Positions for this shot' : 'Scene’s positions', (x) => {
    if (on) x.blocking = sceneBlocking.value ?? ''
    else delete x.blocking
  })
}

const label = 'text-[10px] font-medium tracking-wide text-muted-foreground uppercase'
const fromScene = 'rounded bg-field px-1 py-px text-[9px] font-medium tracking-wide text-muted-foreground uppercase'
</script>

<template>
  <div class="grid grid-cols-2 gap-x-3 gap-y-2.5 text-xs" data-shot-fields="">
    <label class="col-span-2 grid gap-1">
      <span :class="label">What happens</span>
      <Input :model-value="shot.description" placeholder="The shot in a line" class="h-8 text-sm" data-shot-description="" @change="(e: Event) => edit('Shot description', (x) => (x.description = text(e)))" />
    </label>

    <label class="grid gap-1">
      <span :class="label">Shot size</span>
      <Input
        :model-value="framing.size"
        :list="`${id}-sizes`"
        placeholder="Medium close-up"
        class="h-7 text-xs"
        data-shot-size=""
        @change="(e: Event) => setFraming({ size: text(e) })"
      />
      <datalist :id="`${id}-sizes`"><option v-for="x in SHOT_SIZES" :key="x" :value="x" /></datalist>
    </label>
    <label class="grid gap-1">
      <span :class="label">Lens</span>
      <Input :model-value="framing.lens" :list="`${id}-lenses`" placeholder="50mm" class="h-7 text-xs" data-shot-lens="" @change="(e: Event) => setFraming({ lens: text(e) })" />
      <datalist :id="`${id}-lenses`"><option v-for="x in LENSES" :key="x" :value="x" /></datalist>
    </label>

    <div class="col-span-2 grid gap-1">
      <span :class="label">Length</span>
      <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Length">
        <button
          v-for="n in lengths"
          :key="n"
          type="button"
          :aria-pressed="shot.duration === n"
          :class="cn('h-7 rounded-md px-2 text-xs font-medium tabular transition-colors', shot.duration === n ? 'bg-foreground text-background' : 'bg-field text-muted-foreground hover:text-foreground')"
          @click="setLength(n)"
        >
          {{ n }} s
        </button>
        <Input
          type="number"
          min="1"
          :max="maxSeconds"
          :model-value="shot.duration"
          class="h-7 w-16 text-xs"
          :title="`${videoModel?.label ?? 'The video model'} renders up to ${maxSeconds} s per clip`"
          data-shot-length=""
          @change="typedLength"
        />
        <span class="text-[11px] text-muted-foreground">up to {{ maxSeconds }} s</span>
      </div>
    </div>

    <div class="col-span-2 grid gap-1">
      <span :class="label">Camera</span>
      <div class="flex items-center">
        <Input
          :model-value="shot.camera ?? ''"
          placeholder="Slow push-in, ending on her face"
          title="Direction, speed, amount and where it ends, e.g. slow dolly push-in about 20%, ending on her face"
          class="h-7 rounded-r-none text-xs"
          data-shot-camera=""
          @change="(e: Event) => edit('Camera', (x) => (x.camera = text(e) || undefined))"
        />
        <Popover v-model:open="cameraOpen">
          <PopoverTrigger as-child>
            <Button variant="outline" size="icon-sm" class="h-7 shrink-0 rounded-l-none border-l-0" title="Camera moves" aria-label="Camera moves"><Video /></Button>
          </PopoverTrigger>
          <PopoverContent align="end" class="w-80 p-2">
            <CameraPresetPicker :model="videoModel" :active="activeCamera" :active-phrase="shot.camera" @select="pickCamera" />
          </PopoverContent>
        </Popover>
      </div>
    </div>

    <label class="col-span-2 grid gap-1">
      <span :class="label">Camera position</span>
      <Input
        :model-value="shot.view ?? ''"
        placeholder="Where it stands and looks, by landmarks — at the pier’s end, looking back at the bank, over Kuba’s shoulder"
        class="h-7 text-xs"
        data-shot-view=""
        @change="(e: Event) => edit('Camera position', (x) => (x.view = text(e) || undefined))"
      />
    </label>

    <div v-if="s.story.value.characters.length" class="col-span-2 grid gap-1">
      <span :class="label">Cast in the frame</span>
      <div class="flex flex-wrap items-center gap-1" data-shot-cast="">
        <Badge
          v-for="c in s.story.value.characters"
          :key="c.id"
          :variant="presence(c.id) === 'face' ? 'default' : presence(c.id) === 'behind' ? 'secondary' : 'outline'"
          as="button"
          type="button"
          :aria-pressed="Boolean(presence(c.id))"
          :class="
            cn(
              'cursor-pointer text-[11px]',
              presence(c.id) === 'behind' && 'border border-dashed border-foreground/30',
              presence(c.id) === 'hidden' && 'border-dotted border-foreground/40',
              !presence(c.id) && 'text-muted-foreground',
            )
          "
          :title="PRESENCE_TITLE[presence(c.id) ?? 'none']"
          @click="toggleCharacter(c.id)"
        >
          @{{ c.name }}<template v-if="presence(c.id) === 'behind'"> · behind</template><template v-else-if="presence(c.id) === 'hidden'"> · silhouette</template>
        </Badge>
      </div>
    </div>

    <div v-if="s.story.value.places?.length" class="grid min-w-0 gap-1">
      <span class="flex items-center gap-1.5"><span :class="label">Place</span><span v-if="placeFromScene" :class="fromScene">from the scene</span></span>
      <Select :model-value="shot.placeId ?? 'none'" @update:model-value="(v) => edit('Shot place', (x) => (x.placeId = v === 'none' ? undefined : String(v)))">
        <SelectTrigger size="sm" class="w-full min-w-0 gap-1 px-2 text-xs data-[size=sm]:h-7" title="Where it happens: the place’s photos go with the still" data-shot-place="">
          <!-- The name from the doc, not SelectValue: reka keeps an option's text from its first render, so a rename wouldn't show. -->
          <MapPin class="size-3 shrink-0" /><span class="min-w-0 flex-1 truncate text-left">{{ place?.name ?? 'No place' }}<template v-if="placeFromScene && scene?.time"> · {{ scene.time }}</template></span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No place</SelectItem>
          <SelectItem v-for="p in s.story.value.places" :key="p.id" :value="p.id">{{ p.name }}{{ p.id === scene?.placeId ? ' (the scene’s)' : '' }}</SelectItem>
        </SelectContent>
      </Select>
    </div>
    <div v-if="place" class="grid min-w-0 gap-1">
      <span :class="label">View of the place</span>
      <!-- Which way the camera looks: the still gets the place's photo of that direction behind the people. -->
      <Select :model-value="background ?? 'main'" @update:model-value="(v) => edit('Shot background', (x) => (x.background = v as PlaceView))">
        <SelectTrigger
          size="sm"
          :class="cn('w-full min-w-0 gap-1 px-2 text-xs data-[size=sm]:h-7', viewMissing && 'text-role-effects')"
          :title="viewMissing ? `${place.name} has no photo of this view: the still gets its main view, not what is behind them — make the view in Cast & Places` : 'What is behind the people from this camera: the still gets the place’s photo of this view'"
          data-shot-background=""
        >
          <Compass class="size-3 shrink-0" /><span class="min-w-0 flex-1 truncate text-left">{{ PLACE_VIEW_LABEL[background ?? 'main'] }}</span><AlertTriangle v-if="viewMissing" class="size-3 shrink-0" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="v in PLACE_VIEWS" :key="v" :value="v">{{ PLACE_VIEW_LABEL[v] }}{{ hasView(v) ? '' : ' — no photo yet' }}</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div class="col-span-2 grid gap-1" data-shot-light="">
      <span :class="label">Light</span>
      <div v-if="lightOwn" class="flex items-center gap-2">
        <Input
          :model-value="shot.light ?? ''"
          placeholder="One source and direction, e.g. a torch beam from below"
          class="h-7 text-xs"
          aria-label="Light for this shot"
          @change="(e: Event) => edit('Light for this shot', (x) => (x.light = text(e)))"
        />
        <button type="button" class="shrink-0 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:underline" @click="ownLight(false)">Use the scene’s</button>
      </div>
      <div v-else class="flex items-start gap-2">
        <span class="min-w-0 flex-1 leading-snug" :class="!sceneLight && 'text-muted-foreground'">
          {{ sceneLight ?? 'None set for the scene or its place' }} <span :class="fromScene">from the scene</span>
        </span>
        <button type="button" class="shrink-0 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:underline" data-shot-light-own="" @click="ownLight(true)">
          Change for this shot
        </button>
      </div>
    </div>

    <div v-if="shot.placeId || shot.sceneId" class="col-span-2 grid gap-1" data-shot-blocking="">
      <span :class="label">Positions</span>
      <div v-if="blockingOwn" class="flex items-center gap-2">
        <Input
          :model-value="shot.blocking ?? ''"
          placeholder="Who stands where in this shot, e.g. left to right: Zosia, Hanka, Jan"
          class="h-7 text-xs"
          aria-label="Positions in this shot"
          @change="(e: Event) => edit('Shot positions', (x) => (x.blocking = text(e)))"
        />
        <button type="button" class="shrink-0 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:underline" @click="ownBlocking(false)">Use the scene’s</button>
      </div>
      <div v-else class="flex items-start gap-2">
        <span class="min-w-0 flex-1 leading-snug" :class="!sceneBlocking && 'text-muted-foreground'">
          {{ sceneBlocking ?? 'None set for the scene or its place' }} <span :class="fromScene">from the scene</span>
        </span>
        <button type="button" class="shrink-0 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:underline" @click="ownBlocking(true)">Change for this shot</button>
      </div>
    </div>

    <label class="col-span-2 grid gap-1">
      <span :class="label">Sound</span>
      <Input
        :model-value="shot.sfx ?? ''"
        placeholder="Ambience and effects, and whether the ambience carries on from the last shot"
        class="h-7 text-xs"
        data-shot-sound=""
        @change="(e: Event) => edit('Shot SFX', (x) => (x.sfx = text(e) || undefined))"
      />
    </label>
  </div>
</template>
