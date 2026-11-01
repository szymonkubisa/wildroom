<script setup lang="ts">
import { ArrowRight, CheckCircle2, ChevronDown, ExternalLink, KeyRound, Loader2, XCircle } from '@lucide/vue'
import type { CredentialField, ProviderStatus, ProviderTestResult } from '@shared/types/api'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { useConfirm } from '@/components/app/useConfirm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings'
import type { ProviderMeta } from './providers'

/** `focus`: changes when this card was asked for (Generate's "Add key"): it opens and scrolls into view. */
const props = defineProps<{ meta: ProviderMeta; status?: ProviderStatus; focus?: number }>()
/** The RunPod card's link to its options (Settings › GPU). */
const emit = defineEmits<{ gpu: [] }>()
const root = ref<HTMLElement>()
const settings = useSettingsStore()
const confirm = useConfirm()

const drafts = reactive<Partial<Record<CredentialField, string>>>({})
const saving = ref(false)
const testing = ref(false)
const result = ref<ProviderTestResult>()
// Providers that still need a key start expanded (status may arrive after mount; a manual toggle wins).
const open = ref(!props.status?.configured)
let toggled = false
watch(
  () => props.status?.configured,
  (configured) => {
    if (!toggled && configured !== undefined) open.value = !configured
  },
)
function toggle() {
  toggled = true
  open.value = !open.value
}
watch(
  () => props.focus,
  async (focus) => {
    if (!focus) return
    toggled = true
    open.value = true
    await nextTick()
    root.value?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    root.value?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
  },
  { immediate: true },
)

const ACCENTS: Record<string, string> = {
  elevenlabs: 'oklch(0.3 0.01 286)',
  kling: 'oklch(0.58 0.17 258)',
  fal: 'oklch(0.6 0.22 292)',
  anthropic: 'oklch(0.66 0.14 50)',
  local: 'oklch(0.6 0.13 165)',
  runpod: 'oklch(0.55 0.2 300)',
}
const accent = computed(() => ACCENTS[props.meta.id] ?? 'var(--brand)')

const dirty = computed(() => Object.values(drafts).some((v) => v && v.trim()))
// Local models have no key: the card shows whether they are installed instead.
const keyless = computed(() => props.meta.fields.length === 0)

async function recheck() {
  toggled = true
  await settings.load()
  await test()
}

async function save() {
  // Saving flips `configured`, which would collapse the card and hide the connection test below: the user is working
  // here, so it stays open.
  toggled = true
  saving.value = true
  try {
    const payload: Partial<Record<CredentialField, string>> = {}
    for (const [k, v] of Object.entries(drafts)) if (v && v.trim()) payload[k as CredentialField] = v.trim()
    await api.settings.saveProvider(props.meta.id, payload)
    for (const k of Object.keys(drafts)) delete drafts[k as CredentialField]
    await settings.load()
    toast.success(`${props.meta.name} key saved to Keychain`)
    await test()
  } catch (err) {
    toast.error('Could not save key', { description: errorMessage(err) })
  } finally {
    saving.value = false
  }
}

async function removeField(field: CredentialField) {
  const label = props.meta.fields.find((f) => f.field === field)?.label ?? 'key'
  if (!(await confirm({ title: `Remove the ${props.meta.name} ${label} from Keychain?`, confirmText: 'Remove', destructive: true }))) return
  toggled = true
  try {
    await api.settings.saveProvider(props.meta.id, { [field]: null })
    await settings.load()
    result.value = undefined
  } catch (err) {
    toast.error('Could not remove key', { description: errorMessage(err) })
  }
}

async function test() {
  toggled = true
  testing.value = true
  try {
    result.value = await api.settings.testProvider(props.meta.id)
  } catch (err) {
    result.value = { ok: false, message: errorMessage(err) }
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <div ref="root" :class="cn('scroll-mt-3 overflow-hidden rounded-xl bg-card transition-shadow', focus && 'ring-2 ring-brand/50')" :data-provider="meta.id">
    <button type="button" class="flex w-full items-center gap-3 p-3.5 text-left hover:bg-accent/40" @click="toggle">
      <div class="flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white" :style="{ background: accent }">
        {{ meta.name.charAt(0) }}
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 text-sm font-medium">
          {{ meta.name }}
          <span v-if="status?.configured" class="flex items-center gap-1 rounded-full bg-role-music/15 px-2 py-px text-[10px] font-medium text-role-music">
            <span class="size-1.5 rounded-full bg-role-music" /> {{ keyless ? 'Installed' : 'Connected' }}
          </span>
          <span v-else class="rounded-full bg-muted px-2 py-px text-[10px] text-muted-foreground">{{ keyless ? 'Not installed' : 'Not connected' }}</span>
        </div>
        <div class="truncate text-xs text-muted-foreground" :title="meta.tagline">{{ meta.tagline }}</div>
      </div>
      <ChevronDown :class="cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')" />
    </button>

    <div v-if="open" class="grid gap-4 border-t border-border p-4">
      <div v-for="f in meta.fields" :key="f.field" class="grid gap-1.5">
        <Label :for="`${meta.id}-${f.field}`" class="text-xs">{{ f.label }}</Label>
        <div class="flex gap-2">
          <div class="relative flex-1">
            <KeyRound class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              :id="`${meta.id}-${f.field}`"
              v-model="drafts[f.field]"
              :type="f.plain ? 'text' : 'password'"
              autocomplete="off"
              class="h-8 pl-8 font-mono text-xs"
              :placeholder="status?.fields[f.field]?.set ? `Saved (${status.fields[f.field]?.hint}) — type to replace` : f.placeholder"
              @keydown.enter="dirty && save()"
            />
          </div>
          <Button v-if="status?.fields[f.field]?.set" variant="ghost" size="sm" class="text-muted-foreground hover:text-destructive" @click="removeField(f.field)">
            Remove
          </Button>
        </div>
        <p v-if="f.help" class="text-[11px] text-muted-foreground">{{ f.help }}</p>
      </div>
      <p v-if="keyless && status?.detail && !result" :class="cn('rounded-lg px-3 py-2 font-mono text-[11px] break-all', status.configured ? 'bg-role-music/10 text-role-music' : 'bg-muted/60 text-muted-foreground')">
        {{ status.detail }}
      </p>
      <button
        v-if="meta.id === 'runpod' && status?.configured"
        type="button"
        class="flex items-center gap-1.5 justify-self-start text-xs text-brand hover:underline"
        @click="emit('gpu')"
      >
        Volume, GPUs and when to stop: Settings › GPU <ArrowRight class="size-3.5" />
      </button>
      <p v-if="meta.note" class="rounded-lg bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground">{{ meta.note }}</p>
      <div class="flex flex-wrap items-center gap-2">
        <template v-if="keyless">
          <Button size="sm" variant="outline" :disabled="testing" @click="recheck">
            <Loader2 v-if="testing" class="animate-spin" /> Check installation
          </Button>
        </template>
        <template v-else>
          <Button size="sm" class="bg-brand text-brand-foreground hover:bg-brand/90" :disabled="!dirty || saving" @click="save">
            <Loader2 v-if="saving" class="animate-spin" /> Save to Keychain
          </Button>
          <Button size="sm" variant="outline" :disabled="!status?.configured || testing" @click="test">
            <Loader2 v-if="testing" class="animate-spin" /> Test connection
          </Button>
        </template>
        <Button as="a" :href="meta.keysUrl" target="_blank" rel="noreferrer" variant="ghost" size="sm" class="ml-auto text-muted-foreground">
          {{ keyless ? 'Model page' : 'Get a key' }} <ExternalLink />
        </Button>
      </div>
      <div
        v-if="result"
        :class="cn('flex min-w-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs', result.ok ? 'bg-role-music/10 text-role-music' : 'bg-destructive/10 text-destructive')"
      >
        <CheckCircle2 v-if="result.ok" class="size-3.5 shrink-0" />
        <XCircle v-else class="size-3.5 shrink-0" />
        <span class="min-w-0 truncate">{{ result.message }}</span>
        <span v-if="result.credits" class="shrink-0 text-muted-foreground">
          · {{ result.credits.label }}:
          <template v-if="result.credits.remaining != null">{{ result.credits.remaining.toLocaleString() }}</template>
          <template v-if="result.credits.limit != null"> / {{ result.credits.limit.toLocaleString() }}</template>
          {{ result.credits.unit }}
        </span>
      </div>
    </div>
  </div>
</template>
