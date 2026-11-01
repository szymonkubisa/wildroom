<script setup lang="ts">
import { Check, LayoutGrid, Rows3, SlidersHorizontal } from '@lucide/vue'
import { useLocalStorage } from '@vueuse/core'
import { computed, onMounted } from 'vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project'
import BatchConfirmDialog from './BatchConfirmDialog.vue'
import CastStep from './steps/CastStep.vue'
import RenderStep from './steps/RenderStep.vue'
import ScenesStep from './steps/ScenesStep.vue'
import StoryboardView from './steps/StoryboardView.vue'
import StoryStep from './steps/StoryStep.vue'
import { focusShot } from './shotSelection'
import StoryModels from './StoryModels.vue'
import { PLAN_STEP_LABEL, type PlanStep } from './planStep'
import { useStory } from './useStory'
import { useStoryBatch } from './useStoryBatch'
import { pendingBrief } from './brief'

/**
 * Plan step by step: 1 the script (→ an outline of chapters and scenes), 2 its cast and places (looks, voices,
 * pictures), 3 its shots, scene by scene (stills, takes), 4 the film (finals, the animatic, the Story cut timeline).
 */
const emit = defineEmits<{ assembled: [] }>()
const s = useStory()
const project = useProjectStore()
// The project's spend and budget are in the top bar (EditorToolbar).
const batch = useStoryBatch(() => emit('assembled'))

type Step = PlanStep
/** Where each project was left: its step and its scene (UI state, not the document). */
const ui = useLocalStorage<Record<string, { step?: Step; sceneId?: string }>>('story.ui', {})
const remembered = computed(() => ui.value[project.id ?? ''] ?? {})
function remember(change: { step?: Step; sceneId?: string }) {
  ui.value = { ...ui.value, [project.id ?? '']: { ...remembered.value, ...change } }
}

const scenes = computed(() => s.story.value.scenes ?? [])
/** A story opens where its work is: no scenes yet → the story; else the scenes. */
const step = computed<Step>({
  get: () => remembered.value.step ?? (scenes.value.length ? 'scenes' : 'story'),
  set: (v) => remember({ step: v }),
})
// A brief from Home: the Director writes its script, scenes and shots (DirectorPanel) — it opens on the first step.
if (pendingBrief.value && pendingBrief.value.projectId === project.id) remember({ step: 'story' })
// Kept from the first look: outlining (scenes appear) mustn't move the user to another step by itself.
onMounted(() => {
  if (project.id && !remembered.value.step) remember({ step: step.value })
})
const sceneId = computed<string | undefined>({
  get: () => {
    const id = remembered.value.sceneId
    return scenes.value.some((x) => x.id === id) ? id : scenes.value[0]?.id
  },
  set: (v) => remember({ sceneId: v }),
})

const written = computed(() => scenes.value.filter((x) => s.story.value.shots.some((shot) => shot.sceneId === x.id)).length)
const progress = computed(() => scenes.value.map((x) => s.sceneProgress(x.id)))
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const steps = computed(() => {
  const st = s.story.value
  const sum = (key: 'stills' | 'stillsNeeded' | 'renders' | 'animated' | 'finals') => progress.value.reduce((n, p) => n + p[key], 0)
  const renders = sum('renders')
  const animated = sum('animated')
  const finals = sum('finals')
  // The script edited since the scenes were made from it: Update scenes has something to do.
  const edited = st.outlinedFrom !== undefined && st.outlinedFrom.trim() !== st.script.trim()
  return [
    {
      id: 'story' as const,
      hint: scenes.value.length ? `${plural(scenes.value.length, 'scene')}${edited ? ' · edited' : ''}` : 'Idea → scenes',
      done: scenes.value.length > 0 && !edited,
    },
    {
      id: 'cast' as const,
      hint: `${plural(st.characters.length, 'character')} · ${plural(st.places?.length ?? 0, 'place')}`,
      done: st.characters.length > 0 && st.characters.every((c) => c.refAssetId),
    },
    {
      id: 'scenes' as const,
      hint: st.shots.length ? `${sum('stills')}/${sum('stillsNeeded')} stills · ${animated}/${renders} takes` : scenes.value.length ? `${written.value}/${scenes.value.length} scenes written` : 'None yet',
      // Done when every scene has its shots and every one of them a take.
      done: renders > 0 && animated === renders && written.value === scenes.value.length,
    },
    {
      id: 'render' as const,
      hint: renders ? `${finals}/${renders} finals` : 'Nothing yet',
      done: renders > 0 && finals === renders && written.value === scenes.value.length,
    },
  ].map((x, i) => ({ ...x, n: i + 1, label: PLAN_STEP_LABEL[x.id] }))
})

const modelsSummary = computed(() => [s.modelFor('image')?.label, s.modelFor('video')?.label].filter(Boolean).join(' · ') || 'Models')

function openScene(id: string) {
  sceneId.value = id
  step.value = 'scenes'
}

/** Shots, one scene at a time, or the storyboard of the whole film (remembered in this browser). */
const shotsView = useLocalStorage<'scene' | 'board'>('story.shotsView', 'scene')
function openShot(scene: string, shotId: string) {
  focusShot.value = shotId || undefined
  sceneId.value = scene
  shotsView.value = 'scene'
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-2">
    <div class="panel-card flex flex-wrap items-center gap-2 bg-sidebar px-3 py-2">
      <div class="mr-1 min-w-0">
        <div class="truncate text-[13px] font-semibold tracking-tight">{{ s.story.value.title || 'Story' }}</div>
        <div v-if="s.story.value.logline" class="max-w-64 truncate text-[11px] text-muted-foreground" :title="s.story.value.logline">{{ s.story.value.logline }}</div>
      </div>
      <nav class="flex items-center gap-1" data-story-steps="">
        <button
          v-for="x in steps"
          :key="x.id"
          type="button"
          :class="cn('flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors', step === x.id ? 'bg-field text-foreground' : 'text-muted-foreground hover:bg-field/60 hover:text-foreground')"
          :data-step="x.id"
          @click="step = x.id"
        >
          <span
            :class="cn('flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold', x.done ? 'bg-brand text-brand-foreground' : step === x.id ? 'bg-foreground text-background' : 'bg-field-hover')"
          >
            <Check v-if="x.done" class="size-3" /><template v-else>{{ x.n }}</template>
          </span>
          <span class="grid leading-tight">
            <span class="text-xs font-medium">{{ x.label }}</span>
            <span class="text-[10px] text-muted-foreground tabular">{{ x.hint }}</span>
          </span>
        </button>
      </nav>
      <div class="flex-1" />
      <div v-if="step === 'scenes' && scenes.length" class="flex items-center gap-0.5 rounded-lg bg-field p-0.5" role="group" aria-label="Show the shots" data-shots-view="">
        <button
          v-for="v in [{ id: 'scene', label: 'Scene', icon: Rows3 }, { id: 'board', label: 'Storyboard', icon: LayoutGrid }] as const"
          :key="v.id"
          type="button"
          :class="cn('flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground', shotsView === v.id && 'bg-raised text-foreground shadow-sm')"
          :aria-pressed="shotsView === v.id"
          :data-shots-view-option="v.id"
          @click="shotsView = v.id"
        >
          <component :is="v.icon" class="size-3.5" /> {{ v.label }}
        </button>
      </div>
      <Popover>
        <PopoverTrigger as-child>
          <Button size="sm" variant="outline" class="max-w-72" title="The story's image, video and voice models" data-story-models-button="">
            <SlidersHorizontal /> <span class="truncate">{{ modelsSummary }}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" class="w-80 p-3">
          <StoryModels layout="stack" />
        </PopoverContent>
      </Popover>
    </div>

    <StoryStep v-if="step === 'story'" class="min-h-0 flex-1" @next="step = 'cast'" />
    <CastStep v-else-if="step === 'cast'" class="min-h-0 flex-1" @next="step = 'scenes'" />
    <StoryboardView v-else-if="step === 'scenes' && shotsView === 'board' && scenes.length" class="min-h-0 flex-1" @open="openShot" />
    <ScenesStep v-else-if="step === 'scenes'" v-model:scene-id="sceneId" :batch="batch" class="min-h-0 flex-1" @outline="step = 'story'" />
    <RenderStep v-else :batch="batch" class="min-h-0 flex-1" @open-scene="openScene" />

    <BatchConfirmDialog :batch="batch" />
  </div>
</template>
