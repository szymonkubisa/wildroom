<script setup lang="ts">
import { Check, Copy, FileJson, Loader2, RotateCcw, Search, Shuffle } from '@lucide/vue'
import { parseParams } from '@shared/models/params'
import { getModel } from '@shared/models/registry'
import type { GenerationDTO } from '@shared/types/jobs'
import { computed, ref, toRaw, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import AssetThumb from '@/features/assets/AssetThumb.vue'
import GenerationDetailsDialog from '@/features/jobs/GenerationDetailsDialog.vue'
import { describeParams, promptText } from '@/features/jobs/describe'
import { errorMessage } from '@/lib/api'
import { formatUsd, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { useJobsStore } from '@/stores/jobs'
import { useSettingsStore } from '@/stores/settings'
import { useResultActions } from './resultActions'

/**
 * Every prompt generated in the project, newest first, beside the Composer: the list on the left (searchable), the
 * picked one on the right — its whole text, model, settings, inputs and results. Copy the text, Reuse it in the
 * Composer (model, settings and inputs too) or Run it again as it was (a new seed, into the Feed).
 */
const open = defineModel<boolean>('open', { default: false })
const jobs = useJobsStore()
const assets = useAssetsStore()
const settings = useSettingsStore()
const results = useResultActions()

/** One render as the history shows it: a job, or (older than the jobs the client is sent) what its results recorded. */
interface Entry {
  id: string
  modelId: string
  kind: GenerationDTO['kind']
  params: Record<string, unknown>
  prompt: string
  createdAt: string
  status: GenerationDTO['status']
  costUsd?: number
  outputAssetIds: string[]
  job?: GenerationDTO
}

const entries = computed<Entry[]>(() => {
  if (!open.value) return []
  const pid = assets.projectId
  const out: Entry[] = []
  const known = new Set<string>()
  for (const j of jobs.list) {
    if (j.projectId !== pid) continue
    known.add(j.id)
    const prompt = promptText(j.params)
    if (!prompt.trim()) continue
    out.push({ id: j.id, modelId: j.modelId, kind: j.kind, params: j.params, prompt, createdAt: j.createdAt, status: j.status, costUsd: j.costUsd ?? j.costEstimateUsd, outputAssetIds: j.outputAssetIds, job: j })
  }
  // Older renders: their results still say what they were made from.
  const older = new Map<string, Entry>()
  for (const a of assets.list) {
    const gen = a.generation
    if (!gen || known.has(gen.generationId)) continue
    const had = older.get(gen.generationId)
    if (had) {
      had.outputAssetIds.push(a.id)
      continue
    }
    const prompt = promptText(gen.params)
    if (!prompt.trim()) continue
    const kind = getModel(gen.modelId)?.kind ?? (a.kind as Entry['kind'])
    older.set(gen.generationId, { id: gen.generationId, modelId: gen.modelId, kind, params: gen.params, prompt, createdAt: a.createdAt, status: 'succeeded', outputAssetIds: [a.id] })
  }
  return [...out, ...older.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
})

const modelLabel = (e: Entry) => getModel(e.modelId)?.label ?? e.modelId
const search = ref('')
const shown = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return entries.value
  return entries.value.filter((e) => e.prompt.toLowerCase().includes(q) || modelLabel(e).toLowerCase().includes(q))
})

const pickedId = ref<string>()
const picked = computed(() => shown.value.find((e) => e.id === pickedId.value) ?? shown.value[0])
watch(open, (v) => {
  if (!v) return
  pickedId.value = undefined
  search.value = ''
})

const firstOutput = (e: Entry) => e.outputAssetIds.map((id) => assets.get(id)).find((a) => a !== undefined)
const failed = (e: Entry) => e.status === 'failed' || e.status === 'needs_attention' || e.status === 'canceled'
const rows = computed(() => (picked.value ? describeParams(picked.value) : []))
const inputs = computed(() => rows.value.filter((r) => r.assetIds?.length))
const settingsRows = computed(() => rows.value.filter((r) => !r.assetIds?.length))
const outputs = computed(() => (picked.value?.outputAssetIds ?? []).map((id) => assets.get(id)).filter((a) => a !== undefined))
const stamp = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })

// ---- actions
const copied = ref<string>()
async function copy(e: Entry) {
  try {
    await navigator.clipboard.writeText(e.prompt)
    copied.value = e.id
    setTimeout(() => copied.value === e.id && (copied.value = undefined), 1500)
    toast.success('Prompt copied')
  } catch (err) {
    toast.error('Couldn’t copy', { description: errorMessage(err) })
  }
}

/** Back in the Composer as it was asked for: model, prompt, settings and inputs. */
function reuse(e: Entry) {
  results.editAndRetry({ modelId: e.modelId, kind: e.kind, params: structuredClone(toRaw(e.params)) } as GenerationDTO)
  open.value = false
}

/** The same again with a new seed: what it would cost now, or why it can't run. */
function againPlan(e: Entry) {
  const model = getModel(e.modelId)
  if (!model) return { problem: 'This model is no longer available' }
  if (!settings.modelReady(model)) return { problem: `${model.label} isn’t set up — add its key or install it in Settings` }
  const { seed: _, ...rest } = structuredClone(toRaw(e.params))
  const parsed = parseParams(model, rest)
  if (!parsed.ok) return { problem: parsed.message }
  const usd = model.estimateCost(parsed.values).usd
  return { model, params: parsed.values, cost: usd == null ? undefined : formatUsd(usd) }
}
const again = computed(() => (picked.value ? againPlan(picked.value) : undefined))
const starting = ref(false)
async function runAgain(e: Entry) {
  const plan = againPlan(e)
  const projectId = assets.projectId
  if (!plan.model || !projectId) return void toast.error(plan.problem ?? 'No project open')
  starting.value = true
  try {
    await jobs.create({ projectId, modelId: plan.model.id, params: plan.params })
    toast.success('Generating again', { description: [plan.cost && `Estimated ${plan.cost}`, 'It lands in the Feed'].filter(Boolean).join(' · ') })
  } catch (err) {
    toast.error('Couldn’t start it', { description: errorMessage(err) })
  } finally {
    starting.value = false
  }
}

const detailsFor = ref<string>()
const label = 'text-[10px] font-medium tracking-wide text-muted-foreground uppercase'
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex h-[82vh] w-[min(1180px,95vw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none" data-prompt-history="">
      <header class="flex items-center gap-3 border-b px-5 py-3 pr-14">
        <DialogTitle class="shrink-0 text-sm font-semibold">Prompt history</DialogTitle>
        <DialogDescription class="truncate text-xs text-muted-foreground">
          {{ entries.length }} prompt{{ entries.length === 1 ? '' : 's' }} in this project — copy one, reuse it in the Composer or run it again.
        </DialogDescription>
      </header>

      <div class="grid min-h-0 flex-1 grid-cols-[minmax(300px,400px)_minmax(0,1fr)]">
        <!-- The list -->
        <div class="flex min-h-0 flex-col border-r">
          <div class="relative p-3 pb-2">
            <Search class="pointer-events-none absolute top-[calc(50%+2px)] left-5.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input v-model="search" placeholder="Search prompts and models" class="h-8 pl-8 text-xs" data-history-search="" />
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            <button
              v-for="e in shown"
              :key="e.id"
              type="button"
              :class="cn('flex w-full items-start gap-2.5 rounded-lg p-2 text-left transition-colors', picked?.id === e.id ? 'bg-accent' : 'hover:bg-accent/50')"
              data-history-entry=""
              @click="pickedId = e.id"
            >
              <div class="size-12 shrink-0 overflow-hidden rounded-md bg-muted">
                <AssetThumb v-if="firstOutput(e)" :asset="firstOutput(e)!" class="size-full" />
              </div>
              <div class="grid min-w-0 flex-1 gap-0.5">
                <p class="line-clamp-2 text-xs leading-snug">{{ e.prompt }}</p>
                <p class="truncate font-mono text-[10px] text-muted-foreground">
                  <span v-if="failed(e)" class="text-destructive">Failed · </span>{{ modelLabel(e) }}<template v-if="e.costUsd != null"> · {{ formatUsd(e.costUsd) }}</template> ·
                  {{ relativeTime(e.createdAt) }}
                </p>
              </div>
            </button>
            <p v-if="!shown.length" class="px-2 py-10 text-center text-xs text-muted-foreground">{{ entries.length ? 'No prompt matches.' : 'Nothing generated in this project yet.' }}</p>
          </div>
        </div>

        <!-- The picked one -->
        <div v-if="picked" class="flex min-h-0 flex-col">
          <div class="min-h-0 flex-1 overflow-y-auto p-5">
            <div class="grid grid-cols-[minmax(0,1fr)] gap-5">
              <dl class="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-xs">
                <dt class="text-muted-foreground">Model</dt>
                <dd>{{ modelLabel(picked) }}</dd>
                <dt class="text-muted-foreground">When</dt>
                <dd class="tabular">{{ stamp(picked.createdAt) }}</dd>
                <dt class="text-muted-foreground">Status</dt>
                <dd :class="cn('capitalize', failed(picked) && 'text-destructive')">{{ picked.status.replace('_', ' ') }}</dd>
                <dt class="text-muted-foreground">Cost</dt>
                <dd class="tabular">{{ picked.costUsd != null ? formatUsd(picked.costUsd) : '—' }}</dd>
              </dl>

              <section class="grid gap-1.5">
                <div class="flex items-center gap-2">
                  <span :class="label">Prompt</span>
                  <span class="text-[10px] text-muted-foreground">· {{ picked.prompt.length }} characters</span>
                </div>
                <p class="max-h-72 overflow-y-auto rounded-lg bg-muted/60 p-3 text-[13px] leading-relaxed whitespace-pre-wrap select-text" data-history-prompt="">{{ picked.prompt }}</p>
              </section>

              <section v-if="inputs.length" class="grid gap-2">
                <div :class="label">Inputs</div>
                <div v-for="r in inputs" :key="r.key" class="grid grid-cols-[110px_1fr] items-start gap-3 text-xs">
                  <span class="pt-1 text-muted-foreground">{{ r.label }}</span>
                  <div class="flex flex-wrap gap-1.5">
                    <template v-for="id in r.assetIds" :key="id">
                      <div v-if="assets.get(id)" class="size-14 overflow-hidden rounded-md bg-muted" :title="assets.get(id)!.name"><AssetThumb :asset="assets.get(id)!" class="size-full" /></div>
                      <span v-else class="rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">Removed</span>
                    </template>
                  </div>
                </div>
              </section>

              <section v-if="settingsRows.length" class="grid gap-1.5">
                <div :class="label">Settings</div>
                <dl class="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-xs">
                  <template v-for="r in settingsRows" :key="r.key">
                    <dt class="truncate text-muted-foreground">{{ r.label }}</dt>
                    <dd class="min-w-0 break-words">{{ r.value }}</dd>
                  </template>
                </dl>
              </section>

              <section v-if="outputs.length" class="grid gap-2">
                <div :class="label">Results · {{ outputs.length }}</div>
                <div class="flex flex-wrap gap-2">
                  <div v-for="a in outputs" :key="a.id" class="aspect-video h-28 overflow-hidden rounded-lg bg-muted"><AssetThumb :asset="a" class="size-full" /></div>
                </div>
              </section>
            </div>
          </div>

          <footer class="flex flex-wrap items-center gap-2 border-t px-5 py-3">
            <Button v-if="picked.job" variant="ghost" size="sm" title="Everything recorded about this render, with the request the provider got" @click="detailsFor = picked.id">
              <FileJson /> All details
            </Button>
            <span v-if="again?.problem" class="min-w-0 truncate text-[11px] text-muted-foreground">{{ again.problem }}</span>
            <div class="flex-1" />
            <Button variant="outline" size="sm" data-history-copy="" @click="copy(picked)">
              <Check v-if="copied === picked.id" /><Copy v-else /> Copy text
            </Button>
            <Button variant="outline" size="sm" title="Prompt, model, settings and inputs back in the Composer, to change before generating" data-history-reuse="" @click="reuse(picked)">
              <RotateCcw /> Reuse
            </Button>
            <Button
              size="sm"
              class="bg-brand text-brand-foreground hover:bg-brand/90"
              :disabled="Boolean(again?.problem) || starting"
              title="Generate it again as it was, with a new seed — the result lands in the Feed"
              data-history-again=""
              @click="runAgain(picked)"
            >
              <Loader2 v-if="starting" class="animate-spin" /><Shuffle v-else /> Run again<span v-if="again?.cost" class="opacity-75">· {{ again.cost }}</span>
            </Button>
          </footer>
        </div>
        <div v-else class="flex items-center justify-center text-xs text-muted-foreground">Pick a prompt to see it.</div>
      </div>
    </DialogContent>
  </Dialog>
  <GenerationDetailsDialog v-model:id="detailsFor" />
</template>
