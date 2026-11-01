<script setup lang="ts">
import { ChevronDown, Cpu, Hourglass, ImageIcon, Loader2, Plus, Sparkles, Video, Wand2, X } from '@lucide/vue'
import type { ModelSpec } from '@shared/models/types'
import type { StoryShot } from '@shared/types/story'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { readAssetDrag } from '@/features/assets/drag'
import ModelPicker from '@/features/generate/ModelPicker.vue'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { endingOf } from '../dialects'
import { endState, endStateText } from '../endFrame'
import { modelHint, storyboardModels } from '../modelInfo'
import { continuing } from '../sceneRun'
import { inFlight, useStory } from '../useStory'
import { costLabel, useShotRender } from './shotRender'
import ShotCompiled from './ShotCompiled.vue'

/**
 * The shot's two prompts, as the Director wrote them and as you change them: the still's (what the first frame shows
 * — StoryShot.frame; without one the still is drawn from the video prompt) and the video's (what happens, the camera,
 * how it ends — StoryShot.prompt), with an optional end frame between them. New still, Animate and Final make them;
 * Show what the models get shows the prompts as sent, with their pictures.
 */
const props = defineProps<{ shot: StoryShot }>()
const s = useStory()
const assets = useAssetsStore()
const { starting, startRender } = useShotRender(() => props.shot.id)
const busy = inFlight

function edit(label: string, mutate: (shot: StoryShot) => void) {
  s.updateShot(props.shot.id, label, mutate)
}

// ---- the still
const keyframe = computed(() => s.keyframeOf(props.shot))
const keyState = computed(() => s.jobState(props.shot.keyframeGenerationId))
const keyWaiting = computed(() => s.preparingOf(props.shot, 'keyframe'))
const imageModel = computed(() => s.modelFor('image'))
/** No still prompt of its own: the still is drawn from the video prompt (imagePrompt). */
const stillFromVideo = computed(() => !props.shot.frame?.trim())
const stillText = computed(() => props.shot.frame?.trim() || props.shot.prompt)
function setStill(e: Event) {
  const text = (e.target as HTMLTextAreaElement).value.trim()
  // Left as shown (the video prompt): still none of its own.
  if (stillFromVideo.value && text === props.shot.prompt.trim()) return
  edit('Still prompt', (x) => (x.frame = text || undefined))
}
const stillPlan = computed(() => s.planKeyframe(props.shot))
const stillCost = computed(() => costLabel([stillPlan.value]))
const stillBlocker = computed(() => (typeof stillPlan.value === 'string' ? stillPlan.value : undefined))
const newStill = () => startRender(() => [s.planKeyframe(props.shot)])

// ---- the end frame (optional): drawn from the still, the clip lands on it
const endKeyframe = computed(() => s.endKeyframeOf(props.shot))
const endJob = computed(() => s.jobState(props.shot.endKeyframeGenerationId))
const endWaiting = computed(() => s.preparingOf(props.shot, 'end'))
const addingEnd = ref(false)
watch(
  () => props.shot.id,
  () => (addingEnd.value = false),
)
const showEnd = computed(() => Boolean(addingEnd.value || props.shot.endFrame || endKeyframe.value || props.shot.endKeyframeGenerationId))
const endBlocker = computed(() => {
  const plan = s.planEndKeyframe(props.shot)
  return typeof plan === 'string' ? plan : undefined
})
/**
 * What becomes of the end picture (endState): measured against the still once both are drawn (checkEndFrame), it goes
 * with the clip only as the same camera with a visible change — one line, and at most two ways out.
 */
const startReady = computed(() => (keyframe.value?.status === 'ready' ? keyframe.value.id : undefined))
const endReady = computed(() => (endKeyframe.value?.status === 'ready' ? endKeyframe.value.id : undefined))
const lipSynced = computed(() => Boolean(keyframe.value && s.followsVoices(props.shot)))
const endNow = computed(() => endState(props.shot, startReady.value, endReady.value))
const endUserCall = computed(() => Boolean(endReady.value && props.shot.endUse))
const endLine = computed(() => {
  const state = endNow.value
  if (!state) return undefined
  if (state === 'unchecked' && s.checkingEnd(props.shot)) return 'Comparing with the still…'
  return endStateText(state, props.shot.endCheck?.ssim, { lipSync: lipSynced.value, userCall: endUserCall.value })
})
const endWarn = computed(() => !lipSynced.value && !endUserCall.value && (endNow.value === 'same' || endNow.value === 'recomposed'))
const endActions = computed((): { label: string; title: string; run: () => void; disabled?: boolean }[] => {
  const state = endNow.value
  if (!state || lipSynced.value) return []
  const sendAnyway = { label: 'Send anyway', title: 'Send the end picture as the clip’s last frame all the same', run: () => s.setEndUse(props.shot, 'image') }
  if (endUserCall.value) return [{ label: 'By the check', title: 'Let the comparison with the still decide again', run: () => s.setEndUse(props.shot, undefined) }]
  if (state === 'same') {
    const redraw = () => void startRender(() => [s.planEndKeyframe(props.shot)])
    return [{ label: 'Redraw', title: 'Draw the end frame again from the still, with a bigger change', run: redraw, disabled: Boolean(endBlocker.value) || busy(endJob.value) || starting.value }, sendAnyway]
  }
  if (state === 'recomposed') return [{ label: 'Split into two shots', title: 'The next shot starts from the end picture; this one ends where it will', run: () => s.splitAtEnd(props.shot) }, sendAnyway]
  if (state === 'image') return [{ label: 'Text only', title: 'Keep the end picture back: only its description goes into the prompt', run: () => s.setEndUse(props.shot, 'text') }]
  return []
})
/** What the prompt says of how the shot ends, whether or not the picture goes (endingOf). */
const ending = computed(() => endingOf(props.shot))
const endDropping = ref(false)
async function onEndDrop(e: DragEvent) {
  endDropping.value = false
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'))
  if (file) {
    const [imported] = await assets.importFiles([file])
    if (imported) s.setEndKeyframe(props.shot, (await assets.whenReady(imported.id).catch(() => imported)).id)
    return
  }
  const image = (readAssetDrag(e.dataTransfer) ?? []).map((id) => assets.get(id)).find((a) => a?.kind === 'image')
  if (image) s.setEndKeyframe(props.shot, image.id)
  else toast.warning('Drop an image here to use it as the end frame')
}
function removeEnd() {
  if (endKeyframe.value || props.shot.endKeyframeGenerationId) s.removeEndKeyframe(props.shot)
  if (props.shot.endFrame) edit('End frame', (x) => delete x.endFrame)
  addingEnd.value = false
}

// ---- the take
const group = computed(() => s.groupOf(props.shot))
/** Its group renders it as part of one clip: rendered shot by shot (LTX), the shot animates and finals as one of its own. */
const oneClip = computed(() => Boolean(group.value && !s.groupShotByShot(group.value)))
const takes = computed(() => s.takesOf(props.shot))
const takeWaiting = computed(() => s.preparingOf(props.shot, 'take'))
const videoModel = computed(() => s.modelForShot(props.shot))
/** Its takes start where the previous shot's take ends (planContinued), not from its still. */
const continues = computed(() => continuing(s.story.value, props.shot))
const hasPreviousEnd = computed(() => Boolean(s.previousEnd(props.shot)))
const continueBlocker = computed(() => (continues.value && !hasPreviousEnd.value ? 'The shot before has no take to continue from yet' : undefined))
const videoPlan = computed(() => s.planVideo(props.shot))
const videoCost = computed(() => costLabel([videoPlan.value]))
/**
 * Animate, Another take, Final: a continuing shot starts where the previous shot's take ends (planContinued), as
 * Animate scene starts it — from its still it cut where it should run on.
 */
const animate = () => startRender(async () => [continues.value ? await s.planContinued(props.shot) : s.planVideo(props.shot)])

// Draft → final: the same still, prompt and sound, rendered with the final model (or the chosen take's own family).
const finalModel = computed(() => s.finalModelForShot(props.shot))
const finalBlocker = computed(() => (finalModel.value ? s.shotFinalBlocker(props.shot) : 'Pick a final model in Models (top right of Plan)'))
const finalCost = computed(() => (finalModel.value && !finalBlocker.value ? costLabel([s.planShotFinal(props.shot)]) : ''))
function finalRender() {
  const model = finalModel.value
  if (!model) return
  void startRender(async () => [continues.value ? await s.planContinued(props.shot, { model, final: true }) : s.planShotFinal(props.shot)])
}

// "Render with…" (a shot in a group follows the group's model): the model, its longest clip, what a take costs with each.
const storyModel = computed(() => s.modelFor('video'))
const ready = computed(() => storyboardModels(s.readyVideoModels()))
function costWith(m: ModelSpec): number | null | string {
  const p = s.planVideo(props.shot, { model: m })
  return typeof p === 'string' ? p : s.estimate([p])
}
const hintWith = (m: ModelSpec) => modelHint(s.workflowOf(m)) + (props.shot.duration > s.workflowOf(m).multishot.maxSeconds ? ' · shortened' : '')

const showCompiled = ref(false)
const label = 'flex items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase'
</script>

<template>
  <div class="grid content-start gap-3" data-shot-prompts="">
    <section class="grid gap-1.5" data-still-prompt="">
      <div class="flex flex-wrap items-baseline gap-x-2">
        <span :class="label"><ImageIcon class="size-3" /> Still prompt</span>
        <span class="truncate text-[11px] text-muted-foreground">what the frame shows · {{ imageModel?.label ?? 'no image model' }}</span>
      </div>
      <Textarea
        :model-value="stillText"
        rows="3"
        placeholder="The first moment as one picture — who is where in the frame, which way each faces the camera, pose and expression, what is behind them"
        :class="cn('min-h-0 text-xs leading-relaxed', stillFromVideo && 'text-muted-foreground')"
        aria-label="Still prompt"
        data-shot-frame=""
        @change="setStill"
      />
      <p v-if="stillFromVideo && shot.prompt.trim()" class="text-[11px] text-muted-foreground">From the video prompt — the still has none of its own. Edit it to give the still its own.</p>
      <div class="flex flex-wrap items-center gap-1.5">
        <Button
          size="xs"
          variant="outline"
          :disabled="busy(keyState) || Boolean(keyWaiting) || starting || Boolean(stillBlocker)"
          :title="stillBlocker ?? (keyWaiting ? `Waits for ${keyWaiting}` : 'Draw the still from this prompt, with the cast’s and the place’s pictures')"
          data-shot-new-still=""
          @click="newStill"
        >
          <Loader2 v-if="busy(keyState)" class="animate-spin" /><ImageIcon v-else /> {{ keyframe ? 'New still' : 'Make the still' }}{{ stillCost }}
        </Button>
        <button v-if="!showEnd" type="button" class="flex items-center gap-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground" data-add-end-frame="" @click="addingEnd = true">
          <Plus class="size-3" /> End frame
        </button>
      </div>
    </section>

    <section v-if="showEnd" class="grid gap-1.5" data-end-frame="">
      <div class="flex items-baseline gap-2">
        <span :class="label">End frame</span>
        <span class="truncate text-[11px] text-muted-foreground">optional · the shot’s last moment, the same camera</span>
        <div class="flex-1" />
        <button type="button" class="text-[11px] text-muted-foreground hover:text-foreground" title="No end frame: the clip ends where it will" @click="removeEnd"><X class="inline size-3" /> Remove</button>
      </div>
      <Textarea
        :model-value="shot.endFrame ?? ''"
        rows="2"
        placeholder="What changed and what is no longer where it was, then the last moment as one picture. Its first sentence goes into the video prompt."
        class="min-h-0 text-xs leading-relaxed"
        aria-label="End frame"
        data-shot-end-frame=""
        @change="(e: Event) => edit('End frame', (x) => (x.endFrame = (e.target as HTMLTextAreaElement).value.trim() || undefined))"
      />
      <div v-if="shot.endFrame || endKeyframe || shot.endKeyframeGenerationId" class="flex items-center gap-2" data-shot-end-keyframe="">
        <div
          :class="cn('relative aspect-video w-28 shrink-0 overflow-hidden rounded-md bg-muted', endDropping && 'ring-2 ring-brand')"
          title="Drop an image here to use it as the end frame"
          @dragover.prevent="endDropping = true"
          @dragleave="endDropping = false"
          @drop.prevent="onEndDrop"
        >
          <img v-if="endKeyframe?.status === 'ready'" :src="`/media/${endKeyframe.id}/poster`" class="size-full object-cover" alt="" />
          <div v-else-if="busy(endJob)" class="flex size-full items-center justify-center"><Loader2 class="size-4 animate-spin text-muted-foreground" /></div>
          <div v-else-if="endWaiting" class="flex size-full items-center justify-center" :title="`Waits for ${endWaiting}`"><Hourglass class="size-4 text-muted-foreground" /></div>
          <div v-else class="flex size-full items-center justify-center text-[10px] text-muted-foreground">End frame</div>
        </div>
        <div class="grid gap-1">
          <Button
            size="xs"
            variant="outline"
            :disabled="Boolean(endBlocker) || busy(endJob) || Boolean(endWaiting) || starting"
            :title="endBlocker ?? (endWaiting && `Waits for ${endWaiting}`)"
            @click="startRender(() => [s.planEndKeyframe(shot)])"
          >
            <ImageIcon /> {{ endKeyframe ? 'New end frame' : 'Draw end frame' }}
          </Button>
          <Button v-if="endKeyframe || shot.endKeyframeGenerationId" size="xs" variant="ghost" @click="s.removeEndKeyframe(shot)"><X /> Remove picture</Button>
        </div>
        <div class="grid min-w-0 gap-0.5 text-[10px] leading-snug" data-end-verdict="">
          <span :class="endWarn ? 'text-role-effects' : 'text-muted-foreground'">{{ endLine }}</span>
          <div v-if="endActions.length" class="flex flex-wrap gap-1">
            <Button v-for="a in endActions" :key="a.label" size="xs" variant="ghost" class="h-5 px-1.5 text-[10px]" :title="a.title" :disabled="a.disabled" @click="a.run">{{ a.label }}</Button>
          </div>
          <span v-if="ending" class="line-clamp-2 text-muted-foreground" :title="ending">Ending in the prompt: {{ ending }}</span>
        </div>
      </div>
    </section>

    <section class="grid gap-1.5" data-video-prompt="">
      <div class="flex flex-wrap items-baseline gap-x-2">
        <span :class="label"><Video class="size-3" /> Video prompt</span>
        <span class="truncate text-[11px] text-muted-foreground">what happens, the camera, how it ends · {{ videoModel?.label ?? 'no video model' }}{{ continues ? ' from the take before' : keyframe ? ' from the still' : '' }}</span>
      </div>
      <Textarea
        :model-value="shot.prompt"
        rows="3"
        placeholder="Action, in beats and with names only — looks come from the Cast, light and positions from the scene, the move from Camera"
        class="min-h-0 text-xs leading-relaxed"
        aria-label="Video prompt"
        data-shot-prompt=""
        @change="(e: Event) => edit('Video prompt', (x) => (x.prompt = (e.target as HTMLTextAreaElement).value))"
      />
      <div class="flex flex-wrap items-center gap-1.5">
        <Button
          size="xs"
          variant="outline"
          :disabled="starting || Boolean(takeWaiting) || Boolean(continueBlocker)"
          :title="
            oneClip
              ? 'This shot alone, without the cuts around it — animate the multi-shot above to keep the scene continuous'
              : (continueBlocker ?? (takeWaiting ? `Its take waits for ${takeWaiting}` : continues ? 'Starts where the previous shot’s take ends' : undefined))
          "
          data-shot-animate=""
          @click="animate"
        >
          <Wand2 /> {{ oneClip ? 'Animate alone' : takes.length ? 'Another take' : 'Animate' }}{{ videoCost }}
        </Button>
        <Button
          v-if="!oneClip"
          size="xs"
          variant="outline"
          :disabled="Boolean(finalBlocker) || Boolean(continueBlocker) || starting"
          :title="finalBlocker ?? continueBlocker ?? `Render this shot again with ${finalModel!.label}; it becomes the chosen take when ready`"
          data-shot-final=""
          @click="finalRender"
        >
          <Sparkles /> Final{{ finalModel ? ` · ${finalModel.label}` : '' }}{{ finalCost }}
        </Button>
        <template v-if="!group">
          <div class="flex-1" />
          <ModelPicker
            heading="Render this shot with…"
            :models="ready"
            :default-model="storyModel"
            with-default
            :selected="shot.modelId && videoModel?.id === shot.modelId ? shot.modelId : undefined"
            :cost-of="costWith"
            :hint-of="hintWith"
            align="end"
            @pick="(id) => s.setShotModel(shot, id)"
          >
            <Button size="xs" variant="ghost" class="max-w-52 text-muted-foreground" :title="`Render with ${videoModel?.label ?? 'no video model'}`" data-render-with="">
              <Cpu /><span class="truncate">{{ videoModel?.label ?? 'No video model' }}</span><ChevronDown class="opacity-50" />
            </Button>
          </ModelPicker>
        </template>
      </div>
    </section>

    <div class="grid gap-1.5">
      <button type="button" class="justify-self-start text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" :aria-expanded="showCompiled" data-show-compiled="" @click="showCompiled = !showCompiled">
        {{ showCompiled ? 'Hide' : 'Show' }} what the models get
      </button>
      <ShotCompiled v-if="showCompiled" :shot="shot" />
    </div>
  </div>
</template>
