<script setup lang="ts">
import { Loader2 } from '@lucide/vue'
import { formatDuration } from '@shared/models/catalog/local'
import { idleText } from '@shared/types/runpod'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { formatUsd } from '@/lib/format'
import { useSettingsStore } from '@/stores/settings'
import type { StoryBatch } from './useStoryBatch'
import { useStory } from './useStory'

/**
 * Before a batch starts: how many generations, what they cost and how long they take, and the budget. Batches asked
 * in place (a scene's Stills or Animate) show BatchConfirmCard instead.
 */
const props = defineProps<{ batch: StoryBatch }>()
const { pending, pendingSummary, running, spend, priceOf, confirmRun, cancel } = props.batch
const s = useStory()
const settings = useSettingsStore()
</script>

<template>
  <AlertDialog :open="Boolean(pending && !pending.inline)" @update:open="(v) => !v && cancel()">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ pending?.title }}</AlertDialogTitle>
        <AlertDialogDescription as="div" class="grid gap-2 text-sm">
          <template v-if="pendingSummary?.count">
            <div v-if="pending?.note" class="text-xs">{{ pending.note }}</div>
            <div>{{ pendingSummary.count }} generation{{ pendingSummary.count === 1 ? '' : 's' }}:</div>
            <ul class="list-inside list-disc text-xs tabular">
              <li v-for="m in pendingSummary.lines" :key="m.model.id">
                {{ m.count }} × {{ m.model.label }} — {{ priceOf(m.usd) }}<template v-if="m.seconds"> (≈ {{ formatDuration(m.seconds) }})</template>
              </li>
            </ul>
            <div class="font-medium text-foreground">
              Estimated cost: {{ pendingSummary.usd == null ? 'depends on your plan' : formatUsd(pendingSummary.usd) }}
            </div>
            <div v-if="pendingSummary.times.mac || pendingSummary.times.cloud" class="text-xs tabular">
              <template v-if="pendingSummary.times.mac">≈ {{ formatDuration(pendingSummary.times.mac) }} on this Mac (one at a time)</template>
              <template v-if="pendingSummary.times.mac && pendingSummary.times.cloud"> · </template>
              <template v-if="pendingSummary.times.cloud">≈ {{ formatDuration(pendingSummary.times.cloud) }} in the cloud</template>
            </div>
            <div v-if="pendingSummary.runpod" class="text-xs text-muted-foreground">
              Starting the GPU adds a couple of minutes; it stops {{ idleText(settings.app?.runpod?.idleSeconds ?? 30) }} after the queue runs empty.
            </div>
            <div v-if="pendingSummary.over" class="text-xs font-medium text-destructive">
              This goes {{ formatUsd(pendingSummary.over) }} over the {{ formatUsd(s.story.value.budgetUsd!) }} budget (${{ (spend?.totalUsd ?? 0).toFixed(2) }} spent so far).
            </div>
            <slot />
          </template>
          <div v-else-if="!pendingSummary?.problems.length">Nothing to generate — everything is done or in progress.</div>
          <div v-else>Nothing can be generated yet:</div>
          <div v-for="p in pendingSummary?.problems.slice(0, 3)" :key="p" class="text-xs text-role-effects">{{ p }}</div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="running">Cancel</AlertDialogCancel>
        <Button :variant="pendingSummary?.over ? 'destructive' : 'default'" :disabled="running || !pendingSummary?.count" @click="confirmRun">
          <Loader2 v-if="running" class="animate-spin" />
          {{ pendingSummary?.over ? `Generate anyway (${formatUsd(pendingSummary.over)} over budget)` : 'Generate' }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
