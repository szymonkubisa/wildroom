<script setup lang="ts">
import type { ParamValues } from '@shared/models/types'
import type { StoryShot } from '@shared/types/story'
import { computed } from 'vue'
import { useAssetsStore } from '@/stores/assets'
import { continuing } from '../sceneRun'
import { type Planned, useStory } from '../useStory'

/**
 * What the models get for this shot, exactly as it would be sent now: the still's plan (planKeyframe — imagePrompt with
 * its references' legend) and the take's (planVideo — videoPrompt in the shot's video model's dialect), each with its
 * model, its pictures in order and its other settings. Nothing here is written for show: these are the plans New
 * still and Animate start.
 */
const props = defineProps<{ shot: StoryShot }>()
const s = useStory()
const assets = useAssetsStore()

interface Picture {
  id: string
  label: string
  poster?: string
}
/** The settings that are pictures, in the order the model reads them, and what each is called. */
const PICTURE_KEYS: [key: string, label: (i: number) => string][] = [
  ['firstFrame', () => 'Start frame'],
  ['lastFrame', () => 'End frame'],
  ['referenceImages', (i) => `Image ${i + 1}`],
  ['referenceBackground', () => 'Scene'],
  ['continueFrom', () => 'Take before'],
  ['audioClip', () => 'Voice track'],
]
const SHOWN = new Set(['prompt', 'negativePrompt', 'elements', ...PICTURE_KEYS.map(([k]) => k)])

function pictures(params: ParamValues): Picture[] {
  return PICTURE_KEYS.flatMap(([key, label]) => {
    const v = params[key]
    const ids = (Array.isArray(v) ? v : v ? [v] : []).filter((x): x is string => typeof x === 'string' && Boolean(x))
    return ids.map((id, i) => {
      const asset = assets.get(id)
      return { id, label: label(i), poster: asset?.variants.poster ? `/media/${asset.id}/poster` : undefined }
    })
  })
}
/** The other settings, as "duration 5 · aspectRatio 16:9". */
function settings(params: ParamValues): string {
  return Object.entries(params)
    .filter(([k, v]) => !SHOWN.has(k) && v !== undefined && v !== null && v !== '' && typeof v !== 'object')
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(' · ')
}

interface PlanView {
  problem?: string
  model?: string
  prompt?: string
  negative?: string
  pictures?: Picture[]
  elements?: number
  settings?: string
  waits?: string
}
function view(plan: Planned | string): PlanView {
  if (typeof plan === 'string') return { problem: plan }
  const elements = Array.isArray(plan.params.elements) ? plan.params.elements.length : 0
  return {
    model: plan.model.label,
    prompt: String(plan.params.prompt ?? ''),
    negative: typeof plan.params.negativePrompt === 'string' ? plan.params.negativePrompt : undefined,
    pictures: pictures(plan.params),
    elements,
    settings: settings(plan.params),
    waits: plan.prepare ? (plan.makes?.waitsFor ?? 'something first') : undefined,
  }
}
const still = computed(() => view(s.planKeyframe(props.shot)))
const video = computed(() => view(s.planVideo(props.shot)))
const continues = computed(() => continuing(s.story.value, props.shot))
const label = 'text-[10px] font-medium tracking-wide text-muted-foreground uppercase'
</script>

<template>
  <div class="grid gap-3 rounded-xl bg-field/60 p-3 text-[11px]" data-shot-compiled="">
    <section v-for="part in [{ key: 'still', title: 'Still', v: still }, { key: 'video', title: 'Video', v: video }]" :key="part.key" class="grid gap-1.5" :data-compiled="part.key">
      <div class="flex flex-wrap items-baseline gap-x-2">
        <span :class="label">{{ part.title }}</span>
        <span v-if="part.v.model" class="text-muted-foreground">{{ part.v.model }}</span>
      </div>
      <p v-if="part.v.problem" class="text-role-effects">{{ part.v.problem }}</p>
      <template v-else>
        <div v-if="part.v.pictures?.length" class="flex flex-wrap gap-1.5">
          <figure v-for="p in part.v.pictures" :key="`${p.label}:${p.id}`" class="grid w-16 gap-0.5" :title="assets.get(p.id)?.name ?? p.id">
            <span class="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-viewer">
              <img v-if="p.poster" :src="p.poster" class="max-h-full max-w-full object-contain" alt="" />
              <span v-else class="text-[9px] text-muted-foreground">…</span>
            </span>
            <figcaption class="truncate text-[10px] text-muted-foreground">{{ p.label }}</figcaption>
          </figure>
        </div>
        <p v-if="part.v.elements" class="text-muted-foreground">{{ part.v.elements }} Kling element{{ part.v.elements === 1 ? '' : 's' }} (the cast as synced)</p>
        <pre class="max-h-56 overflow-auto rounded-lg bg-card p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap" data-compiled-prompt="">{{ part.v.prompt }}</pre>
        <p v-if="part.v.negative" class="text-muted-foreground"><span class="font-medium">Avoid:</span> {{ part.v.negative }}</p>
        <p v-if="part.v.settings" class="font-mono text-[10px] break-words text-muted-foreground">{{ part.v.settings }}</p>
        <p v-if="part.v.waits" class="text-muted-foreground">Before it starts: {{ part.v.waits }} — then it is planned again with {{ part.v.waits === 'its lines' ? 'its voice track (the prompt then gives the words only)' : 'what that found' }}.</p>
      </template>
    </section>
    <p v-if="continues" class="text-muted-foreground">This shot continues the one before: its take starts from that take’s ending instead of the still, so its start frame then differs.</p>
  </div>
</template>
