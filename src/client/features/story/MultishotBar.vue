<script setup lang="ts">
import { AlertTriangle, ChevronDown, Clapperboard, Columns2, Cpu, Film, Languages, Lightbulb, Loader2, Play, Sparkles, Unlink, Wand2 } from '@lucide/vue'
import { getModel } from '@shared/models/registry'
import type { ModelSpec } from '@shared/models/types'
import { type IdentitySource, followsRecordedAudio, rendersSeparately, workflowFor } from '@shared/models/workflow'
import type { StoryMultishot } from '@shared/types/story'
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { formatUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { isUnseen, shotCast, titleCase } from './cast'
import { modelHint, modelSpeaking, sourceBlocker, sourceExplanation, sourceLabel, speechWarning, storyboardModels } from './modelInfo'
import ModelPicker from '@/features/generate/ModelPicker.vue'
import { speaksAudio, storyLanguage } from './soundtrack'
import { inFlight, useStory } from './useStory'

/**
 * The header of a multi-shot group: its model, whether its shots render separately or as one clip — and then what the
 * clip is made from and its cut plan — its takes (with the cuts they really have), and rendering it as one clip.
 */
const props = defineProps<{ group: StoryMultishot }>()
const s = useStory()
const preview = ref<string>()

const plan = computed(() => s.groupCuts(props.group))
const planned = computed(() => s.groupShots(props.group).reduce((sum, shot) => sum + shot.duration, 0))
const takes = computed(() => s.groupTakes(props.group))
const chosen = computed(() => s.chosenGroupVideo(props.group))
// "1.3" and "1.3–1.4": the group's first shot and its range, as the storyboard numbers shots.
const groupLabels = computed(() => s.groupShots(props.group).map((x) => s.shotName(x)))
const first = computed(() => groupLabels.value[0] ?? '')
const range = computed(() => `${groupLabels.value[0] ?? ''}–${groupLabels.value.at(-1) ?? ''}`)
const busy = inFlight
const failed = (state?: { status: string }) => state && ['failed', 'needs_attention'].includes(state.status)
const fmt = (n: number) => String(Math.round(n * 10) / 10)

// Ready takes get their real cuts detected once (LTX doesn't cut where the prompt says) — again lower if too few were found.
watch(
  () =>
    takes.value
      .filter((t) => t.asset && s.cutsWanted(props.group, t.id))
      .map((t) => t.id)
      .join(),
  (ids) => {
    for (const id of ids ? ids.split(',') : []) void s.detectTakeCuts(props.group, id)
  },
  { immediate: true },
)

/** "cuts at 1.5 s, 5 s (detected)" for a ready take. */
function cutsLabel(generationId: string): string | undefined {
  const info = s.takeCutsOf(props.group, generationId)
  if (!info) return undefined
  const at = info.cuts.map((c) => `${fmt(c)} s`).join(', ')
  // The stray opening shot is one of the extra cuts: said apart below.
  const extra = (info.found ?? 0) - info.cuts.length - (info.start !== undefined ? 1 : 0)
  const note = info.detecting
    ? 'planned — detecting…'
    : info.source === 'detected'
      ? extra > 0
        ? `detected, ${extra} extra cut${extra === 1 ? '' : 's'} ignored`
        : 'detected'
      : info.found !== undefined
        ? `${info.source === 'planned' ? 'planned' : 'estimated'} — only ${info.found} detected`
        : info.source === 'planned'
          ? 'planned'
          : 'estimated'
  const opener = info.start !== undefined ? `; stray opening shot (first ${fmt(info.start)} s) left out` : ''
  return `cuts at ${at} (${note}${opener})`
}

const chosenId = computed(() => takes.value.find((t) => t.asset && t.asset.id === chosen.value?.id)?.id)
const chosenCuts = computed(() => (chosenId.value ? cutsLabel(chosenId.value) : undefined))

// The final render's model: the final model, or the chosen take's own one when that is of another family.
const finalModel = computed(() => s.finalModelForGroup(props.group))
const finalBlocker = computed(() => (finalModel.value ? s.groupFinalBlocker(props.group) : 'Pick a final model in the storyboard header'))

// ---- "Render with…": the group's model, what a take costs with each ready model, one-off takes with another one
const model = computed(() => s.modelForGroup(props.group))
const workflow = computed(() => s.workflowOf(props.group))
const storyModel = computed(() => s.modelFor('video'))
const ready = computed(() => storyboardModels(s.readyVideoModels()))
/**
 * LTX speaking lines inside a multi-shot clip: wrong voices, lines spilling over the cuts. Broken up, each dialogue shot
 * is made from its keyframe to its ElevenLabs lines (see planning.followsVoices) — said here when that would apply.
 */
const dialogueNotice = computed(() => {
  if (shotByShot.value || !followsRecordedAudio(model.value, false)) return undefined
  const speaking = s.groupShots(props.group).filter((shot) => shot.dialogue.some((l) => l.text.trim()))
  if (!speaking.length) return undefined
  const speakers = new Set(speaking.flatMap((shot) => shot.dialogue.filter((l) => l.text.trim()).map((l) => l.characterId)))
  const unvoiced = s.story.value.characters.filter((c) => speakers.has(c.id) && !c.voiceId).map((c) => c.name)
  const voices = unvoiced.length ? ` (pick ElevenLabs voices for ${unvoiced.join(', ')} in the Cast)` : ''
  return `${speaking.length} of these shots ${speaking.length === 1 ? 'has' : 'have'} dialogue. On their own, they’re made from their stills to the ElevenLabs lines${voices}: exact words, lip sync, the right voice. Multi-shot suits runs without dialogue.`
})
/** What one take of the group costs with `m` (a reason when it can't be planned). */
function costWith(m: ModelSpec): number | null | string {
  const p = s.planMultishot(props.group, { model: m })
  return typeof p === 'string' ? p : s.estimate([p])
}
const hintWith = (m: ModelSpec) => modelHint(s.workflowOf(m), { group: true }) + (s.groupLimitProblem(props.group, m) ? ' · too long, gets shortened' : '')
function anotherTakeWith(id: string | undefined) {
  const m = ready.value.find((x) => x.id === id)
  if (m) void s.run([s.planMultishot(oneClip(), { model: m })])
}
const limitProblem = computed(() => (shotByShot.value ? undefined : s.groupLimitProblem(props.group)))

// ---- what the clip is made from, as the group's model offers it
const source = computed(() => s.groupSource(props.group))
const firstHasKeyframe = computed(() => Boolean(s.groupShots(props.group)[0] && s.keyframeOf(s.groupShots(props.group)[0]!)))
const sourceOptions = computed(() =>
  workflow.value.sources.map((value) => ({
    value,
    label: sourceLabel(value, workflow.value),
    blocker: s.canUseSource(props.group, value) ? undefined : sourceBlocker(value, workflow.value, { first: first.value, hasKeyframe: firstHasKeyframe.value }),
  })),
)
/** The group's own choice when its model offers it, else automatic. */
const pickedSource = computed(() => (props.group.source && workflow.value.sources.includes(props.group.source) ? props.group.source : undefined))
/** What "Auto" would pick for the group now (its own choice set aside). */
const autoSource = computed(() => s.groupSource({ ...props.group, source: undefined }))
/** Each shot rendered alone from its own keyframe ("Separate shots"), or the group as one clip (planning.rendersShotByShot). */
const shotByShot = computed(() => s.groupShotByShot(props.group))
/** …what it would do with the group's own choice set aside: Separate shots can be picked only then. */
const autoShotByShot = computed(() => s.groupShotByShot({ ...props.group, source: undefined }))
/** LTX renders a group shot by shot unless it is set to one clip (its multi-shot takes cut in the wrong places). */
const separateByDefault = computed(() => rendersSeparately(model.value, true))
/**
 * One clip: the group gets what Auto would make it from as its own choice — a set source is what makes it one clip.
 * Returns the group as it is then, for a render started right after.
 */
function oneClip(): StoryMultishot {
  if (!shotByShot.value) return props.group
  s.setGroupSource(props.group, autoSource.value)
  return { ...props.group, source: autoSource.value }
}
/** Separate shots: back to Auto, which renders them so (LTX, or later shots with keyframes of their own). */
function separate() {
  if (props.group.source) s.setGroupSource(props.group, undefined)
}
const setMode = (v: unknown) => (v === 'separate' ? separate() : v === 'one' && oneClip())
const separateBlocker = computed(() => {
  if (autoShotByShot.value) return undefined
  const label = model.value?.label ?? 'This model'
  return model.value && !model.value.params.some((p) => p.key === 'firstFrame')
    ? `${label} takes no start frame: the group renders as one clip`
    : `${label} renders a group as one clip until its later shots have stills of their own`
})
const animateOneClip = () => void s.run([s.planMultishot(oneClip())])
const sourceText = computed(() => (pickedSource.value && pickedSource.value === source.value ? sourceLabel(source.value, workflow.value) : `Auto · ${sourceLabel(source.value, workflow.value)}`))
const explanation = computed(() =>
  shotByShot.value
    ? separateByDefault.value
      ? `Animate renders each shot alone from its own still — ${model.value?.label ?? 'LTX'}’s multi-shot takes cut in the wrong places and swapped clothes. One clip renders the group as one take instead.`
      : `${s.groupShots(props.group).length > 2 ? 'Its later shots have' : 'Its second shot has'} a still of its own, so Animate renders each shot alone from its still — one clip could only start from the first. Pick One clip to render them as one clip instead.`
    : sourceExplanation(source.value, workflow.value, first.value),
)

// ---- what LTX from references still lacks: it copies what it is given, and invents what it isn't
const assets = useAssetsStore()
const assetReady = (id?: string) => Boolean(id && assets.get(id)?.status === 'ready')
const listed = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : (xs[0] ?? ''))
const missing = computed(() => {
  if (shotByShot.value || workflow.value.dialect !== 'ltx' || source.value !== 'references') return []
  const shots = s.groupShots(props.group)
  const cast = [...new Set(shots.flatMap(shotCast))]
    .map((id) => s.story.value.characters.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c) && !isUnseen(c!))
  const speakers = cast.filter((c) => shots.some((shot) => shot.dialogue.some((l) => l.characterId === c.id && l.text.trim())))
  const place = shots[0] && s.placeOf(shots[0])
  const out: string[] = []
  if (place && !place.refAssetIds?.some(assetReady)) out.push(`a photo of ${place.name} (Places) — without it every clip invents its own`)
  const noRef = cast.filter((c) => !assetReady(s.videoRefOf(c)))
  if (noRef.length) out.push(`video references for ${listed(noRef.map((c) => titleCase(c.name)))} (Cast) — LTX copies the background of the front view`)
  const noVoice = speakers.filter((c) => !assetReady(c.voiceSampleAssetId))
  if (noVoice.length) out.push(`voice samples for ${listed(noVoice.map((c) => titleCase(c.name)))} (Cast) — lines can go to the wrong voice`)
  return out
})
/**
 * Who the group's first shot leaves out (LTX from references): LTX opens on the reference pictures together, so a group
 * that starts on a close-up gets a stray opening shot — one that starts on everyone (a wide or two-shot) doesn't.
 */
const notOpening = computed(() => {
  if (shotByShot.value || workflow.value.dialect !== 'ltx' || source.value !== 'references') return []
  const shots = s.groupShots(props.group)
  const first = shots[0]
  if (!first) return []
  return [...new Set(shots.flatMap((shot) => shot.characterIds))]
    .filter((id) => !first.characterIds.includes(id))
    .map((id) => s.story.value.characters.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c) && !isUnseen(c!))
    .map((c) => titleCase(c.name))
})

// ---- the story's language vs. the group's model
const hasLines = computed(() => s.groupShots(props.group).some((shot) => shot.dialogue.some((l) => l.text.trim())))
const language = computed(() => storyLanguage(s.story.value))
const languageWarning = computed(() => {
  const m = model.value
  if (!m || !hasLines.value || !speaksAudio(m, s.renderSettings(m, false))) return undefined
  return speechWarning(m, workflow.value, language.value)
})
const speakingModel = computed(() =>
  languageWarning.value && language.value
    ? modelSpeaking(language.value, ready.value, { preferred: storyModel.value, except: model.value, settingsFor: (m) => s.renderSettings(m, false) })
    : undefined,
)
const switchToSpeaking = () => speakingModel.value && s.setGroupModel(props.group, speakingModel.value.id === storyModel.value?.id ? undefined : speakingModel.value.id)

// ---- takes side by side
const readyTakes = computed(() => takes.value.filter((t) => t.asset?.status === 'ready'))
const comparing = ref(false)
/** The compare dialog's players, by take. */
const players = new Map<string, HTMLVideoElement>()
const setPlayer = (id: string, el: unknown) => (el instanceof HTMLVideoElement ? players.set(id, el) : players.delete(id))
const mediaUrl = (asset: { id: string; variants: { proxy?: unknown } }) => `/media/${asset.id}/${asset.variants.proxy ? 'proxy' : 'original'}`
/** Every take from the start, together. */
function playAll() {
  for (const v of players.values()) {
    v.currentTime = 0
    void v.play().catch(() => undefined)
  }
}
/** What a take was made from, in its own model's words ("from Kling elements"). */
function takeSourceText(generationId: string): string | undefined {
  const source = s.takeSourceOf(generationId)
  const id = s.takeModelId(generationId)
  return source && `from ${sourceLabel(source, workflowFor(id ? getModel(id) : undefined)).toLowerCase()}`
}
</script>

<template>
  <div class="grid grid-cols-[minmax(0,1fr)] gap-2 rounded-xl bg-brand/10 p-2.5">
    <div class="flex flex-wrap items-center gap-2 text-xs">
      <Clapperboard class="size-4 shrink-0 text-brand" />
      <span class="font-medium">Multi-shot · shots {{ range }}</span>
      <span v-if="shotByShot" class="text-muted-foreground">each shot its own clip</span>
      <span v-else class="text-muted-foreground tabular">
        one {{ plan.total }} s clip, cuts about {{ plan.cuts.slice(1).map((c) => `${fmt(c.start)} s`).join(', ') }}
        <template v-if="planned > plan.total">(shots shortened from {{ planned }} s)</template>
      </span>
      <div class="flex-1" />
      <div class="flex items-center">
        <Button size="xs" variant="outline" class="rounded-r-none" :title="shotByShot ? 'Sets the group to One clip and renders it' : undefined" @click="animateOneClip">
          <Wand2 /> {{ takes.length && !shotByShot ? 'Another take' : 'Animate as one clip' }}
        </Button>
        <ModelPicker heading="Another take with…" :models="ready" :cost-of="costWith" :hint-of="hintWith" align="end" @pick="anotherTakeWith">
          <Button size="icon-xs" variant="outline" class="rounded-l-none border-l-0" title="Another take with another model (the group keeps its model)" aria-label="Another take with…">
            <ChevronDown />
          </Button>
        </ModelPicker>
      </div>
      <Button
        v-if="!shotByShot || chosen"
        size="xs"
        variant="outline"
        :disabled="Boolean(finalBlocker)"
        :title="finalBlocker ?? `Render the group again with ${finalModel!.label}; it becomes the chosen take when ready`"
        @click="finalModel && s.run([s.planGroupFinal(group)])"
      >
        <Sparkles /> Final render
      </Button>
      <Button size="xs" variant="ghost" title="Render these shots separately again" @click="s.breakUp(group)"><Unlink /> Break up</Button>
    </div>
    <!-- Which model renders the group, its shots separately or as one clip, and what the clip is made from: each model offers its own sources. -->
    <div class="flex items-start gap-2">
      <div class="grid shrink-0 gap-1">
        <ModelPicker
          heading="Render this group with…"
          :models="ready"
          :default-model="storyModel"
          with-default
          :selected="group.modelId && model?.id === group.modelId ? group.modelId : undefined"
          :cost-of="costWith"
          :hint-of="hintWith"
          @pick="(id) => s.setGroupModel(group, id)"
        >
          <Button size="xs" variant="outline" class="h-6 w-40 justify-between bg-transparent text-[11px] font-normal" :title="`Render with ${model?.label ?? 'no video model'}`" data-render-with="">
            <span class="flex min-w-0 items-center gap-1"><Cpu class="size-3 shrink-0 text-muted-foreground" /><span class="truncate">{{ model?.label ?? 'No video model' }}</span></span>
            <ChevronDown class="size-3 shrink-0 opacity-50" />
          </Button>
        </ModelPicker>
        <ToggleGroup type="single" size="sm" variant="outline" class="w-40" :model-value="shotByShot ? 'separate' : 'one'" data-group-mode="" @update:model-value="setMode">
          <ToggleGroupItem value="separate" class="h-6 flex-1 px-1 text-[11px]" :disabled="!shotByShot && Boolean(separateBlocker)" :title="separateBlocker ?? 'Each shot renders alone from its own still'">
            Separate shots
          </ToggleGroupItem>
          <ToggleGroupItem value="one" class="h-6 flex-1 px-1 text-[11px]" title="The group renders as one multi-shot clip">One clip</ToggleGroupItem>
        </ToggleGroup>
        <Select
          v-if="!shotByShot"
          :model-value="pickedSource ?? 'auto'"
          @update:model-value="(v) => s.setGroupSource(group, v === 'auto' ? undefined : (v as IdentitySource))"
        >
          <SelectTrigger size="sm" class="h-6 w-40 shrink-0 text-[11px] data-[size=sm]:h-6" title="What the clip is made from" data-group-source="">
            <span class="truncate">{{ sourceText }}</span>
          </SelectTrigger>
          <SelectContent>
            <!-- Auto renders the shots separately on LTX: that is the switch's other side. -->
            <SelectItem v-if="!autoShotByShot" value="auto">Auto · {{ sourceLabel(autoSource, workflow) }}</SelectItem>
            <SelectItem v-for="o in sourceOptions" :key="o.value" :value="o.value" :disabled="Boolean(o.blocker)">
              {{ o.label }}<span v-if="o.blocker" class="text-[11px] text-muted-foreground">— {{ o.blocker }}</span>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p class="text-[11px] leading-snug text-muted-foreground" data-source-explanation="">{{ explanation }}</p>
    </div>
    <div v-if="notOpening.length" class="flex items-start gap-1.5 rounded-lg bg-muted px-2 py-1 text-[11px] leading-snug" data-ltx-opening="">
      <Lightbulb class="mt-px size-3.5 shrink-0 text-muted-foreground" />
      <span>
        This clip starts on a shot without {{ listed(notOpening) }}: LTX may open on a stray shot of the reference pictures. Start the group on a wide or two-shot
        that shows everyone (cut away when assembling otherwise).
      </span>
    </div>
    <div v-if="missing.length" class="flex items-start gap-1.5 rounded-lg bg-muted px-2 py-1 text-[11px] leading-snug" data-ltx-missing="">
      <Lightbulb class="mt-px size-3.5 shrink-0 text-muted-foreground" />
      <span>For steadier takes add {{ missing.join('; ') }}.</span>
    </div>
    <div v-if="dialogueNotice" class="flex flex-wrap items-center gap-1.5 rounded-lg bg-role-effects/10 px-2 py-0.5 text-[11px]" data-dialogue-notice="">
      <AlertTriangle class="size-3.5 shrink-0 text-role-effects" /><span class="min-w-0 flex-1">{{ dialogueNotice }}</span>
      <Button size="xs" variant="ghost" title="Render these shots separately" @click="s.breakUp(group)"><Unlink /> Break up</Button>
    </div>
    <div v-if="limitProblem" class="flex items-center gap-1.5 rounded-lg bg-role-effects/10 px-2 py-0.5 text-[11px]" data-limit-warning="">
      <AlertTriangle class="size-3.5 shrink-0 text-role-effects" /><span>{{ limitProblem }}</span>
    </div>
    <div v-if="languageWarning" class="flex flex-wrap items-center gap-1.5 rounded-lg bg-role-effects/10 px-2 py-0.5 text-[11px]" data-language-warning="">
      <Languages class="size-3.5 shrink-0 text-role-effects" /><span>{{ languageWarning }}</span>
      <button v-if="speakingModel" type="button" class="font-medium text-brand underline-offset-2 hover:underline" @click="switchToSpeaking">
        Render this group with {{ speakingModel.label }} instead
      </button>
    </div>
    <div v-if="takes.length" class="flex flex-wrap items-center gap-1">
      <button
        v-for="(t, i) in takes"
        :key="t.id"
        type="button"
        :class="cn('relative flex h-10 w-16 items-center justify-center overflow-hidden rounded bg-viewer', t.asset && chosen?.id === t.asset.id && 'ring-2 ring-selection')"
        :title="
          t.state?.error ??
          [`Take ${i + 1}${s.isFinalTake(t.id) ? ' (final)' : ''}`, s.takeModelLabel(t.id)?.label, cutsLabel(t.id), 'click to use, double-click to preview'].filter(Boolean).join(' — ')
        "
        @click="t.asset && s.chooseGroupTake(group, t.asset.id)"
        @dblclick="t.asset && (preview = mediaUrl(t.asset))"
      >
        <img v-if="t.asset?.variants.poster" :src="`/media/${t.asset.id}/poster`" class="max-h-full max-w-full object-contain" alt="" />
        <Loader2 v-else-if="busy(t.state)" class="size-3.5 animate-spin text-brand" />
        <AlertTriangle v-else-if="failed(t.state)" class="size-3.5 text-destructive" />
        <Film v-else class="size-3.5 text-muted-foreground" />
        <span
          v-if="s.takeModelLabel(t.id)"
          class="absolute top-0.5 left-0.5 max-w-[calc(100%-4px)] truncate rounded-sm bg-black/60 px-1 text-[9px] leading-tight font-medium text-white"
          data-take-model=""
        >{{ s.takeModelLabel(t.id)!.short }}</span>
        <span v-if="s.isFinalTake(t.id)" class="absolute bottom-0.5 left-0.5 rounded-sm bg-brand px-1 text-[9px] leading-tight font-medium text-brand-foreground">Final</span>
      </button>
      <Button v-if="readyTakes.length >= 2" size="xs" variant="ghost" class="ml-1" title="The takes side by side" @click="comparing = true"><Columns2 /> Compare</Button>
      <span v-if="chosenCuts" class="ml-1 text-[11px] text-muted-foreground tabular">Chosen take: {{ chosenCuts }}</span>
    </div>

    <Dialog :open="Boolean(preview)" @update:open="(v) => !v && (preview = undefined)">
      <DialogContent class="sm:max-w-3xl">
        <DialogHeader><DialogTitle>Multi-shot · shots {{ range }}</DialogTitle></DialogHeader>
        <video v-if="preview" :src="preview" controls autoplay class="w-full rounded-md bg-black" />
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="comparing">
      <DialogContent class="sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>Compare takes · shots {{ range }}</DialogTitle>
          <DialogDescription class="flex items-center gap-2 text-xs">
            <span class="flex-1">Muted to start — unmute one to hear its lines.</span>
            <Button size="xs" variant="outline" @click="playAll"><Play /> Play all</Button>
          </DialogDescription>
        </DialogHeader>
        <div :class="cn('grid gap-3', readyTakes.length > 2 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')">
          <div v-for="t in readyTakes" :key="t.id" class="grid content-start gap-1.5">
            <video
              :ref="(el) => setPlayer(t.id, el)"
              :src="mediaUrl(t.asset!)"
              controls
              muted
              playsinline
              class="aspect-video w-full rounded-md bg-black"
            />
            <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span class="rounded-sm bg-field px-1.5 py-px font-medium" :title="s.takeModelLabel(t.id)?.label">{{ s.takeModelLabel(t.id)?.short ?? 'Unknown model' }}</span>
              <span v-if="s.isFinalTake(t.id)" class="rounded-sm bg-brand px-1 font-medium text-brand-foreground">Final</span>
              <span v-if="s.takeCostUsd(t.id) !== undefined" class="text-muted-foreground tabular">{{ formatUsd(s.takeCostUsd(t.id)) }}</span>
              <span v-if="takeSourceText(t.id)" class="text-muted-foreground">{{ takeSourceText(t.id) }}</span>
              <div class="flex-1" />
              <Button
                size="xs"
                :variant="chosen?.id === t.asset!.id ? 'secondary' : 'outline'"
                :disabled="chosen?.id === t.asset!.id"
                @click="s.chooseGroupTake(group, t.asset!.id)"
              >
                {{ chosen?.id === t.asset!.id ? 'Chosen' : 'Choose' }}
              </Button>
            </div>
            <div v-if="cutsLabel(t.id)" class="text-[11px] text-muted-foreground tabular">{{ cutsLabel(t.id) }}</div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
