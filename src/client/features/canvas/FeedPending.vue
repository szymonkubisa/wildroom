<script setup lang="ts">
import { AlertTriangle, Loader2, Pencil, RotateCw, Square } from '@lucide/vue'
import { getModel } from '@shared/models/registry'
import type { GenerationDTO } from '@shared/types/jobs'
import { useNow } from '@vueuse/core'
import { computed } from 'vue'
import { toast } from 'vue-sonner'
import { useResultActions } from '@/features/generate/resultActions'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useJobsStore } from '@/stores/jobs'
import { failureNote, pendingState } from './feed'
import { typicalSeconds } from './feedView'

/**
 * A render on its way, or one that just failed, where its result will appear. On its way: the model's name, how long
 * it has run against how long that model usually takes (it says so when it is slow) and Stop. Failed: what went wrong
 * in words, whether it may have been charged, Retry and Edit (back in the Composer as it was asked for).
 */
const props = defineProps<{ job: GenerationDTO; caption?: boolean }>()
const jobs = useJobsStore()
const results = useResultActions()
const now = useNow({ interval: 1000 })

const failed = computed(() => props.job.status === 'failed' || props.job.status === 'needs_attention')
const model = computed(() => getModel(props.job.modelId)?.label ?? props.job.modelId)
const typical = computed(() => typicalSeconds(props.job))
const state = computed(() => pendingState(props.job, now.value.getTime(), typical.value))
const note = computed(() => failureNote(props.job))
/** A picture or clip on its way: the tile shows colour drifting under a blur where it will appear (not for sound). */
const picture = computed(() => !failed.value && ['image', 'cutout', 'vectorize', 'video', 'upscale', 'lipsync'].includes(props.job.kind))
const progress = computed(() => (props.job.progress != null ? Math.round(props.job.progress * 100) : undefined))

async function act(what: 'cancel' | 'retry') {
  try {
    await (what === 'cancel' ? jobs.cancel(props.job.id) : jobs.retry(props.job.id))
  } catch (err) {
    toast.error(what === 'cancel' ? 'Couldn’t stop it' : 'Couldn’t retry', { description: errorMessage(err) })
  }
}
</script>

<template>
  <figure class="grid content-start gap-1.5" data-feed-pending="" :data-phase="failed ? 'failed' : state.phase">
    <div
      :class="
        cn(
          'relative flex aspect-video flex-col items-center justify-center gap-1.5 overflow-hidden rounded-xl border bg-muted/60 p-3 text-center text-xs',
          failed && 'border-destructive/40 bg-destructive/5',
          state.phase === 'slow' && !failed && 'border-role-effects/40',
        )
      "
    >
      <template v-if="failed">
        <AlertTriangle class="size-5 text-destructive" />
        <span class="line-clamp-2 text-foreground" :title="note.message">{{ note.message }}</span>
        <span class="text-[10.5px] text-muted-foreground">{{ note.charge }}</span>
        <div class="mt-1 flex gap-1.5">
          <button v-if="note.retryable" type="button" class="flex h-6 items-center gap-1 rounded-full bg-foreground px-2.5 text-[11px] font-medium text-background hover:bg-foreground/85" data-feed-retry="" @click="act('retry')">
            <RotateCw class="size-3" /> Retry
          </button>
          <button type="button" class="flex h-6 items-center gap-1 rounded-full border px-2.5 text-[11px] font-medium hover:bg-accent" data-feed-edit-retry="" @click="results.editAndRetry(job)">
            <Pencil class="size-3" /> Edit
          </button>
        </div>
      </template>
      <template v-else>
        <div v-if="picture" class="render-glow" data-render-glow="" />
        <!-- Positioned, so they stay over the glow (an absolute layer paints over plain content). -->
        <Loader2 :class="cn('relative size-5 animate-spin', state.phase === 'slow' ? 'text-role-effects' : 'text-brand')" />
        <span class="relative font-medium">{{ job.status === 'queued' ? 'Queued' : progress != null ? `Generating · ${progress}%` : (job.statusDetail ?? 'Generating…') }}</span>
        <span v-if="job.status !== 'queued'" class="relative font-mono text-[10.5px] text-muted-foreground tabular" data-feed-elapsed="">{{ state.text }}</span>
        <button
          type="button"
          class="absolute top-1.5 right-1.5 flex h-6 items-center gap-1 rounded-full px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Stop this render"
          data-feed-cancel=""
          @click="act('cancel')"
        >
          <Square class="size-3" /> Stop
        </button>
        <div v-if="progress != null" class="absolute inset-x-0 bottom-0 h-0.5 bg-foreground/10"><div class="h-full bg-brand transition-[width]" :style="{ width: `${progress}%` }" /></div>
      </template>
    </div>
    <figcaption v-if="caption" class="grid px-0.5 leading-tight">
      <span class="truncate text-[12px] font-medium" :title="job.label">{{ job.label }}</span>
      <span class="truncate font-mono text-[10.5px] text-muted-foreground">{{ model }}</span>
    </figcaption>
  </figure>
</template>
