<script setup lang="ts">
import { Copy, Loader2 } from '@lucide/vue'
import { getModel } from '@shared/models/registry'
import type { GenerationDetails } from '@shared/types/jobs'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import AssetThumb from '@/features/assets/AssetThumb.vue'
import { api, errorMessage } from '@/lib/api'
import { formatSpan, formatUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { describeParams, promptText, renderMs } from './describe'

/**
 * Everything recorded about one render, to see why a take came out wrong: the prompt, the pictures, clips and sound
 * it was given (numbered as the prompt names them), every setting, and the request as the provider got it — for
 * RunPod the ComfyUI workflow itself — with its answer. "Copy all" puts it on the clipboard as JSON.
 */
const id = defineModel<string | undefined>('id')
const assets = useAssetsStore()
const details = ref<GenerationDetails>()
const loading = ref(false)
const problem = ref<string>()

watch(
  id,
  async (gid) => {
    details.value = undefined
    problem.value = undefined
    if (!gid) return
    loading.value = true
    try {
      const got = await api.generations.details(gid)
      if (id.value === gid) details.value = got
    } catch (err) {
      problem.value = errorMessage(err)
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)

const model = computed(() => (details.value ? getModel(details.value.modelId) : undefined))
const prompt = computed(() => (details.value ? promptText(details.value.params) : ''))
const negative = computed(() => (typeof details.value?.params.negativePrompt === 'string' ? details.value.params.negativePrompt : ''))
const rows = computed(() => (details.value ? describeParams(details.value).filter((r) => r.key !== 'negativePrompt') : []))
const inputs = computed(() => rows.value.filter((r) => r.assetIds?.length))
const settings = computed(() => rows.value.filter((r) => !r.assetIds?.length))
const json = (value: unknown) => JSON.stringify(value, null, 2)
const stamp = (iso?: string) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' }) : '—')

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch (err) {
    toast.error('Couldn’t copy', { description: errorMessage(err) })
  }
}

/** The whole record, with each input asset's name beside its id — to paste into a bug report or a chat. */
function copyAll() {
  const d = details.value
  if (!d) return
  const named = (ids: string[]) => ids.map((assetId) => ({ id: assetId, name: assets.get(assetId)?.name ?? '(removed)' }))
  void copy(
    json({
      label: d.label,
      model: { id: d.modelId, label: model.value?.label, provider: d.provider },
      status: d.status,
      error: d.error,
      timing: { queued: d.createdAt, started: d.startedAt, finished: d.finishedAt },
      cost: { usd: d.costUsd, estimate: d.costEstimateUsd },
      prompt: prompt.value || undefined,
      negativePrompt: negative.value || undefined,
      inputs: inputs.value.map((r) => ({ setting: r.label, key: r.key, assets: named(r.assetIds!) })),
      settings: Object.fromEntries(settings.value.map((r) => [r.label, r.value])),
      params: d.params,
      request: d.request,
      response: d.response,
      providerTaskId: d.providerTaskId,
      providerMeta: d.providerMeta,
      outputs: named(d.outputAssetIds),
    }),
    'Everything about this render',
  )
}
</script>

<template>
  <Dialog :open="Boolean(id)" @update:open="(v) => !v && (id = undefined)">
    <DialogContent class="flex max-h-[88vh] min-w-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl" data-generation-details="">
      <DialogHeader class="border-b px-5 pt-5 pb-3">
        <DialogTitle class="pr-6 text-sm leading-snug">What was sent</DialogTitle>
        <DialogDescription class="line-clamp-2 text-xs">
          <template v-if="details">{{ model?.label ?? details.modelId }} · {{ details.provider }} · {{ details.label }}</template>
          <template v-else>The prompt, inputs and settings of this render, and the request as the provider got it.</template>
        </DialogDescription>
      </DialogHeader>

      <div class="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4">
        <div v-if="loading" class="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground"><Loader2 class="size-4 animate-spin" /> Loading…</div>
        <p v-else-if="problem" class="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{{ problem }}</p>
        <!-- One column no wider than the dialog: the JSON's long lines scroll in their own box. -->
        <div v-else-if="details" class="grid grid-cols-[minmax(0,1fr)] gap-5">
          <p
            v-if="details.error"
            :class="cn('rounded-lg px-3 py-2 text-xs leading-snug', details.status === 'needs_attention' ? 'bg-role-effects/10 text-role-effects' : 'bg-destructive/10 text-destructive')"
          >
            {{ details.error.message }}<template v-if="details.error.maybeCharged"> (may have been charged)</template>
          </p>

          <dl class="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-xs">
            <dt class="text-muted-foreground">Status</dt>
            <dd class="capitalize">{{ details.status.replace('_', ' ') }}</dd>
            <dt class="text-muted-foreground">Queued</dt>
            <dd class="tabular">{{ stamp(details.createdAt) }}</dd>
            <dt class="text-muted-foreground">Started → done</dt>
            <dd class="tabular">
              {{ stamp(details.startedAt) }} → {{ stamp(details.finishedAt) }}
              <span v-if="renderMs(details) !== undefined" class="text-muted-foreground">({{ formatSpan(renderMs(details)!) }})</span>
            </dd>
            <dt class="text-muted-foreground">Cost</dt>
            <dd class="tabular">{{ details.costUsd != null ? formatUsd(details.costUsd) : details.costEstimateUsd != null ? `≈ ${formatUsd(details.costEstimateUsd)} (estimate)` : '—' }}</dd>
          </dl>

          <section v-if="prompt" class="grid gap-1.5">
            <div class="flex items-center gap-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Prompt <span class="flex-1 font-normal normal-case">· {{ prompt.length }} characters</span>
              <Button variant="ghost" size="xs" class="normal-case" @click="copy(prompt, 'Prompt')"><Copy /> Copy</Button>
            </div>
            <p class="max-h-72 overflow-y-auto rounded-lg bg-muted/60 p-3 text-xs leading-relaxed whitespace-pre-wrap select-text" data-details-prompt="">{{ prompt }}</p>
            <p v-if="negative" class="rounded-lg bg-muted/40 p-2.5 text-xs whitespace-pre-wrap select-text"><span class="text-muted-foreground">Negative: </span>{{ negative }}</p>
          </section>

          <section v-if="inputs.length" class="grid gap-2">
            <div class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Inputs</div>
            <div v-for="r in inputs" :key="r.key" class="grid gap-1">
              <div class="text-xs text-muted-foreground">{{ r.label }}</div>
              <div class="flex flex-wrap gap-2">
                <figure v-for="(assetId, i) in r.assetIds" :key="assetId" class="grid w-36 gap-1">
                  <div class="aspect-video overflow-hidden rounded-md bg-muted">
                    <AssetThumb v-if="assets.get(assetId)" :asset="assets.get(assetId)!" class="size-full" />
                  </div>
                  <figcaption class="truncate text-[10px] text-muted-foreground" :title="assets.get(assetId)?.name ?? assetId">
                    <template v-if="r.assetIds!.length > 1">Image {{ i + 1 }} · </template>{{ assets.get(assetId)?.name ?? '(removed)' }}
                  </figcaption>
                </figure>
              </div>
            </div>
          </section>

          <section v-if="settings.length" class="grid gap-1.5">
            <div class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Settings</div>
            <dl class="grid grid-cols-[160px_1fr] gap-x-3 gap-y-1 text-xs">
              <template v-for="r in settings" :key="r.key">
                <dt class="text-muted-foreground">{{ r.label }}</dt>
                <dd class="break-words whitespace-pre-wrap">{{ r.value }}</dd>
              </template>
            </dl>
          </section>

          <details class="group rounded-lg border" open>
            <summary class="flex cursor-pointer items-center justify-between px-3 py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Sent to {{ details.provider }}
              <Button v-if="details.request !== undefined" variant="ghost" size="xs" class="normal-case" @click.prevent="copy(json(details.request), 'Request')"><Copy /> Copy</Button>
            </summary>
            <pre v-if="details.request !== undefined" class="max-h-96 overflow-auto border-t bg-muted/40 p-3 font-mono text-[11px] leading-relaxed select-text" data-details-request="">{{ json(details.request) }}</pre>
            <p v-else class="border-t px-3 py-2 text-xs text-muted-foreground">Nothing was recorded — it never reached the provider.</p>
          </details>

          <details v-if="details.response !== undefined" class="rounded-lg border">
            <summary class="cursor-pointer px-3 py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Its answer</summary>
            <pre class="max-h-96 overflow-auto border-t bg-muted/40 p-3 font-mono text-[11px] leading-relaxed select-text">{{ json(details.response) }}</pre>
          </details>
        </div>
      </div>

      <div class="flex items-center justify-end gap-2 border-t px-5 py-3">
        <Button variant="ghost" size="sm" @click="id = undefined">Close</Button>
        <Button size="sm" :disabled="!details" data-details-copy-all="" @click="copyAll"><Copy /> Copy all</Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
