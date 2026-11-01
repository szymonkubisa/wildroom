<script setup lang="ts">
import { ArrowRight, AtSign, MapPin, Plus, UserRound, Wand2 } from '@lucide/vue'
import { nanoid } from 'nanoid'
import { computed } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { setAssetDrag } from '@/features/assets/drag'
import { withoutPictureNotes } from '@/features/story/cast'
import { openDesigner } from '@/features/story/designer'
import { openPlanStep } from '@/features/story/planStep'
import { useStory } from '@/features/story/useStory'
import { useAssetsStore } from '@/stores/assets'
import { mentionHandle } from '@shared/prompt/mentions'
import { addToPrompt } from './addToPrompt'

/**
 * Library › Cast or Places: the story's characters or places as compact rows — picture, name, look. Design the look
 * (the look designer), @mention one in the Composer's prompt, or drag its picture onto the board, the timeline or the Composer. The
 * full cards with voices and every view stay in Plan › Cast & Places.
 */
const props = defineProps<{ kind: 'character' | 'place' }>()
const { story, update } = useStory()
const assets = useAssetsStore()
const cast = computed(() => props.kind === 'character')

interface Row {
  id: string
  name: string
  handle: string
  look: string
  pictureId?: string
  scenes: number[]
}

const scenes = computed(() => story.value.scenes ?? [])
const handleOf = mentionHandle

const rows = computed<Row[]>(() =>
  cast.value
    ? story.value.characters.map((c) => ({
        id: c.id,
        name: c.name,
        handle: handleOf(c.name),
        look: withoutPictureNotes(c.description),
        pictureId: c.refAssetId,
        scenes: scenes.value
          .map((sc, i) => (sc.castIds?.includes(c.id) || story.value.shots.some((x) => x.sceneId === sc.id && (x.characterIds.includes(c.id) || x.partialIds?.includes(c.id))) ? i + 1 : 0))
          .filter(Boolean),
      }))
    : (story.value.places ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        handle: handleOf(p.name),
        look: withoutPictureNotes(p.description),
        pictureId: p.refAssetIds?.[0],
        scenes: scenes.value.map((sc, i) => (sc.placeId === p.id ? i + 1 : 0)).filter(Boolean),
      })),
)

const pictureReady = (id?: string) => Boolean(id && assets.get(id)?.status === 'ready')
/** No picture, or one no longer in the project's media (removed there, its id stays on the character). */
const pictureMissing = (id?: string) => !id || (!assets.loading && !assets.get(id))

function onDrag(row: Row, e: DragEvent) {
  const a = row.pictureId ? assets.get(row.pictureId) : undefined
  if (!e.dataTransfer || a?.status !== 'ready') return e.preventDefault()
  setAssetDrag(e.dataTransfer, [a])
}

function usePrompt(row: Row) {
  addToPrompt(row.handle)
  toast(`@${row.handle} is in the Composer’s prompt`, {
    description: pictureReady(row.pictureId) ? 'Its picture goes along where the model takes one.' : 'No picture yet: it is named and described in words.',
    duration: 2500,
  })
}

/** A new character or place opens in the look designer right away (as in Plan › Cast & Places). */
function add() {
  const id = nanoid(8)
  if (cast.value) update('Add character', (s) => s.characters.push({ id, name: `Character ${s.characters.length + 1}`, description: '' }))
  else update('Add place', (s) => (s.places ??= []).push({ id, name: `Place ${(s.places?.length ?? 0) + 1}`, description: '' }))
  openDesigner(props.kind, id)
}

const inScenes = (n: number[]) => (n.length ? `Scene${n.length === 1 ? '' : 's'} ${n.join(', ')}` : 'In no scene yet')
</script>

<template>
  <div class="flex h-full min-h-0 flex-col" :data-library-elements="kind">
    <div class="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
      <span class="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">
        {{ cast ? 'Faces and voices every still, clip and line keeps.' : 'Places keep their look from every angle you have made.' }}
      </span>
      <Button size="sm" variant="outline" class="shrink-0" @click="add"><Plus /> {{ cast ? 'Character' : 'Place' }}</Button>
    </div>
    <ScrollArea class="min-h-0 flex-1">
      <div class="grid gap-1.5 px-3 pb-3">
        <div v-if="!rows.length" class="rounded-xl border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">
          {{ cast ? 'No characters yet. Plan writes them from the script, or add one here.' : 'No places yet. Plan writes them from the script, or add one here.' }}
        </div>
        <div
          v-for="row in rows"
          :key="row.id"
          class="group flex items-center gap-2.5 rounded-lg bg-field p-2"
          :class="pictureReady(row.pictureId) && 'cursor-grab active:cursor-grabbing'"
          :draggable="pictureReady(row.pictureId)"
          :data-library-row="row.id"
          @dragstart="(e) => onDrag(row, e)"
        >
          <button
            type="button"
            class="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-viewer text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            :title="`Design the look of ${row.name}`"
            @click="openDesigner(kind, row.id)"
          >
            <img v-if="pictureReady(row.pictureId)" :src="`/media/${row.pictureId}/poster`" class="size-full object-cover" alt="" draggable="false" />
            <UserRound v-else-if="cast" class="size-5" />
            <MapPin v-else class="size-5" />
          </button>
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-baseline gap-1.5">
              <span class="truncate text-[13px] font-medium">{{ row.name }}</span>
              <span class="shrink-0 truncate font-mono text-[10px] text-muted-foreground">@{{ row.handle }}</span>
            </div>
            <p class="line-clamp-2 text-[11px] leading-snug text-muted-foreground" :title="row.look || undefined">{{ row.look || 'No look written yet.' }}</p>
            <div class="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground tabular">
              <span>{{ inScenes(row.scenes) }}</span>
              <span v-if="pictureMissing(row.pictureId)" class="text-role-effects">· {{ cast ? 'no front view yet' : 'no photo yet' }}</span>
            </div>
          </div>
          <div class="flex shrink-0 flex-col gap-0.5">
            <Tooltip>
              <TooltipTrigger as-child>
                <Button variant="ghost" size="icon-sm" :aria-label="`Design the look of ${row.name}`" data-library-design="" @click="openDesigner(kind, row.id)"><Wand2 /></Button>
              </TooltipTrigger>
              <TooltipContent side="left">Design look — pictures to choose from, other angles</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger as-child>
                <Button variant="ghost" size="icon-sm" :aria-label="`Use ${row.name} in the prompt`" data-library-use="" @click="usePrompt(row)"><AtSign /></Button>
              </TooltipTrigger>
              <TooltipContent side="left">Use in prompt — @{{ row.handle }} in the Composer{{ pictureReady(row.pictureId) ? ', with the picture' : '' }}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </ScrollArea>
    <div class="flex items-center gap-2 border-t px-3 py-2 text-[11px] text-muted-foreground">
      <span class="min-w-0 flex-1 truncate">Voices, every view and the light: in Plan.</span>
      <Button size="xs" variant="ghost" class="shrink-0" @click="openPlanStep('cast')">Cast & Places <ArrowRight /></Button>
    </div>
  </div>
</template>
