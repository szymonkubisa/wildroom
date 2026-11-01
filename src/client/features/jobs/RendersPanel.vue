<script setup lang="ts">
import {
  AlertTriangle,
  ArrowUpToLine,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleSlash,
  Copy,
  FileSearch,
  FolderOpen,
  History,
  ListOrdered,
  ListTodo,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Search,
  WandSparkles,
  X,
  XCircle,
} from '@lucide/vue'
import { getModel } from '@shared/models/registry'
import type { GenerationDTO, JobStatus } from '@shared/types/jobs'
import { useNow } from '@vueuse/core'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import AssetThumb from '@/features/assets/AssetThumb.vue'
import { errorMessage } from '@/lib/api'
import { formatSpan, formatUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { useEditorStore } from '@/stores/editor'
import { useGenerateStore } from '@/stores/generate'
import { useJobsStore } from '@/stores/jobs'
import { useSettingsStore } from '@/stores/settings'
import { describeParams, promptText, renderMs } from './describe'
import GenerationDetailsDialog from './GenerationDetailsDialog.vue'

const jobs = useJobsStore()
const assets = useAssetsStore()
const settings = useSettingsStore()
const editor = useEditorStore()
const generate = useGenerateStore()
const router = useRouter()
const open = ref(false)
const tab = ref<'queue' | 'history'>('queue')
// Elapsed times and start times tick every second, but only while the Queue tab is on screen: each tick
// re-renders the panel.
const { now, pause: pauseClock, resume: resumeClock } = useNow({ interval: 1000, controls: true })
watch([open, tab], ([isOpen, current]) => (isOpen && current === 'queue' ? resumeClock() : pauseClock()), { immediate: true })

/**
 * One queue for every project (and one GPU): the panel lists all of them, in the editor and on the projects page.
 * The project open in the editor, if any: its jobs need no project label, and only they can be previewed or reused.
 */
const here = computed(() => jobs.projectId)
const refresh = () => void jobs.loadShared().catch(() => {})
onMounted(() => {
  if (!here.value) refresh()
})
watch(open, (isOpen) => isOpen && refresh())

const running = computed(() => jobs.sharedRunning)
const queued = computed(() => jobs.sharedQueued)
const activeCount = computed(() => running.value.length + queued.value.length)
const paused = computed(() => Boolean(settings.app?.queuePaused))
const projectLabel = (job: GenerationDTO) => job.projectName ?? jobs.projectNames[job.projectId] ?? 'Another project'
const isHere = (job: GenerationDTO) => job.projectId === here.value

function openProject(job: GenerationDTO) {
  open.value = false
  void router.push({ name: 'editor', params: { id: job.projectId } })
}

/** The model's name; "Any OpenRouter image model" jobs name the model they ran. */
const modelLabel = (job: GenerationDTO) =>
  typeof job.params.orModel === 'string' ? `${job.params.orModel} (OpenRouter)` : (getModel(job.modelId)?.label ?? job.modelId)
const estimateMs = (job: GenerationDTO) => {
  const seconds = getModel(job.modelId)?.estimateSeconds?.(job.params)
  return seconds === undefined ? undefined : seconds * 1000
}

async function run(fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (err) {
    toast.error('Action failed', { description: errorMessage(err) })
  }
}

// ---- queue

const STAGE: Partial<Record<JobStatus, string>> = { submitting: 'Starting', running: 'Rendering', downloading: 'Downloading', ingesting: 'Importing' }

function elapsedMs(job: GenerationDTO): number {
  return job.startedAt ? now.value.getTime() - Date.parse(job.startedAt) : 0
}

/** Time left: from progress once it says something, else from the model's estimate. */
function remainingMs(job: GenerationDTO): number | undefined {
  const elapsed = elapsedMs(job)
  if (job.progress != null && job.progress > 0.1) return (elapsed / job.progress) * (1 - job.progress)
  const estimate = estimateMs(job)
  return estimate === undefined ? undefined : Math.max(0, estimate - elapsed)
}

/**
 * Local renders run strictly in the shared queue's order (every project's), so their start times follow from the
 * estimates ahead of them. Nothing starts while the queue is paused, so there is nothing to predict then.
 */
const localStarts = computed(() => {
  const starts = new Map<string, number>()
  if (paused.value) return starts
  let at = now.value.getTime()
  for (const job of jobs.sharedRunning.filter((j) => j.provider === 'local')) at += remainingMs(job) ?? 0
  for (const job of jobs.sharedQueued.filter((j) => j.provider === 'local')) {
    starts.set(job.id, at)
    at += estimateMs(job) ?? 0
  }
  return starts
})

const queueTotals = computed(() => {
  const localMs = queued.value.reduce((sum, j) => sum + (j.provider === 'local' ? (estimateMs(j) ?? 0) : 0), 0)
  const usd = queued.value.reduce((sum, j) => sum + (j.costEstimateUsd ?? 0), 0)
  return { localMs, usd }
})

/** "21:40", "07:15 tomorrow", "Sat 07:15" for later days. */
function clock(ms: number): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000)
  if (days <= 0) return time
  if (days === 1) return `${time} tomorrow`
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

function summary(job: GenerationDTO): string {
  return describeParams(job)
    .filter((r) => !r.assetIds && !['seed', 'negativePrompt', 'fps'].includes(r.key))
    .slice(0, 4)
    .map((r) => r.value)
    .join(' · ')
}

const setPaused = (value: boolean) => run(() => settings.update({ queuePaused: value }))
const setOneAtATime = (value: boolean) => run(() => settings.update({ cloudOneAtATime: value }))

// ---- history

const query = ref('')
const statusFilter = ref<'all' | 'done' | 'failed'>('all')
const expanded = ref(new Set<string>())
/** The render whose prompt, inputs and request are shown ("What was sent"). */
const detailsFor = ref<string>()
/** In the editor: this project's renders (all of them) or every project's lately finished ones. */
const scope = ref<'project' | 'all'>('project')
const historyScope = computed(() => (here.value ? scope.value : 'all'))
const historyList = computed(() => (historyScope.value === 'project' ? jobs.history : jobs.sharedHistory))

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return historyList.value.filter((job) => {
    if (statusFilter.value === 'done' && job.status !== 'succeeded') return false
    if (statusFilter.value === 'failed' && job.status === 'succeeded') return false
    return !q || `${promptText(job.params)} ${modelLabel(job)} ${job.label} ${projectLabel(job)}`.toLowerCase().includes(q)
  })
})

const groups = computed(() => {
  const out: { day: string; items: GenerationDTO[] }[] = []
  for (const job of filtered.value) {
    const day = dayLabel(job.finishedAt ?? job.updatedAt)
    const last = out.at(-1)
    if (last?.day === day) last.items.push(job)
    else out.push({ day, items: [job] })
  }
  return out
})

const spent = computed(() => jobs.list.reduce((sum, j) => sum + (j.status === 'succeeded' ? (j.costUsd ?? 0) : 0), 0))

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
}

function toggle(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function statusIcon(job: GenerationDTO) {
  return { succeeded: CheckCircle2, failed: XCircle, canceled: CircleSlash, needs_attention: AlertTriangle }[job.status as string] ?? Loader2
}

function statusClass(job: GenerationDTO) {
  return {
    'text-role-music': job.status === 'succeeded',
    'text-destructive': job.status === 'failed',
    'text-role-effects': job.status === 'needs_attention',
    'text-muted-foreground': job.status === 'canceled',
  }
}

function reuse(job: GenerationDTO) {
  generate.open(job.kind, { modelId: job.modelId, params: job.params })
  open.value = false
  toast.success('Settings loaded into Generate', { description: modelLabel(job) })
}

function preview(job: GenerationDTO) {
  const id = job.outputAssetIds[0]
  if (!id) return
  editor.playPreview(id)
  open.value = false
}

async function copyPrompt(job: GenerationDTO) {
  await navigator.clipboard.writeText(promptText(job.params))
  toast.success('Prompt copied')
}

/** What a finished render cost: the actual cost, the estimate for successes, and nothing for jobs that never ran. */
function costText(job: GenerationDTO): string {
  if (job.costUsd != null) return formatUsd(job.costUsd)
  if (job.status === 'succeeded') return formatUsd(job.costEstimateUsd)
  if (job.error?.maybeCharged && job.costEstimateUsd) return `maybe ${formatUsd(job.costEstimateUsd)}`
  return '—'
}

function stamp(iso?: string) {
  return iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'
}
</script>

<template>
  <Sheet v-model:open="open">
    <SheetTrigger as-child>
      <Button data-tour="jobs" variant="outline" size="sm" class="relative rounded-full px-3.5">
        <Loader2 v-if="activeCount && !paused" class="animate-spin text-brand" />
        <Pause v-else-if="paused && queued.length" class="text-role-effects" />
        <ListTodo v-else />
        Activity
        <!-- What is queued or rendering; renders that finished needing a look are counted apart (they're in History). -->
        <span
          v-if="activeCount"
          class="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold text-brand-foreground"
          :title="`${activeCount} queued or rendering`"
          data-queue-count=""
        >
          {{ activeCount }}
        </span>
        <span
          v-if="jobs.sharedAttention.length"
          class="absolute -top-0.5 -left-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-role-effects px-1 text-[10px] font-semibold text-white"
          :title="`${jobs.sharedAttention.length} finished render${jobs.sharedAttention.length === 1 ? ' needs' : 's need'} a look — see History`"
          data-attention-count=""
        >
          !{{ jobs.sharedAttention.length }}
        </span>
      </Button>
    </SheetTrigger>
    <SheetContent side="right" class="w-[560px] gap-0 bg-sidebar p-0 sm:max-w-[560px]">
      <SheetHeader class="px-5 pt-5 pb-3">
        <SheetTitle>Activity</SheetTitle>
        <SheetDescription>What is generating in every project: they share one queue — and one GPU — and run in order. Finished ones stay in History.</SheetDescription>
      </SheetHeader>

      <Tabs v-model="tab" class="min-h-0 flex-1 gap-0">
        <div class="px-5 pb-3">
          <TabsList class="h-8 w-full">
            <TabsTrigger value="queue" class="gap-1.5 text-xs">
              <ListOrdered class="size-3.5" /> Queue <span class="text-muted-foreground tabular">{{ activeCount }}</span>
            </TabsTrigger>
            <TabsTrigger value="history" class="gap-1.5 text-xs">
              <History class="size-3.5" /> History <span class="text-muted-foreground tabular">{{ historyList.length }}</span>
              <span v-if="jobs.sharedAttention.length" class="rounded-full bg-role-effects px-1.5 text-[10px] font-semibold text-white tabular" :title="`${jobs.sharedAttention.length} need a look`">{{ jobs.sharedAttention.length }}</span>
            </TabsTrigger>
          </TabsList>
        </div>

        <!-- Queue -->
        <TabsContent value="queue" class="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          <div class="grid gap-4">
            <div class="grid gap-3 rounded-xl bg-card p-3.5">
              <div class="flex items-center gap-3">
                <span :class="cn('size-2 shrink-0 rounded-full', paused ? 'bg-role-effects' : activeCount ? 'animate-pulse bg-brand' : 'bg-muted-foreground')" />
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium">{{ paused ? 'Queue paused' : running.length ? 'Rendering' : 'Ready' }}</div>
                  <div class="text-xs text-muted-foreground">
                    <template v-if="paused">Nothing new starts in any project; renders already running finish.</template>
                    <template v-else>{{ queued.length }} waiting · every project's jobs start in the order below</template>
                  </div>
                </div>
                <Button v-if="paused" size="sm" class="bg-brand text-brand-foreground hover:bg-brand/90" @click="setPaused(false)"><Play /> Resume</Button>
                <Button v-else size="sm" variant="outline" @click="setPaused(true)"><Pause /> Pause</Button>
              </div>
              <label class="flex cursor-pointer items-center gap-3 border-t pt-3">
                <div class="min-w-0 flex-1">
                  <div class="text-xs font-medium">Cloud jobs one at a time</div>
                  <div class="text-[11px] leading-snug text-muted-foreground">
                    Local renders always go one by one. Off: cloud jobs run in parallel — faster, but you can't stop the rest after a bad first result.
                  </div>
                </div>
                <Switch :model-value="settings.app?.cloudOneAtATime ?? true" @update:model-value="setOneAtATime" />
              </label>
              <div v-if="queued.length" class="flex gap-4 border-t pt-3 text-xs text-muted-foreground">
                <span v-if="queueTotals.localMs">Local renders ≈ <span class="text-foreground tabular">{{ formatSpan(queueTotals.localMs) }}</span></span>
                <span>Estimated cost <span class="text-foreground tabular">{{ formatUsd(queueTotals.usd) }}</span></span>
              </div>
            </div>

            <section v-if="running.length" class="grid gap-2">
              <h3 class="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Now rendering</h3>
              <div v-for="job in running" :key="job.id" class="grid gap-2 rounded-xl bg-card p-3">
                <div class="flex items-start gap-2.5">
                  <Loader2 class="mt-0.5 size-4 shrink-0 animate-spin text-brand" />
                  <div class="min-w-0 flex-1">
                    <p class="line-clamp-2 text-xs leading-snug" :title="promptText(job.params)">{{ promptText(job.params) || job.label }}</p>
                    <div class="mt-1 text-[11px] text-muted-foreground">{{ modelLabel(job) }}<template v-if="summary(job)"> · {{ summary(job) }}</template></div>
                    <button v-if="!isHere(job)" type="button" class="mt-1 inline-flex max-w-full items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline" :title="`Open ${projectLabel(job)}`" @click="openProject(job)">
                      <FolderOpen class="size-3 shrink-0" /><span class="truncate">{{ projectLabel(job) }}</span>
                    </button>
                  </div>
                  <Button variant="ghost" size="xs" class="shrink-0 text-muted-foreground" @click="run(() => jobs.cancel(job.id))"><X /> Cancel</Button>
                </div>
                <Progress :model-value="(job.progress ?? 0) * 100" class="h-1.5" />
                <div class="flex justify-between text-[11px] text-muted-foreground tabular">
                  <span>{{ job.statusDetail ?? STAGE[job.status] ?? 'Working' }}<template v-if="job.progress != null"> · {{ Math.round(job.progress * 100) }}%</template> · {{ formatSpan(elapsedMs(job)) }}</span>
                  <span v-if="remainingMs(job) !== undefined">≈ {{ formatSpan(remainingMs(job)!) }} left</span>
                </div>
              </div>
            </section>

            <section v-if="queued.length" class="grid gap-2">
              <h3 class="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Up next</h3>
              <div v-for="(job, i) in queued" :key="job.id" class="group flex items-start gap-2.5 rounded-xl bg-card p-3">
                <span class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium tabular">{{ i + 1 }}</span>
                <div class="min-w-0 flex-1">
                  <p class="line-clamp-2 text-xs leading-snug" :title="promptText(job.params)">{{ promptText(job.params) || job.label }}</p>
                  <div class="mt-1 text-[11px] text-muted-foreground">{{ modelLabel(job) }}<template v-if="summary(job)"> · {{ summary(job) }}</template></div>
                  <button v-if="!isHere(job)" type="button" class="mt-0.5 inline-flex max-w-full items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline" :title="`Open ${projectLabel(job)}`" @click="openProject(job)">
                    <FolderOpen class="size-3 shrink-0" /><span class="truncate">{{ projectLabel(job) }}</span>
                  </button>
                  <div v-if="job.statusDetail" class="mt-0.5 text-[11px] text-brand">{{ job.statusDetail }}</div>
                  <div class="mt-0.5 text-[11px] text-muted-foreground tabular">
                    <template v-if="estimateMs(job) !== undefined">≈ {{ formatSpan(estimateMs(job)!) }}</template>
                    <template v-if="localStarts.get(job.id) !== undefined"> · starts ≈ {{ clock(localStarts.get(job.id)!) }}</template>
                    <template v-if="job.costEstimateUsd"> · {{ formatUsd(job.costEstimateUsd) }}</template>
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-0.5">
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <Button variant="ghost" size="icon-sm" aria-label="Render next" :disabled="i === 0" @click="run(() => jobs.move(job.id, 'top'))"><ArrowUpToLine /></Button>
                    </TooltipTrigger>
                    <TooltipContent>Render next</TooltipContent>
                  </Tooltip>
                  <Button variant="ghost" size="icon-sm" aria-label="Move up" :disabled="i === 0" @click="run(() => jobs.move(job.id, 'up'))"><ChevronUp /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Move down" :disabled="i === queued.length - 1" @click="run(() => jobs.move(job.id, 'down'))"><ChevronDown /></Button>
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <Button variant="ghost" size="icon-sm" aria-label="Remove from queue" class="text-muted-foreground hover:text-destructive" @click="run(() => jobs.cancel(job.id))"><X /></Button>
                    </TooltipTrigger>
                    <TooltipContent>Remove from queue</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </section>

            <div v-if="!activeCount" class="rounded-xl border border-dashed p-8 text-center">
              <ListOrdered class="mx-auto size-6 text-muted-foreground" />
              <p class="mt-2 text-sm font-medium">The queue is empty</p>
              <p class="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
                Every Generate, in any project, adds a job here. Set up several shots — they render one after another, even overnight.
              </p>
            </div>
          </div>
        </TabsContent>

        <!-- History -->
        <TabsContent value="history" class="flex min-h-0 flex-1 flex-col">
          <div v-if="here" class="px-5 pb-2">
            <div class="flex rounded-md bg-muted p-0.5 text-[11px]">
              <button
                v-for="sc in (['project', 'all'] as const)"
                :key="sc"
                type="button"
                :class="cn('flex-1 rounded px-2 py-1', scope === sc ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')"
                @click="scope = sc"
              >
                {{ sc === 'project' ? 'This project' : 'All projects' }}
              </button>
            </div>
          </div>
          <div class="flex items-center gap-2 px-5 pb-3">
            <div class="relative flex-1">
              <Search class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input v-model="query" placeholder="Search prompts and models" class="h-8 pl-8 text-xs" />
            </div>
            <div class="flex rounded-md bg-muted p-0.5 text-[11px]">
              <button
                v-for="f in (['all', 'done', 'failed'] as const)"
                :key="f"
                type="button"
                :class="cn('rounded px-2 py-1 capitalize', statusFilter === f ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')"
                @click="statusFilter = f"
              >
                {{ f === 'done' ? 'Done' : f === 'failed' ? 'Failed' : 'All' }}
              </button>
            </div>
          </div>
          <div class="px-5 pb-2 text-[11px] text-muted-foreground">
            <template v-if="historyScope === 'project'">{{ filtered.length }} render{{ filtered.length === 1 ? '' : 's' }} · spent on this project {{ formatUsd(spent) }}</template>
            <template v-else>{{ filtered.length }} render{{ filtered.length === 1 ? '' : 's' }} finished in any project since the app started</template>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
            <p v-if="!filtered.length" class="py-10 text-center text-xs text-muted-foreground">
              {{ historyList.length ? 'No render matches.' : 'Finished renders appear here.' }}
            </p>
            <section v-for="group in groups" :key="group.day" class="mb-4">
              <h3 class="sticky top-0 z-10 bg-sidebar px-1 py-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{{ group.day }}</h3>
              <div class="grid gap-2">
                <div v-for="job in group.items" :key="job.id" class="overflow-hidden rounded-xl bg-card">
                  <button type="button" class="flex w-full items-start gap-3 p-2.5 text-left hover:bg-accent/40" @click="toggle(job.id)">
                    <div class="relative aspect-video w-24 shrink-0 overflow-hidden rounded-md bg-muted">
                      <AssetThumb v-if="assets.get(job.outputAssetIds[0])" :asset="assets.get(job.outputAssetIds[0])!" class="size-full" />
                      <div v-else class="flex size-full items-center justify-center">
                        <component :is="statusIcon(job)" :class="cn('size-4', statusClass(job))" />
                      </div>
                    </div>
                    <div class="min-w-0 flex-1">
                      <p class="line-clamp-2 text-xs leading-snug">{{ promptText(job.params) || job.label }}</p>
                      <div class="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
                        <component :is="statusIcon(job)" :class="cn('size-3', statusClass(job))" />
                        <span>{{ modelLabel(job) }}</span>
                        <template v-if="!isHere(job)"><span>·</span><span class="truncate">{{ projectLabel(job) }}</span></template>
                        <template v-if="renderMs(job) !== undefined"><span>·</span><span class="tabular">{{ formatSpan(renderMs(job)!) }}</span></template>
                        <span>·</span><span class="tabular">{{ costText(job) }}</span>
                        <span>·</span><span class="tabular">{{ new Date(job.finishedAt ?? job.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span>
                      </div>
                    </div>
                    <ChevronRight :class="cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', expanded.has(job.id) && 'rotate-90')" />
                  </button>

                  <div v-if="expanded.has(job.id)" class="grid gap-3 border-t px-3 py-3">
                    <div v-if="promptText(job.params)">
                      <div class="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                        Prompt
                        <Button variant="ghost" size="xs" @click="copyPrompt(job)"><Copy /> Copy</Button>
                      </div>
                      <p class="rounded-lg bg-background/60 p-2.5 text-xs leading-relaxed whitespace-pre-wrap select-text">{{ promptText(job.params) }}</p>
                    </div>
                    <dl class="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-xs">
                      <dt class="text-muted-foreground">Model</dt>
                      <dd>{{ modelLabel(job) }} <span class="text-muted-foreground">· {{ getModel(job.modelId)?.vendor ?? job.provider }}</span></dd>
                      <template v-for="row in describeParams(job)" :key="row.key">
                        <dt class="text-muted-foreground">{{ row.label }}</dt>
                        <dd v-if="row.assetIds" class="flex flex-wrap gap-1.5">
                          <template v-for="id in row.assetIds" :key="id">
                            <div v-if="assets.get(id)" class="aspect-video w-20 overflow-hidden rounded bg-muted"><AssetThumb :asset="assets.get(id)!" class="size-full" /></div>
                            <span v-else class="text-muted-foreground">(removed)</span>
                          </template>
                        </dd>
                        <dd v-else class="break-words whitespace-pre-wrap">{{ row.value }}</dd>
                      </template>
                      <dt class="text-muted-foreground">Status</dt>
                      <dd :class="statusClass(job)" class="capitalize">{{ job.status.replace('_', ' ') }}</dd>
                      <dt class="text-muted-foreground">Queued</dt>
                      <dd class="tabular">{{ stamp(job.createdAt) }}</dd>
                      <dt class="text-muted-foreground">Started → done</dt>
                      <dd class="tabular">
                        {{ stamp(job.startedAt) }} → {{ stamp(job.finishedAt) }}
                        <span v-if="renderMs(job) !== undefined" class="text-muted-foreground">({{ formatSpan(renderMs(job)!) }})</span>
                      </dd>
                      <dt class="text-muted-foreground">Cost</dt>
                      <dd class="tabular">
                        {{ costText(job) }}
                        <span v-if="job.costUsd == null && job.costEstimateUsd" class="text-muted-foreground">(estimate {{ formatUsd(job.costEstimateUsd) }})</span>
                      </dd>
                    </dl>
                    <p
                      v-if="job.error"
                      :class="cn('rounded-lg px-2.5 py-2 text-xs leading-snug', job.status === 'needs_attention' ? 'bg-role-effects/10 text-role-effects' : 'bg-destructive/10 text-destructive')"
                    >
                      {{ job.error.message }}<template v-if="job.error.maybeCharged"> (may have been charged)</template>
                    </p>
                    <div v-if="isHere(job)" class="flex flex-wrap gap-1.5">
                      <!-- A tool call (voice isolation, transcription, describe) is recorded for its cost, not as a render:
                           there are no settings to reuse and nothing to render again. -->
                      <template v-if="!job.params.tool">
                        <Button size="sm" class="bg-brand text-brand-foreground hover:bg-brand/90" @click="reuse(job)"><WandSparkles /> Use these settings</Button>
                        <Button size="sm" variant="outline" @click="run(() => jobs.retry(job.id))"><RotateCcw /> Render again</Button>
                      </template>
                      <Button v-if="job.outputAssetIds[0]" size="sm" variant="outline" @click="preview(job)"><Play /> Preview</Button>
                      <Button size="sm" variant="ghost" title="The prompt, inputs and settings, and the request as the provider got it" @click="detailsFor = job.id"><FileSearch /> What was sent</Button>
                    </div>
                    <div v-else class="flex flex-wrap gap-1.5">
                      <Button size="sm" variant="outline" @click="openProject(job)"><FolderOpen /> Open {{ projectLabel(job) }}</Button>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </TabsContent>
      </Tabs>
    </SheetContent>
    <GenerationDetailsDialog v-model:id="detailsFor" />
  </Sheet>
</template>
