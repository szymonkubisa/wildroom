<script setup lang="ts">
import { Brush, Loader2, X } from '@lucide/vue'
import { getModel } from '@shared/models/registry'
import { flicksToSeconds } from '@shared/time/flicks'
import { type MediaClip, activeTake } from '@shared/types/project-doc'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { layersAt } from '@/engine/scene'
import { currentFrame } from '@/features/editor/transport'
import { useTimelineCommands } from '@/features/timeline/commands'
import { api, errorMessage } from '@/lib/api'
import { useAssetsStore } from '@/stores/assets'
import { useEditorStore } from '@/stores/editor'
import { useGenerateStore } from '@/stores/generate'
import { useProjectStore } from '@/stores/project'

const open = defineModel<boolean>('open', { default: false })
const editor = useEditorStore()
const project = useProjectStore()
const assets = useAssetsStore()
const commands = useTimelineCommands()

const clip = ref<MediaClip>()
const frameId = ref<string>()
const loading = ref(false)
const instruction = ref('')
/** Marked region as fractions of the frame. */
const region = ref<{ x: number; y: number; w: number; h: number }>()
/** Where the frame sits in the 16:9 box, as fractions of it: object-contain letterboxes a portrait or square shot. */
const fit = ref({ x: 0, y: 0, w: 1, h: 1 })

const PRESETS = [
  { label: 'Remove', text: 'Remove the marked object and fill in the background naturally' },
  { label: 'Replace', text: 'Replace the marked object with ' },
  { label: 'Recolour', text: 'Change the colour of the marked object to ' },
  { label: 'Add', text: 'Add ' },
  { label: 'New background', text: 'Replace the background with ' },
  { label: 'Relight', text: 'Relight the scene as ' },
]

/** Topmost video clip under the playhead (or the selected clip), and the frame shown there. */
async function prepare() {
  frameId.value = undefined
  region.value = undefined
  fit.value = { x: 0, y: 0, w: 1, h: 1 }
  instruction.value = ''
  const scene = commands.currentScene()
  const frame = currentFrame()
  const layers = [...layersAt(scene, frame)].reverse().filter((l) => l.kind === 'media' && l.assetId && !l.still)
  const layer = layers.find((l) => editor.selection.includes(l.clipId)) ?? layers[0]
  const c = layer ? commands.findClip(layer.clipId) : undefined
  if (!layer?.assetId || c?.kind !== 'media' || !assets.projectId) {
    toast.warning('Put the playhead over a video shot first')
    open.value = false
    return
  }
  clip.value = c
  loading.value = true
  try {
    const seconds = layer.sourceStart + ((frame + 0.5 - layer.start) / scene.fps) * layer.speed
    const still = await api.assets.frame(assets.projectId, layer.assetId, seconds, `${c.name ?? 'Shot'} — frame to edit`)
    assets.upsert(still)
    frameId.value = still.id
  } catch (err) {
    toast.error('Could not grab the frame', { description: errorMessage(err) })
    open.value = false
  } finally {
    loading.value = false
  }
}

watch(open, (v) => v && void prepare(), { immediate: true })

// ---- region drawing
const box = ref<HTMLDivElement>()
let origin: { x: number; y: number } | undefined
function onImageLoad(e: Event) {
  const img = e.target as HTMLImageElement
  const el = box.value
  if (!el?.clientHeight || !img.naturalWidth || !img.naturalHeight) return
  const ratio = img.naturalWidth / img.naturalHeight / (el.clientWidth / el.clientHeight)
  const w = Math.min(1, ratio)
  const h = Math.min(1, 1 / ratio)
  fit.value = { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
}
/** Pointer position as fractions of the frame itself, not of the box around it (a 9:16 shot fills only its middle). */
function point(e: PointerEvent) {
  const r = box.value!.getBoundingClientRect()
  const f = fit.value
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  return { x: clamp(((e.clientX - r.left) / r.width - f.x) / f.w), y: clamp(((e.clientY - r.top) / r.height - f.y) / f.h) }
}
function onDown(e: PointerEvent) {
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  origin = point(e)
  region.value = { ...origin, w: 0, h: 0 }
}
function onMove(e: PointerEvent) {
  if (!origin) return
  const p = point(e)
  region.value = { x: Math.min(origin.x, p.x), y: Math.min(origin.y, p.y), w: Math.abs(p.x - origin.x), h: Math.abs(p.y - origin.y) }
}
function onUp() {
  origin = undefined
  if (region.value && (region.value.w < 0.02 || region.value.h < 0.02)) region.value = undefined
}

/** Plain-language location of the marked region (image models follow words better than coordinates). */
const regionText = computed(() => {
  const r = region.value
  if (!r) return ''
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const h = cx < 0.36 ? 'left' : cx > 0.64 ? 'right' : 'centre'
  const v = cy < 0.36 ? 'top' : cy > 0.64 ? 'bottom' : 'middle'
  const where = v === 'middle' && h === 'centre' ? 'the centre' : v === 'middle' ? `the ${h} side` : h === 'centre' ? `the ${v}` : `the ${v}-${h}`
  const size = r.w * r.h > 0.25 ? 'a large area' : r.w * r.h > 0.06 ? 'a medium area' : 'a small area'
  return `The marked object is in ${where} of the frame (${size}, about ${Math.round(r.x * 100)}–${Math.round((r.x + r.w) * 100)}% across and ${Math.round(r.y * 100)}–${Math.round((r.y + r.h) * 100)}% down).`
})

function submit() {
  const c = clip.value
  if (!c || !frameId.value || !instruction.value.trim()) return
  const asset = assets.get(activeTake(c)?.assetId)
  const prompt = [instruction.value.trim(), regionText.value, 'Keep everything else in the image exactly the same: composition, people, lighting and style.']
    .filter(Boolean)
    .join(' ')
  const originalPrompt = asset?.generation?.prompt ?? ''
  let videoModel = asset?.generation ? getModel(asset.generation.modelId) : undefined
  if (videoModel && videoModel.kind !== 'video') videoModel = undefined
  const seconds = Math.min(15, Math.max(3, (c.duration / project.fps) * c.speed || flicksToSeconds(asset?.durationFlicks ?? 0)))
  useGenerateStore().open('image', {
    params: { prompt, referenceImages: [frameId.value] },
    target: {
      label: 'Step 1 of 2: edits the frame — then the shot is re-animated from it as a new take',
      chain: {
        clipId: c.id,
        prompt: [originalPrompt, instruction.value.trim()].filter(Boolean).join(' '),
        // Only reuse the shot's model when it makes video (an upscale or lip-sync take can't animate a frame).
        videoModelId: videoModel?.id,
        seconds,
      },
    },
  })
  editor.select([c.id])
  open.value = false
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2"><Brush class="size-4" /> Edit inside the shot</DialogTitle>
        <DialogDescription>
          Mark what to change on the frame under the playhead and describe the change. The frame is edited with an image model, then the
          shot is re-generated from it as a new take (you confirm both steps).
        </DialogDescription>
      </DialogHeader>
      <div
        ref="box"
        class="relative aspect-video w-full cursor-crosshair overflow-hidden rounded-md border bg-viewer select-none"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
      >
        <div v-if="loading || !frameId" class="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 class="size-4 animate-spin" /></div>
        <img v-else :src="`/media/${frameId}/original`" class="pointer-events-none h-full w-full object-contain" alt="" @load="onImageLoad" />
        <div
          v-if="region"
          class="pointer-events-none absolute border-2 border-brand bg-brand/20 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
          :style="{
            left: `${(fit.x + region.x * fit.w) * 100}%`,
            top: `${(fit.y + region.y * fit.h) * 100}%`,
            width: `${region.w * fit.w * 100}%`,
            height: `${region.h * fit.h * 100}%`,
          }"
        />
        <button v-if="region" class="absolute top-2 right-2 rounded bg-black/60 p-1 text-white" title="Clear the marked area" @pointerdown.stop @click="region = undefined">
          <X class="size-3.5" />
        </button>
        <span v-if="!region && frameId" class="pointer-events-none absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white/90">
          Drag to mark the area to change (optional)
        </span>
      </div>
      <div class="flex flex-wrap gap-1">
        <button
          v-for="p in PRESETS"
          :key="p.label"
          type="button"
          class="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          @click="instruction = p.text"
        >
          {{ p.label }}
        </button>
      </div>
      <Textarea v-model="instruction" rows="2" placeholder="e.g. Remove the parked car · Make her jacket red · Add falling snow" class="text-sm" />
      <p v-if="regionText" class="text-[11px] text-muted-foreground">{{ regionText }}</p>
      <DialogFooter>
        <Button variant="ghost" @click="open = false">Cancel</Button>
        <Button :disabled="!frameId || !instruction.trim()" @click="submit">Continue in the Composer…</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
