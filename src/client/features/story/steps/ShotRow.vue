<script setup lang="ts">
import { AlertTriangle, Check, ChevronDown, CircleDashed, CornerDownRight, Equal, Hourglass, ImageIcon, Loader2, Play, Scissors, Type } from '@lucide/vue'
import { splitFraming } from '@shared/story/framing'
import type { StoryShot } from '@shared/types/story'
import { computed, watch } from 'vue'
import { cn } from '@/lib/utils'
import { shotStatus } from '../readiness'
import { continuing } from '../sceneRun'
import { inFlight, useStory } from '../useStory'

/**
 * A shot in one line: its picture, its framing (SIZE · LENS), what happens, its first line of dialogue, how long, and
 * how far it is — Still (or "Still · redo" once the shot was rewritten), Take n/m, Final. Click to open its details.
 */
const props = defineProps<{ shot: StoryShot; label: string; open?: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
const s = useStory()

const keyframe = computed(() => s.keyframeOf(props.shot))
const group = computed(() => s.groupOf(props.shot))
/** The shot's own takes, else (a shot rendered as part of its group's clip) the group's. */
const takes = computed(() => {
  const own = s.takesOf(props.shot)
  return own.length || !group.value ? own : s.groupTakes(group.value)
})
const video = computed(() => s.chosenVideoOf(props.shot) ?? (group.value ? s.chosenGroupVideo(group.value) : undefined))
const poster = computed(() => {
  const asset = keyframe.value?.variants.poster ? keyframe.value : video.value?.variants.poster ? video.value : undefined
  return asset && `/media/${asset.id}/poster`
})
/** A shot with a set end shows where it lands, small, beside its first picture. */
const endPoster = computed(() => {
  const end = s.endKeyframeOf(props.shot)
  return end?.variants.poster ? `/media/${end.id}/poster` : undefined
})
const busy = (id?: string) => inFlight(s.jobState(id))
/** A still waiting for the picture it is drawn from, or a take for its lines to be voiced: no job yet, but on its way. */
const preparing = computed(() => {
  const keyframe = s.preparingOf(props.shot, 'keyframe')
  if (keyframe) return `still waits for ${keyframe}`
  const end = s.preparingOf(props.shot, 'end')
  if (end) return `end frame waits for ${end}`
  const take = s.preparingOf(props.shot, 'take')
  return take && `take waits for ${take}`
})
const stillRunning = computed(() => busy(props.shot.keyframeGenerationId) || Boolean(s.preparingOf(props.shot, 'keyframe')))
const takeRunning = computed(() => takes.value.some((t) => inFlight(t.state)) || Boolean(s.preparingOf(props.shot, 'take')))
const finalRunning = computed(() => busy((group.value && !s.groupShotByShot(group.value) ? group.value : props.shot).finalGenerationId))
const isFinal = computed(() => Boolean(video.value && s.isFinalAsset(video.value)))
/** "Take 2/3": the chosen one of the takes made. */
const takeText = computed(() => {
  const made = takes.value.filter((t) => t.asset)
  if (!made.length) return 'Take'
  const at = made.findIndex((t) => t.asset!.id === video.value?.id)
  return `Take ${at >= 0 ? at + 1 : made.length}/${made.length}`
})

const framing = computed(() => {
  const f = splitFraming(props.shot.shotType)
  return [f.size, f.lens].filter(Boolean).join(' · ')
})
const line = computed(() => {
  const l = props.shot.dialogue.find((x) => x.text.trim())
  return l && { who: s.characterName(l.characterId) ?? 'Narrator', text: l.text.trim(), more: props.shot.dialogue.filter((x) => x.text.trim()).length - 1 }
})
const continues = computed(() => continuing(s.story.value, props.shot))
const waitingFor = computed(() => s.waitingFor(props.shot))

// Both stills drawn: compared once (checkEndFrame) — the end picture goes with the clip only as a visible change.
watch(
  () => s.endCheckDue(props.shot),
  (due) => due && void s.checkEndFrame(props.shot),
  { immediate: true },
)
/** One mark on the end frame (what becomes of it) and one count of what to look at (shotStatus). */
const status = computed(() => {
  const shot = props.shot
  const start = keyframe.value?.status === 'ready' ? keyframe.value.id : undefined
  const end = s.endKeyframeOf(shot)
  return shotStatus(s.story.value, shot, {
    ...(group.value ? { group: s.groupShotByShot(group.value) ? ('separate' as const) : ('one-clip' as const) } : {}),
    startId: start,
    endId: end?.status === 'ready' ? end.id : undefined,
    lipSync: Boolean(start && s.followsVoices(shot)),
    ...(line.value ? { dialogue: s.dialogueFitOf(shot) } : {}),
  })
})
const END_MARK = { image: Check, text: Type, same: Equal, recomposed: Scissors, unchecked: CircleDashed }

const pill = (on: boolean, running: boolean, warn = false) =>
  cn(
    'inline-flex h-5 items-center gap-1 rounded-full px-2 text-[10px] font-medium whitespace-nowrap',
    warn ? 'bg-role-effects/15 text-role-effects' : running ? 'bg-brand/15 text-brand' : on ? 'bg-foreground text-background' : 'bg-field text-muted-foreground',
  )
</script>

<template>
  <div
    role="button"
    tabindex="0"
    :aria-expanded="open"
    :class="cn('flex w-full cursor-pointer items-center gap-3 rounded-2xl bg-card p-2 pr-2.5 text-left transition-shadow hover:ring-1 hover:ring-border', open && 'rounded-b-none ring-1 ring-border')"
    :data-shot-row="shot.id"
    @click="emit('toggle')"
    @keydown.enter.self.prevent="emit('toggle')"
    @keydown.space.self.prevent="emit('toggle')"
  >
    <span class="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-lg bg-field px-1 text-xs font-semibold tabular">{{ label }}</span>
    <span class="relative flex aspect-video w-32 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-viewer">
      <img v-if="poster" :src="poster" class="max-h-full max-w-full object-contain" alt="" />
      <Loader2 v-else-if="stillRunning" class="size-4 animate-spin text-brand" />
      <ImageIcon v-else class="size-4 text-muted-foreground/60" />
      <span v-if="video" class="absolute right-1 bottom-1 flex items-center gap-0.5 rounded bg-black/60 px-1 text-[9px] font-medium text-white tabular">
        <Play class="size-2.5" />{{ shot.duration }}s
      </span>
    </span>
    <span
      v-if="shot.endFrame"
      class="relative -ml-2 flex aspect-video w-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-viewer"
      :title="status.endText ?? (endPoster ? 'End frame' : 'End frame not drawn yet')"
      data-shot-row-end=""
    >
      <img v-if="endPoster" :src="endPoster" class="max-h-full max-w-full object-contain" alt="" />
      <span v-else class="text-[9px] text-muted-foreground">end</span>
      <component
        :is="END_MARK[status.end]"
        v-if="status.end && endPoster"
        :class="
          cn(
            'absolute right-0.5 bottom-0.5 size-3 rounded-sm bg-black/60 p-px text-white',
            (status.end === 'same' || status.end === 'recomposed') && !shot.endUse && 'text-role-effects',
          )
        "
        :data-shot-row-end-mark="status.end"
      />
    </span>
    <span class="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-0.5">
      <span class="flex min-w-0 items-center gap-1.5">
        <span v-if="framing" class="truncate text-[10px] font-medium tracking-wide text-muted-foreground uppercase" data-shot-row-framing="">{{ framing }}</span>
        <span v-if="continues" class="flex shrink-0 items-center gap-0.5 rounded bg-brand/10 px-1 text-[10px] text-brand"><CornerDownRight class="size-3" /> continues</span>
        <span v-if="waitingFor" class="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground"><Hourglass class="size-3" /> waiting for {{ waitingFor }}</span>
        <span v-else-if="preparing" class="flex min-w-0 items-center gap-0.5 text-[10px] text-muted-foreground" data-shot-row-preparing="">
          <Hourglass class="size-3 shrink-0" /><span class="truncate">{{ preparing }}</span>
        </span>
      </span>
      <span class="truncate text-sm">{{ shot.description || shot.prompt || 'New shot' }}</span>
      <span v-if="line" class="truncate text-[11px] text-muted-foreground" data-shot-row-line="">
        <span class="font-semibold tracking-wide uppercase">{{ line.who }}</span> “{{ line.text }}”<template v-if="line.more"> +{{ line.more }}</template>
      </span>
    </span>
    <span
      v-if="status.warnings.length"
      class="flex shrink-0 items-center gap-0.5 text-[11px] text-role-effects tabular"
      :title="status.warnings.join('\n')"
      data-shot-row-warnings=""
    >
      <AlertTriangle class="size-3" />{{ status.warnings.length }}
    </span>
    <span class="w-9 shrink-0 text-right text-xs text-muted-foreground tabular">{{ shot.duration }} s</span>
    <span class="flex shrink-0 items-center gap-1" data-shot-row-status="">
      <span
        v-if="shot.stillStale && !stillRunning"
        :class="pill(false, false, true)"
        title="The shot was written again after its still was drawn: draw the still again (or keep it, in the shot’s details)"
        data-shot-row-redo=""
        >Still · redo</span
      >
      <span v-else :class="pill(Boolean(keyframe), stillRunning)" :title="stillRunning ? 'Drawing the still…' : keyframe ? 'Has a still' : 'No still yet'">
        <Loader2 v-if="stillRunning" class="size-2.5 animate-spin" />Still
      </span>
      <span :class="pill(Boolean(video), takeRunning)" :title="takeRunning ? 'Rendering a take…' : video ? 'The chosen take, of the takes made' : 'No take yet'">
        <Loader2 v-if="takeRunning" class="size-2.5 animate-spin" />{{ takeText }}
      </span>
      <span :class="pill(isFinal, finalRunning)" :title="finalRunning ? 'Rendering the final…' : isFinal ? 'The chosen take is a final render' : 'No final yet'">
        <Loader2 v-if="finalRunning" class="size-2.5 animate-spin" />Final
      </span>
    </span>
    <ChevronDown :class="cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')" />
  </div>
</template>
