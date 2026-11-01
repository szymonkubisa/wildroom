<script setup lang="ts">
import { Check, ChevronDown, Loader2, Search } from '@lucide/vue'
import type { OpenRouterImageModel } from '@shared/models/catalog/openrouter'
import { computed, onMounted, ref, watch } from 'vue'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { imageModelPricing, imageModelTraits, loadImageModels, useImageModels } from './openrouterImages'

const model = defineModel<string | undefined>()

const { models, error } = useImageModels()
const open = ref(false)
const query = ref('')
const price = ref<string[]>()
const priceError = ref<string>()

onMounted(() => void loadImageModels())
watch(open, (v) => {
  if (v) void loadImageModels()
  else query.value = ''
})

const current = computed(() => models.value.find((m) => m.id === model.value))
const shown = computed(() => {
  const words = query.value.toLowerCase().split(/\s+/).filter(Boolean)
  return words.length ? models.value.filter((m) => words.every((w) => `${m.name} ${m.id}`.toLowerCase().includes(w))) : models.value
})

watch(
  model,
  async (id) => {
    price.value = undefined
    priceError.value = undefined
    if (!id) return
    try {
      const lines = await imageModelPricing(id)
      if (model.value === id) price.value = lines
    } catch (err) {
      if (model.value === id) priceError.value = errorMessage(err)
    }
  },
  { immediate: true },
)

function pick(m: OpenRouterImageModel) {
  model.value = m.id
  open.value = false
}
</script>

<template>
  <div class="grid gap-1">
    <Popover v-model:open="open">
      <PopoverTrigger as-child>
        <button type="button" class="flex h-9 w-full items-center gap-2 rounded-md border bg-background px-3 text-left text-sm hover:bg-accent/50">
          <!-- w-0: a long model id must not widen the panel (the scroll area sizes to its content's min width). -->
          <span class="w-0 min-w-0 flex-1 truncate">
            {{ current?.name ?? model ?? 'Choose a model' }}
            <span v-if="current" class="text-xs text-muted-foreground">{{ current.id }}</span>
          </span>
          <ChevronDown class="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" class="w-[360px] p-0">
        <div class="relative border-b p-2">
          <Search class="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="query" autofocus placeholder="Search — gpt, flux, seedream, recraft…" class="h-8 pl-7 text-xs" />
        </div>
        <div class="max-h-80 overflow-y-auto p-1">
          <div v-if="!models.length && !error" class="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
            <Loader2 class="size-3.5 animate-spin" /> Loading OpenRouter’s image models…
          </div>
          <div v-else-if="error && !models.length" class="p-4 text-xs text-destructive">{{ error }}</div>
          <div v-else-if="!shown.length" class="p-4 text-center text-xs text-muted-foreground">No model matches “{{ query }}”.</div>
          <button
            v-for="m in shown"
            :key="m.id"
            type="button"
            :class="cn('flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent', m.id === model && 'bg-accent')"
            :title="m.description"
            @click="pick(m)"
          >
            <Check :class="cn('mt-0.5 size-3.5 shrink-0', m.id === model ? 'text-brand' : 'opacity-0')" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-xs font-medium">{{ m.name }}</span>
              <span class="block truncate text-[10px] text-muted-foreground">{{ m.id }}</span>
            </span>
            <span class="shrink-0 pt-0.5 text-right text-[10px] text-muted-foreground">{{ imageModelTraits(m).slice(0, 2).join(' · ') }}</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
    <p v-if="current" class="text-[11px] leading-snug text-muted-foreground">{{ imageModelTraits(current).join(' · ') }}</p>
    <p v-if="price" class="text-[11px] leading-snug text-muted-foreground">{{ price.length ? price.join(' · ') : 'OpenRouter lists no price for it yet' }}</p>
    <p v-else-if="priceError" class="text-[11px] text-muted-foreground">Price unavailable — {{ priceError }}</p>
    <p v-if="model && models.length && !current" class="text-[11px] text-destructive">OpenRouter doesn’t list “{{ model }}” as an image model.</p>
  </div>
</template>
