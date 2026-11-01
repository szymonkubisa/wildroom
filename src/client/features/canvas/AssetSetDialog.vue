<script setup lang="ts">
import { ArrowLeft, KeyRound, Loader2, Minus, Plus, Sparkles, Trash2 } from '@lucide/vue'
import { framePreset } from '@shared/canvas/framePresets'
import { type AssetPlan, DELIVERABLES, deliverable } from '@shared/types/assetSet'
import { hasBrand } from '@shared/types/brand'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { api, errorMessage } from '@/lib/api'
import { formatUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/stores/canvas'
import { useProjectStore } from '@/stores/project'
import TextModelPicker from '@/features/director/TextModelPicker.vue'
import { brandForPlanner, planCost, resolveItem, runPlan } from './useAssetSet'

const canvas = useCanvasStore()
const project = useProjectStore()
const open = computed({ get: () => canvas.dialog === 'asset-set', set: (v) => (canvas.dialog = v ? 'asset-set' : undefined) })

const brand = computed(() => (hasBrand(project.doc.brand) ? project.doc.brand : undefined))
const brief = ref('')
const counts = ref<Record<string, number>>({})
const useBrand = ref(true)
const anchor = ref(true)
const planning = ref(false)
const plan = ref<AssetPlan>()
const via = ref('')

watch(
  open,
  (v) => {
    if (!v || plan.value) return
  if (canvas.briefDraft) {
    brief.value = canvas.briefDraft
    canvas.briefDraft = undefined
  }
  if (!brief.value) brief.value = [brand.value?.name, brand.value?.tagline, brand.value?.description].filter(Boolean).join(' — ')
  if (!Object.keys(counts.value).length) {
    const start = brand.value?.logoAssetIds.length ? ['og', 'social', 'hero'] : ['logo', 'og', 'social', 'hero']
    counts.value = Object.fromEntries(DELIVERABLES.map((d) => [d.id, start.includes(d.id) ? d.defaultCount : 0]))
    }
  },
  // Opened from the Brand workspace, the dialog mounts already open.
  { immediate: true },
)

const picked = computed(() => DELIVERABLES.filter((d) => (counts.value[d.id] ?? 0) > 0))
const itemCount = computed(() => picked.value.reduce((n, d) => n + (counts.value[d.id] ?? 0), 0))

function step(id: string, delta: number) {
  const d = deliverable(id)!
  counts.value = { ...counts.value, [id]: Math.max(0, Math.min(d.maxCount, (counts.value[id] ?? 0) + delta)) }
}

async function makePlan() {
  planning.value = true
  try {
    const res = await api.director.assetSet({
      brief: brief.value,
      deliverables: picked.value.map((d) => ({ id: d.id, count: counts.value[d.id]! })),
      brand: useBrand.value ? brandForPlanner(brand.value) : undefined,
    })
    plan.value = res.plan
    via.value = res.via === 'demo' ? 'demo templates' : `${res.model} via ${{ anthropic: 'Anthropic', openrouter: 'OpenRouter', fal: 'fal.ai' }[res.via]}`
  } catch (err) {
    toast.error('Could not plan the set', { description: errorMessage(err) })
  } finally {
    planning.value = false
  }
}

const brandForRun = computed(() => (useBrand.value ? brand.value : undefined))
const resolved = computed(() => (plan.value ? plan.value.items.map((it) => resolveItem(it, plan.value!, brandForRun.value)) : []))
const cost = computed(() => planCost(resolved.value))
const unavailable = computed(() => resolved.value.filter((r) => !r?.ready).length)

function removeItem(i: number) {
  plan.value?.items.splice(i, 1)
}

const running = ref(false)
async function generate() {
  if (!plan.value?.items.length) return
  running.value = true
  try {
    await runPlan(plan.value, { brand: brandForRun.value, anchor: anchor.value })
    open.value = false
    plan.value = undefined
  } catch (err) {
    toast.error('Could not start the set', { description: errorMessage(err) })
  } finally {
    running.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex max-h-[88vh] flex-col sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2"><Sparkles class="size-4 text-brand" /> {{ plan ? plan.title : 'Plan assets from a brief' }}</DialogTitle>
        <DialogDescription v-if="!plan">
          Describe the brand, site or campaign. The AI Director plans a matching set; each item becomes a frame of the right size on a new board, with its
          image generated inside and the copy on top as text you can edit.
        </DialogDescription>
        <DialogDescription v-else>
          Planned by {{ via }}. Edit prompts and copy, drop what you don't need, then generate.
          <span v-if="plan.style" class="mt-1 block text-foreground/80">Shared look: {{ plan.style }}</span>
        </DialogDescription>
      </DialogHeader>

      <!-- Step 1: brief -->
      <div v-if="!plan" class="grid min-h-0 gap-4 overflow-y-auto">
        <Textarea v-model="brief" rows="4" placeholder="e.g. Small-batch coffee roastery in Leeds launching a subscription. Warm, honest, a little nerdy about beans. Website + launch campaign." />
        <div class="grid gap-1.5">
          <span class="text-xs text-muted-foreground">What to make</span>
          <div class="grid gap-1.5 sm:grid-cols-2">
            <div
              v-for="d in DELIVERABLES"
              :key="d.id"
              :class="cn('flex items-center gap-2 rounded-lg border px-2.5 py-2', (counts[d.id] ?? 0) > 0 && 'border-brand/50 bg-brand/5')"
            >
              <div class="min-w-0 flex-1">
                <div class="truncate text-xs font-medium">{{ d.label }}</div>
                <div class="truncate text-[10px] text-muted-foreground">{{ d.hint }} · {{ framePreset(d.framePresetId)?.w }}×{{ framePreset(d.framePresetId)?.h }}</div>
              </div>
              <button class="rounded p-0.5 text-muted-foreground hover:bg-accent" @click="step(d.id, -1)"><Minus class="size-3.5" /></button>
              <span class="tabular w-4 text-center text-xs">{{ counts[d.id] ?? 0 }}</span>
              <button class="rounded p-0.5 text-muted-foreground hover:bg-accent" @click="step(d.id, 1)"><Plus class="size-3.5" /></button>
            </div>
          </div>
        </div>
        <label v-if="brand" class="flex items-center gap-2 text-xs">
          <Checkbox v-model="useBrand" /> Follow the brand kit{{ brand.name ? ` (${brand.name})` : '' }} — style, palette, fonts and style references
        </label>
      </div>

      <!-- Step 2: review -->
      <ScrollArea v-else class="h-[52vh] rounded-md border">
        <div class="grid gap-2 p-2">
          <div v-for="(it, i) in plan.items" :key="i" class="grid gap-1.5 rounded-lg border bg-card p-2.5">
            <div class="flex items-center gap-2">
              <Input v-model="it.title" class="h-7 flex-1 text-xs font-medium" />
              <span class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {{ deliverable(it.deliverable)?.label }} · {{ framePreset(deliverable(it.deliverable)?.framePresetId ?? '')?.w }}×{{ framePreset(deliverable(it.deliverable)?.framePresetId ?? '')?.h }}
              </span>
              <button class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive" title="Remove" @click="removeItem(i)"><Trash2 class="size-3.5" /></button>
            </div>
            <Textarea v-model="it.prompt" rows="2" class="text-xs" />
            <div v-if="deliverable(it.deliverable)?.copy" class="grid grid-cols-2 gap-1.5">
              <Input v-model="it.headline" placeholder="Headline" class="h-7 text-xs" />
              <Input v-model="it.subline" placeholder="Subline" class="h-7 text-xs" />
            </div>
            <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
              <KeyRound v-if="!resolved[i]?.ready" class="size-3 text-destructive" />
              {{ resolved[i]?.model.label ?? 'No model for this' }}{{ resolved[i] && !resolved[i]!.ready ? ' — needs its provider key' : '' }}
              <span v-if="resolved[i]?.usd != null" class="ml-auto tabular">{{ formatUsd(resolved[i]!.usd!) }}</span>
            </div>
          </div>
        </div>
      </ScrollArea>

      <DialogFooter class="items-center gap-2 sm:justify-between">
        <template v-if="!plan">
          <div class="flex min-w-0 items-center gap-2">
            <span class="shrink-0 text-xs text-muted-foreground">{{ itemCount }} item{{ itemCount === 1 ? '' : 's' }}</span>
            <TextModelPicker compact />
          </div>
          <Button :disabled="planning || !brief.trim() || !itemCount" class="bg-brand text-brand-foreground hover:bg-brand/90" @click="makePlan">
            <Loader2 v-if="planning" class="animate-spin" /><Sparkles v-else /> {{ planning ? 'Planning…' : 'Plan the set' }}
          </Button>
        </template>
        <template v-else>
          <div class="flex items-center gap-3">
            <Button variant="ghost" size="sm" @click="plan = undefined"><ArrowLeft /> Brief</Button>
            <label class="flex items-center gap-1.5 text-xs" title="Generate one image first, then the rest with it as a style reference">
              <Checkbox v-model="anchor" /> Match the first image's look
            </label>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-right text-xs">
              <span class="tabular font-medium">{{ cost.usd ? `${cost.partial ? 'from ' : ''}${formatUsd(cost.usd)}` : cost.partial ? 'Price varies' : 'Free' }}</span>
              <span v-if="unavailable" class="block text-[10px] text-destructive">{{ unavailable }} can't run yet</span>
            </span>
            <Button :disabled="running || !plan.items.length" class="bg-brand text-brand-foreground hover:bg-brand/90" @click="generate">
              <Loader2 v-if="running" class="animate-spin" /><Sparkles v-else /> Generate {{ plan.items.length }}
            </Button>
          </div>
        </template>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
