<script setup lang="ts">
import { AlertTriangle, Film, Hourglass, ImageIcon, ImagePlus, LayoutGrid, Loader2, WandSparkles, X } from '@lucide/vue'
import type { StoryShot } from '@shared/types/story'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ASSET_DRAG_TYPE, readAssetDrag } from '@/features/assets/drag'
import AssetPickList from '@/features/generate/AssetPickList.vue'
import { COVERAGE_ANGLES, type CoverageAngle } from '@/features/generate/coverage'
import CoveragePicker from '@/features/generate/CoveragePicker.vue'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { inFlight, useStory } from '../useStory'
import { useShotRender } from './shotRender'

/**
 * The shot's pictures: its still (drop an image from the Library or Finder on it, or pick one), its earlier stills,
 * a change to the still in words, and its takes — click one to use it, double-click to watch.
 */
const props = defineProps<{ shot: StoryShot }>()
const emit = defineEmits<{ preview: [url: string, video: boolean] }>()
const s = useStory()
const assets = useAssetsStore()
const { starting, startRender } = useShotRender(() => props.shot.id)

const keyframe = computed(() => s.keyframeOf(props.shot))
const keyState = computed(() => s.jobState(props.shot.keyframeGenerationId))
const keyWaiting = computed(() => s.preparingOf(props.shot, 'keyframe'))
const history = computed(() => s.keyframeHistoryOf(props.shot))
const takes = computed(() => s.takesOf(props.shot))
const chosen = computed(() => s.chosenVideoOf(props.shot))
/** A keyframe to remove: a ready one, or one still rendering or failed. */
const hasKeyframe = computed(() => Boolean(keyframe.value || props.shot.keyframeGenerationId))
const busy = inFlight
// Not a canceled one: canceling isn't a failure.
const failed = (state?: { status: string }) => state && ['failed', 'needs_attention'].includes(state.status)

// An existing image as the still: picked from the Library, dragged from it, or a file from Finder.
const pickOpen = ref(false)
const dropping = ref(false)
function onDragOver(e: DragEvent) {
  const types = e.dataTransfer?.types
  if (!types?.includes(ASSET_DRAG_TYPE) && !types?.includes('Files')) return
  e.preventDefault()
  dropping.value = true
}
async function onDrop(e: DragEvent) {
  dropping.value = false
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'))
  if (file) {
    const [imported] = await assets.importFiles([file])
    // The upload is usually still processing: setKeyframe only takes a ready image.
    if (imported) s.setKeyframe(props.shot, (await assets.whenReady(imported.id).catch(() => imported)).id)
    return
  }
  const ids = readAssetDrag(e.dataTransfer)
  if (!ids) return
  // From a multi-asset drag, the first image.
  const image = ids.map((id) => assets.get(id)).find((a) => a?.kind === 'image')
  if (image) s.setKeyframe(props.shot, image.id)
  else toast.warning('Drop an image here to use it as the still')
}

// A change to the still in words: a new still made from this one.
const editBlocker = computed(() => s.imageEditBlocker())
const editText = ref('')
async function applyEdit() {
  if ((await startRender(() => [s.planKeyframeEdit(props.shot, editText.value)])) > 0) editText.value = ''
}

// More shots of this moment from the still (coverage): new shots after this one, each with its still drawn from it.
const coverageOpen = ref(false)
const coverageBusy = ref(false)
const coverageSample = computed(() => (coverageOpen.value && COVERAGE_ANGLES[0] ? s.planShotsFromStill(props.shot, [COVERAGE_ANGLES[0]])[0] : undefined))
const coverageBlocker = computed(() => (typeof coverageSample.value === 'string' ? coverageSample.value : undefined))
const coverageCost = computed(() => (coverageSample.value && typeof coverageSample.value !== 'string' ? (s.estimate([coverageSample.value]) ?? undefined) : undefined))
async function makeShots(angles: CoverageAngle[]) {
  coverageBusy.value = true
  try {
    const started = await s.shotsFromStill(props.shot, angles)
    if (started) {
      coverageOpen.value = false
      toast.success(`${angles.length} shot${angles.length === 1 ? '' : 's'} added after shot ${s.shotName(props.shot)}`, { description: 'Their stills are being drawn from this one.' })
    }
  } finally {
    coverageBusy.value = false
  }
}

/** The still is from before the shot was written again: keep it as it is ("Still · redo" goes). */
const keepStill = () => s.updateShot(props.shot.id, 'Keep the still', (x) => delete x.stillStale)

// The Blender previs (docs/blender-previs.md): LTX on the GPU follows its camera. Imported with the shot, or a video
// dropped here from the Library.
const previs = computed(() => (props.shot.previs ? assets.get(props.shot.previs.assetId) : undefined))
const previsDropping = ref(false)
function onPrevisDragOver(e: DragEvent) {
  if (!e.dataTransfer?.types.includes(ASSET_DRAG_TYPE)) return
  e.preventDefault()
  previsDropping.value = true
}
function onPrevisDrop(e: DragEvent) {
  previsDropping.value = false
  const video = readAssetDrag(e.dataTransfer)
    ?.map((id) => assets.get(id))
    .find((a) => a?.kind === 'video')
  if (!video) return void toast.warning('Drop a video here: the previs render the shot follows')
  s.updateShot(props.shot.id, 'Set the previs', (x) => (x.previs = { assetId: video.id }))
}
const removePrevis = () => s.updateShot(props.shot.id, 'Remove the previs', (x) => delete x.previs)
</script>

<template>
  <div class="grid content-start gap-2" data-shot-media="">
    <div :class="cn('group/keyframe relative rounded-xl', dropping && 'ring-2 ring-brand')" @dragover="onDragOver" @dragleave="dropping = false" @drop.prevent="onDrop">
      <button
        type="button"
        class="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl bg-viewer"
        :title="keyframe ? 'Still — double-click to preview, or drop an image from the Library to replace it' : 'No still yet — make one, or drop an image from the Library'"
        @dblclick="keyframe && emit('preview', `/media/${keyframe.id}/original`, false)"
      >
        <img v-if="keyframe?.variants.poster" :src="`/media/${keyframe.id}/poster`" :class="cn('max-h-full max-w-full object-contain', shot.stillStale && 'opacity-70')" alt="" />
        <Loader2 v-else-if="busy(keyState)" class="size-5 animate-spin text-brand" />
        <span v-else-if="keyWaiting" class="flex items-center gap-1 px-2 text-[11px] text-muted-foreground" data-keyframe-waiting=""><Hourglass class="size-3.5 shrink-0" /> waits for {{ keyWaiting }}</span>
        <AlertTriangle v-else-if="failed(keyState)" class="size-5 text-destructive" :title="keyState?.error" />
        <ImageIcon v-else class="size-5 text-muted-foreground/50" />
        <span class="absolute top-1.5 left-1.5 rounded-md bg-black/55 px-1.5 py-px text-[10px] font-medium text-white backdrop-blur-sm">Still</span>
        <span v-if="shot.stillStale" class="absolute bottom-1.5 left-1.5 rounded-md bg-role-effects px-1.5 py-px text-[10px] font-medium text-white">Still · redo</span>
      </button>
      <!-- A sibling, not inside the thumbnail: a button can't hold a button. -->
      <button
        v-if="hasKeyframe"
        type="button"
        class="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-md bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover/keyframe:opacity-100 hover:bg-destructive focus-visible:opacity-100"
        :title="busy(keyState) ? 'Cancel and remove this still' : 'Remove the still from this shot (the image stays in the Library)'"
        aria-label="Remove still"
        @click="s.removeKeyframe(shot)"
      >
        <X class="size-3" />
      </button>
    </div>
    <div v-if="shot.stillStale" class="flex flex-wrap items-center gap-1.5 rounded-lg bg-role-effects/10 px-2 py-1 text-[11px]" data-still-stale="">
      <span class="min-w-0 flex-1">The shot was written again after this still was drawn.</span>
      <button type="button" class="font-medium text-muted-foreground hover:text-foreground hover:underline" data-keep-still="" @click="keepStill">Keep this still</button>
    </div>
    <div class="flex flex-wrap items-center gap-1">
      <div v-for="h in history" :key="h.id" class="group/earlier relative">
        <button
          type="button"
          class="flex h-6 w-10 items-center justify-center overflow-hidden rounded-md bg-viewer opacity-60 transition-opacity hover:opacity-100"
          title="Earlier still — click to use it again"
          @click="s.restoreKeyframe(shot, h.id)"
        >
          <img v-if="h.asset?.variants.poster" :src="`/media/${h.asset.id}/poster`" class="max-h-full max-w-full object-contain" alt="" />
          <Loader2 v-else class="size-3 animate-spin text-brand" />
        </button>
        <button
          type="button"
          class="absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-foreground text-background opacity-0 transition-opacity group-hover/earlier:opacity-100 hover:bg-destructive hover:text-white focus-visible:opacity-100"
          title="Remove this earlier still"
          aria-label="Remove earlier still"
          @click="s.forgetKeyframe(shot, h.id)"
        >
          <X class="size-2.5" />
        </button>
      </div>
      <div class="flex-1" />
      <Popover v-model:open="coverageOpen">
        <PopoverTrigger as-child>
          <Button
            size="xs"
            variant="ghost"
            class="text-muted-foreground"
            :disabled="keyframe?.status !== 'ready'"
            title="More shots of this moment from the still — a wide, a close-up, the reverse… — each a new shot after this one"
            data-shots-from-still=""
          >
            <LayoutGrid /> Shots from still
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" side="left" class="w-[26rem] p-2.5">
          <div class="mb-2 text-xs font-medium">Shots from this still</div>
          <CoveragePicker
            v-if="keyframe"
            :src="`/media/${keyframe.id}/${keyframe.variants.display ? 'display' : 'poster'}`"
            :cost-each="coverageCost"
            :blocker="coverageBlocker"
            :busy="coverageBusy"
            what="each a new shot after this one, with its still"
            @make="makeShots"
          />
        </PopoverContent>
      </Popover>
      <Popover v-model:open="pickOpen">
        <PopoverTrigger as-child>
          <Button size="xs" variant="ghost" class="text-muted-foreground" title="Use an image from the Library as the still"><ImagePlus /> From Library</Button>
        </PopoverTrigger>
        <PopoverContent align="end" class="w-80 p-2">
          <AssetPickList
            kind="image"
            :selected="keyframe?.id"
            @pick="
              (id) => {
                s.setKeyframe(shot, id)
                pickOpen = false
              }
            "
          />
        </PopoverContent>
      </Popover>
    </div>
    <form v-if="keyframe" class="flex items-center gap-1" @submit.prevent="applyEdit">
      <Input v-model="editText" placeholder="Change the still… (e.g. remove the car)" class="h-7 min-w-0 flex-1 text-xs" :disabled="Boolean(editBlocker)" :title="editBlocker" />
      <Button
        type="submit"
        size="icon-xs"
        variant="outline"
        class="size-7"
        :disabled="Boolean(editBlocker) || !editText.trim() || busy(keyState) || Boolean(keyWaiting) || starting"
        :title="editBlocker ?? 'Apply the change — a new still made from this one'"
        aria-label="Apply the change to the still"
      >
        <WandSparkles />
      </Button>
    </form>

    <div
      :class="cn('grid gap-1 rounded-lg', previsDropping && 'ring-2 ring-brand')"
      data-shot-previs=""
      @dragover="onPrevisDragOver"
      @dragleave="previsDropping = false"
      @drop.prevent="onPrevisDrop"
    >
      <span class="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Previs</span>
      <div v-if="shot.previs" class="flex items-center gap-1.5">
        <button
          type="button"
          class="relative flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-viewer"
          :title="[shot.previs.source ?? 'Blender previs', 'the video follows its camera — double-click to watch'].join(' — ')"
          @dblclick="previs && emit('preview', `/media/${previs.id}/${previs.variants.proxy ? 'proxy' : 'original'}`, true)"
        >
          <img v-if="previs?.variants.poster" :src="`/media/${previs.id}/poster`" class="max-h-full max-w-full object-contain" alt="" />
          <Film v-else class="size-3.5 text-muted-foreground" />
        </button>
        <span
          class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
          :title="shot.previs.firstFrameAssetId ? 'The still is drawn over the previs’s first frame: its camera and blocking, in the story’s look' : undefined"
          >{{ shot.previs.source ?? 'Camera guide' }}{{ shot.previs.depthAssetId ? ' · depth' : '' }}{{ shot.previs.firstFrameAssetId ? ' · still drawn over it' : '' }}</span
        >
        <button
          type="button"
          class="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive hover:text-white"
          title="Remove the previs from this shot (the video stays in the Library)"
          aria-label="Remove previs"
          @click="removePrevis"
        >
          <X class="size-3" />
        </button>
      </div>
      <p v-else class="text-[11px] text-muted-foreground">Drop a Blender previs from the Library: LTX on the GPU follows its camera.</p>
    </div>

    <div class="grid gap-1">
      <span class="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Takes</span>
      <div v-if="takes.length" class="flex flex-wrap gap-1" data-shot-takes="">
        <button
          v-for="(t, i) in takes"
          :key="t.id"
          type="button"
          :class="cn('relative flex h-10 w-16 items-center justify-center overflow-hidden rounded-lg bg-viewer', t.asset && chosen?.id === t.asset.id && 'ring-2 ring-selection')"
          :title="t.state?.error ?? [`Take ${i + 1}${s.isFinalTake(t.id) ? ' (final)' : ''}`, s.takeModelLabel(t.id)?.label, 'click to use, double-click to watch'].filter(Boolean).join(' — ')"
          :aria-pressed="Boolean(t.asset && chosen?.id === t.asset.id)"
          @click="t.asset && s.chooseTake(shot, t.asset.id)"
          @dblclick="t.asset && emit('preview', `/media/${t.asset.id}/${t.asset.variants.proxy ? 'proxy' : 'original'}`, true)"
        >
          <img v-if="t.asset?.variants.poster" :src="`/media/${t.asset.id}/poster`" class="max-h-full max-w-full object-contain" alt="" />
          <Loader2 v-else-if="busy(t.state)" class="size-3.5 animate-spin text-brand" />
          <AlertTriangle v-else-if="failed(t.state)" class="size-3.5 text-destructive" />
          <Film v-else class="size-3.5 text-muted-foreground" />
          <span
            v-if="s.takeModelLabel(t.id)"
            class="absolute top-0.5 left-0.5 max-w-[calc(100%-4px)] truncate rounded-sm bg-black/60 px-1 text-[9px] leading-tight font-medium text-white"
            data-take-model=""
            >{{ s.takeModelLabel(t.id)!.short }}</span
          >
          <span v-if="s.isFinalTake(t.id)" class="absolute bottom-0.5 left-0.5 rounded-sm bg-brand px-1 text-[9px] leading-tight font-medium text-brand-foreground">Final</span>
        </button>
      </div>
      <p v-else class="text-[11px] text-muted-foreground">No takes yet{{ s.groupOf(shot) && !s.groupShotByShot(s.groupOf(shot)!) ? ' — the multi-shot above makes them' : '' }}.</p>
    </div>
  </div>
</template>
