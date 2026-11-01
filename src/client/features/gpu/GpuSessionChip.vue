<script setup lang="ts">
import { Cpu, Loader2, Pin, Play, Square, Workflow } from '@lucide/vue'
import { useNow } from '@vueuse/core'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useConfirm } from '@/components/app/useConfirm'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { openSettings } from '@/features/settings/settingsSheet'
import { formatClock, sessionCost, useGpuStore } from '@/stores/gpu'
import { useJobsStore } from '@/stores/jobs'
import { useSettingsStore } from '@/stores/settings'

/** The rented GPU at a glance: state, time and money so far; start, stop or keep it on. */
const gpu = useGpuStore()
const jobs = useJobsStore()
const settings = useSettingsStore()
const route = useRoute()
const now = useNow({ interval: 1000 })
const confirm = useConfirm()

const visible = computed(() => settings.providerReady('runpod'))
const s = computed(() => gpu.session)

const tone = computed(() => {
  switch (s.value.state) {
    case 'ready':
      return 'bg-role-music'
    case 'creating':
    case 'booting':
    case 'stopping':
      return 'bg-role-effects animate-pulse'
    case 'needs_choice':
    case 'error':
      // Waiting for the first-choice GPU is a wait, not a failure.
      return s.value.waitingFor ? 'bg-role-effects animate-pulse' : 'bg-destructive'
    default:
      return 'bg-muted-foreground/40'
  }
})

const label = computed(() => {
  switch (s.value.state) {
    case 'ready':
      return s.value.gpu?.name ?? 'GPU on'
    case 'creating':
    case 'booting':
      return 'GPU starting'
    case 'stopping':
      return 'GPU stopping'
    case 'needs_choice':
      return 'Choose a GPU'
    case 'error':
      return s.value.waitingFor ? `Waiting for ${s.value.waitingFor}` : 'GPU problem'
    default:
      return 'GPU off'
  }
})

const cost = computed(() => sessionCost(s.value, now.value.getTime()))
const uptime = computed(() => (s.value.startedAt ? formatClock(now.value.getTime() - Date.parse(s.value.startedAt)) : undefined))
const stopsIn = computed(() => (s.value.idleStopAt ? Date.parse(s.value.idleStopAt) - now.value.getTime() : undefined))
const runpodJobs = computed(() => [...jobs.sharedQueued, ...jobs.sharedRunning].filter((j) => j.provider === 'runpod'))

async function stop() {
  const n = runpodJobs.value.length
  if (
    n &&
    !(await confirm({
      title: 'Cancel the renders and stop the GPU?',
      description: `${n} RunPod render${n === 1 ? ' is' : 's are'} queued or running.`,
      confirmText: 'Stop the GPU',
      cancelText: 'Keep it running',
      destructive: true,
    }))
  )
    return
  await Promise.all(runpodJobs.value.map((j) => jobs.cancel(j.id).catch(() => {})))
  await gpu.stop()
}
</script>

<template>
  <Popover v-if="visible">
    <PopoverTrigger as-child>
      <Button variant="outline" size="sm" class="gap-1.5 rounded-full px-3" :title="s.detail ?? label">
        <span :class="cn('size-2 rounded-full', tone)" />
        <Cpu class="size-3.5" />
        <span class="hidden lg:inline">{{ label }}</span>
        <span v-if="cost != null" class="font-mono text-[11px] text-muted-foreground">${{ cost.toFixed(2) }}</span>
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-80 p-3">
      <div class="grid gap-3 text-xs">
        <div class="flex items-center gap-2">
          <span :class="cn('size-2 rounded-full', tone)" />
          <span class="font-medium">{{ label }}</span>
          <span v-if="s.gpu" class="text-muted-foreground">{{ s.gpu.vramGb }} GB · {{ s.gpu.precision }}</span>
          <Loader2 v-if="gpu.starting" class="ml-auto size-3.5 animate-spin text-muted-foreground" />
        </div>
        <p v-if="s.detail" class="text-muted-foreground">{{ s.detail }}</p>

        <div v-if="s.startedAt" class="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 p-2 text-center">
          <div>
            <div class="font-mono text-sm">{{ uptime }}</div>
            <div class="text-[10px] text-muted-foreground">running</div>
          </div>
          <div>
            <div class="font-mono text-sm">${{ (cost ?? 0).toFixed(2) }}</div>
            <div class="text-[10px] text-muted-foreground">so far</div>
          </div>
          <div>
            <div class="font-mono text-sm">${{ s.costPerHrUsd?.toFixed(2) }}</div>
            <div class="text-[10px] text-muted-foreground">per hour</div>
          </div>
        </div>

        <p v-if="s.state === 'ready'" class="text-muted-foreground">
          <template v-if="s.busy">Rendering — it stays on until the queue is empty.</template>
          <template v-else-if="stopsIn != null">Stops in {{ formatClock(stopsIn) }} without a new render.</template>
          <template v-if="s.keepUntil"> Kept on until {{ new Date(s.keepUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}.</template>
          <template v-else-if="s.comfyUntil"> Held while you use ComfyUI.</template>
        </p>
        <p v-else-if="s.state === 'off'" class="text-muted-foreground">
          Starts by itself when you render with LTX-2.5 (RunPod). Billed per second while on.
        </p>

        <div class="flex flex-wrap gap-2">
          <Button v-if="s.waitingFor" size="sm" variant="outline" title="Stop waiting: the GPUs free now are offered on the next try" @click="gpu.offerOthers()">Rent another GPU instead</Button>
          <Button v-if="!s.waitingFor && (s.state === 'off' || s.state === 'error')" size="sm" class="bg-brand text-brand-foreground hover:bg-brand/90" @click="gpu.start()">
            <Play /> Start GPU
          </Button>
          <Button size="sm" variant="outline" @click="gpu.openComfy(route.name === 'editor' ? String(route.params.id) : undefined)">
            <Workflow /> ComfyUI
          </Button>
          <Button v-if="s.state === 'ready'" size="sm" variant="outline" @click="gpu.keep()"><Pin /> Keep on</Button>
          <Button v-if="gpu.running" size="sm" variant="outline" class="text-destructive hover:text-destructive" @click="stop">
            <Square /> Stop GPU
          </Button>
          <Button v-if="s.state === 'error' && s.fatal" size="sm" variant="ghost" class="ml-auto" @click="openSettings(settings.providerReady('runpod') ? { tab: 'gpu' } : { provider: 'runpod' })">
            Settings
          </Button>
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>
