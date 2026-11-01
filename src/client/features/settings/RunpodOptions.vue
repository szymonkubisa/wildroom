<script setup lang="ts">
import { CheckCircle2, HardDrive, KeyRound, Loader2, Plus, RefreshCw, Wrench } from '@lucide/vue'
import {
  type GpuAvailability,
  IDLE_STOP_CHOICES,
  LTX_GPUS,
  RECOMMENDED_VOLUME_GB,
  type RunpodAccountDTO,
  type RunpodDatacenterDTO,
  type RunpodSettings,
  type RunpodVolumeDTO,
  VOLUME_USD_PER_GB_MONTH,
  idleText,
} from '@shared/types/runpod'
import { computed, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
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
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useGpuStore } from '@/stores/gpu'
import { useSettingsStore } from '@/stores/settings'

/** RunPod options under the provider card: the network volume, which GPUs to rent, when to stop. */
const settings = useSettingsStore()
const runpod = computed(() => settings.app?.runpod)

const volumes = ref<RunpodVolumeDTO[]>()
const account = ref<RunpodAccountDTO>()
const loading = ref(false)
const loadError = ref<string>()

async function refresh() {
  loading.value = true
  loadError.value = undefined
  try {
    const [v, a] = await Promise.all([api.gpu.volumes(), api.gpu.account().catch(() => undefined)])
    volumes.value = v
    account.value = a
  } catch (err) {
    loadError.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}
onMounted(refresh)

const selected = computed(() => volumes.value?.find((v) => v.id === runpod.value?.volumeId))

// ---------------------------------------------------------------- preparing the volume

const gpu = useGpuStore()
onMounted(() => void gpu.load())
const hfDraft = ref('')
const setupConfirm = ref(false)
const setupRunning = computed(() => gpu.setup.state === 'creating' || gpu.setup.state === 'running')
const setupForThis = computed(() => gpu.setup.volumeId === runpod.value?.volumeId)
// A finished setup marks the volume prepared on the server: show it.
watch(
  () => gpu.setup.state,
  (state) => {
    if (state === 'done') void refresh()
  },
)

async function prepare() {
  setupConfirm.value = false
  await gpu.startSetup(hfDraft.value.trim() || undefined)
  hfDraft.value = ''
}

async function patch(next: Partial<RunpodSettings>) {
  if (!runpod.value) return
  try {
    await settings.update({ runpod: { ...runpod.value, ...next } })
  } catch (err) {
    toast.error('Could not save RunPod settings', { description: errorMessage(err) })
  }
}

// ---------------------------------------------------------------- new volume

const creating = ref(false)
const datacenters = ref<RunpodDatacenterDTO[]>()
const draft = ref({ name: 'ltx-models', sizeGb: RECOMMENDED_VOLUME_GB, dataCenter: '' })
const confirmOpen = ref(false)
const submitting = ref(false)

const RANK: Record<GpuAvailability, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, NONE: 0 }
/** Data centers that stock the first GPU in the list come first, then by overall stock. */
const sortedDatacenters = computed(() => {
  const first = runpod.value?.gpuIds[0]
  const score = (dc: RunpodDatacenterDTO) =>
    (RANK[dc.gpus.find((g) => g.id === first)?.availability ?? 'NONE'] ?? 0) * 100 + dc.gpus.reduce((sum, g) => sum + RANK[g.availability], 0)
  // Half-price standard storage counts like one more well-stocked GPU.
  const cheap = (dc: RunpodDatacenterDTO) => (dc.volumeType === 'STANDARD' ? 3 : 0)
  return [...(datacenters.value ?? [])].filter((dc) => dc.gpus.length).sort((a, b) => score(b) + cheap(b) - (score(a) + cheap(a)))
})
const draftDc = computed(() => datacenters.value?.find((dc) => dc.id === draft.value.dataCenter))
const perGb = computed(() => draftDc.value?.volumeUsdPerGbMonth ?? VOLUME_USD_PER_GB_MONTH)
const monthly = computed(() => (draft.value.sizeGb * perGb.value).toFixed(2))

async function startCreate() {
  creating.value = true
  if (!datacenters.value) {
    try {
      datacenters.value = await api.gpu.datacenters()
      draft.value.dataCenter = sortedDatacenters.value[0]?.id ?? ''
    } catch (err) {
      toast.error('Could not load RunPod data centers', { description: errorMessage(err) })
    }
  }
}

async function createVolume() {
  submitting.value = true
  try {
    const volume = await api.gpu.createVolume({ ...draft.value, sizeGb: Math.round(draft.value.sizeGb), type: draftDc.value?.volumeType })
    confirmOpen.value = false
    creating.value = false
    await patch({ volumeId: volume.id })
    await refresh()
    toast.success(`Volume “${volume.name}” created in ${volume.dataCenter}`)
  } catch (err) {
    toast.error('Could not create the volume', { description: errorMessage(err) })
  } finally {
    submitting.value = false
  }
}

const availabilityLabel = (a: GpuAvailability) => ({ HIGH: 'plenty', MEDIUM: 'some', LOW: 'few', NONE: 'none' })[a]

// ---------------------------------------------------------------- GPUs

function toggleGpu(id: string, on: boolean) {
  const current = runpod.value?.gpuIds ?? []
  const next = on ? LTX_GPUS.map((g) => g.id).filter((g) => g === id || current.includes(g)) : current.filter((g) => g !== id)
  if (!next.length) return toast.info('Keep at least one GPU')
  void patch({ gpuIds: next })
}
</script>

<template>
  <div v-if="runpod" class="grid min-w-0 gap-4 rounded-lg border border-border p-3">
    <div class="flex items-center gap-2">
      <HardDrive class="size-4 text-muted-foreground" />
      <span class="text-xs font-medium">Model volume</span>
      <span v-if="account?.balanceUsd != null" class="ml-auto text-[11px] text-muted-foreground">Balance ${{ account.balanceUsd.toFixed(2) }}</span>
      <Button variant="ghost" size="icon" class="size-6" :class="account?.balanceUsd == null && 'ml-auto'" :disabled="loading" title="Refresh" @click="refresh">
        <RefreshCw :class="cn('size-3.5', loading && 'animate-spin')" />
      </Button>
    </div>

    <p v-if="loadError" class="rounded-lg bg-destructive/10 px-3 py-2 text-[11px] text-destructive">{{ loadError }}</p>

    <template v-else-if="volumes">
      <div v-if="volumes.length" class="grid gap-1.5">
        <Select :model-value="runpod.volumeId || undefined" @update:model-value="(v) => patch({ volumeId: String(v) })">
          <SelectTrigger class="h-8 w-full text-xs"><SelectValue placeholder="Choose the volume with the models" /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="v in volumes" :key="v.id" :value="v.id">{{ v.name }} · {{ v.sizeGb }} GB · {{ v.dataCenter }}</SelectItem>
          </SelectContent>
        </Select>
        <p class="text-[11px] text-muted-foreground">
          <template v-if="selected">GPUs start in {{ selected.dataCenter }}, where this volume lives.</template>
          <template v-else>The models live on a network volume; GPUs start in its data center.</template>
        </p>
      </div>

      <div v-if="selected" class="grid gap-2 rounded-lg bg-muted/40 p-3">
        <div class="flex items-center gap-2 text-xs">
          <CheckCircle2 v-if="selected.prepared" class="size-3.5 text-role-music" />
          <Wrench v-else class="size-3.5 text-muted-foreground" />
          <span class="font-medium">{{ selected.prepared ? 'Ready for LTX-2.5' : 'Not prepared yet' }}</span>
        </div>
        <template v-if="setupRunning && setupForThis">
          <div class="flex items-center gap-2 text-[11px]">
            <Loader2 class="size-3.5 animate-spin" />
            <span>
              <template v-if="gpu.setup.step">Step {{ gpu.setup.step }}/{{ gpu.setup.totalSteps }} — </template>{{ gpu.setup.title }}
            </span>
          </div>
          <div v-if="gpu.setup.step && gpu.setup.totalSteps" class="h-1 overflow-hidden rounded bg-muted">
            <div class="h-full bg-brand transition-all" :style="{ width: `${(gpu.setup.step / gpu.setup.totalSteps) * 100}%` }" />
          </div>
          <pre v-if="gpu.setup.lines.length" class="max-h-28 overflow-y-auto rounded bg-background/60 p-2 font-mono text-[10px] whitespace-pre-wrap text-muted-foreground">{{ gpu.setup.lines.join('\n') }}</pre>
          <p class="text-[11px] text-muted-foreground">
            On {{ gpu.setup.gpuName }} (${{ gpu.setup.costPerHrUsd?.toFixed(2) }}/h). The models are ~113 GB: this takes a while. You can close Settings.
          </p>
          <div><Button size="sm" variant="ghost" class="text-destructive" @click="gpu.cancelSetup()">Stop setup</Button></div>
        </template>
        <template v-else>
          <p v-if="gpu.setup.state === 'failed' && setupForThis" class="rounded bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">{{ gpu.setup.error }}</p>
          <p class="text-[11px] text-muted-foreground">
            {{ selected.prepared ? 'Run it again to update ComfyUI, the nodes and the models.' : 'Installs ComfyUI, the LTX-2.5 nodes and ~113 GB of models onto the volume, once.' }}
            It rents a cheap CPU machine there (a GPU if none is free) for ~20–40 min, usually under $0.50, and stops it when done.
          </p>
          <div class="grid gap-1.5">
            <Label class="text-xs">Hugging Face token</Label>
            <div class="relative">
              <KeyRound class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                v-model="hfDraft"
                type="password"
                autocomplete="off"
                class="h-8 pl-8 font-mono text-xs"
                :placeholder="gpu.hfToken.set ? `Saved (${gpu.hfToken.hint}) — type to replace` : 'hf_…'"
              />
            </div>
            <p class="text-[11px] text-muted-foreground">
              Read token from an account that accepted the
              <a href="https://huggingface.co/Lightricks/LTX-2.5" target="_blank" rel="noreferrer" class="underline">LTX-2.5 licence</a>. Saved to Keychain; sent only to the setup pod.
            </p>
          </div>
          <div>
            <Button size="sm" variant="outline" :disabled="!gpu.hfToken.set && !hfDraft.trim()" @click="setupConfirm = true">
              <Wrench /> {{ selected.prepared ? 'Update volume' : 'Prepare volume' }}
            </Button>
          </div>
        </template>
      </div>
      <p v-if="!volumes.length" class="text-[11px] text-muted-foreground">No network volume yet. Create one for the LTX-2.5 models (~{{ RECOMMENDED_VOLUME_GB }} GB).</p>
      <p v-else-if="!selected" class="rounded bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
        Choose the volume above: preparing it (with your Hugging Face token) appears here.
      </p>

      <div v-if="!creating">
        <Button size="sm" variant="outline" @click="startCreate"><Plus /> New volume</Button>
      </div>
      <div v-else class="grid gap-3 rounded-lg bg-muted/40 p-3">
        <div class="grid gap-1.5">
          <Label class="text-xs">Data center</Label>
          <Select v-model="draft.dataCenter">
            <SelectTrigger class="h-8 w-full text-xs"><SelectValue placeholder="Loading…" /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="dc in sortedDatacenters" :key="dc.id" :value="dc.id">
                {{ dc.id }} — {{ dc.gpus.slice(0, 3).map((g) => `${g.name}: ${availabilityLabel(g.availability)}`).join(', ') }}
                <template v-if="dc.volumeType === 'HIGH_PERFORMANCE'"> · storage ${{ dc.volumeUsdPerGbMonth }}/GB</template>
              </SelectItem>
            </SelectContent>
          </Select>
          <p class="text-[11px] text-muted-foreground">Pick one that stocks your first-choice GPU: every pod will start there.</p>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-1.5">
            <Label class="text-xs">Name</Label>
            <Input v-model="draft.name" class="h-8 text-xs" />
          </div>
          <div class="grid gap-1.5">
            <Label class="text-xs">Size (GB)</Label>
            <Input v-model.number="draft.sizeGb" type="number" min="10" max="4096" class="h-8 text-xs" />
          </div>
        </div>
        <p class="text-[11px] text-muted-foreground">
          ≈ ${{ monthly }} per month (${{ perGb }}/GB{{ draftDc?.volumeType === 'HIGH_PERFORMANCE' ? ', high-performance only there' : '' }}), billed for as long as the volume exists. It can grow later, never shrink.
          {{ RECOMMENDED_VOLUME_GB }} GB holds both LTX-2.5 weight sets, the LoRAs and ComfyUI.
        </p>
        <div class="flex gap-2">
          <Button size="sm" class="bg-brand text-brand-foreground hover:bg-brand/90" :disabled="!draft.dataCenter || !draft.name || draft.sizeGb < 10" @click="confirmOpen = true">
            Create volume
          </Button>
          <Button size="sm" variant="ghost" @click="creating = false">Cancel</Button>
        </div>
      </div>
    </template>
    <Loader2 v-else class="size-4 animate-spin text-muted-foreground" />

    <div class="grid gap-1.5">
      <span class="text-xs font-medium">GPUs to rent</span>
      <p class="text-[11px] text-muted-foreground">Tried in this order. When none of them is free, the app asks before renting another card.</p>
      <label v-for="g in LTX_GPUS" :key="g.id" class="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-xs hover:bg-accent/40">
        <Checkbox :model-value="runpod.gpuIds.includes(g.id)" @update:model-value="(v) => toggleGpu(g.id, v === true)" />
        <span class="w-28 shrink-0">{{ g.name }}</span>
        <span class="w-14 shrink-0 text-muted-foreground">{{ g.vramGb }} GB</span>
        <span class="w-10 shrink-0 text-muted-foreground">{{ g.precision }}</span>
        <span class="w-16 shrink-0 text-muted-foreground">${{ g.priceUsdHr.toFixed(2) }}/h</span>
        <span class="min-w-0 truncate text-[11px] text-muted-foreground" :title="g.note">{{ g.note }}</span>
      </label>
    </div>

    <div class="grid gap-1.5">
      <span class="text-xs font-medium">Stop the GPU after</span>
      <ToggleGroup
        type="single"
        :model-value="String(runpod.idleSeconds)"
        class="justify-start"
        @update:model-value="(v) => v && patch({ idleSeconds: Number(v) })"
      >
        <ToggleGroupItem v-for="s in IDLE_STOP_CHOICES" :key="s" :value="String(s)" class="h-7 px-3 text-xs">{{ idleText(s) }}</ToggleGroupItem>
      </ToggleGroup>
      <p class="text-[11px] text-muted-foreground">
        …once the queue is empty (nothing rendering or waiting); “Keep on” holds it longer. Billing is per second; each start loads the models again (a few minutes). The pod also stops itself
        after {{ runpod.maxHours }} h, or 10 min after this app stops reaching it.
      </p>
    </div>

    <AlertDialog :open="setupConfirm" @update:open="(v) => (setupConfirm = v)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Prepare “{{ selected?.name }}” for LTX-2.5?</AlertDialogTitle>
          <AlertDialogDescription>
            The app rents a cheap CPU machine in {{ selected?.dataCenter }} (or the cheapest free GPU; billed per second, usually under $1 in total),
            installs ComfyUI and downloads the models onto the volume, then stops it. If anything goes wrong it stops too; you can run it again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button class="bg-brand text-brand-foreground hover:bg-brand/90" @click="prepare">Rent a machine and prepare</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog :open="confirmOpen" @update:open="(v) => (confirmOpen = v)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Create a {{ draft.sizeGb }} GB volume in {{ draft.dataCenter }}?</AlertDialogTitle>
          <AlertDialogDescription>
            RunPod bills about ${{ monthly }} per month from your balance for as long as it exists, whether or not a GPU is running.
            You can delete it in the RunPod console.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button class="bg-brand text-brand-foreground hover:bg-brand/90" :disabled="submitting" @click="createVolume">
            <Loader2 v-if="submitting" class="animate-spin" /> Create for ${{ monthly }}/month
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
