<script setup lang="ts">
import { Check, Loader2, Sparkles } from '@lucide/vue'
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { formatUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { COVERAGE_ANGLES, type CoverageAngle, DEFAULT_COVERAGE } from './coverage'

/**
 * Shots from one picture: the angles to draw, each previewed on the picture itself (closer, pulled back, mirrored for
 * the reverse, tilted…) — a sketch of where the camera goes, not the result. Pick several; the cost is before the
 * button. `costEach`: one picture's price (null: plan price, undefined: unknown).
 */
const props = defineProps<{ src: string; costEach?: number | null; blocker?: string; busy?: boolean; what?: string }>()
const emit = defineEmits<{ make: [angles: CoverageAngle[]] }>()

const picked = ref<string[]>([...DEFAULT_COVERAGE])
function toggle(id: string) {
  picked.value = picked.value.includes(id) ? picked.value.filter((x) => x !== id) : [...picked.value, id]
}
const chosen = computed(() => COVERAGE_ANGLES.filter((a) => picked.value.includes(a.id)))
const cost = computed(() => {
  if (props.costEach === undefined) return ''
  if (props.costEach === null) return ' · plan price'
  return ` · ${formatUsd(props.costEach * chosen.value.length)}`
})

/** The miniature: the picture framed as the angle would (a sketch on the real picture). */
function frameStyle(a: CoverageAngle) {
  const p = a.preview
  const t: string[] = []
  if (p.tilt) t.push(`perspective(160px) rotateX(${p.tilt}deg)`)
  if (p.zoom) t.push(`scale(${p.zoom})`)
  if (p.flip) t.push('scaleX(-1)')
  if (p.wide) t.push('scale(0.62)')
  const [x, y] = p.focus ?? [50, 50]
  return { transform: t.join(' ') || undefined, transformOrigin: `${x}% ${y}%` }
}
</script>

<template>
  <div class="grid gap-2.5" data-coverage-picker="">
    <div class="grid grid-cols-3 gap-1.5">
      <button
        v-for="a in COVERAGE_ANGLES"
        :key="a.id"
        type="button"
        :aria-pressed="picked.includes(a.id)"
        :title="a.instruction"
        :class="cn('grid gap-1 rounded-lg p-1 text-left transition-colors hover:bg-accent', picked.includes(a.id) && 'bg-accent ring-1 ring-brand/60')"
        :data-coverage-angle="a.id"
        @click="toggle(a.id)"
      >
        <span class="relative block aspect-video overflow-hidden rounded-md bg-black">
          <!-- Pulled back: the picture smaller, its own blur around it for the more the wide would show. -->
          <img v-if="a.preview.wide" :src="src" alt="" class="absolute inset-0 size-full scale-125 object-cover opacity-60 blur-[3px]" />
          <img :src="src" alt="" class="absolute inset-0 size-full object-cover" :style="frameStyle(a)" />
          <span v-if="a.preview.shoulder" class="absolute -bottom-6 -left-6 size-20 rounded-full bg-black/85 blur-[6px]" />
          <span
            :class="cn('absolute top-1 right-1 grid size-4 place-items-center rounded-full border border-white/70 bg-black/40', picked.includes(a.id) && 'border-brand bg-brand')"
          >
            <Check v-if="picked.includes(a.id)" class="size-2.5 text-brand-foreground" />
          </span>
        </span>
        <span class="truncate px-0.5 text-[11.5px]">{{ a.label }}</span>
      </button>
    </div>
    <p class="text-[10.5px] leading-snug text-muted-foreground">
      The miniatures sketch where the camera goes. Each is drawn from the picture — the same people, place and light{{ what ? `; ${what}` : '' }}.
    </p>
    <Button :disabled="!chosen.length || Boolean(blocker) || busy" :title="blocker" class="w-full" data-coverage-make="" @click="emit('make', chosen)">
      <Loader2 v-if="busy" class="animate-spin" /><Sparkles v-else />
      Make {{ chosen.length }} shot{{ chosen.length === 1 ? '' : 's' }}{{ cost }}
    </Button>
    <p v-if="blocker" class="text-[10.5px] text-destructive">{{ blocker }}</p>
  </div>
</template>
