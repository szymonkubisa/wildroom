<script setup lang="ts">
import { Check, Clapperboard, Film, ImageIcon, Loader2, MapPin } from '@lucide/vue'
import { splitFraming } from '@shared/story/framing'
import { sceneNumber, shotsOfScene } from '@shared/story/structure'
import type { StoryScene, StoryShot } from '@shared/types/story'
import { computed } from 'vue'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { inFlight, useStory } from '../useStory'

/**
 * The whole film at a glance, as LTX Studio, Boords and Storyboarder show it: every scene a row of shot cards — the
 * still (or the take) big, the shot's number, framing, length and how far it is — under its chapter, with what the
 * scene has done ("stills 3/5 · takes 1/5"). Click a card to open that shot in its scene.
 */
const emit = defineEmits<{ open: [sceneId: string, shotId: string] }>()
const s = useStory()
const story = s.story

const chapters = computed(() => {
  const st = story.value
  const scenes = st.scenes ?? []
  if (!st.chapters?.length) return [{ id: 'all', title: '', scenes }]
  const out = st.chapters.map((c) => ({ id: c.id, title: c.title, scenes: scenes.filter((x) => x.chapterId === c.id) }))
  const loose = scenes.filter((x) => !st.chapters!.some((c) => c.id === x.chapterId))
  return loose.length ? [...out, { id: 'loose', title: 'No chapter', scenes: loose }] : out
})

type CardState = 'final' | 'take' | 'still' | 'rendering' | 'empty'
const STATE_LABEL: Record<CardState, string> = { final: 'Final', take: 'Take', still: 'Still', rendering: 'Rendering', empty: 'To do' }

function card(shot: StoryShot) {
  const keyframe = s.keyframeOf(shot)
  const group = s.groupOf(shot)
  const video = s.chosenVideoOf(shot) ?? (group ? s.chosenGroupVideo(group) : undefined)
  const poster = keyframe?.variants.poster ? keyframe : video?.variants.poster ? video : undefined
  const takes = s.takesOf(shot)
  const running = inFlight(s.jobState(shot.keyframeGenerationId)) || takes.some((t) => inFlight(t.state))
  const state: CardState = running ? 'rendering' : video && s.isFinalAsset(video) ? 'final' : video ? 'take' : keyframe ? 'still' : 'empty'
  const f = splitFraming(shot.shotType)
  return {
    shot,
    label: s.shotName(shot),
    poster: poster && `/media/${poster.id}/poster`,
    state,
    framing: [f.size, f.lens].filter(Boolean).join(' · '),
    takes: takes.filter((t) => t.asset).length,
  }
}
/** Each scene's cards, made once per change (not once per use in the template). */
const cards = computed(() => new Map((story.value.scenes ?? []).map((sc) => [sc.id, shotsOfScene(story.value, sc.id).map(card)])))
const cardsOf = (scene: StoryScene) => cards.value.get(scene.id) ?? []
const placeOf = (scene: StoryScene) => (scene.placeId ? story.value.places?.find((p) => p.id === scene.placeId)?.name : undefined)
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`

const pill = (state: CardState) =>
  cn(
    'inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-[10px] font-medium backdrop-blur',
    state === 'final' ? 'bg-emerald-500/90 text-white' : state === 'take' ? 'bg-white/90 text-black' : state === 'still' ? 'bg-black/60 text-white' : state === 'rendering' ? 'bg-brand text-brand-foreground' : 'bg-black/50 text-white/70',
  )
</script>

<template>
  <div class="panel-card flex min-h-0 flex-col bg-sidebar" data-storyboard="">
    <ScrollArea class="min-h-0 flex-1">
      <div class="grid gap-8 px-5 pt-4 pb-6">
        <section v-for="ch in chapters" :key="ch.id" class="grid gap-5">
          <h2 v-if="ch.title" class="font-mono text-[10.5px] font-medium tracking-widest text-muted-foreground uppercase">{{ ch.title }}</h2>
          <article v-for="scene in ch.scenes" :key="scene.id" class="grid gap-2.5" :data-storyboard-scene="scene.id">
            <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 class="text-sm font-semibold">
                <span class="mr-1.5 text-muted-foreground tabular">{{ sceneNumber(story, scene.id) }}</span>{{ scene.title }}
              </h3>
              <span v-if="placeOf(scene)" class="flex items-center gap-1 text-[11px] text-muted-foreground"><MapPin class="size-3" />{{ placeOf(scene) }}</span>
              <span class="ml-auto font-mono text-[10.5px] text-muted-foreground tabular" data-storyboard-progress="">
                <template v-for="p in [s.sceneProgress(scene.id)]" :key="scene.id">
                  {{ p.shots }} shots · {{ clock(p.seconds) }} · stills {{ p.stills }}/{{ p.stillsNeeded }} · takes {{ p.animated }}/{{ p.renders }}
                </template>
              </span>
            </header>
            <div v-if="cardsOf(scene).length" class="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
              <button
                v-for="c in cardsOf(scene)"
                :key="c.shot.id"
                type="button"
                class="group/card grid gap-1.5 text-left"
                :data-storyboard-shot="c.shot.id"
                :data-state="c.state"
                @click="emit('open', scene.id, c.shot.id)"
              >
                <span class="relative block aspect-video overflow-hidden rounded-xl bg-viewer transition-[transform,box-shadow] duration-150 group-hover/card:-translate-y-px group-hover/card:shadow-[0_10px_30px_-12px_rgb(0_0_0/0.6)] group-hover/card:ring-1 group-hover/card:ring-border">
                  <img v-if="c.poster" :src="c.poster" alt="" class="size-full object-cover" />
                  <span v-else class="grid size-full place-items-center text-muted-foreground/50">
                    <Loader2 v-if="c.state === 'rendering'" class="size-5 animate-spin text-brand" /><ImageIcon v-else class="size-5" />
                  </span>
                  <span class="absolute top-1.5 left-1.5 rounded-md bg-black/60 px-1.5 py-px text-[11px] font-semibold text-white tabular backdrop-blur">{{ c.label }}</span>
                  <span :class="cn(pill(c.state), 'absolute top-1.5 right-1.5')">
                    <Check v-if="c.state === 'final'" class="size-3" /><Film v-else-if="c.state === 'take'" class="size-3" /><Loader2 v-else-if="c.state === 'rendering'" class="size-3 animate-spin" />{{ STATE_LABEL[c.state] }}<template v-if="c.takes > 1"> · {{ c.takes }}</template>
                  </span>
                  <span class="absolute right-1.5 bottom-1.5 rounded-md bg-black/60 px-1.5 py-px font-mono text-[10px] text-white tabular">{{ c.shot.duration }} s</span>
                </span>
                <span class="grid gap-0.5 px-0.5">
                  <span v-if="c.framing" class="truncate text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{{ c.framing }}</span>
                  <span class="line-clamp-2 text-[12px] leading-snug">{{ c.shot.description }}</span>
                </span>
              </button>
            </div>
            <button
              v-else
              type="button"
              class="flex h-20 items-center justify-center gap-2 rounded-xl border border-dashed text-xs text-muted-foreground hover:bg-field hover:text-foreground"
              @click="emit('open', scene.id, '')"
            >
              <Clapperboard class="size-4" /> No shots yet — open the scene to write them
            </button>
          </article>
        </section>
      </div>
    </ScrollArea>
  </div>
</template>
