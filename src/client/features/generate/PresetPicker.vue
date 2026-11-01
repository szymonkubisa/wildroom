<script setup lang="ts">
import { Check, ChevronsUpDown, Sparkles } from '@lucide/vue'
import { PRESETS } from '@shared/presets/catalog'
import type { GenPreset } from '@shared/presets/types'
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { presetIcon } from './presetIcons'

const props = defineProps<{ kind: 'image' | 'video'; presetId?: string }>()
const emit = defineEmits<{ select: [preset: GenPreset | undefined] }>()

const open = ref(false)
const presets = computed(() => PRESETS.filter((p) => p.kind === props.kind))
const selected = computed(() => presets.value.find((p) => p.id === props.presetId))
const groups = computed(() => {
  const byGroup = new Map<string, GenPreset[]>()
  for (const p of presets.value) byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), p])
  return [...byGroup].map(([heading, items]) => ({ heading, items }))
})

function choose(preset: GenPreset | undefined) {
  open.value = false
  emit('select', preset)
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button variant="outline" class="h-9 w-full justify-between font-normal">
        <span class="flex min-w-0 items-center gap-2">
          <component :is="presetIcon(selected?.id)" class="size-3.5 shrink-0 text-brand" />
          <span v-if="selected" class="truncate">{{ selected.label }}</span>
          <span v-else class="truncate text-muted-foreground">What are you making?</span>
        </span>
        <ChevronsUpDown class="opacity-50" />
      </Button>
    </PopoverTrigger>
    <PopoverContent class="w-80 p-0" align="start">
      <Command>
        <CommandInput placeholder="Search jobs…" />
        <CommandList class="max-h-80">
          <CommandEmpty>No matching preset.</CommandEmpty>
          <CommandGroup>
            <CommandItem value="no preset choose model" @select="choose(undefined)">
              <Sparkles class="size-3.5 text-muted-foreground" />
              <span class="flex-1 text-xs">No preset — pick a model yourself</span>
              <Check v-if="!selected" class="size-3.5" />
            </CommandItem>
          </CommandGroup>
          <CommandGroup v-for="g in groups" :key="g.heading" :heading="g.heading">
            <CommandItem v-for="p in g.items" :key="p.id" :value="`${p.label} ${p.blurb} ${p.group}`" class="items-start" @select="choose(p)">
              <component :is="presetIcon(p.id)" class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1">
                <span class="block text-xs font-medium">{{ p.label }}</span>
                <span class="block text-[10px] leading-snug text-muted-foreground">{{ p.blurb }}</span>
              </span>
              <Check v-if="selected?.id === p.id" class="mt-0.5 size-3.5 shrink-0" />
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
</template>
