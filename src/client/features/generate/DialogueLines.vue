<script setup lang="ts">
import { Plus, Trash2 } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import VoicePicker from './VoicePicker.vue'

interface Line {
  voiceId: string
  text: string
}

const model = defineModel<Line[] | undefined>()
const lines = computed(() => model.value ?? [])
const chars = computed(() => lines.value.reduce((n, l) => n + l.text.length, 0))

function update(index: number, patch: Partial<Line>) {
  model.value = lines.value.map((l, i) => (i === index ? { ...l, ...patch } : l))
}

function add() {
  const prev = lines.value.at(-2)?.voiceId ?? lines.value.at(-1)?.voiceId ?? ''
  model.value = [...lines.value, { voiceId: prev, text: '' }]
}

function remove(index: number) {
  model.value = lines.value.filter((_, i) => i !== index)
}
</script>

<template>
  <div class="grid gap-2">
    <div v-for="(line, i) in lines" :key="i" class="grid gap-1.5 rounded-md border bg-background/40 p-2">
      <div class="flex items-center gap-1.5">
        <span class="w-5 shrink-0 text-[10px] text-muted-foreground">{{ i + 1 }}</span>
        <VoicePicker compact :model-value="line.voiceId" @update:model-value="(v) => update(i, { voiceId: v ?? '' })" />
        <Button variant="ghost" size="icon-sm" class="shrink-0" :aria-label="`Remove line ${i + 1}`" @click="remove(i)"><Trash2 /></Button>
      </div>
      <Textarea
        :model-value="line.text"
        rows="2"
        class="min-h-0 text-xs"
        placeholder="[whispering] Did you hear that?"
        @update:model-value="(v) => update(i, { text: String(v) })"
      />
    </div>
    <div class="flex items-center justify-between">
      <Button variant="outline" size="sm" @click="add"><Plus /> Add line</Button>
      <span class="text-[10px]" :class="chars > 2000 ? 'text-destructive' : 'text-muted-foreground'">{{ chars }} / 2000</span>
    </div>
  </div>
</template>
