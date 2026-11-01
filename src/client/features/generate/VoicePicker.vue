<script setup lang="ts">
import { Check, ChevronsUpDown, Loader2, Pause, Play, Search, Sparkles } from '@lucide/vue'
import { watchDebounced } from '@vueuse/core'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import VoiceLabDialog from '@/features/voices/VoiceLabDialog.vue'
import { api, errorMessage, type VoiceInfo } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings'

defineProps<{ compact?: boolean }>()
const model = defineModel<string | undefined>()
const settings = useSettingsStore()

const open = ref(false)
const search = ref('')
const voices = ref<VoiceInfo[]>([])
const loading = ref(false)
const error = ref<string>()
const playing = ref<string>()
let audio: HTMLAudioElement | undefined

const known = new Map<string, VoiceInfo>()
const labOpen = ref(false)

function onVoiceCreated(v: { id: string; name: string }) {
  known.set(v.id, { id: v.id, name: v.name })
  model.value = v.id
  void load(true)
}
const selected = computed(() => (model.value ? known.get(model.value) : undefined))
const ready = computed(() => settings.providerReady('elevenlabs'))

async function load(fresh = false) {
  if (!ready.value) return
  loading.value = true
  error.value = undefined
  try {
    const res = await api.voices.list(search.value, undefined, fresh)
    voices.value = res.voices
    for (const v of res.voices) known.set(v.id, v)
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

watch(open, (v) => {
  if (v && !voices.value.length) void load()
})
watchDebounced(search, () => load(), { debounce: 300 })
watch(ready, (v) => v && model.value && !known.size && load(), { immediate: true })

function preview(v: VoiceInfo) {
  audio?.pause()
  if (playing.value === v.id || !v.previewUrl) {
    playing.value = undefined
    return
  }
  audio = new Audio(v.previewUrl)
  playing.value = v.id
  audio.onended = () => (playing.value = undefined)
  void audio.play()
}

onBeforeUnmount(() => audio?.pause())

function choose(v: VoiceInfo) {
  model.value = v.id
  open.value = false
}

function describe(v: VoiceInfo) {
  const l = v.labels ?? {}
  return [l.gender, l.age, l.accent, l.use_case ?? l.descriptive].filter(Boolean).join(' · ')
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button variant="outline" :size="compact ? 'sm' : 'default'" class="w-full justify-between font-normal" :disabled="!ready">
        <span class="truncate">{{ ready ? (selected?.name ?? (model ? 'Voice selected' : 'Pick a voice')) : 'ElevenLabs not configured' }}</span>
        <ChevronsUpDown class="opacity-50" />
      </Button>
    </PopoverTrigger>
    <PopoverContent class="w-80 p-0" align="start">
      <div class="relative border-b p-2">
        <Search class="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="search" placeholder="Search your voices" class="h-8 pl-7 text-xs" />
      </div>
      <ScrollArea class="h-72">
        <div v-if="loading" class="flex justify-center p-6"><Loader2 class="size-4 animate-spin text-muted-foreground" /></div>
        <div v-else-if="error" class="p-4 text-xs text-destructive">{{ error }}</div>
        <div v-else-if="!voices.length" class="p-4 text-center text-xs text-muted-foreground">No voices found.</div>
        <div v-else class="p-1">
          <!-- .self: Enter or Space on the preview button plays it, not picks the voice. -->
          <div
            v-for="v in voices"
            :key="v.id"
            role="button"
            tabindex="0"
            :class="cn('flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50', model === v.id && 'bg-accent')"
            @click="choose(v)"
            @keydown.enter.self.prevent="choose(v)"
            @keydown.space.self.prevent="choose(v)"
          >
            <button
              type="button"
              class="flex size-6 shrink-0 items-center justify-center rounded-full border hover:bg-background"
              :aria-label="playing === v.id ? `Stop ${v.name}` : `Play ${v.name}`"
              :disabled="!v.previewUrl"
              @click.stop="preview(v)"
            >
              <Pause v-if="playing === v.id" class="size-3" />
              <Play v-else class="size-3" />
            </button>
            <div class="min-w-0 flex-1">
              <div class="truncate text-xs font-medium">{{ v.name }}</div>
              <div class="truncate text-[10px] text-muted-foreground">{{ describe(v) || v.category }}</div>
            </div>
            <Check v-if="model === v.id" class="size-3.5 shrink-0" />
          </div>
        </div>
      </ScrollArea>
      <div class="border-t p-1">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-brand hover:bg-accent"
          @click="
            open = false;
            labOpen = true
          "
        >
          <Sparkles class="size-3.5" /> Design or clone a voice…
        </button>
      </div>
    </PopoverContent>
  </Popover>
  <VoiceLabDialog v-model:open="labOpen" @created="onVoiceCreated" />
</template>
