<script setup lang="ts">
import { computed } from 'vue'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { fontFamilies, fontSpecs } from '@/engine/fonts'
import { TITLE_FONTS } from '@/engine/titles'
import { useAssetsStore } from '@/stores/assets'
import { useProjectStore } from '@/stores/project'

/** A font family: the project's uploaded fonts first, then the brand kit's, then the ones every Mac has. */
const props = defineProps<{ modelValue: string; triggerClass?: string }>()
const emit = defineEmits<{ 'update:modelValue': [family: string] }>()

const assets = useAssetsStore()
const project = useProjectStore()

const groups = computed(() => {
  const seen = new Set<string>()
  const take = (list: readonly string[]) => list.filter((f) => f && !seen.has(f) && seen.add(f))
  const out = [
    { label: 'Project fonts', fonts: take(fontFamilies(fontSpecs(assets.list))) },
    { label: 'Brand kit', fonts: take((project.doc.brand?.fonts ?? []).map((f) => f.family)) },
    { label: 'System', fonts: take(['Inter', ...TITLE_FONTS]) },
  ]
  // A family set elsewhere (the Director, an import) still shows as chosen.
  if (props.modelValue && !seen.has(props.modelValue)) out.unshift({ label: 'In use', fonts: [props.modelValue] })
  return out.filter((g) => g.fonts.length)
})
</script>

<template>
  <Select :model-value="modelValue" @update:model-value="(v) => emit('update:modelValue', String(v))">
    <SelectTrigger :class="triggerClass ?? 'h-8 w-full'"><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectGroup v-for="g in groups" :key="g.label">
        <SelectLabel class="text-[10px] text-muted-foreground">{{ g.label }}</SelectLabel>
        <SelectItem v-for="f in g.fonts" :key="f" :value="f"><span :style="{ fontFamily: `&quot;${f}&quot;` }">{{ f }}</span></SelectItem>
      </SelectGroup>
    </SelectContent>
  </Select>
</template>
