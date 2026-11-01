<script setup lang="ts">
/**
 * A cast character ↔ its Kling element (Kling's element library keeps the character's look consistent across
 * generations). Shows whether the character is synced, not synced, or stale (reference images changed since the
 * sync), and syncs it: `POST /api/kling/elements` (front image = the character's reference image, plus 1–3 extra
 * views from `refAssetIds`), then stores `{ elementId, syncedAt, sourceAssetIds }` on the character.
 */
import { CircleAlert, CircleCheck, CloudUpload, Loader2, RefreshCw } from '@lucide/vue'
import type { CreateKlingElementRequest } from '@shared/types/kling'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, errorMessage } from '@/lib/api'
import { useSettingsStore } from '@/stores/settings'
import { useStory } from './useStory'

const props = defineProps<{ characterId: string }>()

const MAX_REFERENCES = 3

const { story, update } = useStory()
const settings = useSettingsStore()
const syncing = ref(false)

const character = computed(() => story.value.characters.find((c) => c.id === props.characterId))
const frontalId = computed(() => character.value?.refAssetId)
const referenceIds = computed(() => {
  const front = frontalId.value
  return [...new Set((character.value?.refAssetIds ?? []).filter((id) => id && id !== front))].slice(0, MAX_REFERENCES)
})
/** What a sync would send now: front image first. */
const sourceIds = computed(() => (frontalId.value ? [frontalId.value, ...referenceIds.value] : []))

const status = computed<'none' | 'synced' | 'stale'>(() => {
  const kling = character.value?.kling
  if (!kling) return 'none'
  const [front, ...refs] = kling.sourceAssetIds
  const sameFront = front === frontalId.value
  const sameRefs = refs.length === referenceIds.value.length && refs.every((id) => referenceIds.value.includes(id))
  return sameFront && sameRefs ? 'synced' : 'stale'
})

const klingFields = computed(() => settings.providers.find((p) => p.id === 'kling')?.fields)
/** The element library takes the legacy AK/SK (preferred) or, per Kling's docs, the API key. */
const hasKeys = computed(() => {
  const f = klingFields.value
  return Boolean((f?.accessKey?.set && f?.secretKey?.set) || f?.apiKey?.set)
})

const blocker = computed<string | undefined>(() => {
  if (!character.value) return 'Character not found'
  if (!frontalId.value) return 'Add a reference image of the character first (a clear front view works best)'
  if (!referenceIds.value.length)
    return 'Kling elements need 2–4 views: add at least one more reference image (another angle or a close-up)'
  if (!hasKeys.value) return 'Add your Kling keys in Settings → Providers (legacy Access Key + Secret Key, or the API key)'
  return undefined
})

const statusText = computed(() => {
  const kling = character.value?.kling
  if (status.value === 'none' || !kling) return 'Not synced to Kling'
  const when = new Date(kling.syncedAt)
  const date = Number.isNaN(when.getTime()) ? '' : ` · ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
  return status.value === 'stale' ? 'Kling element out of date' : `Kling element ${kling.elementId}${date}`
})

async function sync() {
  const c = character.value
  if (!c || blocker.value || syncing.value) return
  syncing.value = true
  const request: CreateKlingElementRequest = {
    name: c.name,
    description: c.description,
    frontalAssetId: frontalId.value!,
    referenceAssetIds: referenceIds.value,
    replaceElementId: c.kling?.elementId,
  }
  try {
    const data = await api.kling.createElement(request)
    if (!data.elementId) throw new Error('Kling returned no element id')
    const kling = { elementId: data.elementId, syncedAt: new Date().toISOString(), sourceAssetIds: data.sourceAssetIds ?? sourceIds.value }
    update('Sync character to Kling', (s) => {
      const target = s.characters.find((x) => x.id === props.characterId)
      if (target) target.kling = kling
    })
    toast.success(`${c.name} is ready in Kling`, { description: 'Use the character in Kling generations to keep the look consistent.' })
  } catch (err) {
    toast.error(`Could not sync ${c.name} to Kling`, { description: errorMessage(err) })
  } finally {
    syncing.value = false
  }
}
</script>

<template>
  <div v-if="character" class="flex items-center justify-between gap-2 text-[11px]">
    <span
      class="flex min-w-0 items-center gap-1"
      :class="status === 'synced' ? 'text-foreground' : status === 'stale' ? 'text-amber-500' : 'text-muted-foreground'"
    >
      <CircleCheck v-if="status === 'synced'" class="size-3.5 shrink-0 text-emerald-500" />
      <CircleAlert v-else-if="status === 'stale'" class="size-3.5 shrink-0" />
      <span class="truncate" :title="character.kling?.elementId ? `Kling element id ${character.kling.elementId}` : undefined">{{ statusText }}</span>
    </span>
    <Tooltip :disabled="!blocker && status !== 'stale'">
      <TooltipTrigger as-child>
        <!-- Disabled buttons swallow pointer events; the wrapper keeps the tooltip working. -->
        <span class="shrink-0" :tabindex="blocker ? 0 : undefined">
          <Button size="xs" :variant="status === 'synced' ? 'ghost' : 'outline'" :disabled="Boolean(blocker) || syncing" @click="sync">
            <Loader2 v-if="syncing" class="animate-spin" />
            <RefreshCw v-else-if="status !== 'none'" />
            <CloudUpload v-else />
            {{ syncing ? 'Syncing…' : status === 'none' ? 'Sync to Kling' : 'Re-sync' }}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent class="max-w-64">
        {{ blocker ?? 'The reference images changed since the last sync — re-sync so Kling uses the new look.' }}
      </TooltipContent>
    </Tooltip>
  </div>
</template>
