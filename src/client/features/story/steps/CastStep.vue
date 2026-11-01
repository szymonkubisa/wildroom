<script setup lang="ts">
import { ArrowRight, ChevronDown, Library, Loader2, MapPin, Plus, UserRound, Wand2 } from '@lucide/vue'
import { useLocalStorage } from '@vueuse/core'
import { nanoid } from 'nanoid'
import { computed } from 'vue'
import { confirmDialog } from '@/components/app/useConfirm'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useLibrary } from '@/features/library/library'
import { formatUsd } from '@/lib/format'
import { groupByProvider } from '@/lib/providers'
import { useSettingsStore } from '@/stores/settings'
import CharacterCard from '../CharacterCard.vue'
import { openDesigner } from '../designer'
import PlaceCard from '../PlaceCard.vue'
import { type Planned, useStory } from '../useStory'

/**
 * Step 2: the heroes and the places, before any shot — their looks, voices and pictures are what keeps every keyframe
 * and clip consistent. One tab each; drag pictures in from the Library (or pick them in each slot).
 */
const emit = defineEmits<{ next: [] }>()
const s = useStory()
const { story, update } = s
const library = useLibrary()
const tab = useLocalStorage<'cast' | 'places'>('story.castTab', 'cast')

const scenes = computed(() => story.value.scenes ?? [])
/** "Scenes 1, 3, 5" — where a hero appears (the scene's cast, or a shot of it). */
function heroScenes(id: string) {
  return scenes.value
    .map((sc, i) => (sc.castIds?.includes(id) || story.value.shots.some((x) => x.sceneId === sc.id && (x.characterIds.includes(id) || x.partialIds?.includes(id))) ? i + 1 : 0))
    .filter(Boolean)
}
const placeScenes = (id: string) => scenes.value.map((sc, i) => (sc.placeId === id ? i + 1 : 0)).filter(Boolean)
const inScenes = (numbers: number[]) => (numbers.length ? `In scene${numbers.length === 1 ? '' : 's'} ${numbers.join(', ')}` : 'In no scene yet')

const missingFaces = computed(() => story.value.characters.filter((c) => !c.refAssetId).length)
const missingPhotos = computed(() => (story.value.places ?? []).filter((p) => !p.refAssetIds?.length).length)

/**
 * Create looks: one picture for every hero and place without one, used as its front view (main view) once drawn —
 * no designer. Design the look on a card is for choosing between a few, and for the other angles.
 */
const settings = useSettingsStore()
/** What the looks can be drawn with (the arrow beside Create looks): the look designer's model, by where they run. */
const imageModels = computed(() => groupByProvider(settings.availableModels.filter((m) => m.kind === 'image')))
const quickPlans = computed(() => s.planQuickLooks())
const quickReady = computed(() => quickPlans.value.filter((p): p is Planned => typeof p !== 'string'))
const quickUsd = computed(() => s.estimate(quickReady.value))
const drawing = computed(
  () => story.value.characters.filter((c) => s.quickLooking('character', c.id)).length + (story.value.places ?? []).filter((p) => s.quickLooking('place', p.id)).length,
)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
async function createLooks() {
  const plans = quickPlans.value
  const n = quickReady.value.length
  if (n && quickUsd.value !== 0) {
    const ok = await confirmDialog({
      title: `Create ${plural(n, 'look')}?`,
      description: `One picture each with ${s.designModel()?.label ?? 'the image model'}, used as the front view or main view — ${formatUsd(quickUsd.value)}. Design the look on a card to choose between a few pictures, or to draw other angles.`,
      confirmText: `Create · ${formatUsd(quickUsd.value)}`,
    })
    if (!ok) return
  }
  // The ones that can't be drawn (no look written yet) say so.
  void s.run(plans)
}

/** A new hero or place opens in the look designer right away. */
function add() {
  const id = nanoid(8)
  if (tab.value === 'places') update('Add place', (s) => (s.places ??= []).push({ id, name: `Place ${(s.places?.length ?? 0) + 1}`, description: '' }))
  else update('Add character', (s) => s.characters.push({ id, name: `Character ${s.characters.length + 1}`, description: '' }))
  openDesigner(tab.value === 'places' ? 'place' : 'character', id)
}
</script>

<template>
  <div class="panel-card flex h-full min-h-0 min-w-0 flex-col bg-muted dark:bg-sidebar">
    <div class="flex flex-wrap items-center gap-3 px-4 pt-3 pb-3">
      <Tabs v-model="tab">
        <TabsList class="h-8">
          <TabsTrigger value="cast" class="gap-1.5 px-3 text-xs" data-cast-tab="">
            <UserRound class="size-3.5" /> Cast <span class="text-muted-foreground tabular">{{ story.characters.length }}</span>
            <span v-if="missingFaces" class="size-1.5 rounded-full bg-role-effects" :title="`${missingFaces} without a front view`" />
          </TabsTrigger>
          <TabsTrigger value="places" class="gap-1.5 px-3 text-xs" data-places-tab="">
            <MapPin class="size-3.5" /> Places <span class="text-muted-foreground tabular">{{ story.places?.length ?? 0 }}</span>
            <span v-if="missingPhotos" class="size-1.5 rounded-full bg-role-effects" :title="`${missingPhotos} without a photo`" />
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <Button size="sm" variant="ghost" @click="add"><Plus /> {{ tab === 'places' ? 'Place' : 'Character' }}</Button>
      <Button v-if="drawing" size="sm" variant="secondary" disabled data-create-looks=""><Loader2 class="animate-spin" /> Drawing {{ plural(drawing, 'look') }}…</Button>
      <!-- A split button: the arrow picks the model the looks are drawn with (the look designer's). -->
      <div v-if="quickPlans.length" class="flex items-stretch">
        <Button
          size="sm"
          class="rounded-r-none bg-brand text-brand-foreground hover:bg-brand/90"
          :title="`One picture for every character and place without one, with ${s.designModel()?.label ?? 'the image model'}, used right away — ${quickPlans.length - quickReady.length ? `${quickPlans.length - quickReady.length} still need a look written` : 'no choosing'}`"
          data-create-looks=""
          @click="createLooks"
        >
          <Wand2 /> Create {{ plural(quickPlans.length, 'look') }}<span v-if="quickReady.length && quickUsd != null" class="opacity-70">· {{ formatUsd(quickUsd) }}</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button
              size="sm"
              class="rounded-l-none border-l border-brand-foreground/25 bg-brand px-1.5 text-brand-foreground hover:bg-brand/90"
              :title="`Image model: ${s.designModel()?.label ?? 'none'}`"
              aria-label="Image model for the looks"
              data-create-looks-model=""
            >
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="max-h-96 w-64 overflow-y-auto">
            <DropdownMenuLabel class="text-[11px] text-muted-foreground">Draw the looks with</DropdownMenuLabel>
            <DropdownMenuRadioGroup :model-value="s.designModel()?.id" @update:model-value="(v) => v && s.setDesignModel(String(v))">
              <template v-for="g in imageModels" :key="g.provider">
                <DropdownMenuLabel class="px-2 pt-2 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{{ g.name }}</DropdownMenuLabel>
                <DropdownMenuRadioItem v-for="m in g.models" :key="m.id" :value="m.id" class="text-xs">
                  {{ m.label }}<span v-if="m.id === s.modelFor('image')?.id" class="ml-auto text-[10px] text-muted-foreground">stills</span>
                </DropdownMenuRadioItem>
              </template>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
        <template v-if="tab === 'places'">
          Every place needs a main photo — each scene’s opening wide takes its composition.
          <span v-if="missingPhotos" class="text-role-effects">{{ missingPhotos }} without a photo.</span>
        </template>
        <template v-else>
          Every character needs a front view — stills and takes keep the face from it.
          <span v-if="missingFaces" class="text-role-effects">{{ missingFaces }} without a front view.</span>
        </template>
      </div>
      <Button size="sm" variant="ghost" title="Open the Library’s media to drag pictures in (⌘L)" data-cast-library="" @click="library.toggle('media')"><Library /> Media</Button>
      <Button size="sm" :disabled="!scenes.length" @click="emit('next')">Scenes <ArrowRight /></Button>
    </div>
    <ScrollArea class="min-h-0 flex-1">
      <div class="px-4 pb-6">
        <template v-if="tab === 'cast'">
          <div v-if="!story.characters.length" class="rounded-xl border border-dashed py-10 text-center text-xs text-muted-foreground">
            Create the scenes in step 1, or add the characters yourself.
          </div>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3" data-cast-grid="">
            <CharacterCard v-for="c in story.characters" :key="c.id" :character="c">
              <template #header>
                <div class="-mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span class="tabular">{{ inScenes(heroScenes(c.id)) }}</span>
                  <span v-if="!c.refAssetId" class="text-role-effects">· no front view yet</span>
                </div>
              </template>
            </CharacterCard>
          </div>
        </template>
        <template v-else>
          <div v-if="!story.places?.length" class="rounded-xl border border-dashed py-10 text-center text-xs text-muted-foreground">
            Create the scenes in step 1, or add the places yourself.
          </div>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3" data-places-grid="">
            <PlaceCard v-for="p in story.places ?? []" :key="p.id" :place="p">
              <template #header>
                <div class="-mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span class="tabular">{{ inScenes(placeScenes(p.id)) }}</span>
                  <span v-if="!p.refAssetIds?.length" class="text-role-effects">· no photo yet</span>
                </div>
              </template>
            </PlaceCard>
          </div>
        </template>
      </div>
    </ScrollArea>
  </div>
</template>
