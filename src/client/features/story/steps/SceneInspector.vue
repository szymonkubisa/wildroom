<script setup lang="ts">
import { Compass, Library, SlidersHorizontal } from '@lucide/vue'
import { setScenePlace, shotsOfScene } from '@shared/story/structure'
import type { StoryScene } from '@shared/types/story'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useLibrary } from '@/features/library/library'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { openDesigner } from '../designer'
import { placeReadiness } from '../readiness'
import { PLACE_VIEW_LABEL, PLACE_VIEW_SHORT } from '../references'
import { useStory } from '../useStory'

/**
 * What a scene's shots inherit — its place, time, light, blocking and cast — and what its shots are written from (its
 * summary and part of the script). A shot can still say otherwise. Pictures to drag onto shots: the Library's media.
 */
const props = defineProps<{ sceneId: string }>()
const s = useStory()
const { story, update } = s
const assets = useAssetsStore()
const library = useLibrary()

const scene = computed(() => story.value.scenes?.find((x) => x.id === props.sceneId))
const first = computed(() => story.value.scenes?.[0]?.id === props.sceneId)
/**
 * The place and its photos as the keyframes get them (placeReadiness): a photo still in Assets — one removed there
 * keeps its id on the place, and showed as a broken picture — and look designer pictures that came out.
 */
const readiness = computed(() =>
  placeReadiness(story.value, props.sceneId, (id) => Boolean(assets.loading || assets.get(id)), (gid) => Boolean(s.outputOf(gid))),
)
const place = computed(() => readiness.value.place)
const mainPhoto = computed(() => readiness.value.main)
/** The place's other three directions, each with its photo if it has one. */
const turned = computed(() => readiness.value.views.map((v) => ({ ...v, label: PLACE_VIEW_LABEL[v.view] })))
const missingViews = computed(() => readiness.value.missing)
/** Missing views the scene's shots look toward: those keyframes would get the main view behind the people. */
const neededViews = computed(() => readiness.value.needed)
const neededText = computed(() => {
  const names = neededViews.value.map((v) => PLACE_VIEW_LABEL[v].toLowerCase())
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
})

function set(label: string, change: (sc: StoryScene) => void) {
  s.updateScene(props.sceneId, label, change)
}
const text = (e: Event) => (e.target as HTMLInputElement | HTMLTextAreaElement).value.trim()
function rename(title: string) {
  if (!title) return
  // Shots carry the heading as text too (older builds group by it).
  update('Scene heading', (st) => {
    const sc = st.scenes?.find((x) => x.id === props.sceneId)
    if (!sc) return
    sc.title = title
    for (const shot of shotsOfScene(st, sc.id)) shot.scene = title
  })
}
function setPlace(id: unknown) {
  update('Scene place', (st) => setScenePlace(st, props.sceneId, id && id !== 'none' ? String(id) : undefined))
}
function setChapter(id: unknown) {
  set('Scene chapter', (sc) => (sc.chapterId = String(id)))
}
function toggleCast(id: string) {
  set('Scene cast', (sc) => {
    const cast = sc.castIds ?? []
    sc.castIds = cast.includes(id) ? cast.filter((x) => x !== id) : [...cast, id]
  })
}
function setTarget(v: unknown) {
  set('Shots to write', (sc) => {
    if (v && v !== 'auto') sc.targetShots = Number(v)
    else delete sc.targetShots
  })
}
function setContinues(v: boolean) {
  set('Scene continues', (sc) => {
    if (v) sc.continuesPrevious = true
    else delete sc.continuesPrevious
  })
}
const optional = (v: string) => v || undefined
</script>

<template>
  <div class="flex min-h-0 flex-col gap-0 bg-sidebar">
    <div class="flex h-10 shrink-0 items-center gap-1.5 px-3 pt-2.5 text-xs font-medium">
      <SlidersHorizontal class="size-3.5 text-muted-foreground" /> Scene
      <div class="flex-1" />
      <Button size="xs" variant="ghost" title="Open the Library’s media to drag pictures onto shots (⌘L)" data-inspector-library="" @click="library.toggle('media')"><Library /> Media</Button>
    </div>
    <div class="min-h-0 flex-1">
      <ScrollArea v-if="scene" class="h-full">
        <div class="grid gap-3 p-3" data-scene-inspector="">
          <div class="grid gap-1">
            <Label class="text-[11px] text-muted-foreground">Heading</Label>
            <Input :model-value="scene.title" class="h-8 text-sm font-medium" @change="(e: Event) => rename(text(e))" />
          </div>
          <div v-if="story.chapters?.length" class="grid gap-1">
            <Label class="text-[11px] text-muted-foreground">Chapter</Label>
            <Select :model-value="scene.chapterId" @update:model-value="setChapter">
              <SelectTrigger class="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem v-for="c in story.chapters" :key="c.id" :value="c.id">{{ c.title }}</SelectItem></SelectContent>
            </Select>
          </div>
          <div class="grid gap-1">
            <Label class="text-[11px] text-muted-foreground">Place</Label>
            <Select :model-value="scene.placeId ?? 'none'" @update:model-value="setPlace">
              <SelectTrigger class="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No place</SelectItem>
                <SelectItem v-for="p in story.places ?? []" :key="p.id" :value="p.id">{{ p.name }}</SelectItem>
              </SelectContent>
            </Select>
            <img
              v-if="place && mainPhoto"
              :src="`/media/${mainPhoto}/poster`"
              class="aspect-video w-full rounded-lg bg-viewer object-cover"
              :title="`${place.name}: its main photo — the scene's opening wide takes its composition`"
              alt=""
            />
            <div v-else-if="readiness.state === 'removed'" class="text-[11px] text-role-effects">
              {{ place?.name }}'s main photo was removed from Assets — every shot will invent the place until it has one again (Cast & Places).
            </div>
            <!-- The Chase: the garage had four pictures drawn and none approved, so no keyframe ever got a photo of it. -->
            <div v-else-if="place && readiness.state === 'unapproved'" class="flex flex-wrap items-center gap-1.5 rounded-lg bg-role-effects/10 px-2 py-1.5 text-[11px]" data-place-unapproved="">
              <span>{{ readiness.drawn }} picture{{ readiness.drawn === 1 ? '' : 's' }} drawn, none approved — every shot will invent the place until one is.</span>
              <Button size="xs" variant="outline" data-approve-place="" @click="openDesigner('place', place.id)">Approve</Button>
            </div>
            <div v-else-if="place" class="text-[11px] text-role-effects">{{ place.name }} has no photo yet — every shot will invent the place (add one in Cast & Places).</div>
            <!-- The other directions: a shot looking that way gets that photo behind the people, not the main view. -->
            <div v-if="place && turned.length" class="grid grid-cols-3 gap-1.5" data-place-views="">
              <div v-for="t in turned" :key="t.view" class="grid gap-0.5">
                <img v-if="t.photo" :src="`/media/${t.photo}/poster`" class="aspect-video w-full rounded-md bg-viewer object-cover" :title="`${place.name}: ${t.label.toLowerCase()}`" alt="" />
                <div v-else class="flex aspect-video w-full items-center justify-center rounded-md border border-dashed text-muted-foreground" :title="`${place.name} has no ${t.label.toLowerCase()} yet`">
                  <Compass class="size-3.5" />
                </div>
                <span class="truncate text-[10px] text-muted-foreground">{{ PLACE_VIEW_SHORT[t.view] }}</span>
              </div>
            </div>
            <div v-if="place && missingViews.length" :class="['grid justify-items-start gap-1.5 text-[11px]', neededViews.length && 'rounded-lg bg-role-effects/10 px-2 py-1.5']" data-missing-views="">
              <span v-if="neededViews.length">Shots here look toward the {{ neededText }} of {{ place.name }}, which has no photo of {{ neededViews.length > 1 ? 'them' : 'it' }} — their keyframes would get the main view behind the people.</span>
              <Button size="xs" variant="outline" data-make-views="" @click="openDesigner('place', place.id, missingViews)">
                <Compass /> Make the {{ missingViews.length > 1 ? `${missingViews.length} missing views` : 'missing view' }}
              </Button>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div class="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
              <Label class="text-[11px] text-muted-foreground">Time of day</Label>
              <Input :model-value="scene.time ?? ''" placeholder="dusk" class="h-8 text-xs" @change="(e: Event) => set('Scene time', (sc) => (sc.time = optional(text(e))))" />
            </div>
            <!-- minmax(0, 1fr): in a narrow panel the select's text pushed the cell past the panel's edge. -->
            <div class="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
              <Label class="text-[11px] text-muted-foreground">Shots to write</Label>
              <Select :model-value="scene.targetShots ? String(scene.targetShots) : 'auto'" @update:model-value="setTarget">
                <SelectTrigger class="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Director decides</SelectItem>
                  <SelectItem v-for="n in [2, 3, 4, 6, 8, 12]" :key="n" :value="String(n)">~{{ n }} shots</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div class="grid gap-1">
            <Label class="text-[11px] text-muted-foreground">Light</Label>
            <Input
              :model-value="scene.light ?? ''"
              :placeholder="place?.light ? `The place’s: ${place.light}` : 'One source and direction, e.g. low sun from behind the cars'"
              class="h-8 text-xs"
              @change="(e: Event) => set('Scene light', (sc) => (sc.light = optional(text(e))))"
            />
          </div>
          <div class="grid gap-1">
            <Label class="text-[11px] text-muted-foreground">Blocking</Label>
            <Textarea
              :model-value="scene.blocking ?? ''"
              rows="2"
              :placeholder="place?.blocking ? `The place’s: ${place.blocking}` : 'Who stands where, by screen side from the wide: e.g. Jan on the left by the car, Hanka on the right'"
              class="min-h-0 text-xs"
              @change="(e: Event) => set('Scene blocking', (sc) => (sc.blocking = optional(text(e))))"
            />
          </div>
          <div class="grid gap-1">
            <Label class="text-[11px] text-muted-foreground">Who’s in it</Label>
            <div class="flex flex-wrap gap-1">
              <button
                v-for="c in story.characters"
                :key="c.id"
                type="button"
                :class="cn('rounded-md px-2 py-0.5 text-[11px] font-medium uppercase transition-colors', scene.castIds?.includes(c.id) ? 'bg-foreground text-background' : 'bg-field text-muted-foreground hover:text-foreground')"
                @click="toggleCast(c.id)"
              >
                {{ c.name }}
              </button>
              <span v-if="!story.characters.length" class="text-[11px] text-muted-foreground">No characters yet (step 2).</span>
            </div>
          </div>
          <div class="grid gap-1">
            <Label class="text-[11px] text-muted-foreground">What happens</Label>
            <Textarea :model-value="scene.summary ?? ''" rows="3" class="min-h-0 text-xs" @change="(e: Event) => set('Scene summary', (sc) => (sc.summary = optional(text(e))))" />
          </div>
          <div class="grid gap-1">
            <Label class="text-[11px] text-muted-foreground">Its part of the script</Label>
            <Textarea
              :model-value="scene.script ?? ''"
              rows="6"
              placeholder="The shots are written from this (else from the summary)."
              class="min-h-0 font-mono text-[11px] leading-relaxed"
              @change="(e: Event) => set('Scene script', (sc) => (sc.script = optional((e.target as HTMLTextAreaElement).value.trim())))"
            />
          </div>
          <label class="flex items-start gap-2 text-xs">
            <Switch :model-value="Boolean(scene.continuesPrevious)" :disabled="first" @update:model-value="setContinues" />
            <span class="grid gap-0.5">
              <span>Continues the previous scene</span>
              <span class="text-[11px] text-muted-foreground">No jump in time: its first shot picks up where that scene ends.</span>
            </span>
          </label>
        </div>
      </ScrollArea>
    </div>
  </div>
</template>
