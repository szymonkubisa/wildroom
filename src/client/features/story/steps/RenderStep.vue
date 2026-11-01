<script setup lang="ts">
import { AudioLines, Clapperboard, Gem, Loader2, Wand2 } from '@lucide/vue'
import { scenesOfChapter } from '@shared/story/structure'
import type { StoryScene } from '@shared/types/story'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { formatUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useStory } from '../useStory'
import type { StoryBatch } from '../useStoryBatch'

/**
 * Step 4, Film: the whole film — how far each scene is, animating the scenes whose stills are ready, final renders of
 * the chosen takes, the animatic, and Update timeline (the story laid out again on its own timeline, the Story cut).
 */
const props = defineProps<{ batch: StoryBatch }>()
const emit = defineEmits<{ openScene: [sceneId: string] }>()
const s = useStory()
const { story } = s
const { voicing, assembling } = props.batch

const scenes = computed(() => story.value.scenes ?? [])
const groups = computed<{ title?: string; scenes: StoryScene[] }[]>(() =>
  story.value.chapters?.length ? story.value.chapters.map((c) => ({ title: c.title, scenes: scenesOfChapter(story.value, c.id) })) : [{ scenes: scenes.value }],
)
const numberOf = (id: string) => scenes.value.findIndex((x) => x.id === id) + 1
const progress = computed(() => new Map(scenes.value.map((x) => [x.id, s.sceneProgress(x.id)])))
const totals = computed(() => {
  const all = [...progress.value.values()]
  return {
    shots: all.reduce((n, p) => n + p.shots, 0),
    seconds: all.reduce((n, p) => n + p.seconds, 0),
    renders: all.reduce((n, p) => n + p.renders, 0),
    animated: all.reduce((n, p) => n + p.animated, 0),
    finals: all.reduce((n, p) => n + p.finals, 0),
  }
})

/** Scenes whose stills are all made and that still have shots without a take. */
const ready = computed(() =>
  scenes.value.filter((x) => {
    const p = progress.value.get(x.id)!
    return p.shots && p.stills === p.stillsNeeded && p.animated + p.rendering < p.renders
  }),
)

/** What Animate scene starts in each, priced first — continuing shots too (a scene left with only those had nothing to confirm). */
function animateReady() {
  const list = ready.value
  const planned = list.map((x) => s.planSceneAnimation(x.id))
  const continuing = planned.reduce((n, p) => n + p.continuing, 0)
  props.batch.ask(
    `Animate ${list.length} scene${list.length === 1 ? '' : 's'} with ready stills`,
    planned.flatMap((p) => p.plans),
    () => {
      void (async () => {
        for (const x of list) await s.animateScene(x.id)
      })()
    },
    props.batch.continuingNote(continuing),
  )
}
const finalAll = () => props.batch.ask(`Final render · ${s.finalModel()?.label ?? 'final model'}`, s.planFinals())

/** What a batch would cost, for its button ("· $1.20"); nothing when it can't be priced. */
function costOf(plans: ReturnType<typeof s.planFinals>): string {
  const ok = plans.filter((p): p is Exclude<typeof p, string> => typeof p !== 'string')
  if (!ok.length) return ''
  const usd = s.estimate(ok)
  return usd == null ? '' : ` · ${formatUsd(usd)}`
}
const animateCost = computed(() => costOf(ready.value.flatMap((x) => s.planSceneAnimation(x.id).plans)))
const finalPlans = computed(() => (s.finalModel() ? s.planFinals() : []))
const finalCount = computed(() => finalPlans.value.filter((p) => typeof p !== 'string').length)
const finalCost = computed(() => costOf(finalPlans.value))

const fraction = (a: number, b: number) => (b ? `${a}/${b}` : '—')
</script>

<template>
  <div class="panel-card flex min-h-0 flex-col bg-muted dark:bg-sidebar">
    <div class="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2">
      <div>
        <div class="text-[13px] font-semibold tracking-tight">4 · Film</div>
        <div class="text-[11px] text-muted-foreground tabular">
          {{ scenes.length }} scene{{ scenes.length === 1 ? '' : 's' }} · {{ totals.shots }} shot{{ totals.shots === 1 ? '' : 's' }} · {{ Math.round(totals.seconds) }} s · animated
          {{ fraction(totals.animated, totals.renders) }} · finals {{ fraction(totals.finals, totals.renders) }}
        </div>
      </div>
      <div class="flex-1" />
      <Button size="sm" variant="outline" :disabled="!ready.length" :title="ready.length ? `Scenes ${ready.map((x) => numberOf(x.id)).join(', ')}` : 'No scene has all its stills and shots left to animate'" data-film-animate="" @click="animateReady">
        <Wand2 /> Animate ready scenes{{ ready.length ? ` (${ready.length})${animateCost}` : '' }}
      </Button>
      <Button
        size="sm"
        variant="outline"
        :disabled="!totals.animated || !s.finalModel()"
        :title="s.finalModel() ? 'Render every chosen take that isn’t final yet with the final model' : 'Pick a final model first (Models)'"
        data-film-finals=""
        @click="finalAll"
      >
        <Gem /> Finals for chosen takes{{ finalCount ? ` · ${finalCount}${finalCost}` : '' }}
      </Button>
      <Button
        size="sm"
        variant="outline"
        :disabled="!totals.shots || Boolean(voicing) || assembling"
        title="The stills timed to free temp voices (macOS), on the Story cut — check the pacing before paying for anything"
        data-film-animatic=""
        @click="batch.animatic"
      >
        <Loader2 v-if="voicing" class="animate-spin" /><AudioLines v-else />
        {{ voicing ? (voicing.total ? `Voicing ${voicing.done}/${voicing.total}…` : 'Animatic…') : 'Animatic · free' }}
      </Button>
      <Button
        size="sm"
        :disabled="!totals.shots || assembling"
        title="The chosen takes (else stills) on the Story cut timeline, with the lines and chapter markers — replaced as a whole each time, in one undo step"
        data-film-update-timeline=""
        @click="batch.assemble"
      >
        <Loader2 v-if="assembling" class="animate-spin" /><Clapperboard v-else /> Update timeline
      </Button>
    </div>
    <p class="px-4 pb-2 text-[11px] text-muted-foreground">
      Update timeline replaces the “Story cut” timeline in one step — Undo puts it back. Your other timelines are never touched.
    </p>
    <ScrollArea class="min-h-0 flex-1">
      <div class="mx-auto grid max-w-4xl gap-4 px-4 pb-6" data-render-table="">
        <section v-for="(g, gi) in groups" :key="gi" class="grid gap-1">
          <div v-if="g.title" class="px-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{{ g.title }}</div>
          <div class="overflow-hidden rounded-xl bg-card">
            <div class="grid grid-cols-[2rem_minmax(0,1fr)_4rem_4.5rem_5.5rem_4rem] gap-2 border-b px-3 py-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              <span>#</span><span>Scene</span><span class="text-right">Shots</span><span class="text-right">Stills</span><span class="text-right">Animated</span><span class="text-right">Finals</span>
            </div>
            <button
              v-for="sc in g.scenes"
              :key="sc.id"
              type="button"
              class="grid w-full grid-cols-[2rem_minmax(0,1fr)_4rem_4.5rem_5.5rem_4rem] items-center gap-2 px-3 py-2 text-left text-xs tabular hover:bg-field/60"
              :title="`Open scene ${numberOf(sc.id)}`"
              @click="emit('openScene', sc.id)"
            >
              <span class="font-semibold text-muted-foreground">{{ numberOf(sc.id) }}</span>
              <span class="truncate font-medium">{{ sc.title }}</span>
              <span class="text-right">{{ progress.get(sc.id)!.shots || '—' }}</span>
              <span :class="cn('text-right', progress.get(sc.id)!.stillsNeeded && progress.get(sc.id)!.stills === progress.get(sc.id)!.stillsNeeded && 'text-role-effects')">
                {{ fraction(progress.get(sc.id)!.stills, progress.get(sc.id)!.stillsNeeded) }}
              </span>
              <span :class="cn('flex items-center justify-end gap-1', progress.get(sc.id)!.renders && progress.get(sc.id)!.animated === progress.get(sc.id)!.renders && 'text-brand')">
                <Loader2 v-if="progress.get(sc.id)!.rendering" class="size-3 animate-spin" />
                {{ fraction(progress.get(sc.id)!.animated, progress.get(sc.id)!.renders) }}
              </span>
              <span class="text-right">{{ progress.get(sc.id)!.finals || '—' }}</span>
            </button>
            <div v-if="!g.scenes.length" class="px-3 py-2 text-xs text-muted-foreground">No scenes</div>
          </div>
        </section>
      </div>
    </ScrollArea>
  </div>
</template>
