<script setup lang="ts">
import { ExternalLink, Loader2, Play, X } from '@lucide/vue'
import { useNow } from '@vueuse/core'
import type { ProjectEntry } from '@shared/types/api'
import type { ComfyImportMode, ComfyTarget } from '@shared/types/runpod'
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { formatClock, useGpuStore } from '@/stores/gpu'

/**
 * The pod's ComfyUI inside the app. It runs on its own local address (the app's proxy adds the access token), so
 * the same page also opens in a browser. Prompts queued here are saved to the chosen project when they finish.
 */
const gpu = useGpuStore()
const now = useNow({ interval: 1000 })

const s = computed(() => gpu.session)
const ready = computed(() => s.value.state === 'ready')
const canStart = computed(() => s.value.state === 'off' || (s.value.state === 'error' && !s.value.fatal))
const target = computed<ComfyTarget>(() => gpu.comfy?.target ?? { mode: 'assets' })

const MODES: { value: ComfyImportMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'assets', label: 'Assets' },
  { value: 'append', label: 'Append' },
  { value: 'insert', label: 'Insert at playhead' },
]

const projects = ref<ProjectEntry[]>([])
watch(
  () => gpu.comfyOpen,
  async (open) => {
    if (!open) return
    const list = await api.projects.list().catch(() => [] as ProjectEntry[])
    projects.value = list.filter((p) => p.id && p.state === 'ok')
  },
  { immediate: true },
)

const stopsIn = computed(() => (ready.value && !s.value.busy && s.value.idleStopAt ? Date.parse(s.value.idleStopAt) - now.value.getTime() : undefined))
const status = computed(() => {
  if (ready.value) {
    if (s.value.busy) return 'Rendering'
    return stopsIn.value != null ? `Stops in ${formatClock(stopsIn.value)} without use` : 'Ready'
  }
  return s.value.detail ?? (s.value.state === 'off' ? 'The GPU is off' : 'Starting the GPU…')
})

function openInBrowser() {
  // Electron hands new windows to the system browser.
  if (gpu.comfy) window.open(gpu.comfy.url, '_blank', 'noopener')
}
</script>

<template>
  <Dialog v-model:open="gpu.comfyOpen">
    <DialogContent :show-close-button="false" class="flex h-[92vh] w-[96vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
      <header class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
        <DialogTitle class="text-sm font-semibold">ComfyUI</DialogTitle>
        <DialogDescription class="sr-only">ComfyUI running on the rented GPU</DialogDescription>
        <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span :class="cn('size-2 rounded-full', ready ? 'bg-role-music' : canStart ? 'bg-muted-foreground/40' : 'bg-role-effects animate-pulse')" />
          {{ status }}
        </span>

        <div class="ml-auto flex flex-wrap items-center gap-2 text-xs">
          <span class="text-muted-foreground">Save outputs to</span>
          <Select :model-value="target.projectId" @update:model-value="(v) => gpu.setComfyTarget({ ...target, projectId: String(v) })">
            <SelectTrigger size="sm" class="h-7 w-44 text-xs"><SelectValue placeholder="Choose a project" /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="p in projects" :key="p.id" :value="p.id!">{{ p.name }}</SelectItem>
            </SelectContent>
          </Select>
          <ToggleGroup
            type="single"
            :model-value="target.mode"
            @update:model-value="(v) => v && gpu.setComfyTarget({ ...target, mode: v as ComfyImportMode })"
          >
            <ToggleGroupItem v-for="m in MODES" :key="m.value" :value="m.value" class="h-7 px-2.5 text-xs">{{ m.label }}</ToggleGroupItem>
          </ToggleGroup>
          <Button size="sm" variant="outline" class="h-7" :disabled="!gpu.comfy" @click="openInBrowser"><ExternalLink /> Open in browser</Button>
          <DialogClose as-child>
            <Button size="icon" variant="ghost" class="size-7" aria-label="Close"><X /></Button>
          </DialogClose>
        </div>
      </header>

      <div class="relative min-h-0 flex-1 bg-background">
        <iframe
          v-if="ready && gpu.comfy"
          :key="s.podId"
          :src="gpu.comfy.url"
          title="ComfyUI"
          allow="clipboard-read; clipboard-write"
          class="size-full border-0"
        />
        <div v-else class="grid size-full place-items-center p-6">
          <div class="grid max-w-sm justify-items-center gap-3 text-center text-sm">
            <Loader2 v-if="!canStart" class="size-6 animate-spin text-muted-foreground" />
            <p class="font-medium">{{ canStart ? 'ComfyUI runs on the rented GPU' : 'Starting the GPU' }}</p>
            <p class="text-xs text-muted-foreground">
              {{ s.detail ?? 'Billed per second while it runs. Clicks and keys in ComfyUI keep it on; it stops a few minutes after you stop using it.' }}
            </p>
            <Button v-if="canStart" size="sm" class="bg-brand text-brand-foreground hover:bg-brand/90" @click="gpu.start()"><Play /> Start GPU</Button>
          </div>
        </div>
      </div>

      <footer v-if="target.mode === 'append' || target.mode === 'insert'" class="border-t px-4 py-1.5 text-[11px] text-muted-foreground">
        Outputs go on the timeline when that project is open in the editor; otherwise they are saved to its Assets only.
      </footer>
    </DialogContent>
  </Dialog>
</template>
