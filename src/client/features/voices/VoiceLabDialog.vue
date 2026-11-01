<script setup lang="ts">
import { AudioLines, Check, KeyRound, Loader2, Mic, Pause, Play, Search, Upload, Video, WandSparkles } from '@lucide/vue'
import { FLICKS_PER_SECOND } from '@shared/time/flicks'
import { formatDuration } from '@shared/time/timecode'
import type { AssetDTO } from '@shared/types/assets'
import { VOICE_LAB_LIMITS as LIMITS, type VoiceCreatedResponse, type VoiceDesignPreviewDTO } from '@shared/types/voiceLab'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { api, errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { useSettingsStore } from '@/stores/settings'

type Tab = 'design' | 'clone'

const props = defineProps<{ defaultTab?: Tab }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ created: [voice: { id: string; name: string }] }>()

const assets = useAssetsStore()
const settings = useSettingsStore()
const ready = computed(() => settings.providerReady('elevenlabs'))
const tab = ref<Tab>(props.defaultTab ?? 'design')

// ------------------------------------------------------------------------------------ preview playback

const playing = ref<string>()
let audio: HTMLAudioElement | undefined

function stopAudio() {
  audio?.pause()
  audio = undefined
  playing.value = undefined
}

function togglePlay(preview: VoiceDesignPreviewDTO) {
  if (playing.value === preview.generatedVoiceId) return stopAudio()
  stopAudio()
  const el = new Audio(preview.audioUrl)
  audio = el
  playing.value = preview.generatedVoiceId
  const done = () => {
    if (audio === el) playing.value = undefined
  }
  el.onended = done
  el.play().catch(done)
}

// ------------------------------------------------------------------------------------ design

const chars = (s: string) => [...s.trim()].length
const description = ref('')
const sampleText = ref('')
const previews = ref<VoiceDesignPreviewDTO[]>([])
const previewText = ref<string>()
/** Description the current previews were generated from (saved with the voice). */
const generatedFor = ref('')
const chosen = ref<string>()
const designName = ref('')
const designing = ref(false)
const saving = ref(false)
const designError = ref<string>()
let designAbort: AbortController | undefined

const descriptionLength = computed(() => chars(description.value))
const textLength = computed(() => chars(sampleText.value))
const descriptionOk = computed(() => descriptionLength.value >= LIMITS.descriptionMin && descriptionLength.value <= LIMITS.descriptionMax)
const textOk = computed(() => textLength.value === 0 || (textLength.value >= LIMITS.sampleTextMin && textLength.value <= LIMITS.sampleTextMax))
const canDesign = computed(() => ready.value && descriptionOk.value && textOk.value && !designing.value && !saving.value)
const canSave = computed(() => ready.value && Boolean(chosen.value) && chars(designName.value) > 0 && !saving.value && !designing.value)

async function generatePreviews() {
  if (!canDesign.value) return
  stopAudio()
  designAbort?.abort()
  const controller = new AbortController()
  designAbort = controller
  designing.value = true
  designError.value = undefined
  const desc = description.value.trim()
  try {
    const res = await api.voices.design({ description: desc, text: sampleText.value.trim() || undefined }, controller.signal)
    previews.value = res.previews.slice(0, 3)
    previewText.value = res.text
    generatedFor.value = desc
    chosen.value = undefined
  } catch (err) {
    if (!controller.signal.aborted) designError.value = errorMessage(err)
  } finally {
    if (designAbort === controller) {
      designAbort = undefined
      designing.value = false
    }
  }
}

async function saveDesigned() {
  const generatedVoiceId = chosen.value
  if (!generatedVoiceId || !canSave.value) return
  saving.value = true
  designError.value = undefined
  try {
    finish(await api.voices.saveDesign({ name: designName.value.trim(), description: generatedFor.value, generatedVoiceId }))
  } catch (err) {
    designError.value = errorMessage(err)
  } finally {
    saving.value = false
  }
}

// ------------------------------------------------------------------------------------ clone

interface SampleOption {
  asset: AssetDTO
  seconds: number
  usable: boolean
  note?: string
}

const cloneName = ref('')
const cloneDescription = ref('')
const sampleQuery = ref('')
const selectedIds = ref<string[]>([])
const removeNoise = ref(false)
const consent = ref(false)
const cloning = ref(false)
const cloneError = ref<string>()
const fileInput = ref<HTMLInputElement>()
/** Freshly imported files get selected as soon as they finish processing. */
const autoSelect = new Set<string>()

const samples = computed<SampleOption[]>(() =>
  assets.list
    .filter((a) => a.kind === 'audio' || (a.kind === 'video' && a.hasAudio))
    .map((asset) => {
      const seconds = (asset.durationFlicks ?? 0) / FLICKS_PER_SECOND
      if (asset.status === 'processing') return { asset, seconds, usable: false, note: 'Processing…' }
      if (asset.status !== 'ready') return { asset, seconds, usable: false, note: asset.status === 'missing' ? 'File missing' : 'Import failed' }
      if (asset.kind === 'video' && !asset.variants.audio) return { asset, seconds, usable: false, note: 'No extracted audio' }
      return { asset, seconds, usable: true }
    }),
)
const visibleSamples = computed(() => {
  const q = sampleQuery.value.trim().toLowerCase()
  return q ? samples.value.filter((s) => s.asset.name.toLowerCase().includes(q)) : samples.value
})
const chosenSamples = computed(() => samples.value.filter((s) => s.usable && selectedIds.value.includes(s.asset.id)))
const selectedSeconds = computed(() => chosenSamples.value.reduce((sum, s) => sum + s.seconds, 0))
const atLimit = computed(() => chosenSamples.value.length >= LIMITS.cloneFilesMax)
const hint = computed<{ warn: boolean; text: string }>(() => {
  const n = chosenSamples.value.length
  const total = formatDuration(selectedSeconds.value)
  if (!n) return { warn: false, text: 'Pick clean recordings of one speaker — 1–3 minutes of speech in total works best.' }
  const picked = `${n} sample${n === 1 ? '' : 's'} · ${total}`
  if (selectedSeconds.value < 60) return { warn: true, text: `${picked} — add more speech if you can; aim for 1–3 minutes.` }
  if (selectedSeconds.value > 180) return { warn: true, text: `${picked} — more than ~3 minutes rarely improves the clone.` }
  return { warn: false, text: `${picked} of audio.` }
})
const canClone = computed(
  () =>
    ready.value &&
    chars(cloneName.value) > 0 &&
    chosenSamples.value.length > 0 &&
    chosenSamples.value.length <= LIMITS.cloneFilesMax &&
    consent.value &&
    !cloning.value,
)

function isSelected(id: string) {
  return selectedIds.value.includes(id)
}

function setSelected(id: string, on: boolean) {
  if (on && !isSelected(id) && !atLimit.value) selectedIds.value = [...selectedIds.value, id]
  else if (!on) selectedIds.value = selectedIds.value.filter((x) => x !== id)
}

watch(samples, (list) => {
  for (const s of list) {
    if (s.usable && autoSelect.delete(s.asset.id)) setSelected(s.asset.id, true)
  }
})

async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (!files.length) return
  const before = new Set(assets.byId.keys())
  await assets.importFiles(files)
  for (const a of assets.list) {
    if (before.has(a.id) || a.kind === 'image') continue
    if (samples.value.some((s) => s.asset.id === a.id && s.usable)) setSelected(a.id, true)
    else autoSelect.add(a.id)
  }
}

async function clone() {
  if (!canClone.value) return
  cloning.value = true
  cloneError.value = undefined
  try {
    const voice = await api.voices.clone({
      name: cloneName.value.trim(),
      description: cloneDescription.value.trim() || undefined,
      assetIds: chosenSamples.value.map((s) => s.asset.id),
      consent: consent.value,
      removeBackgroundNoise: removeNoise.value,
    })
    finish(voice)
  } catch (err) {
    cloneError.value = errorMessage(err)
  } finally {
    cloning.value = false
  }
}

// ------------------------------------------------------------------------------------ lifecycle

function finish(voice: VoiceCreatedResponse) {
  toast.success(`Voice “${voice.name}” added`, {
    description: voice.requiresVerification
      ? 'ElevenLabs asks you to verify this voice before it can be used.'
      : 'It’s in your ElevenLabs voices and ready to use.',
  })
  emit('created', { id: voice.voiceId, name: voice.name })
  reset()
  open.value = false
}

function reset() {
  stopAudio()
  designAbort?.abort()
  description.value = ''
  sampleText.value = ''
  previews.value = []
  previewText.value = undefined
  generatedFor.value = ''
  chosen.value = undefined
  designName.value = ''
  designError.value = undefined
  cloneName.value = ''
  cloneDescription.value = ''
  sampleQuery.value = ''
  selectedIds.value = []
  removeNoise.value = false
  consent.value = false
  cloneError.value = undefined
  autoSelect.clear()
}

// A running design keeps going while the dialog is closed; reopening shows its previews.
watch(open, (isOpen) => {
  if (!isOpen) stopAudio()
  else if (props.defaultTab) tab.value = props.defaultTab
})
watch(tab, stopAudio)
onBeforeUnmount(() => {
  stopAudio()
  designAbort?.abort()
})
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="gap-3 sm:max-w-lg" @interact-outside="(e) => (saving || cloning) && e.preventDefault()">
      <DialogHeader>
        <DialogTitle>Voice Lab</DialogTitle>
        <DialogDescription class="text-xs">Design a new voice from a description, or clone one from recordings in this project.</DialogDescription>
      </DialogHeader>

      <div v-if="!ready" class="flex items-center gap-2 rounded-md border border-dashed p-2.5 text-xs">
        <KeyRound class="size-4 shrink-0 text-muted-foreground" />
        <span>Connect ElevenLabs in Settings → Providers to design or clone voices.</span>
      </div>

      <Tabs :model-value="tab" class="gap-3" @update:model-value="(v) => (tab = v as Tab)">
        <TabsList class="h-8 w-full">
          <TabsTrigger value="design" class="text-xs"><WandSparkles /> Design</TabsTrigger>
          <TabsTrigger value="clone" class="text-xs"><Mic /> Clone</TabsTrigger>
        </TabsList>

        <!-- Design -->
        <TabsContent value="design" class="mt-0 grid gap-3">
          <div class="grid gap-1.5">
            <div class="flex items-center justify-between gap-2">
              <Label for="voice-lab-description" class="text-xs">Describe the voice</Label>
              <span :class="cn('text-[10px] tabular', descriptionOk || !descriptionLength ? 'text-muted-foreground' : 'text-destructive')">
                {{ descriptionLength }}/{{ LIMITS.descriptionMax }}
              </span>
            </div>
            <Textarea
              id="voice-lab-description"
              v-model="description"
              :rows="3"
              class="min-h-0 resize-y text-xs leading-relaxed"
              placeholder="A gravelly old sea captain in his seventies, warm Irish lilt, slow and amused, slightly hoarse"
            />
            <p class="text-[11px] text-muted-foreground">
              Age, gender, accent, tone, pace and recording quality all help — at least {{ LIMITS.descriptionMin }} characters.
            </p>
          </div>

          <div class="grid gap-1.5">
            <div class="flex items-center justify-between gap-2">
              <Label for="voice-lab-text" class="text-xs">Sample text <span class="font-normal text-muted-foreground">(optional)</span></Label>
              <span :class="cn('text-[10px] tabular', textOk ? 'text-muted-foreground' : 'text-destructive')">
                {{ textLength }}/{{ LIMITS.sampleTextMax }}
              </span>
            </div>
            <Textarea
              id="voice-lab-text"
              v-model="sampleText"
              :rows="2"
              class="min-h-0 resize-y text-xs leading-relaxed"
              placeholder="What the previews say. Leave empty and ElevenLabs writes a line that suits the voice."
            />
            <p v-if="!textOk" class="text-[11px] text-destructive">
              Sample text needs {{ LIMITS.sampleTextMin }}–{{ LIMITS.sampleTextMax.toLocaleString('en-US') }} characters — or leave it empty.
            </p>
          </div>

          <Button size="sm" variant="outline" :disabled="!canDesign" @click="generatePreviews">
            <Loader2 v-if="designing" class="animate-spin" />
            <WandSparkles v-else />
            {{ designing ? 'Designing voices…' : previews.length ? 'Generate new previews' : 'Generate previews' }}
          </Button>

          <template v-if="previews.length">
            <div class="grid gap-1.5">
              <Label class="text-xs">Pick a voice</Label>
              <div role="radiogroup" aria-label="Voice previews" class="grid gap-2 sm:grid-cols-3">
                <div
                  v-for="(p, i) in previews"
                  :key="p.generatedVoiceId"
                  role="radio"
                  tabindex="0"
                  :aria-checked="chosen === p.generatedVoiceId"
                  :class="
                    cn(
                      'relative flex cursor-pointer items-center gap-2 rounded-lg border p-2 transition-colors outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50',
                      chosen === p.generatedVoiceId && 'border-brand bg-brand/10',
                    )
                  "
                  @click="chosen = p.generatedVoiceId"
                  @keydown.enter.prevent="chosen = p.generatedVoiceId"
                  @keydown.space.prevent="chosen = p.generatedVoiceId"
                >
                  <button
                    type="button"
                    class="flex size-7 shrink-0 items-center justify-center rounded-full border bg-background/40 hover:bg-background"
                    :aria-label="playing === p.generatedVoiceId ? `Pause voice ${i + 1}` : `Play voice ${i + 1}`"
                    @click.stop="togglePlay(p)"
                  >
                    <Pause v-if="playing === p.generatedVoiceId" class="size-3" />
                    <Play v-else class="size-3" />
                  </button>
                  <div class="min-w-0">
                    <div class="text-xs font-medium">Voice {{ i + 1 }}</div>
                    <div class="truncate text-[10px] text-muted-foreground tabular">
                      {{ p.durationSeconds ? formatDuration(p.durationSeconds) : 'Preview' }}{{ p.language ? ` · ${p.language}` : '' }}
                    </div>
                  </div>
                  <Check v-if="chosen === p.generatedVoiceId" class="absolute top-1.5 right-1.5 size-3.5 text-brand" />
                </div>
              </div>
              <p v-if="previewText" class="line-clamp-2 text-[11px] text-muted-foreground italic" :title="previewText">“{{ previewText }}”</p>
            </div>

            <div class="grid gap-1.5">
              <Label for="voice-lab-name" class="text-xs">Voice name</Label>
              <Input
                id="voice-lab-name"
                v-model="designName"
                class="h-8 text-xs"
                placeholder="e.g. Captain Doyle"
                :maxlength="LIMITS.nameMax"
                @keydown.enter.prevent="saveDesigned"
              />
            </div>
          </template>

          <p v-if="designError" class="text-[11px] text-destructive">{{ designError }}</p>

          <div v-if="previews.length" class="flex items-center justify-between gap-2">
            <span class="text-[11px] text-muted-foreground">{{ chosen ? 'Saving adds it to your ElevenLabs voices.' : 'Listen, then pick the one you like.' }}</span>
            <Button size="sm" :disabled="!canSave" @click="saveDesigned">
              <Loader2 v-if="saving" class="animate-spin" />
              <Check v-else />
              Save voice
            </Button>
          </div>
        </TabsContent>

        <!-- Clone -->
        <TabsContent value="clone" class="mt-0 grid gap-3">
          <div class="grid grid-cols-2 gap-3">
            <div class="grid gap-1.5">
              <Label for="voice-lab-clone-name" class="text-xs">Voice name</Label>
              <Input id="voice-lab-clone-name" v-model="cloneName" class="h-8 text-xs" placeholder="e.g. Maya (narrator)" :maxlength="LIMITS.nameMax" />
            </div>
            <div class="grid gap-1.5">
              <Label for="voice-lab-clone-description" class="text-xs">Description <span class="font-normal text-muted-foreground">(optional)</span></Label>
              <Input
                id="voice-lab-clone-description"
                v-model="cloneDescription"
                class="h-8 text-xs"
                placeholder="Calm, low, documentary"
                :maxlength="LIMITS.descriptionMax"
              />
            </div>
          </div>

          <div class="grid gap-1.5">
            <div class="flex items-center justify-between gap-2">
              <Label class="text-xs">Voice samples</Label>
              <Button size="xs" variant="ghost" :disabled="!assets.projectId" @click="fileInput?.click()"><Upload /> Import recordings…</Button>
              <input ref="fileInput" type="file" multiple accept="audio/*,video/*" class="hidden" @change="onFiles" />
            </div>
            <div v-if="samples.length > 6" class="relative">
              <Search class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input v-model="sampleQuery" placeholder="Filter by name" class="h-7 pl-7 text-xs" />
            </div>
            <!-- inline-size containment: long names truncate instead of widening the dialog's grid -->
            <ScrollArea class="h-44 rounded-md border [contain:inline-size]">
              <div v-if="!samples.length" class="p-4 text-center text-xs text-muted-foreground">
                No audio (or video with sound) in this project yet — import a recording of the voice.
              </div>
              <div v-else-if="!visibleSamples.length" class="p-4 text-center text-xs text-muted-foreground">No matches.</div>
              <div v-else class="p-1">
                <label
                  v-for="s in visibleSamples"
                  :key="s.asset.id"
                  :class="
                    cn(
                      'flex items-center gap-2 rounded px-2 py-1.5',
                      s.usable && (isSelected(s.asset.id) || !atLimit) ? 'cursor-pointer hover:bg-accent' : 'opacity-50',
                    )
                  "
                >
                  <Checkbox
                    :model-value="s.usable && isSelected(s.asset.id)"
                    :disabled="!s.usable || (!isSelected(s.asset.id) && atLimit)"
                    @update:model-value="(v) => setSelected(s.asset.id, v === true)"
                  />
                  <AudioLines v-if="s.asset.kind === 'audio'" class="size-3.5 shrink-0 text-role-dialogue" />
                  <Video v-else class="size-3.5 shrink-0 text-role-video" />
                  <span class="min-w-0 flex-1 truncate text-xs" :title="s.asset.name">{{ s.asset.name }}</span>
                  <span v-if="s.note" class="shrink-0 text-[10px] text-muted-foreground">{{ s.note }}</span>
                  <span class="shrink-0 text-[10px] text-muted-foreground tabular">{{ formatDuration(s.seconds) }}</span>
                </label>
              </div>
            </ScrollArea>
            <p :class="cn('text-[11px]', hint.warn ? 'text-role-effects' : 'text-muted-foreground')">
              {{ hint.text }}<template v-if="atLimit"> Up to {{ LIMITS.cloneFilesMax }} samples.</template>
            </p>
          </div>

          <label class="flex cursor-pointer items-start gap-2 text-xs">
            <Checkbox class="mt-px" :model-value="removeNoise" @update:model-value="(v) => (removeNoise = v === true)" />
            <span class="grid gap-0.5">
              <span>Remove background noise</span>
              <span class="text-[11px] text-muted-foreground">Only for noisy recordings — it can make clean audio sound worse.</span>
            </span>
          </label>

          <label class="flex cursor-pointer items-start gap-2 rounded-md border border-dashed p-2.5 text-xs">
            <Checkbox class="mt-px" :model-value="consent" @update:model-value="(v) => (consent = v === true)" />
            <span>I own this voice or have the speaker’s permission to clone it.</span>
          </label>

          <p v-if="cloneError" class="text-[11px] text-destructive">{{ cloneError }}</p>

          <div class="flex items-center justify-between gap-2">
            <span class="text-[11px] text-muted-foreground">Instant Voice Cloning needs an ElevenLabs Starter plan or above.</span>
            <Button size="sm" class="shrink-0" :disabled="!canClone" @click="clone">
              <Loader2 v-if="cloning" class="animate-spin" />
              <Mic v-else />
              {{ cloning ? 'Cloning…' : 'Clone voice' }}
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </DialogContent>
  </Dialog>
</template>
