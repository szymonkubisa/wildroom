<script setup lang="ts">
import { formatDuration } from '@shared/models/catalog/local'
import { idleText } from '@shared/types/runpod'
import { computed } from 'vue'
import { formatUsd } from '@/lib/format'
import { useSettingsStore } from '@/stores/settings'
import InlineConfirm from './InlineConfirm.vue'
import type { StoryBatch } from './useStoryBatch'
import { useStory } from './useStory'

/**
 * A batch asked in place (`ask(…, inline)`), under the button that asked: the same summary as BatchConfirmDialog —
 * generations per model with their cost and time, the batch's time, the GPU's start, the budget — as a card.
 */
const props = defineProps<{ batch: StoryBatch }>()
const { pending, pendingSummary, running, spend, priceOf, confirmRun, cancel } = props.batch
const s = useStory()
const settings = useSettingsStore()

const card = computed(() => {
  const p = pending.value
  const sum = pendingSummary.value
  if (!p || !sum) return undefined
  const lines: { text: string; value?: string; warn?: boolean }[] = sum.lines.map((m) => ({
    text: `${m.count} × ${m.model.label}`,
    value: `${priceOf(m.usd)}${m.seconds ? ` · ≈ ${formatDuration(m.seconds)}` : ''}`,
  }))
  if (sum.runpod) lines.push({ text: `The GPU starts first (a couple of minutes); it stops ${idleText(settings.app?.runpod?.idleSeconds ?? 30)} after the queue runs empty`, value: '' })
  if (sum.over) {
    lines.push({
      text: `${formatUsd(sum.over)} over the ${formatUsd(s.story.value.budgetUsd!)} budget ($${(spend.value?.totalUsd ?? 0).toFixed(2)} spent so far)`,
      value: '',
      warn: true,
    })
  }
  const time = sum.times.mac || sum.times.cloud
  return {
    title: p.title,
    total: sum.count ? `${sum.usd == null ? 'price depends on your plan' : formatUsd(sum.usd)}${time ? ` · ≈ ${formatDuration(time)}` : ''}` : undefined,
    lines,
    note: p.note ?? (!sum.count && !sum.problems.length ? 'Nothing to generate — everything is done or in progress.' : undefined),
    problems: sum.problems.slice(0, 3),
    confirmText: sum.count ? (sum.over ? `Generate anyway (${formatUsd(sum.over)} over)` : `Generate ${sum.count}`) : 'Generate',
    over: Boolean(sum.over),
    disabled: !sum.count,
  }
})
</script>

<template>
  <InlineConfirm
    v-if="card"
    :title="card.title"
    :total="card.total"
    :lines="card.lines"
    :note="card.note"
    :problems="card.problems"
    :confirm-text="card.confirmText"
    :destructive="card.over"
    :disabled="card.disabled"
    :busy="running"
    data-batch-card=""
    @confirm="confirmRun"
    @cancel="cancel"
  />
</template>
