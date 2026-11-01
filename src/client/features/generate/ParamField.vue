<script setup lang="ts">
import { ChevronDown, Dices, Loader2, Sparkles, Video, X } from '@lucide/vue'
import type { ModelSpec, ParamDef } from '@shared/models/types'
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import KlingElementsPicker from '@/features/story/KlingElementsPicker.vue'
import AssetSlot from './AssetSlot.vue'
import DialogueLines from './DialogueLines.vue'
import OpenRouterImagePicker from './OpenRouterImagePicker.vue'
import VoicePicker from './VoicePicker.vue'
import CameraMovePreview from './CameraMovePreview.vue'
import CameraPresetPicker from './CameraPresetPicker.vue'
import { CAMERA_FAMILY_LABELS, cameraFamily, cameraMatch, withCamera } from './camera'

const props = defineProps<{
  param: ParamDef
  error?: string
  enhance?: () => Promise<void>
  camera?: boolean
  /** The selected model, so camera moves are worded in its own vocabulary. */
  cameraModel?: ModelSpec
}>()
const enhancing = ref(false)

async function runEnhance() {
  if (!props.enhance || enhancing.value) return
  enhancing.value = true
  try {
    await props.enhance()
  } finally {
    enhancing.value = false
  }
}
const model = defineModel<unknown>()

const ui = computed(() => props.param.ui)
const isNumeric = computed(() => typeof props.param.default === 'number' || ui.value.options?.some((o) => typeof o.value === 'number'))
const id = computed(() => `param-${props.param.key}`)

// Select/ToggleGroup work with strings; map back to numbers for numeric options.
const stringValue = computed({
  get: () => (model.value == null ? '' : String(model.value)),
  set: (v: string) => {
    if (v === '' || v == null) return
    model.value = isNumeric.value ? Number(v) : v
  },
})

const images = computed<string[]>(() => (Array.isArray(model.value) ? (model.value as string[]) : []))

function setImage(index: number, value: string | undefined) {
  const next = [...images.value]
  if (value) next[index] = value
  else next.splice(index, 1)
  model.value = next.filter(Boolean)
}

const activeCamera = computed(() => cameraMatch(String(model.value ?? '')))
const cameraOpen = ref(false)
const cameraHover = ref(false)
const cameraPicker = ref<InstanceType<typeof CameraPresetPicker>>()
/** On open, focus the applied move (or just the grid) instead of the first tile, so the right preview plays. */
function focusCameraPicker(e: Event) {
  e.preventDefault()
  cameraPicker.value?.focus()
}
const cameraWording = computed(() => {
  const family = cameraFamily(props.cameraModel)
  return family ? `Worded for ${CAMERA_FAMILY_LABELS[family]}` : 'Generic wording'
})
/** Applies a move; picking the exact wording already in the prompt removes it, another wording swaps it in. */
function setCamera(phrase: string | undefined) {
  const same = phrase && activeCamera.value?.phrase.toLowerCase() === phrase.toLowerCase()
  model.value = withCamera(String(model.value ?? ''), same ? undefined : phrase)
  cameraOpen.value = false
}

function randomSeed() {
  model.value = Math.floor(Math.random() * 2_147_483_647)
}

function sliderLabel(v: unknown) {
  const n = Number(v ?? props.param.default ?? 0)
  return `${Number.isInteger(n) ? n : n.toFixed(2)}${ui.value.unit ?? ''}`
}
</script>

<template>
  <div class="grid grid-cols-[minmax(0,1fr)] gap-1.5">
    <div v-if="ui.control !== 'switch'" class="flex items-center justify-between gap-2">
      <Label :for="id" class="text-xs text-muted-foreground">{{ ui.label }}</Label>
      <span v-if="ui.control === 'slider'" class="text-xs text-muted-foreground tabular">{{ sliderLabel(model) }}</span>
      <span v-else-if="ui.control === 'prompt'" class="flex items-center gap-2">
        <button
          v-if="enhance"
          type="button"
          class="flex items-center gap-1 text-[10px] text-brand hover:underline disabled:opacity-50"
          :disabled="enhancing || !String(model ?? '').trim()"
          title="Rewrite with Claude for this model"
          @click="runEnhance"
        >
          <Loader2 v-if="enhancing" class="size-3 animate-spin" /><Sparkles v-else class="size-3" /> Enhance
        </button>
        <span v-if="typeof model === 'string'" class="text-[10px] text-muted-foreground tabular">{{ (model as string).length }}</span>
      </span>
    </div>

    <!-- One branch of the control chain: the prompt textarea and, for video, its camera chips. -->
    <template v-if="ui.control === 'prompt' || ui.control === 'textarea' || (ui.control === 'text' && param.key !== 'lines')">
      <Textarea
        :id="id"
        :model-value="(model as string) ?? ''"
        :rows="ui.control === 'prompt' ? 4 : 2"
        class="min-h-0 resize-y text-xs leading-relaxed"
        :placeholder="ui.placeholder"
        @update:model-value="(v) => (model = String(v))"
      />
      <div v-if="camera && ui.control === 'prompt'" class="flex items-center gap-1">
        <Popover v-model:open="cameraOpen">
          <PopoverTrigger as-child>
            <button
              type="button"
              class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg bg-field px-1 pr-2 text-left text-xs transition-colors hover:bg-field-hover focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
              :aria-label="activeCamera ? `Camera move: ${activeCamera.preset.label}. Change` : 'Add a camera move'"
              @mouseenter="cameraHover = true"
              @mouseleave="cameraHover = false"
            >
              <CameraMovePreview v-if="activeCamera" :preset-id="activeCamera.preset.id" :size="36" :playing="cameraHover && !cameraOpen" />
              <span v-else class="grid h-[20px] w-9 shrink-0 place-items-center rounded-[5px] bg-muted"><Video class="size-3 text-muted-foreground" /></span>
              <span v-if="activeCamera" class="truncate">Camera: <span class="font-medium">{{ activeCamera.preset.label }}</span></span>
              <span v-else class="truncate text-muted-foreground">Camera move</span>
              <ChevronDown class="ml-auto size-3.5 shrink-0 opacity-50" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" class="w-[22rem] p-2.5" @open-auto-focus="focusCameraPicker">
            <div class="mb-2 flex items-baseline justify-between gap-2">
              <span class="text-xs font-medium">Camera move</span>
              <span class="text-[10px] text-muted-foreground">{{ cameraWording }}</span>
            </div>
            <CameraPresetPicker ref="cameraPicker" :model="cameraModel" :active="activeCamera?.preset.id" :active-phrase="activeCamera?.phrase" @select="(phrase) => setCamera(phrase)" />
          </PopoverContent>
        </Popover>
        <Button v-if="activeCamera" variant="ghost" size="icon-sm" type="button" aria-label="Remove camera move" title="Remove camera move" @click="setCamera(undefined)">
          <X />
        </Button>
      </div>
    </template>

    <DialogueLines v-else-if="param.key === 'lines'" v-model="model as never" />

    <Select v-else-if="ui.control === 'select'" v-model="stringValue">
      <SelectTrigger :id="id" class="h-8 w-full text-xs"><SelectValue :placeholder="ui.placeholder ?? 'Choose'" /></SelectTrigger>
      <SelectContent>
        <SelectItem v-for="o in ui.options" :key="String(o.value)" :value="String(o.value)" class="text-xs">{{ o.label }}</SelectItem>
      </SelectContent>
    </Select>

    <ToggleGroup
      v-else-if="ui.control === 'segmented'"
      type="single"
      variant="outline"
      size="sm"
      class="w-full"
      :model-value="stringValue"
      @update:model-value="(v) => v && (stringValue = String(v))"
    >
      <ToggleGroupItem v-for="o in ui.options" :key="String(o.value)" :value="String(o.value)" class="h-7 flex-1 text-xs">
        {{ o.label }}
      </ToggleGroupItem>
    </ToggleGroup>

    <Slider
      v-else-if="ui.control === 'slider'"
      :model-value="[Number(model ?? param.default ?? ui.min ?? 0)]"
      :min="ui.min"
      :max="ui.max"
      :step="ui.step"
      class="py-1"
      @update:model-value="(v) => v && (model = v[0])"
    />

    <Input
      v-else-if="ui.control === 'number'"
      :id="id"
      type="number"
      class="h-8 text-xs"
      :min="ui.min"
      :max="ui.max"
      :model-value="(model as number) ?? ''"
      @update:model-value="(v) => (model = v === '' ? undefined : Number(v))"
    />

    <div v-else-if="ui.control === 'seed'" class="flex gap-1.5">
      <Input
        :id="id"
        type="number"
        class="h-8 text-xs"
        placeholder="Random"
        :model-value="(model as number) ?? ''"
        @update:model-value="(v) => (model = v === '' ? undefined : Number(v))"
      />
      <Button variant="outline" size="icon-sm" type="button" @click="randomSeed"><Dices /></Button>
    </div>

    <div v-else-if="ui.control === 'switch'" class="flex items-center justify-between gap-2">
      <Label :for="id" class="text-xs">{{ ui.label }}</Label>
      <Switch :id="id" :model-value="Boolean(model)" @update:model-value="(v) => (model = v)" />
    </div>

    <AssetSlot v-else-if="ui.control === 'image'" v-model="model as string | undefined" kind="image" :label="ui.label" />
    <AssetSlot v-else-if="ui.control === 'video'" v-model="model as string | undefined" kind="video" :label="ui.label" compact />
    <AssetSlot v-else-if="ui.control === 'audio'" v-model="model as string | undefined" kind="audio" :label="ui.label" compact />

    <div v-else-if="ui.control === 'images'" class="grid grid-cols-2 gap-1.5">
      <AssetSlot
        v-for="(img, i) in [...images, undefined].slice(0, ui.maxItems ?? 4)"
        :key="i"
        :model-value="img"
        kind="image"
        :label="`Ref ${i + 1}`"
        compact
        @update:model-value="(v) => setImage(i, v)"
      />
    </div>

    <VoicePicker v-else-if="ui.control === 'voice'" v-model="model as string | undefined" />

    <KlingElementsPicker v-else-if="ui.control === 'elements'" v-model="model as string[] | undefined" :max-items="ui.maxItems" />

    <OpenRouterImagePicker v-else-if="ui.control === 'openrouterImageModel'" v-model="model as string | undefined" />

    <p v-if="error" class="text-[11px] text-destructive">{{ error }}</p>
    <p v-else-if="ui.help" class="text-[11px] text-muted-foreground">{{ ui.help }}</p>
  </div>
</template>
