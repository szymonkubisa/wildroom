<script setup lang="ts">
import { Compass, Loader2, SlidersHorizontal, Trash2, Wand2 } from '@lucide/vue'
import { type PlaceView, type StoryPlace, type StoryShot } from '@shared/types/story'
import { computed } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import AssetSlot from '@/features/generate/AssetSlot.vue'
import { angleOf } from './design'
import { openDesigner, useQuickLook } from './designer'
import { PLACE_VIEW_LABEL, PLACE_VIEW_SHORT, placeViewOf, placeViewPhoto } from './references'
import { useStory } from './useStory'

/** Reference images per place: the main view, the three other directions and a detail (image models take 4–16 in all). */
const MAX_VIEWS = 5
/** The directions besides the main view: a shot looking that way gets that photo behind the people. */
const TURNED: readonly Exclude<PlaceView, 'main'>[] = ['reverse', 'left', 'right']

/** One place: its look and geography, blocking, light, and reference photos with what each shows. */
const props = defineProps<{ place: StoryPlace }>()
const { story, update } = useStory()
const p = computed(() => props.place)
const quick = useQuickLook('place', () => p.value.id)
const usedIn = computed(() => story.value.shots.filter((s) => s.placeId === p.value.id).length)
const missingViews = computed(() => TURNED.filter((v) => !placeViewPhoto(p.value, v)))
/** Photos of a detail (no direction), after the three directions. */
const details = computed(() => (p.value.refAssetIds ?? []).slice(1).filter((id) => !placeViewOf(p.value, id)))
const photoLabel = (assetId: string) => {
  const view = placeViewOf(p.value, assetId)
  return view ? PLACE_VIEW_SHORT[view] : 'Detail'
}

function patch(label: string, change: { name?: string; description?: string; blocking?: string; light?: string }) {
  update(label, (s) => {
    const x = s.places?.find((x) => x.id === p.value.id)
    if (x) Object.assign(x, change)
  })
}

function setRef(index: number, assetId: string | undefined) {
  // The first photo is the main view whatever its note says (placeViewOf): cleared, the next one — the view to the
  // left, say — became the main view, and the left went missing. The main view is replaced instead; a detail promoted
  // in its place would be no better a composition for the scene's opening wide.
  if (index === 0 && !assetId && (p.value.refAssetIds?.length ?? 0) > 1) {
    return void toast.warning('Replace the main view instead', {
      description: 'Drop or pick another picture on it. Removed, the next photo would become the main view and its own direction would go missing.',
    })
  }
  update('Place reference', (s) => {
    const x = s.places?.find((x) => x.id === p.value.id)
    if (!x) return
    const refs = [...(x.refAssetIds ?? [])]
    if (assetId) refs[index] = assetId
    else refs.splice(index, 1)
    x.refAssetIds = refs.filter(Boolean)
    // Notes belong to a photo: drop the ones whose photo is gone.
    if (x.refNotes) x.refNotes = Object.fromEntries(Object.entries(x.refNotes).filter(([id]) => x.refAssetIds!.includes(id)))
  })
}

/** Puts a photo in as the place's view of a direction (its note says which), replacing the one there; none removes it. */
function setView(view: Exclude<PlaceView, 'main'>, assetId: string | undefined) {
  update('Place view', (s) => {
    const x = s.places?.find((x) => x.id === p.value.id)
    if (!x?.refAssetIds?.length) return
    const old = placeViewPhoto(x, view)
    const notes = { ...x.refNotes }
    let refs = x.refAssetIds.filter((id) => id !== old && id !== assetId)
    if (old) delete notes[old]
    if (assetId) {
      refs = [...refs, assetId]
      notes[assetId] = angleOf('place', view)!.note
    }
    x.refAssetIds = refs.slice(0, MAX_VIEWS)
    x.refNotes = Object.fromEntries(Object.entries(notes).filter(([id]) => x.refAssetIds!.includes(id)))
  })
}

function setNote(assetId: string, text: string) {
  update('Photo note', (s) => {
    const x = s.places?.find((x) => x.id === p.value.id)
    if (!x) return
    const notes = { ...x.refNotes }
    if (text.trim()) notes[assetId] = text.trim()
    else delete notes[assetId]
    x.refNotes = notes
  })
}

function remove() {
  const id = p.value.id
  update('Remove place', (s) => {
    s.places = (s.places ?? []).filter((x) => x.id !== id)
    for (const shot of s.shots) if (shot.placeId === id) shot.placeId = undefined
    for (const scene of s.scenes ?? []) if (scene.placeId === id) scene.placeId = undefined
  })
}

/** Sets the place on many shots at once: a whole scene, the shots that have none yet, or every shot. */
function assign(label: string, pick: (shot: StoryShot) => boolean, sceneId?: string) {
  const id = p.value.id
  let count = 0
  update('Assign place', (s) => {
    // A whole scene: the scene happens here, so shots added to it later get the place too.
    const scene = sceneId ? s.scenes?.find((x) => x.id === sceneId) : undefined
    if (scene) scene.placeId = id
    for (const shot of s.shots) {
      if (pick(shot) && shot.placeId !== id) {
        shot.placeId = id
        count++
      }
    }
  })
  toast.success(count ? `${label}: ${count} shot${count === 1 ? '' : 's'} now take place here` : sceneId ? `${label} takes place here` : `${label}: already set`)
}
</script>

<template>
  <div class="grid content-start gap-2 rounded-xl bg-card p-2.5">
    <!-- The place first: its main photo is the composition of every scene's opening wide here. -->
    <AssetSlot cover aspect="16 / 9" kind="image" label="Main view" :model-value="p.refAssetIds?.[0]" data-place-main="" @update:model-value="(v) => setRef(0, v)" />
    <!-- No picture yet: one drawn and used right away, or the designer to choose between a few. -->
    <div v-if="!p.refAssetIds?.[0]" class="flex gap-1.5">
      <Button
        size="sm"
        class="min-w-0 flex-1 rounded-full bg-brand text-brand-foreground hover:bg-brand/90"
        :disabled="quick.drawing.value || Boolean(quick.blocker.value)"
        :title="quick.blocker.value ?? 'Draw one main view from the look and use it — Design to choose between a few'"
        data-quick-look=""
        @click="quick.start"
      >
        <template v-if="quick.drawing.value"><Loader2 class="animate-spin" /> Drawing…</template>
        <template v-else><Wand2 /> Generate<span v-if="quick.cost.value" class="opacity-70">· {{ quick.cost.value }}</span></template>
      </Button>
      <Button size="sm" variant="outline" class="rounded-full" title="Design the look: pictures to choose from, other angles" data-design-look="" @click="openDesigner('place', p.id)">
        <SlidersHorizontal /> Design
      </Button>
    </div>
    <!-- The other three directions: a shot looking that way gets that photo behind the people, not the main view. -->
    <div v-if="p.refAssetIds?.length" class="grid grid-cols-3 gap-1.5" data-place-views="">
      <AssetSlot
        v-for="v in TURNED"
        :key="v"
        cover
        aspect="16 / 9"
        kind="image"
        :label="PLACE_VIEW_SHORT[v]"
        :model-value="placeViewPhoto(p, v)"
        @update:model-value="(id) => setView(v, id)"
      />
      <AssetSlot
        v-for="id in details"
        :key="id"
        cover
        aspect="16 / 9"
        kind="image"
        label="Detail"
        :model-value="id"
        @update:model-value="(v) => setRef(p.refAssetIds!.indexOf(id), v)"
      />
    </div>
    <Button
      v-if="p.refAssetIds?.length && missingViews.length"
      size="xs"
      variant="outline"
      class="justify-self-start"
      :title="`Draw the ${missingViews.map((v) => PLACE_VIEW_LABEL[v].toLowerCase()).join(', ')} from the main view — shots looking that way get them behind the people`"
      data-make-views=""
      @click="openDesigner('place', p.id, [...missingViews])"
    >
      <Compass /> Make the {{ missingViews.length > 1 ? `${missingViews.length} missing views` : 'missing view' }}
    </Button>
    <div class="flex items-center gap-1.5">
      <Input :model-value="p.name" class="h-7 text-sm font-medium" @change="(e: Event) => patch('Rename place', { name: (e.target as HTMLInputElement).value })" />
      <Button variant="ghost" size="icon-sm" title="Design the look: pictures to choose from, other angles" data-open-designer="" @click="openDesigner('place', p.id)"><Wand2 /></Button>
      <Button variant="ghost" size="icon-sm" title="Remove place" @click="remove"><Trash2 /></Button>
    </div>
    <slot name="header" />
    <label class="grid gap-1">
      <span class="px-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Look</span>
      <Textarea
        :model-value="p.description"
        placeholder="Architecture, materials, layout, surroundings — and what lies on each side…"
        class="h-24 min-h-0 resize-none overflow-y-auto text-xs field-sizing-fixed"
        @change="(e: Event) => patch('Describe place', { description: (e.target as HTMLTextAreaElement).value })"
      />
    </label>
    <!-- Kept in every keyframe and clip here: close-ups and reverse shots stay on the same side of the line. -->
    <label class="grid gap-1">
      <span class="px-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Blocking · who stands where</span>
      <Textarea
        :model-value="p.blocking ?? ''"
        placeholder="By screen side from the establishing view, e.g. Maja on the left at the ticket machine, facing right; Tymon on the right, facing left"
        class="h-24 min-h-0 resize-none overflow-y-auto text-xs field-sizing-fixed"
        @change="(e: Event) => patch('Place blocking', { blocking: (e.target as HTMLTextAreaElement).value.trim() || undefined })"
      />
    </label>
    <label class="grid gap-1">
      <span class="px-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Light</span>
      <Input
        :model-value="p.light ?? ''"
        placeholder="One source and time of day, e.g. low golden evening sun from the left"
        class="h-7 text-xs"
        @change="(e: Event) => patch('Place light', { light: (e.target as HTMLInputElement).value.trim() || undefined })"
      />
    </label>
    <!-- What each photo shows: named in the keyframe prompt, and a shot that mentions it gets that photo first. -->
    <div v-if="p.refAssetIds?.length" class="grid gap-1">
      <div v-for="assetId in p.refAssetIds" :key="assetId" class="flex items-center gap-1.5">
        <span class="w-12 shrink-0 text-[10px] text-muted-foreground">{{ photoLabel(assetId) }}</span>
        <Input
          :model-value="p.refNotes?.[assetId] ?? ''"
          placeholder="What it shows, e.g. the ticket machine"
          class="h-6 text-[11px]"
          @change="(e: Event) => setNote(assetId, (e.target as HTMLInputElement).value)"
        />
      </div>
    </div>
    <div class="flex items-center gap-2">
      <span class="flex-1 text-[11px] text-muted-foreground tabular">
        {{ usedIn ? `In ${usedIn} shot${usedIn === 1 ? '' : 's'}` : 'Not in any shot yet' }}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button size="xs" variant="ghost" :disabled="!story.shots.length && !story.scenes?.length">Use in…</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-64">
          <template v-if="story.scenes?.length">
            <DropdownMenuLabel class="text-[11px] text-muted-foreground">A whole scene</DropdownMenuLabel>
            <DropdownMenuItem v-for="scene in story.scenes" :key="scene.id" @select="assign(scene.title, (s) => s.sceneId === scene.id, scene.id)">
              <span class="truncate">{{ scene.title }}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </template>
          <DropdownMenuItem :disabled="!story.shots.length" @select="assign('Shots without a place', (s) => !s.placeId)">Shots without a place</DropdownMenuItem>
          <DropdownMenuItem :disabled="!story.shots.length" @select="assign('All shots', () => true)">All shots</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</template>
