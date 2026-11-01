<script setup lang="ts">
import { Check } from '@lucide/vue'
import { nextTimelineName } from '@shared/timeline/timelines'
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FORMAT_PRESETS, aspectLabel } from '@/features/projects/formats'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project'
import { useTimelines } from './timelines'

const open = defineModel<boolean>('open', { default: false })
const project = useProjectStore()
const timelines = useTimelines()

const name = ref('')
const placeholder = computed(() => nextTimelineName(project.doc))
const current = computed(() => project.doc.settings)
/** 'current' keeps the open timeline's format; otherwise a preset id. */
const format = ref('current')
const options = computed(() => [
  { id: 'current', label: 'Same as now', detail: `${current.value.width} × ${current.value.height} · ${aspectLabel(current.value.width, current.value.height)}`, width: current.value.width, height: current.value.height },
  ...FORMAT_PRESETS.filter((p) => p.width !== current.value.width || p.height !== current.value.height),
])

function create() {
  const preset = options.value.find((o) => o.id === format.value)
  timelines.create({
    name: name.value.trim() || undefined,
    settings: preset && format.value !== 'current' ? { width: preset.width, height: preset.height } : undefined,
  })
  open.value = false
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>New timeline</DialogTitle>
        <DialogDescription>An empty timeline in this project, listed in Assets. Each timeline keeps its own format and frame rate.</DialogDescription>
      </DialogHeader>
      <form class="grid gap-5" @submit.prevent="create">
        <div class="grid gap-2">
          <Label for="timeline-name">Name</Label>
          <Input id="timeline-name" v-model="name" :placeholder="placeholder" autofocus />
        </div>
        <div class="grid gap-2">
          <Label>Format</Label>
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <button
              v-for="o in options"
              :key="o.id"
              type="button"
              :class="cn('relative flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors hover:bg-accent/60', format === o.id && 'border-brand bg-brand/10')"
              @click="format = o.id"
            >
              <div
                class="rounded-[3px] border border-foreground/40 bg-foreground/5"
                :style="{
                  width: `${o.width >= o.height ? 32 : Math.round((32 * o.width) / o.height)}px`,
                  height: `${o.height >= o.width ? 32 : Math.round((32 * o.height) / o.width)}px`,
                }"
              />
              <div>
                <div class="text-sm font-medium">{{ o.label }}</div>
                <div class="text-xs text-muted-foreground">{{ o.detail }}</div>
              </div>
              <Check v-if="format === o.id" class="absolute top-2 right-2 size-4 text-brand" />
            </button>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" @click="open = false">Cancel</Button>
          <Button type="submit">Create timeline</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
