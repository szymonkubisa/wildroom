<script setup lang="ts">
import {
  Bot,
  Brain,
  CircleDollarSign,
  Clapperboard,
  Compass,
  Cpu,
  Eye,
  FolderOpen,
  HardDrive,
  KeyRound,
  Layers,
  ListChecks,
  ListOrdered,
  Monitor,
  Moon,
  Plug,
  Server,
  SlidersHorizontal,
  Sparkles,
  Sun,
  SunMoon,
} from '@lucide/vue'
import type { ThemePreference } from '@shared/types/api'
import { LLM_ROUTES, type LlmRoute } from '@shared/types/llm'
import { type Component, computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import TextModelPicker from '@/features/director/TextModelPicker.vue'
import { ROUTE_LABELS, useTextModels } from '@/features/director/textModels'
import StoryModels from '@/features/story/StoryModels.vue'
import { ALL_FEATURES } from '@/features/guide/catalog'
import { api, errorMessage } from '@/lib/api'
import { chooseFolderPath } from '@/lib/desktop'
import { formatBytes } from '@/lib/format'
import { applyTheme, themePreference } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings'
import { useTourStore } from '@/stores/tour'
import McpConnect from './McpConnect.vue'
import ProviderCard from './ProviderCard.vue'
import { PROVIDER_META } from './providers'
import RunpodOptions from './RunpodOptions.vue'
import type { SettingsRow } from './settingsIndex'
import { useSettingsSheet } from './settingsSheet'

/** One setting in Settings, by its row id: its icon, label and description (from the row) and its control. */
const props = defineProps<{ row: SettingsRow; cacheBytes?: number }>()
const emit = defineEmits<{ clearedCache: [bytes: number] }>()

const router = useRouter()
const settings = useSettingsStore()
const sheet = useSettingsSheet()
const tour = useTourStore()

const ICONS: Record<string, { icon: Component; tone: string }> = {
  theme: { icon: SunMoon, tone: 'bg-brand/20 text-brand' },
  demo: { icon: Sparkles, tone: 'bg-role-effects/20 text-role-effects' },
  'cloud-one': { icon: ListOrdered, tone: 'bg-role-video/20 text-role-video' },
  ffmpeg: { icon: SlidersHorizontal, tone: 'bg-role-music/20 text-role-music' },
  'plan-models': { icon: Clapperboard, tone: 'bg-brand/20 text-brand' },
  'models-defaults': { icon: Layers, tone: 'bg-muted text-muted-foreground' },
  'director-model': { icon: Brain, tone: 'bg-brand/20 text-brand' },
  'director-route': { icon: KeyRound, tone: 'bg-role-dialogue/20 text-role-dialogue' },
  'director-used': { icon: ListChecks, tone: 'bg-muted text-muted-foreground' },
  runpod: { icon: Server, tone: 'bg-role-effects/20 text-role-effects' },
  'mcp-enabled': { icon: Bot, tone: 'bg-brand/20 text-brand' },
  'mcp-cap': { icon: CircleDollarSign, tone: 'bg-role-dialogue/20 text-role-dialogue' },
  'mcp-connect': { icon: Plug, tone: 'bg-role-music/20 text-role-music' },
  'projects-folder': { icon: FolderOpen, tone: 'bg-role-video/20 text-role-video' },
  cache: { icon: HardDrive, tone: 'bg-role-dialogue/20 text-role-dialogue' },
  'local-models': { icon: Cpu, tone: 'bg-role-music/20 text-role-music' },
  walkthrough: { icon: Compass, tone: 'bg-brand/20 text-brand' },
  features: { icon: ListChecks, tone: 'bg-role-music/20 text-role-music' },
}
const look = computed(() => ICONS[props.row.id] ?? { icon: SlidersHorizontal, tone: 'bg-muted text-muted-foreground' })
const providerMeta = computed(() => PROVIDER_META.find((m) => m.id === props.row.provider))

const home = (path: string | undefined) => path?.replace(/^\/Users\/[^/]+/, '~') ?? ''

// ---- general
const THEMES: { id: ThemePreference; label: string; icon: typeof Sun }[] = [
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'system', label: 'System', icon: Monitor },
]

async function setTheme(value: ThemePreference) {
  applyTheme(value)
  try {
    await settings.update({ theme: value })
  } catch (err) {
    toast.error('Could not save the theme', { description: errorMessage(err) })
  }
}

async function save(patch: Parameters<typeof settings.update>[0], failure = 'Could not update settings') {
  try {
    await settings.update(patch)
    return true
  } catch (err) {
    toast.error(failure, { description: errorMessage(err) })
    return false
  }
}

const ffmpegPath = ref('')
watch(
  () => settings.app?.ffmpegPath,
  (v) => (ffmpegPath.value = v ?? ''),
  { immediate: true },
)
const ffmpegDirty = computed(() => ffmpegPath.value.trim() !== (settings.app?.ffmpegPath ?? ''))
async function saveFfmpeg() {
  if (await save({ ffmpegPath: ffmpegPath.value.trim() }, 'Could not save')) toast.success('ffmpeg path saved')
}

// ---- storage
const clearingCache = ref(false)
async function changeProjectsFolder() {
  try {
    const path = await chooseFolderPath('Where should new projects go?', settings.app?.projectsDir)
    if (!path) return
    await settings.update({ projectsDir: path })
    toast.success('New projects will be created there')
  } catch (err) {
    toast.error('Could not change the projects folder', { description: errorMessage(err) })
  }
}
async function clearCache() {
  clearingCache.value = true
  try {
    emit('clearedCache', (await api.settings.clearCache()).bytes)
    toast.success('Cache cleared', { description: 'Open projects rebuild their previews in the background.' })
  } catch (err) {
    toast.error('Could not clear the cache', { description: errorMessage(err) })
  } finally {
    clearingCache.value = false
  }
}

// ---- director
const director = useTextModels()
const ROUTE_HELP: Record<LlmRoute, string> = {
  auto: 'Claude models go to Anthropic when its key is set; any other model (or no Anthropic key) goes to OpenRouter, then to fal.ai, which can call the same OpenRouter models for text.',
  anthropic: 'Claude directly with your Anthropic key — native structured outputs and refusal fallbacks. Only Claude models.',
  openrouter: 'Your OpenRouter key, billed by OpenRouter — any model in the list, including ones that read images.',
  fal: 'OpenRouter models through fal.ai, billed to your fal key. Text only: frame analysis needs Anthropic or OpenRouter.',
}
const keyFor = (route: LlmRoute) => (route === 'auto' ? true : Boolean(settings.providers.find((p) => p.id === route)?.configured))
async function setRoute(route: LlmRoute) {
  try {
    await director.setChoice({ route })
  } catch (err) {
    toast.error('Could not change the route', { description: errorMessage(err) })
  }
}

// ---- integrations
const mcpCap = ref('')
watch(
  () => settings.app?.mcp.sessionCapUsd,
  (v) => (mcpCap.value = v === undefined ? '' : String(v)),
  { immediate: true },
)
const mcpCapValue = computed(() => (mcpCap.value.trim() === '' ? NaN : Number(mcpCap.value)))
const mcpCapDirty = computed(() => Number.isFinite(mcpCapValue.value) && mcpCapValue.value >= 0 && mcpCapValue.value !== settings.app?.mcp.sessionCapUsd)
async function saveMcpCap() {
  if (!mcpCapDirty.value || !settings.app) return
  if (await save({ mcp: { ...settings.app.mcp, sessionCapUsd: mcpCapValue.value } }, 'Could not save the cap')) toast.success('Spend cap saved')
}

const runpodConnected = computed(() => Boolean(settings.providers.find((p) => p.id === 'runpod')?.configured))

/** Leaving for another page closes the sheet over it. */
function goFeatures() {
  sheet.open = false
  void router.push({ name: 'features' })
}
function startTour() {
  sheet.open = false
  tour.start()
}
</script>

<template>
  <!-- A provider: its own card. -->
  <ProviderCard
    v-if="row.layout === 'card' && providerMeta"
    :meta="providerMeta"
    :status="settings.providers.find((p) => p.id === providerMeta!.id)"
    :focus="sheet.provider === providerMeta.id ? sheet.focus : undefined"
    @gpu="sheet.show({ tab: 'gpu' })"
  />

  <!-- A shortcut: what it does, its keys. -->
  <div v-else-if="row.layout === 'key'" class="flex items-center justify-between gap-4 px-4 py-2.5 text-sm" :data-setting="row.id">
    <span>{{ row.label }}</span>
    <Kbd class="shrink-0">{{ row.keys }}</Kbd>
  </div>

  <div v-else :class="cn('grid gap-3 p-4', row.layout === 'row' && 'sm:flex sm:items-center sm:gap-4')" :data-setting="row.id">
    <div class="flex min-w-0 flex-1 items-start gap-4">
      <div :class="cn('flex size-9 shrink-0 items-center justify-center rounded-lg', look.tone)"><component :is="look.icon" class="size-4" /></div>
      <div class="min-w-0 flex-1">
        <div class="text-sm font-medium">
          {{ row.label }}<template v-if="row.id === 'cache' && cacheBytes !== undefined"> · {{ formatBytes(cacheBytes) }}</template>
        </div>
        <div v-if="row.description" class="text-xs leading-snug text-muted-foreground">{{ row.description }}</div>
        <div v-if="row.id === 'projects-folder'" class="truncate font-mono text-xs text-muted-foreground" :title="settings.app?.projectsDir">{{ home(settings.app?.projectsDir) }}</div>
        <div v-else-if="row.id === 'cache'" class="truncate font-mono text-xs text-muted-foreground" :title="settings.app?.storage.cacheDir">{{ home(settings.app?.storage.cacheDir) }}</div>
        <div v-else-if="row.id === 'local-models'" class="truncate font-mono text-xs text-muted-foreground" :title="settings.app?.storage.modelsDir">{{ home(settings.app?.storage.modelsDir) }}</div>
      </div>
    </div>

    <!-- Controls beside the label (row) or under it (block). -->
    <!-- Under the label, lined up with it (the RunPod options use the full width). -->
    <div :class="cn('flex min-w-0 shrink-0 items-center gap-2', row.layout === 'block' && row.id !== 'runpod' && row.id !== 'mcp-connect' && 'sm:pl-[52px]')">
      <ToggleGroup
        v-if="row.id === 'theme'"
        type="single"
        size="sm"
        class="gap-0.5 rounded-lg bg-muted p-0.5"
        :model-value="themePreference"
        @update:model-value="(v) => v && setTheme(v as ThemePreference)"
      >
        <ToggleGroupItem
          v-for="t in THEMES"
          :key="t.id"
          :value="t.id"
          class="h-7 gap-1.5 rounded-md px-3 text-xs data-[state=on]:bg-brand data-[state=on]:text-brand-foreground"
        >
          <component :is="t.icon" class="size-3.5" /> {{ t.label }}
        </ToggleGroupItem>
      </ToggleGroup>
      <Switch v-else-if="row.id === 'demo'" :model-value="settings.app?.demoMode ?? false" aria-label="Demo mode" @update:model-value="(v) => save({ demoMode: v })" />
      <Switch
        v-else-if="row.id === 'cloud-one'"
        :model-value="settings.app?.cloudOneAtATime ?? true"
        aria-label="Cloud jobs one at a time"
        @update:model-value="(v) => save({ cloudOneAtATime: v })"
      />
      <Switch
        v-else-if="row.id === 'mcp-enabled'"
        :model-value="settings.app?.mcp.enabled ?? true"
        aria-label="Let Claude use the app"
        @update:model-value="(v) => settings.app && save({ mcp: { ...settings.app.mcp, enabled: v } })"
      />
      <template v-else-if="row.id === 'mcp-cap'">
        <div class="relative w-24">
          <span class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-xs text-muted-foreground">$</span>
          <Input v-model="mcpCap" inputmode="decimal" class="h-8 pl-5 text-xs tabular" aria-label="Spend cap per Claude session (USD)" @keydown.enter="saveMcpCap" />
        </div>
        <Button size="sm" :disabled="!mcpCapDirty" @click="saveMcpCap">Save</Button>
      </template>
      <div v-else-if="row.id === 'mcp-connect'" class="w-full min-w-0"><McpConnect /></div>
      <template v-else-if="row.id === 'ffmpeg'">
        <Input v-model="ffmpegPath" placeholder="Bundled ffmpeg" class="h-8 font-mono text-xs" aria-label="ffmpeg path" @keydown.enter="saveFfmpeg" />
        <Button size="sm" :disabled="!ffmpegDirty" @click="saveFfmpeg">Save</Button>
      </template>

      <div v-else-if="row.id === 'plan-models'" class="w-full max-w-sm"><StoryModels layout="stack" /></div>
      <p v-else-if="row.id === 'models-defaults'" class="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">App-wide defaults and Draft / Final quality are coming with the Composer.</p>

      <div v-else-if="row.id === 'director-model'" class="grid w-full gap-3">
        <TextModelPicker />
        <p class="text-xs leading-relaxed text-muted-foreground">
          <Eye class="inline size-3" /> marks models that read images; the others are used for writing, and frame analysis (describe media, continuity, reframe)
          falls back to Claude Opus 5.5.
        </p>
        <div class="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs">
          <Brain class="size-3.5 text-brand" /> Running now: <span class="font-medium">{{ director.label.value }}</span>
        </div>
      </div>
      <div v-else-if="row.id === 'director-route'" class="grid w-full gap-3">
        <ToggleGroup
          type="single"
          variant="outline"
          class="w-full"
          :model-value="director.choice.value.route"
          @update:model-value="(v) => v && setRoute(v as LlmRoute)"
        >
          <ToggleGroupItem v-for="r in LLM_ROUTES" :key="r" :value="r" class="h-auto min-w-0 flex-1 flex-col gap-0 py-1.5 text-xs">
            <span>{{ ROUTE_LABELS[r] }}</span>
            <span class="text-[10px] font-normal text-muted-foreground">{{ r === 'auto' ? 'best available' : keyFor(r) ? 'key set' : 'no key' }}</span>
          </ToggleGroupItem>
        </ToggleGroup>
        <p class="text-xs leading-relaxed text-muted-foreground">{{ ROUTE_HELP[director.choice.value.route] }}</p>
        <Button
          v-if="director.choice.value.route !== 'auto' && !keyFor(director.choice.value.route)"
          variant="outline"
          size="sm"
          class="justify-self-start"
          @click="sheet.show({ provider: director.choice.value.route as 'anthropic' | 'openrouter' | 'fal' })"
        >
          <KeyRound /> Add the {{ ROUTE_LABELS[director.choice.value.route] }} key
        </Button>
      </div>

      <div v-else-if="row.id === 'runpod'" class="w-full min-w-0">
        <RunpodOptions v-if="runpodConnected" />
        <div v-else class="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          Connect RunPod first: its key is in Providers.
          <Button size="sm" variant="outline" @click="sheet.show({ provider: 'runpod' })"><KeyRound /> Add the RunPod key</Button>
        </div>
      </div>

      <template v-else-if="row.id === 'projects-folder'">
        <Button variant="ghost" size="sm" @click="api.system.reveal('projects')">Show</Button>
        <Button variant="outline" size="sm" @click="changeProjectsFolder">Change…</Button>
      </template>
      <Button v-else-if="row.id === 'cache'" variant="outline" size="sm" :disabled="clearingCache" @click="clearCache">Clear cache</Button>
      <Button v-else-if="row.id === 'local-models'" variant="ghost" size="sm" @click="api.system.reveal('models')">Show</Button>

      <Button v-else-if="row.id === 'walkthrough'" size="sm" class="bg-brand text-brand-foreground hover:bg-brand/90" @click="startTour"><Compass /> Start</Button>
      <Button v-else-if="row.id === 'features'" size="sm" variant="outline" @click="goFeatures"><ListChecks /> Browse {{ ALL_FEATURES.length }}</Button>
    </div>
  </div>
</template>
