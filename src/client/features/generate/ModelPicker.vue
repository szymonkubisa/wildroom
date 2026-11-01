<script setup lang="ts">
import { Check, Sparkles, Star } from '@lucide/vue'
import type { ModelSpec } from '@shared/models/types'
import { computed } from 'vue'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { formatEta, formatUsd } from '@/lib/format'
import { groupByProvider } from '@/lib/providers'
import { cn } from '@/lib/utils'

/**
 * A model menu, honest before you run: each model with what this run would cost with it, about how long it takes
 * (when that is known), a short note or its badges, and whether it can run now — a model that can't offers to set it
 * up ("Add key", "Install"). The Composer puts "Auto" first (why, and what it picks); the storyboard's "Render with…"
 * menus put the story's default first. The trigger is the default slot. Content is only rendered while open, so the
 * estimates are worked out then.
 */
export interface ModelStatus {
  /** It can run now. */
  ready: boolean
  /** "Ready", "On this Mac", "Add key", "Install"… */
  text: string
}

const props = defineProps<{
  heading: string
  models: ModelSpec[]
  /** The story's video model: offered first as "Story default (…)", the choice while `selected` is unset. */
  defaultModel?: ModelSpec
  /** Offer the story default as the first item. */
  withDefault?: boolean
  /** Offer "Auto" first: whether it is on, why, and the model it picks. */
  auto?: { on: boolean; reason?: string; model?: ModelSpec }
  /** The chosen model id (unset: the default / Auto). Shown with a check. */
  selected?: string
  /** What this run would cost with the model: USD, null (depends on the plan), or a reason it can't be planned. */
  costOf?: (model: ModelSpec) => number | null | string | undefined
  /** About how long it takes, in seconds (undefined: not known). */
  etaOf?: (model: ModelSpec) => number | undefined
  /** A short note on what the model takes ("≤6 shots · 15 s · Elements 3"). */
  hintOf?: (model: ModelSpec) => string | undefined
  /** Whether it can run now; a model that can't is offered for setup (`setup`) instead of picked. */
  statusOf?: (model: ModelSpec) => ModelStatus
  align?: 'start' | 'end'
  side?: 'top' | 'bottom'
  /** Wider rows, for the cost, time and status columns. */
  wide?: boolean
  /** Under a heading per provider (where the model runs), as the story's model menus. */
  grouped?: boolean
  /** Starred model ids, in order: listed on top, each row with a star to (un)star it (`favorite`). */
  favorites?: string[]
}>()
const emit = defineEmits<{ pick: [modelId: string | undefined]; auto: []; setup: [model: ModelSpec]; favorite: [modelId: string] }>()

const starred = computed(() => (props.favorites ? props.favorites.flatMap((id) => props.models.find((m) => m.id === id) ?? []) : []))
/** The rest, by provider when `grouped` (one unnamed group otherwise); the starred ones are on top instead. */
const sections = computed(() => {
  const rest = props.models.filter((m) => !props.favorites?.includes(m.id))
  return props.grouped ? groupByProvider(rest).map((g) => ({ key: g.provider, name: g.name, models: g.models })) : [{ key: 'all', name: '', models: rest }]
})

function costText(model: ModelSpec): { text: string; title?: string } {
  const usd = props.costOf?.(model)
  if (usd === undefined) return { text: '' }
  if (typeof usd === 'string') return { text: '—', title: usd }
  return usd === null ? { text: 'plan price', title: 'The price depends on your plan' } : { text: formatUsd(usd), title: 'Estimated cost of this run' }
}
/** Each model's cost and time, worked out once (lazily: only the open menu reads them) and kept until the inputs change. */
const facts = computed(
  () =>
    new Map(
      [...props.models, ...(props.defaultModel ? [props.defaultModel] : [])].map((m) => {
        const eta = props.etaOf?.(m)
        return [m.id, { cost: costText(m), eta: eta === undefined ? '' : formatEta(eta), status: props.statusOf?.(m) }]
      }),
    ),
)
const fact = (model: ModelSpec) => facts.value.get(model.id) ?? { cost: { text: '' }, eta: '', status: undefined }
const checked = (m: ModelSpec) => (props.withDefault || props.auto) && props.selected === m.id && !props.auto?.on

function choose(m: ModelSpec) {
  const status = fact(m).status
  if (status && !status.ready) emit('setup', m)
  else emit('pick', m.id)
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child><slot /></DropdownMenuTrigger>
    <DropdownMenuContent :align="align ?? 'start'" :side="side" :class="cn('max-h-[min(28rem,70vh)] overflow-y-auto', wide ? 'w-[27rem]' : 'w-80')" data-model-picker="">
      <DropdownMenuLabel class="flex items-baseline justify-between gap-2">
        <span>{{ heading }}</span>
        <span v-if="wide" class="text-[10px] font-normal text-muted-foreground">cost · time · before you run</span>
      </DropdownMenuLabel>
      <template v-if="auto">
        <DropdownMenuItem :class="cn('items-start gap-2 bg-brand/6', auto.on && 'bg-brand/12')" data-model-auto="" @select="emit('auto')">
          <Check v-if="auto.on" class="mt-0.5 text-foreground" /><Sparkles v-else class="mt-0.5 text-brand" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5 font-medium">Auto <span class="text-[9.5px] font-medium tracking-wide text-brand uppercase">recommended</span></div>
            <div class="text-[11px] leading-snug text-muted-foreground">
              {{ auto.reason ?? 'Picks the model from what you attach' }}<template v-if="auto.model"> → <span class="text-foreground">{{ auto.model.label }}</span></template>
            </div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
      </template>
      <template v-if="withDefault">
        <DropdownMenuItem data-model-option="" @select="emit('pick', undefined)">
          <Check v-if="!selected" class="text-foreground" /><span v-else class="size-4 shrink-0" />
          <div class="min-w-0 flex-1">
            <div class="truncate">Story default ({{ defaultModel?.label ?? 'no video model' }})</div>
            <div v-if="defaultModel && hintOf?.(defaultModel)" class="truncate text-[11px] text-muted-foreground">{{ hintOf(defaultModel) }}</div>
          </div>
          <span v-if="defaultModel" class="shrink-0 text-[11px] text-muted-foreground tabular" :title="fact(defaultModel).cost.title">{{ fact(defaultModel).cost.text }}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
      </template>
      <div v-if="!models.length" class="px-2.5 py-1.5 text-[11px] text-muted-foreground">No other model is ready — add a provider key in Settings.</div>
      <template v-for="s in [...(starred.length ? [{ key: 'favorites', name: 'Favorites', models: starred }] : []), ...sections]" :key="s.key">
        <div
          v-if="s.name && s.models.length"
          class="flex items-baseline justify-between gap-2 px-2 pt-2 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
          :data-model-group="s.key"
        >
          <span>{{ s.name }}</span>
          <span v-if="s.key === 'favorites'" class="font-normal tracking-normal normal-case">the first ready one is the default</span>
        </div>
        <DropdownMenuItem
          v-for="m in s.models"
          :key="m.id"
          data-model-option=""
          :data-model-id="m.id"
          :class="cn('group/model', fact(m).status && !fact(m).status!.ready && 'text-muted-foreground')"
          @select="choose(m)"
        >
          <template v-if="withDefault || auto"><Check v-if="checked(m)" class="text-foreground" /><span v-else class="size-4 shrink-0" /></template>
          <div class="min-w-0 flex-1">
            <div class="truncate">{{ m.label }}</div>
            <div v-if="hintOf?.(m)" class="truncate text-[11px] text-muted-foreground">{{ hintOf(m) }}</div>
          </div>
          <span class="flex shrink-0 flex-col items-end text-[11px] leading-tight tabular">
            <span :class="fact(m).status && !fact(m).status!.ready ? 'text-muted-foreground' : 'text-foreground/80'" :title="fact(m).cost.title">{{ fact(m).cost.text }}</span>
            <span v-if="fact(m).eta" class="text-[10px] text-muted-foreground" title="About how long it takes">{{ fact(m).eta }}</span>
          </span>
          <span
            v-if="fact(m).status"
            :class="cn('w-[4.5rem] shrink-0 text-right text-[10.5px]', fact(m).status!.ready ? 'text-emerald-500' : 'text-role-effects')"
            data-model-status=""
          >
            {{ fact(m).status!.text }}
          </span>
          <!-- The star stops the row's own pointer and click handling: starring doesn't pick the model or close the menu. -->
          <button
            v-if="favorites"
            type="button"
            :class="
              cn(
                'grid size-6 shrink-0 place-items-center rounded-md hover:bg-accent',
                favorites.includes(m.id) ? 'text-amber-400' : 'text-muted-foreground/40 opacity-0 group-hover/model:opacity-100 group-data-highlighted/model:opacity-100 focus-visible:opacity-100',
              )
            "
            :aria-label="favorites.includes(m.id) ? `Unstar ${m.label}` : `Star ${m.label}`"
            :aria-pressed="favorites.includes(m.id)"
            :title="favorites.includes(m.id) ? 'Unstar' : 'Star — starred models are on top; the first ready one is picked by default'"
            data-model-star=""
            @pointerdown.stop
            @pointerup.stop
            @click.stop.prevent="emit('favorite', m.id)"
          >
            <Star :class="cn('size-3.5', favorites.includes(m.id) && 'fill-current')" />
          </button>
        </DropdownMenuItem>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
