<script setup lang="ts">
import { useNow } from '@vueuse/core'
import type { GpuChoiceDTO } from '@shared/types/runpod'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { onServerEvent } from '@/lib/sse'
import { cn } from '@/lib/utils'
import { formatClock, useGpuStore } from '@/stores/gpu'
import ComfyDialog from './ComfyDialog.vue'

/**
 * App-wide GPU notices: a countdown in the last minute before an idle GPU stops (with "Keep on"), the dialog that
 * asks which GPU to rent when the chosen ones are taken, and short notes when it starts, stops or fails.
 */
const gpu = useGpuStore()
const now = useNow({ interval: 1000 })
onMounted(() => void gpu.load())

const IDLE_TOAST = 'gpu-idle'
const stopsIn = computed(() => (gpu.session.state === 'ready' && !gpu.session.busy && gpu.session.idleStopAt ? Date.parse(gpu.session.idleStopAt) - now.value.getTime() : undefined))
watch(stopsIn, (ms) => {
  if (ms === undefined || ms > 60_000) return void toast.dismiss(IDLE_TOAST)
  toast.warning(`GPU stops in ${formatClock(ms)}`, {
    id: IDLE_TOAST,
    duration: Number.POSITIVE_INFINITY,
    description: 'Nothing is rendering. Keep it on to avoid loading the models again.',
    action: { label: 'Keep on', onClick: () => void gpu.keep() },
  })
})

watch(
  () => [gpu.session.state, gpu.loaded] as const,
  ([state, loaded], [previous, wasLoaded]) => {
    // The first load only says how things stand (a pod already running at app start, after the store's default 'off'):
    // nothing happened, so no note.
    if (state === previous || (loaded && !wasLoaded)) return
    if (state === 'ready') toast.success(`GPU ready${gpu.session.gpu ? ` — ${gpu.session.gpu.name}` : ''}`)
    // Waiting for the first-choice GPU retries every minute: not an error to shout about each time.
    else if (state === 'error' && gpu.session.detail && !gpu.session.waitingFor) toast.error('GPU', { description: gpu.session.detail })
    else if (state === 'off' && (previous === 'ready' || previous === 'stopping') && gpu.session.detail) toast.info(gpu.session.detail)
  },
)

// ---------------------------------------------------------------- outputs of prompts queued from ComfyUI

const offComfy = onServerEvent((event) => {
  if (event.type === 'comfy.imported') {
    const n = event.assetIds.length
    toast.success(`ComfyUI: ${n} output${n === 1 ? '' : 's'} saved to Assets`)
  } else if (event.type === 'comfy.import.failed') {
    toast.error('ComfyUI output not saved', { description: event.error })
  }
})
onBeforeUnmount(offComfy)

// ---------------------------------------------------------------- choosing another GPU

const choosing = computed(() => gpu.session.state === 'needs_choice')
const picked = ref<string>()
watch(choosing, (open) => {
  if (open) picked.value = gpu.session.choices?.[0]?.id
})
const STOCK: Record<GpuChoiceDTO['availability'], string> = { HIGH: 'plenty free', MEDIUM: 'some free', LOW: 'few free', NONE: 'none free' }

async function rent() {
  if (picked.value) await gpu.choose(picked.value)
}
</script>

<template>
  <ComfyDialog />
  <AlertDialog :open="choosing">
    <AlertDialogContent class="max-w-lg">
      <AlertDialogHeader>
        <AlertDialogTitle>Rent another GPU?</AlertDialogTitle>
        <AlertDialogDescription>{{ gpu.session.detail }}. These run LTX-2.5 and are free there now:</AlertDialogDescription>
      </AlertDialogHeader>
      <div class="grid max-h-80 gap-1.5 overflow-y-auto">
        <button
          v-for="c in gpu.session.choices ?? []"
          :key="c.id"
          type="button"
          :class="cn('grid grid-cols-[1fr_auto] gap-x-3 rounded-lg border px-3 py-2 text-left text-xs transition-colors', picked === c.id ? 'border-brand bg-brand/10' : 'border-border hover:bg-accent/40')"
          @click="picked = c.id"
        >
          <span class="font-medium">{{ c.name }} <span class="font-normal text-muted-foreground">· {{ c.vramGb }} GB · {{ c.precision }}</span></span>
          <span class="font-mono">${{ c.priceUsdHr.toFixed(2) }}/h</span>
          <span class="text-muted-foreground">{{ c.note }}</span>
          <span class="text-right text-muted-foreground">{{ STOCK[c.availability] }}</span>
        </button>
      </div>
      <AlertDialogFooter>
        <Button variant="ghost" @click="gpu.decline()">Don’t rent — cancel the renders</Button>
        <Button variant="outline" title="The renders stay queued; your first-choice GPU is tried again every minute" data-gpu-keep-waiting="" @click="gpu.keepWaiting()">Keep waiting</Button>
        <Button class="bg-brand text-brand-foreground hover:bg-brand/90" :disabled="!picked" @click="rent">Rent it</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
