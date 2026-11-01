<script setup lang="ts">
import { type Fill, type GradientFill, PATTERNS, type PatternFill, fillColor } from '@shared/types/canvas'
import { computed } from 'vue'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/** A fill: a colour, a linear or radial gradient of two colours, or (shapes) a pattern. */
const props = defineProps<{ fill: Fill | undefined; patterns?: boolean }>()
const emit = defineEmits<{ change: [fill: Fill, label: string] }>()

type Kind = 'solid' | 'linear' | 'radial' | 'pattern'
const kind = computed<Kind>(() => (!props.fill || typeof props.fill === 'string' ? 'solid' : props.fill.type === 'pattern' ? 'pattern' : props.fill.type))
const gradient = computed(() => (props.fill && typeof props.fill !== 'string' && props.fill.type !== 'pattern' ? props.fill : undefined))
const pattern = computed(() => (props.fill && typeof props.fill !== 'string' && props.fill.type === 'pattern' ? props.fill : undefined))
const base = computed(() => fillColor(props.fill, '#7c3aed'))

function setKind(k: Kind) {
  const c = base.value
  if (k === 'solid') return emit('change', c, 'Fill')
  if (k === 'pattern') return emit('change', { type: 'pattern', pattern: 'dots', color: c, size: 24 }, 'Pattern')
  const stops = gradient.value?.stops ?? [
    { at: 0, color: c },
    { at: 1, color: '#000000' },
  ]
  emit('change', k === 'linear' ? { type: 'linear', stops, angle: 90 } : { type: 'radial', stops, cx: 0.5, cy: 0.5 }, 'Gradient')
}
function setGradient(patch: Partial<GradientFill>) {
  if (gradient.value) emit('change', { ...gradient.value, ...patch }, 'Gradient')
}
function setStop(i: number, color: string) {
  const g = gradient.value
  if (g) setGradient({ stops: g.stops.map((s, j) => (j === i ? { ...s, color } : s)) })
}
function setPattern(patch: Partial<PatternFill>) {
  if (!pattern.value) return
  const next: PatternFill = { ...pattern.value, ...patch }
  if (!next.background) delete next.background
  emit('change', next, 'Pattern')
}
</script>

<template>
  <div class="grid gap-1.5">
    <Select :model-value="kind" @update:model-value="(v) => setKind(v as Kind)">
      <SelectTrigger class="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="solid">Solid colour</SelectItem>
        <SelectItem value="linear">Linear gradient</SelectItem>
        <SelectItem value="radial">Radial gradient</SelectItem>
        <SelectItem v-if="patterns" value="pattern">Pattern</SelectItem>
      </SelectContent>
    </Select>
    <input
      v-if="kind === 'solid'"
      type="color"
      :value="base"
      class="h-8 w-full cursor-pointer rounded border bg-transparent"
      @change="(e) => emit('change', (e.target as HTMLInputElement).value, 'Fill')"
    />
    <template v-else-if="gradient">
      <div class="grid grid-cols-2 gap-1.5">
        <input v-for="(s, i) in gradient.stops" :key="i" type="color" :value="s.color" class="h-8 w-full cursor-pointer rounded border bg-transparent" @change="(e) => setStop(i, (e.target as HTMLInputElement).value)" />
      </div>
      <label v-if="gradient.type === 'linear'" class="grid grid-cols-[1fr_auto] items-center gap-2">
        <span class="text-[10px] text-muted-foreground">Angle ° (90 = top to bottom)</span>
        <Input :model-value="gradient.angle ?? 90" type="number" class="h-7 w-20 text-xs" @change="(e: Event) => setGradient({ angle: Number((e.target as HTMLInputElement).value) || 0 })" />
      </label>
      <div v-else class="grid grid-cols-2 gap-1.5">
        <label class="grid gap-0.5">
          <span class="text-[10px] text-muted-foreground">Centre X %</span>
          <Input :model-value="Math.round((gradient.cx ?? 0.5) * 100)" type="number" class="h-7 text-xs" @change="(e: Event) => setGradient({ cx: (Number((e.target as HTMLInputElement).value) || 0) / 100 })" />
        </label>
        <label class="grid gap-0.5">
          <span class="text-[10px] text-muted-foreground">Centre Y %</span>
          <Input :model-value="Math.round((gradient.cy ?? 0.5) * 100)" type="number" class="h-7 text-xs" @change="(e: Event) => setGradient({ cy: (Number((e.target as HTMLInputElement).value) || 0) / 100 })" />
        </label>
      </div>
    </template>
    <template v-else-if="pattern">
      <Select :model-value="pattern.pattern" @update:model-value="(v) => setPattern({ pattern: v as PatternFill['pattern'] })">
        <SelectTrigger class="h-7 w-full text-xs capitalize"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem v-for="p in PATTERNS" :key="p" :value="p" class="capitalize">{{ p }}</SelectItem></SelectContent>
      </Select>
      <div class="grid grid-cols-3 gap-1.5">
        <label class="grid gap-0.5">
          <span class="text-[10px] text-muted-foreground">Ink</span>
          <input type="color" :value="pattern.color" class="h-7 w-full cursor-pointer rounded border bg-transparent" @change="(e) => setPattern({ color: (e.target as HTMLInputElement).value })" />
        </label>
        <label class="grid gap-0.5">
          <span class="text-[10px] text-muted-foreground">Background</span>
          <input type="color" :value="pattern.background ?? '#ffffff'" class="h-7 w-full cursor-pointer rounded border bg-transparent" @change="(e) => setPattern({ background: (e.target as HTMLInputElement).value })" />
        </label>
        <label class="grid gap-0.5">
          <span class="text-[10px] text-muted-foreground">Tile</span>
          <Input :model-value="pattern.size" type="number" min="2" class="h-7 text-xs" @change="(e: Event) => setPattern({ size: Math.max(2, Number((e.target as HTMLInputElement).value) || 24) })" />
        </label>
      </div>
      <button v-if="pattern.background" type="button" class="justify-self-start text-[10px] text-muted-foreground underline" @click="setPattern({ background: undefined })">No background</button>
    </template>
  </div>
</template>
