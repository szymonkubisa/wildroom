<script setup lang="ts">
import { ChevronDown, SlidersHorizontal } from '@lucide/vue'
import { defaultValues } from '@shared/models/params'
import type { ModelSpec, ParamDef } from '@shared/models/types'
import { STORYBOARD_MANAGED } from '@shared/models/workflow'
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import ParamField from '@/features/generate/ParamField.vue'
import { cn } from '@/lib/utils'
import { useStory } from './useStory'

/**
 * The video model's settings for every story render — resolution (4K), fps, audio — kept apart for drafts and for
 * finals, so drafts can stay 1080p while finals render in 4K with the same model.
 */
const props = defineProps<{
  model?: ModelSpec
  final?: boolean
  /** The settings folded open in place instead of a popover (inside another popover, where a second one misbehaves). */
  inline?: boolean
}>()
const s = useStory()
const advancedOpen = ref(false)
const inlineOpen = ref(false)

const chosen = computed(() => (props.final ? s.story.value.finalVideoSettings : s.story.value.videoSettings) ?? {})
/** What the model's `visibleIf` rules see: its defaults with the story's choices on top. */
const values = computed(() => (props.model ? { ...defaultValues(props.model), ...chosen.value } : {}))
/**
 * The render's own choices. Per-shot values (prompt, frames, length, references, multi-shot…) come from the storyboard
 * (STORYBOARD_MANAGED); params hidden by another choice (Kling 2.6's audio outside 1080p) aren't offered.
 */
const params = computed<ParamDef[]>(
  () =>
    props.model?.params.filter(
      (p) =>
        !STORYBOARD_MANAGED.has(p.key) &&
        !p.ui.hidden &&
        ['segmented', 'select', 'switch'].includes(p.ui.control) &&
        (!p.ui.visibleIf || p.ui.visibleIf(values.value)),
    ) ?? [],
)
const basic = computed(() => params.value.filter((p) => !p.ui.advanced))
const advanced = computed(() => params.value.filter((p) => p.ui.advanced))
const valueOf = (p: ParamDef) => chosen.value[p.key] ?? p.default

function set(key: string, value: unknown) {
  s.update(props.final ? 'Final render settings' : 'Render settings', (story) => {
    const current = { ...(props.final ? story.finalVideoSettings : story.videoSettings) }
    current[key] = value
    if (props.final) story.finalVideoSettings = current
    else story.videoSettings = current
  })
}

/** "1080p", "4K"… on the button: the resolution, the setting people look for. */
const summary = computed(() => {
  const resolution = params.value.find((p) => p.key === 'resolution')
  return resolution ? String(valueOf(resolution)) : undefined
})
</script>

<template>
  <Collapsible v-if="params.length && inline" v-model:open="inlineOpen" class="grid gap-2">
    <CollapsibleTrigger class="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
      <ChevronDown :class="cn('size-3.5 transition-transform', !inlineOpen && '-rotate-90')" />
      <SlidersHorizontal class="size-3.5" /> {{ final ? 'Final settings' : 'Settings' }}<template v-if="summary"> · {{ summary }}</template>
    </CollapsibleTrigger>
    <CollapsibleContent class="grid gap-3 rounded-lg bg-field/60 p-2">
      <ParamField v-for="p in params" :key="p.key" :param="p" :model-value="valueOf(p)" @update:model-value="(v) => set(p.key, v)" />
    </CollapsibleContent>
  </Collapsible>
  <Popover v-else-if="params.length">
    <PopoverTrigger as-child>
      <Button size="xs" variant="ghost" class="h-7 gap-1 px-1.5 text-xs" :title="final ? 'Final render settings' : 'Render settings'">
        <SlidersHorizontal class="size-3.5" />{{ summary }}
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" class="grid w-80 gap-3 p-3">
      <div>
        <div class="text-xs font-medium">{{ final ? 'Final renders' : 'Renders' }} · {{ model?.label }}</div>
        <div class="text-[11px] text-muted-foreground">
          {{ final ? 'Used when chosen takes are rendered again as finals.' : 'Used for every shot and multi-shot rendered from the storyboard.' }}
        </div>
      </div>
      <ParamField v-for="p in basic" :key="p.key" :param="p" :model-value="valueOf(p)" @update:model-value="(v) => set(p.key, v)" />
      <Collapsible v-if="advanced.length" v-model:open="advancedOpen">
        <CollapsibleTrigger class="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ChevronDown :class="cn('size-3.5 transition-transform', !advancedOpen && '-rotate-90')" /> Advanced
        </CollapsibleTrigger>
        <CollapsibleContent class="mt-3 grid gap-3">
          <ParamField v-for="p in advanced" :key="p.key" :param="p" :model-value="valueOf(p)" @update:model-value="(v) => set(p.key, v)" />
        </CollapsibleContent>
      </Collapsible>
    </PopoverContent>
  </Popover>
</template>
