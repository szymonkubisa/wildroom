<script setup lang="ts">
import { ArrowRight, Clapperboard, Loader2, MapPin, MoreHorizontal, Plus, RotateCcw, Sparkles, Square, Wand2 } from '@lucide/vue'
import { insertShot, sceneNumber, shotsOfScene } from '@shared/story/structure'
import type { StoryMultishot, StoryShot } from '@shared/types/story'
import { nanoid } from 'nanoid'
import { computed, nextTick, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { useConfirm } from '@/components/app/useConfirm'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import BatchConfirmCard from '../BatchConfirmCard.vue'
import MultishotBar from '../MultishotBar.vue'
import { placeNote, placeReadiness } from '../readiness'
import { focusShot } from '../shotSelection'
import { useStory } from '../useStory'
import type { StoryBatch } from '../useStoryBatch'
import { costLabel } from './shotRender'
import ShotDetails from './ShotDetails.vue'
import ShotRow from './ShotRow.vue'

/**
 * One scene at a time: write its shots, make its stills (the opening wide first — the layout the others follow), check
 * them, then animate the scene — each batch with its cost on the button, asked in place under the header. Shots are
 * rows; one opens its details at a time.
 */
const props = defineProps<{ sceneId: string; batch: StoryBatch }>()
const emit = defineEmits<{ select: [sceneId: string] }>()
const s = useStory()
const { story } = s

const scene = computed(() => story.value.scenes?.find((x) => x.id === props.sceneId))
const number = computed(() => sceneNumber(story.value, props.sceneId))
const shots = computed(() => shotsOfScene(story.value, props.sceneId))
const progress = computed(() => s.sceneProgress(props.sceneId))
const run = computed(() => s.sceneRunOf(props.sceneId))
const place = computed(() => (scene.value?.placeId ? story.value.places?.find((p) => p.id === scene.value!.placeId) : undefined))
const assets = useAssetsStore()
const confirm = useConfirm()
/** The place without an approved photo there (placeReadiness): its keyframes would invent it — said before Stills. */
const placeProblem = computed(() =>
  placeNote(placeReadiness(story.value, props.sceneId, (id) => Boolean(assets.loading || assets.get(id)), (gid) => Boolean(s.outputOf(gid)))),
)
const next = computed(() => story.value.scenes?.[number.value])

/** The open shot: one at a time, the rest folded to a line. */
const open = ref<string>()
watch(
  () => props.sceneId,
  () => (open.value = undefined),
)
// A card clicked on the storyboard: open that shot here and bring it into view.
watch(
  [focusShot, shots],
  async ([id]) => {
    if (!id || !shots.value.some((x) => x.id === id)) return
    focusShot.value = undefined
    open.value = id
    await nextTick()
    document.querySelector(`[data-shot-row="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  },
  { immediate: true },
)

type Block = { kind: 'group'; group: StoryMultishot; shots: StoryShot[] } | { kind: 'shot'; shot: StoryShot }
const blocks = computed(() => {
  const out: Block[] = []
  for (const shot of shots.value) {
    const group = s.groupOf(shot)
    const last = out.at(-1)
    if (!group) out.push({ kind: 'shot', shot })
    else if (last?.kind === 'group' && last.group.id === group.id) last.shots.push(shot)
    else out.push({ kind: 'group', group, shots: [shot] })
  }
  return out
})
const indexOf = (shot: StoryShot) => story.value.shots.findIndex((x) => x.id === shot.id)
const toggle = (id: string) => (open.value = open.value === id ? undefined : id)

// ---- write
// The scene's own: the board stays one component from scene to scene, and a scene being written showed on the next one.
const writing = computed(() => s.writingShots(props.sceneId))
async function write() {
  if (writing.value) return
  const sceneId = props.sceneId
  // Read now: after the minute the Director takes, the board may show another scene (its toast named that one).
  const n0 = number.value
  const work = s.sceneWork(sceneId)
  if (
    work.shots &&
    !(await confirm({
      title: 'Write this scene’s shots again?',
      description: `Its ${work.shots} shot${work.shots === 1 ? '' : 's'}${work.keyframes ? `, ${work.keyframes} still${work.keyframes === 1 ? '' : 's'}` : ''}${work.takes ? ` and ${work.takes} take${work.takes === 1 ? '' : 's'}` : ''} are set aside — Undo brings them back, and images and clips stay in Assets.`,
      confirmText: 'Write again',
      destructive: true,
    }))
  )
    return
  // The Director takes a minute or so: from the ⋯ menu nothing else showed it was at work.
  const id = toast.loading(`Writing the shots for scene ${n0}…`, { description: 'The Director reads the scene, its place and cast — about a minute.' })
  try {
    const n = await s.writeShotsForScene(sceneId)
    toast.success(`${n} shot${n === 1 ? '' : 's'} written for scene ${n0}`, { id, description: 'Check them, then make the stills.' })
  } catch (err) {
    toast.error(`Writing the shots for scene ${n0} failed`, { id, description: errorMessage(err) })
  }
}

// ---- stills, then the scene's takes
const prepareLabel = computed(() => (shots.value.some(props.batch.voicedByElevenLabs) ? 'Stills & voices' : 'Stills'))
/**
 * The stills the shots don't have yet — or `again` (the button, once every still is made): all of them drawn again,
 * in the same order as the first time (the opening shot, the others from it, each end frame from its new keyframe).
 */
function stills(again = stillsDone.value) {
  const list = shots.value
  const first = list[0]
  // A scene that continues the one before opens on that scene's last frame, redrawn; the others follow it.
  const fromPrevious = Boolean(scene.value?.continuesPrevious && first && (again || !s.keyframeOf(first)) && s.previousEnd(first))
  const rest = fromPrevious ? list.slice(1) : list
  const opts = { again }
  const plans = props.batch.planPrepare(rest, opts)
  if (fromPrevious && !plans.length) return void s.openingFromPrevious(first!)
  props.batch.ask(
    `${again ? 'Stills again' : prepareLabel.value} · scene ${number.value}`,
    plans,
    fromPrevious
      ? () =>
          void (async () => {
            await s.openingFromPrevious(first!)
            // Planned again now, so the others get the new opening as their layout — from the shots as they are now
            // (a minute later), not as they were when the dialog opened.
            const ids = new Set(rest.map((x) => x.id))
            await s.runBatch(props.batch.planPrepare(story.value.shots.filter((x) => ids.has(x.id)), opts))
          })()
      : undefined,
    [
      placeProblem.value,
      again &&
        'Every still of this scene is drawn again: the opening shot first, the others from it, each end frame from its new still. The current stills stay among each shot’s earlier stills; the takes are kept.',
    ]
      .filter(Boolean)
      .join(' ') || undefined,
    props.sceneId,
  )
}

/** Confirmed with its cost first — the continuing shots too, which start later (they started unpriced, unbudgeted). */
function animate() {
  const sceneId = props.sceneId
  const { plans, continuing } = s.planSceneAnimation(sceneId)
  const model = s.modelFor('video')
  props.batch.ask(
    `Animate scene ${number.value}${model ? ` · ${model.label}` : ''}`,
    plans,
    () => void s.animateScene(sceneId),
    props.batch.continuingNote(continuing),
    sceneId,
  )
}

/** What the scene's two batches would start now, for their buttons: how many, and what they cost. */
const valid = <T,>(plans: (T | string)[]) => plans.filter((p): p is T => typeof p !== 'string')
const stillPlans = computed(() => (progress.value.shots ? props.batch.planPrepare(shots.value, { again: stillsDone.value }) : []))
const stillCount = computed(() => valid(stillPlans.value).filter((p) => p.model.kind === 'image').length)
const stillsLabel = computed(() => {
  if (stillsDone.value) return `Stills again${stillCount.value ? ` · ${stillCount.value}` : ''}${costLabel(stillPlans.value)}`
  return `${stillCount.value ? `Make ${stillCount.value} still${stillCount.value === 1 ? '' : 's'}` : prepareLabel.value}${costLabel(stillPlans.value)}`
})
const animatePlans = computed(() => (progress.value.shots ? s.planSceneAnimation(props.sceneId).plans : []))
const animateCount = computed(() => valid(animatePlans.value).length)
const animateLabel = computed(() => (animateCount.value ? `Animate ${animateCount.value}${costLabel(animatePlans.value)}` : 'Animate scene'))
/** The scene's batch asked in place: shown under its header. */
const asking = computed(() => props.batch.pending.value?.inline === props.sceneId)

function addShot() {
  const id = nanoid(8)
  const after = open.value && shots.value.some((x) => x.id === open.value) ? open.value : undefined
  s.update('Add shot', (st) =>
    insertShot(st, props.sceneId, { id, description: '', prompt: '', duration: 5, characterIds: [...(scene.value?.castIds ?? [])], dialogue: [], videoGenerationIds: [] }, after),
  )
  open.value = id
}

const stillsDone = computed(() => progress.value.stillsNeeded > 0 && progress.value.stills === progress.value.stillsNeeded && !shots.value.some((x) => x.stillStale))
</script>

<template>
  <div v-if="scene" class="flex min-h-0 flex-col bg-muted dark:bg-sidebar">
    <div class="grid gap-1.5 px-4 pt-3 pb-2">
      <div class="flex flex-wrap items-center gap-2">
        <span class="rounded-md bg-foreground px-1.5 py-0.5 text-[11px] font-semibold text-background tabular">Scene {{ number }}</span>
        <div class="min-w-0 truncate text-[15px] font-semibold tracking-tight" data-scene-title="">{{ scene.title }}</div>
        <span v-if="place" class="flex items-center gap-0.5 text-[11px] text-muted-foreground" :title="placeProblem" data-scene-place="">
          <MapPin :class="cn('size-3', placeProblem && 'text-role-effects')" />{{ place.name }}
        </span>
        <span v-if="scene.time" class="text-[11px] text-muted-foreground">· {{ scene.time }}</span>
      </div>
      <div v-if="scene.summary" class="line-clamp-2 text-xs text-muted-foreground">{{ scene.summary }}</div>
      <div class="flex flex-wrap items-center gap-2 pt-1">
        <span class="text-[11px] text-muted-foreground tabular" data-scene-progress="">
          <span v-if="writing" class="flex items-center gap-1 text-foreground"><Loader2 class="size-3 animate-spin" /> Writing the shots…</span>
          <template v-else-if="progress.shots">
            {{ progress.shots }} shot{{ progress.shots === 1 ? '' : 's' }} · {{ Math.round(progress.seconds) }} s · stills {{ progress.stills }}/{{ progress.stillsNeeded }} · animated
            {{ progress.animated }}/{{ progress.renders }}
          </template>
          <template v-else>No shots yet</template>
        </span>
        <div class="flex-1" />
        <template v-if="progress.shots">
          <Button
            size="sm"
            :variant="stillsDone ? 'outline' : 'default'"
            :title="stillsDone ? 'Draw every still of this scene again — the opening shot first, the others from it' : batch.prepareTitle(shots)"
            data-scene-stills=""
            @click="stills()"
          >
            <template v-if="stillsDone"><RotateCcw /> {{ stillsLabel }}</template>
            <template v-else><Sparkles /> {{ stillsLabel }}</template>
          </Button>
          <Button size="sm" :variant="stillsDone ? 'default' : 'outline'" title="Every shot without a take, in order — the first comes back first" data-scene-animate="" @click="animate">
            <Wand2 /> {{ animateLabel }}
          </Button>
          <Button v-if="run" size="sm" variant="ghost" :title="`${run.rendering} rendering, ${run.waiting.length} waiting`" @click="s.stopScene(sceneId)">
            <Square /> Stop
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger as-child><Button size="icon-sm" variant="ghost"><MoreHorizontal /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem :disabled="writing" @select="write"><RotateCcw /> Write the shots again</DropdownMenuItem>
              <DropdownMenuItem v-if="progress.stills" data-scene-stills-again="" @select="stills(true)"><Sparkles /> Make all stills again</DropdownMenuItem>
              <DropdownMenuItem @select="addShot"><Plus /> Add a shot</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </template>
      </div>
    </div>

    <div v-if="asking" class="px-4 pb-2"><BatchConfirmCard :batch="batch" /></div>

    <ScrollArea class="min-h-0 flex-1">
      <!-- minmax(0, 1fr): an auto column grew to its widest card's content and pushed every card past the right edge. -->
      <div class="mx-auto grid max-w-4xl grid-cols-[minmax(0,1fr)] gap-2 px-4 pb-6">
        <div v-if="!shots.length" class="grid justify-items-center gap-3 rounded-2xl border border-dashed bg-card/50 px-6 py-10 text-center" data-scene-empty="">
          <Clapperboard class="size-6 text-muted-foreground" />
          <div class="text-sm font-medium">Write this scene’s shots</div>
          <div class="max-w-md text-xs text-muted-foreground">
            The Director writes them from the scene’s part of the script, with its place, light and cast as you set them — the first one a wide that sets where everyone stands.
          </div>
          <pre v-if="scene.script" class="max-h-40 w-full max-w-xl overflow-auto rounded-lg bg-field p-3 text-left font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">{{ scene.script }}</pre>
          <div class="flex items-center gap-2">
            <Button :disabled="writing || (!scene.script && !scene.summary)" data-write-shots="" @click="write">
              <Loader2 v-if="writing" class="animate-spin" /><Wand2 v-else /> Write shots
            </Button>
            <Button variant="ghost" @click="addShot"><Plus /> Add a shot by hand</Button>
          </div>
        </div>

        <template v-for="b in blocks" :key="b.kind === 'group' ? b.group.id : b.shot.id">
          <section v-if="b.kind === 'group'" class="grid grid-cols-[minmax(0,1fr)] gap-2 rounded-2xl border-2 border-brand/45 bg-brand/[0.06] p-2" data-multishot-block="">
            <MultishotBar :group="b.group" />
            <div v-for="x in b.shots" :key="x.id" class="grid grid-cols-[minmax(0,1fr)]">
              <ShotRow :shot="x" :label="s.shotName(x)" :open="open === x.id" @toggle="toggle(x.id)" />
              <ShotDetails v-if="open === x.id" :shot="x" :index="indexOf(x)" :total="story.shots.length" :label="s.shotName(x)" />
            </div>
          </section>
          <div v-else class="grid grid-cols-[minmax(0,1fr)]">
            <ShotRow :shot="b.shot" :label="s.shotName(b.shot)" :open="open === b.shot.id" @toggle="toggle(b.shot.id)" />
            <ShotDetails v-if="open === b.shot.id" :shot="b.shot" :index="indexOf(b.shot)" :total="story.shots.length" :label="s.shotName(b.shot)" />
          </div>
        </template>

        <div v-if="shots.length" class="flex items-center justify-between pt-2">
          <Button variant="ghost" size="sm" @click="addShot"><Plus /> Add shot</Button>
          <Button v-if="next" variant="outline" size="sm" @click="emit('select', next.id)">Scene {{ number + 1 }}: {{ next.title }} <ArrowRight /></Button>
        </div>
      </div>
    </ScrollArea>
  </div>
</template>
