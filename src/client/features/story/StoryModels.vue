<script setup lang="ts">
import type { ModelSpec } from '@shared/models/types'
import { computed } from 'vue'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { groupByProvider } from '@/lib/providers'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings'
import { capabilityChips } from './modelInfo'
import RenderSettings from './RenderSettings.vue'
import { useStory } from './useStory'

/**
 * The story's models: the keyframes' image model, the drafts' and the finals' video models with their render settings,
 * and the voice model. In a row, or stacked (the steps' Models popover).
 */
const props = withDefaults(defineProps<{ layout?: 'inline' | 'stack' }>(), { layout: 'inline' })
const s = useStory()
const settings = useSettingsStore()
const stack = computed(() => props.layout === 'stack')

const models = (kind: 'image' | 'video' | 'speech') => settings.availableModels.filter((m) => m.kind === kind)
/** Capability chips beside a model in the pickers ("Multi-shot ≤6", "Elements 3", "EN/ZH speech", "$0.17/s"). */
const chipsOf = (m: ModelSpec, final = false) => capabilityChips(m, s.renderSettings(m, final))

function setModel(kind: 'image' | 'video' | 'speech', id: unknown) {
  s.update('Story models', (story) => {
    if (kind === 'image') story.imageModelId = String(id)
    else if (kind === 'video') story.videoModelId = String(id)
    else story.voiceModelId = String(id)
  })
}
function setFinalModel(id: unknown) {
  s.update('Final model', (story) => (story.finalVideoModelId = id && id !== 'none' ? String(id) : undefined))
}
const finalLabel = computed(() => {
  const id = s.story.value.finalVideoModelId
  return id ? (models('video').find((m) => m.id === id)?.label ?? id) : 'None'
})
const trigger = computed(() => cn('h-7 text-xs', stack.value ? 'w-full' : 'w-40'))
</script>

<template>
  <div :class="cn(stack ? 'grid gap-3' : 'contents')">
    <!-- Each control says what it picks: the keyframes' image model, the drafts', the finals', the line voices'. -->
    <div class="grid gap-0.5" data-story-models="">
      <span class="px-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Stills</span>
      <Select :model-value="s.modelFor('image')?.id" @update:model-value="(v) => setModel('image', v)">
        <SelectTrigger :class="trigger" title="Image model for the stills and the Cast's video references"><SelectValue placeholder="Image model" /></SelectTrigger>
        <SelectContent>
          <!-- By where they run: the same model on fal.ai and OpenRouter read as duplicates in one flat list. -->
          <SelectGroup v-for="g in groupByProvider(models('image'))" :key="g.provider">
            <SelectLabel class="px-2 pt-2 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{{ g.name }}</SelectLabel>
            <SelectItem v-for="m in g.models" :key="m.id" :value="m.id">{{ m.label }}</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
    <div class="grid gap-0.5">
      <span class="px-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Draft video</span>
      <div :class="cn('flex gap-1', stack ? 'flex-col items-stretch' : 'items-center')">
        <!-- The trigger shows the name from the model, not SelectValue: the items carry capability chips too. -->
        <Select :model-value="s.modelFor('video')?.id" @update:model-value="(v) => setModel('video', v)">
          <SelectTrigger
            :class="trigger"
            :title="s.modelFor('video') ? chipsOf(s.modelFor('video')!).map((c) => c.text).join(' · ') : undefined"
            data-story-video-model=""
          >
            <span class="truncate">{{ s.modelFor('video')?.label ?? 'Video model' }}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup v-for="g in groupByProvider(models('video'))" :key="g.provider">
              <SelectLabel class="px-2 pt-2 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{{ g.name }}</SelectLabel>
              <SelectItem v-for="m in g.models" :key="m.id" :value="m.id">
                {{ m.label }}
                <span class="ml-auto flex gap-1 pl-2" data-model-chips="">
                  <span v-for="c in chipsOf(m)" :key="c.text" class="rounded bg-field px-1 text-[10px] whitespace-nowrap text-muted-foreground" :title="c.title">{{ c.text }}</span>
                </span>
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <RenderSettings :model="s.modelFor('video')" :inline="stack" />
      </div>
    </div>
    <div class="grid gap-0.5">
      <span class="px-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Final video</span>
      <div :class="cn('flex gap-1', stack ? 'flex-col items-stretch' : 'items-center')">
        <Select :model-value="s.story.value.finalVideoModelId ?? 'none'" @update:model-value="setFinalModel">
          <SelectTrigger :class="trigger" title="Final model: chosen draft takes are rendered again with it">
            <span class="truncate">{{ finalLabel }}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No final model</SelectItem>
            <SelectGroup v-for="g in groupByProvider(models('video'))" :key="g.provider">
              <SelectLabel class="px-2 pt-2 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{{ g.name }}</SelectLabel>
              <SelectItem v-for="m in g.models" :key="m.id" :value="m.id">
                {{ m.label }}
                <span class="ml-auto flex gap-1 pl-2" data-model-chips="">
                  <span v-for="c in chipsOf(m, true)" :key="c.text" class="rounded bg-field px-1 text-[10px] whitespace-nowrap text-muted-foreground" :title="c.title">{{ c.text }}</span>
                </span>
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <RenderSettings v-if="s.finalModel()" :model="s.finalModel()" final :inline="stack" />
      </div>
    </div>
    <div class="grid gap-0.5">
      <span class="px-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Voices</span>
      <Select :model-value="s.modelFor('speech')?.id" @update:model-value="(v) => setModel('speech', v)">
        <SelectTrigger :class="trigger" title="Voice model that speaks the lines (ElevenLabs)"><SelectValue placeholder="Voice model" /></SelectTrigger>
        <SelectContent>
          <SelectGroup v-for="g in groupByProvider(models('speech'))" :key="g.provider">
            <SelectLabel class="px-2 pt-2 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{{ g.name }}</SelectLabel>
            <SelectItem v-for="m in g.models" :key="m.id" :value="m.id">{{ m.label }}</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  </div>
</template>
