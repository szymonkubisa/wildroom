<script setup lang="ts">
import { ArrowRight, Check, Circle, Loader2, Minus, Square, TriangleAlert, X } from '@lucide/vue'
import type { DirectorMessage, StepProgress } from '@shared/director/plan'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { formatUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { PlanQuote, StepQuote } from './tools'

/**
 * A plan of the Director's: its steps, each with what it makes, costs and takes; the total of what runs now and about
 * how long, finals for later; then Approve & run · $X / Change something / Not now. Once approved, each step's
 * progress and where to see what it made.
 */
const props = defineProps<{
  message: DirectorMessage
  /** Priced now (only while it waits for approval). */
  quote?: PlanQuote
  progress?: StepProgress[]
  /** Another plan is running: this one waits. */
  blocked?: boolean
}>()
const emit = defineEmits<{ approve: []; change: []; decline: []; stop: []; show: [where: NonNullable<StepProgress['show']>] }>()

const plan = computed(() => props.message.plan!)
const ready = computed(() => plan.value.state === 'ready')

/** "about 12 min", "under a minute". */
function minutes(seconds: number): string {
  if (seconds < 50) return 'under a minute'
  if (seconds < 90 * 60) return `about ${Math.max(1, Math.round(seconds / 60))} min`
  return `about ${(seconds / 3600).toFixed(1)} h`
}
/** A step's time: "< 1 min", "≈ 4 min". */
const stepTime = (seconds: number) => (seconds < 50 ? '< 1 min' : `≈ ${minutes(seconds).replace('about ', '')}`)
/** A step's price: free, a few cents of the Director's model, unpriced, or the sum. */
function price(q: StepQuote): string {
  if (q.nothing) return '—'
  if (q.free) return 'Free'
  if (q.usd === undefined) return 'a few cents'
  if (q.usd === null) return 'see plan'
  return formatUsd(q.usd)
}
const total = computed(() => {
  const q = props.quote
  if (!q) return ''
  if (q.usd === null) return 'price depends on your plan'
  return `${formatUsd(q.usd)}${q.unpricedText ? ' + a few cents' : ''}`
})
const approveText = computed(() => {
  const q = props.quote
  if (!q || q.empty) return 'Nothing to run'
  const usd = q.usd == null ? '' : ` · ${formatUsd(q.usd)}`
  return q.over ? `Approve anyway${usd} (${formatUsd(q.over)} over budget)` : `Approve & run${usd}`
})

const STATE_TEXT: Record<StepProgress['state'], string> = {
  waiting: 'Waiting',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Nothing to do',
  stopped: 'Stopped',
}
/** A step's progress; one still waiting when its plan stopped or was cut short never ran. */
const stepProgress = (i: number): StepProgress | undefined => {
  const p = props.progress?.[i]
  return p?.state === 'waiting' && plan.value.state !== 'running' ? { state: 'skipped', note: 'Not run' } : p
}
</script>

<template>
  <div class="mt-2 grid gap-2.5 rounded-xl border bg-card p-3 text-xs shadow-sm" :data-plan-card="plan.state" role="group" aria-label="Plan">
    <div class="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Plan · {{ plan.steps.length }} step{{ plan.steps.length === 1 ? '' : 's' }}</div>

    <ol class="grid gap-1.5">
      <li v-for="(step, i) in plan.steps" :key="i" class="grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-2" :data-plan-step="step.op">
        <!-- What became of the step once approved; its number before. -->
        <span class="mt-px flex size-4 items-center justify-center">
          <template v-if="stepProgress(i)">
            <Loader2 v-if="stepProgress(i)!.state === 'running'" class="size-3.5 animate-spin text-role-effects" />
            <Check v-else-if="stepProgress(i)!.state === 'done'" class="size-3.5 text-role-music" />
            <X v-else-if="stepProgress(i)!.state === 'failed'" class="size-3.5 text-destructive" />
            <Square v-else-if="stepProgress(i)!.state === 'stopped'" class="size-3 text-role-effects" />
            <Minus v-else-if="stepProgress(i)!.state === 'skipped'" class="size-3.5 text-muted-foreground" />
            <Circle v-else class="size-3 text-muted-foreground/60" />
          </template>
          <span v-else class="font-mono text-[10px] text-muted-foreground tabular">{{ i + 1 }}</span>
        </span>
        <span class="min-w-0">
          <span :class="cn('block leading-snug', quote?.steps[i]?.nothing && ready && 'text-muted-foreground line-through')">{{ step.title }}</span>
          <!-- Before approval: what it makes and with what, and anything to know first. -->
          <template v-if="ready && quote?.steps[i]">
            <span class="block text-[11px] text-muted-foreground">
              {{ quote.steps[i]!.nothing ?? quote.steps[i]!.detail }}<template v-if="!quote.steps[i]!.nothing && quote.steps[i]!.seconds >= 5"> · {{ stepTime(quote.steps[i]!.seconds) }}</template>
            </span>
            <span v-if="quote.steps[i]!.warn" class="flex items-start gap-1 text-[11px] leading-snug text-role-effects"><TriangleAlert class="mt-px size-3 shrink-0" />{{ quote.steps[i]!.warn }}</span>
            <span v-for="p in quote.steps[i]!.problems.slice(0, 2)" :key="p" class="block text-[11px] leading-snug text-role-effects">{{ p }}</span>
          </template>
          <!-- Once approved: how far it got. -->
          <template v-else-if="stepProgress(i)">
            <span
              :class="cn('block text-[11px] leading-snug', stepProgress(i)!.state === 'failed' ? 'text-destructive' : stepProgress(i)!.state === 'stopped' ? 'text-role-effects' : 'text-muted-foreground')"
              :data-step-state="stepProgress(i)!.state"
            >
              {{ stepProgress(i)!.note ?? STATE_TEXT[stepProgress(i)!.state] }}
            </span>
            <button
              v-if="stepProgress(i)!.show && ['done', 'failed', 'stopped'].includes(stepProgress(i)!.state)"
              type="button"
              class="mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-medium text-foreground underline-offset-2 hover:underline"
              data-step-show=""
              @click="emit('show', stepProgress(i)!.show!)"
            >
              Show <ArrowRight class="size-3" />
            </button>
          </template>
        </span>
        <span v-if="ready && quote?.steps[i]" class="shrink-0 pt-px text-right font-mono text-[11px] text-muted-foreground tabular">{{ price(quote.steps[i]!) }}</span>
      </li>
    </ol>

    <!-- The total of what runs now, the GPU's start, and finals for later. -->
    <div v-if="ready && quote" class="grid gap-1 border-t pt-2 tabular">
      <div v-if="quote.gpuStart" class="flex justify-between gap-3 text-[11px] text-muted-foreground">
        <span>RunPod GPU start, once · ≈ {{ Math.round(quote.gpuStart.seconds / 60) }} min</span><span class="font-mono">{{ formatUsd(quote.gpuStart.usd) }}</span>
      </div>
      <div class="flex justify-between gap-3 font-semibold" data-plan-total="">
        <span>Now · {{ minutes(quote.seconds) }}</span><span class="font-mono">{{ total }}</span>
      </div>
      <div v-if="quote.later" class="flex justify-between gap-3 text-[11px] text-muted-foreground" data-plan-later="">
        <span>{{ quote.later.label }}</span><span class="font-mono">{{ quote.later.usd == null ? '—' : formatUsd(quote.later.usd) }}</span>
      </div>
      <div v-if="quote.over" class="text-[11px] font-medium text-destructive">This goes {{ formatUsd(quote.over) }} over the project’s budget.</div>
    </div>

    <div v-if="ready" class="flex flex-wrap items-center gap-1.5">
      <Button size="sm" :variant="quote?.over ? 'destructive' : 'default'" :disabled="!quote || quote.empty || blocked" :title="blocked ? 'Another plan is running' : undefined" data-plan-approve="" @click="emit('approve')">
        {{ approveText }}
      </Button>
      <Button size="sm" variant="outline" data-plan-change="" @click="emit('change')">Change something</Button>
      <Button size="sm" variant="ghost" data-plan-decline="" @click="emit('decline')">Not now</Button>
    </div>
    <div v-else-if="plan.state === 'running'" class="flex items-center gap-2 text-[11px] text-role-effects" data-plan-running="">
      <Loader2 class="size-3.5 animate-spin" /> Running — renders show in Activity
      <span class="flex-1" />
      <Button size="xs" variant="ghost" title="Stop after this step (renders already started go on)" data-plan-stop="" @click="emit('stop')">Stop</Button>
    </div>
    <div v-else-if="plan.state === 'done'" class="flex items-center gap-1.5 text-[11px] text-role-music"><Check class="size-3.5" /> Approved and done</div>
    <div v-else-if="plan.state === 'stopped'" class="text-[11px] text-role-effects">Stopped — ask again for what’s left</div>
    <div v-else class="text-[11px] text-muted-foreground">Not now</div>
  </div>
</template>
