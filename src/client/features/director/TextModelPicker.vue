<script setup lang="ts">
import { Brain, Check, ChevronDown, Eye, Loader2, Search, Settings2 } from '@lucide/vue'
import { shortModelName } from '@shared/types/llm'
import { computed, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { openSettings } from '@/features/settings/settingsSheet'
import { priceLabel, useTextModels } from './textModels'

/** `compact`: a small "Model: …" button for dialogs; otherwise a full-width field for Settings. */
const props = defineProps<{ compact?: boolean }>()

const { models, modelsError, choice, current, label, setChoice, loadModels } = useTextModels()
const open = ref(false)
const query = ref('')
const saving = ref(false)

// Names and prices for the button and the "running now" line.
onMounted(() => void loadModels())

watch(open, (v) => {
  if (v) void loadModels()
  else query.value = ''
})

/** Suggested models first; a search looks through all of OpenRouter's text models (name, id, vendor). */
const shown = computed(() => {
  const words = query.value.toLowerCase().split(/\s+/).filter(Boolean)
  const list = words.length
    ? models.value.filter((m) => words.every((w) => `${m.name} ${m.id}`.toLowerCase().includes(w)))
    : models.value.filter((m) => m.suggested)
  return list.slice(0, 80)
})
const total = computed(() => models.value.length)

async function pick(id: string) {
  saving.value = true
  try {
    await setChoice({ model: id })
    open.value = false
  } catch (err) {
    toast.error('Could not change the model', { description: errorMessage(err) })
  } finally {
    saving.value = false
  }
}

const buttonText = computed(() => current.value?.name ?? shortModelName(choice.value.model))
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        :class="
          cn(
            'flex items-center gap-2 text-left transition-colors',
            props.compact
              ? 'max-w-full rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground'
              : 'h-9 w-full rounded-md border bg-background px-3 text-sm hover:bg-accent/50',
          )
        "
        :title="label"
      >
        <Brain :class="props.compact ? 'size-3 shrink-0' : 'size-4 shrink-0 text-muted-foreground'" />
        <span class="min-w-0 flex-1 truncate">
          <template v-if="props.compact">Director: {{ label }}</template>
          <template v-else>{{ buttonText }} <span class="text-xs text-muted-foreground">{{ choice.model }}</span></template>
        </span>
        <ChevronDown :class="props.compact ? 'size-3 shrink-0' : 'size-4 shrink-0 text-muted-foreground'" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-[380px] p-0">
      <div class="relative border-b p-2">
        <Search class="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="query" autofocus placeholder="Search models — claude, gpt, gemini, deepseek…" class="h-8 pl-7 text-xs" />
      </div>
      <div class="max-h-80 overflow-y-auto p-1">
        <div v-if="!models.length && !modelsError" class="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
          <Loader2 class="size-3.5 animate-spin" /> Loading OpenRouter's models…
        </div>
        <div v-else-if="modelsError && !models.length" class="p-4 text-xs text-destructive">{{ modelsError }}</div>
        <div v-else-if="!shown.length" class="p-4 text-center text-xs text-muted-foreground">No model matches “{{ query }}”.</div>
        <div v-if="!query && shown.length" class="px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Suggested</div>
        <button
          v-for="m in shown"
          :key="m.id"
          type="button"
          :disabled="saving"
          :class="cn('flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent', m.id === choice.model && 'bg-accent')"
          @click="pick(m.id)"
        >
          <Check :class="cn('mt-0.5 size-3.5 shrink-0', m.id === choice.model ? 'text-brand' : 'opacity-0')" />
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-1.5">
              <span class="truncate text-xs font-medium">{{ m.name }}</span>
              <Eye v-if="m.vision" class="size-3 shrink-0 text-muted-foreground" title="Reads images" />
              <span v-if="!m.structured" class="shrink-0 rounded bg-muted px-1 text-[9px] text-muted-foreground" title="No schema-enforced JSON — results are checked and retried">free-form</span>
            </span>
            <span class="block truncate text-[10px] text-muted-foreground">{{ m.id }}</span>
          </span>
          <span class="tabular shrink-0 pt-0.5 text-[10px] text-muted-foreground" title="USD per million tokens, input / output">{{ priceLabel(m) }}</span>
        </button>
        <div v-if="!query && total" class="px-2 py-1.5 text-[10px] text-muted-foreground">Search to see all {{ total }} OpenRouter text models.</div>
      </div>
      <button
        type="button"
        class="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        @click="openSettings({ tab: 'director' })"
      >
        <Settings2 class="size-3.5" /> Route and keys — now: {{ label }}
      </button>
    </PopoverContent>
  </Popover>
</template>
