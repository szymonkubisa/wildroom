<script setup lang="ts">
import { Wallet } from '@lucide/vue'
import type { ProjectSpendDTO } from '@shared/types/api'
import { type HTMLAttributes, computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { budgetLevel } from './budget'

/** "Spent $2.66 of $10": the project's spend against its budget, with a breakdown and the budget setting. */
const props = defineProps<{ spend?: ProjectSpendDTO; budget?: number; class?: HTMLAttributes['class'] }>()
const emit = defineEmits<{ 'update:budget': [usd: number | undefined]; open: [] }>()

const spent = computed(() => props.spend?.totalUsd ?? 0)
const level = computed(() => budgetLevel(spent.value, props.budget))
const providers = computed(() =>
  Object.entries(props.spend?.byProvider ?? {})
    .filter(([, usd]) => usd > 0)
    .sort((a, b) => b[1] - a[1]),
)
const PROVIDER_LABELS: Record<string, string> = { fal: 'fal.ai', kling: 'Kling', elevenlabs: 'ElevenLabs', runpod: 'RunPod', openrouter: 'OpenRouter', anthropic: 'Anthropic', local: 'This Mac', mock: 'Demo' }
const usd = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)

const draft = ref<string | number>('')
watch(
  () => props.budget,
  (b) => (draft.value = b ? String(b) : ''),
  { immediate: true },
)
function saveBudget() {
  const n = Number(draft.value)
  emit('update:budget', String(draft.value).trim() && n > 0 ? Math.round(n * 100) / 100 : undefined)
}
</script>

<template>
  <Popover @update:open="(v) => v && emit('open')">
    <PopoverTrigger as-child>
      <button
        type="button"
        :class="cn('flex h-7 items-center gap-1.5 rounded-md bg-field px-2 text-xs tabular hover:bg-field-hover', props.class)"
        :title="spend ? 'What this project’s generations cost' : 'Loading spend…'"
      >
        <Wallet class="size-3.5 text-muted-foreground" />
        <span>Spent {{ usd(spent) }}</span>
        <template v-if="budget">
          <span class="text-muted-foreground">of {{ formatUsd(budget) }}</span>
          <span class="h-1 w-10 overflow-hidden rounded-full bg-muted">
            <span
              :class="cn('block h-full rounded-full', level?.level === 'over' ? 'bg-destructive' : level?.level === 'near' ? 'bg-role-effects' : 'bg-brand')"
              :style="{ width: `${Math.min(100, (level?.share ?? 0) * 100)}%` }"
            />
          </span>
        </template>
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" class="grid w-64 gap-3 p-3 text-xs">
      <div class="grid gap-1">
        <div class="font-medium">Spent on this project</div>
        <div v-for="[id, n] in providers" :key="id" class="flex justify-between tabular">
          <span class="text-muted-foreground">{{ PROVIDER_LABELS[id] ?? id }}</span><span>{{ usd(n) }}</span>
        </div>
        <div v-if="!providers.length" class="text-muted-foreground">Nothing paid yet.</div>
        <div v-if="spend?.count" class="text-[11px] text-muted-foreground">{{ spend.count }} generation{{ spend.count === 1 ? '' : 's' }} counted</div>
        <div v-if="spend?.gpuSessionsUsd" class="text-[11px] text-muted-foreground">
          RunPod GPU sessions on this Mac (all projects, boot and idle time included): {{ usd(spend.gpuSessionsUsd) }}
        </div>
      </div>
      <form class="grid gap-1.5" @submit.prevent="saveBudget">
        <label class="font-medium" for="story-budget">Budget</label>
        <div class="flex items-center gap-1">
          <span class="text-muted-foreground">$</span>
          <Input id="story-budget" v-model="draft" type="number" min="0" step="1" placeholder="No budget" class="h-7 flex-1 text-xs" />
          <Button type="submit" size="xs" variant="outline">Set</Button>
          <Button v-if="budget" type="button" size="xs" variant="ghost" @click="emit('update:budget', undefined)">Clear</Button>
        </div>
        <div class="text-[11px] text-muted-foreground">Batch renders warn before going over it.</div>
      </form>
    </PopoverContent>
  </Popover>
</template>
