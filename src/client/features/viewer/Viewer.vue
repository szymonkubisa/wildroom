<script setup lang="ts">
import {
  Camera,
  Maximize,
  Pause,
  Play,
  Rewind,
  FastForward,
  ListVideo,
  SkipBack,
  SkipForward,
  SquareDashed,
  X,
} from '@lucide/vue'
import { flicksToSeconds } from '@shared/time/flicks'
import { formatTimecode } from '@shared/time/timecode'
import { activeTimelineName } from '@shared/timeline/timelines'
import { activeTake } from '@shared/types/project-doc'
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { defaultMix } from '@shared/types/project-doc'
import { buildScene } from '@/engine/buildScene'
import { stillUrls } from '@/engine/canvasDraw'
import { playheadBus } from '@/engine/playhead'
import { Player } from '@/engine/player'
import { attachPlayer, detachPlayer, onPlayerFrame, onPlayerState, transport } from '@/features/editor/transport'
import { useAssetsStore } from '@/stores/assets'
import { useEditorStore } from '@/stores/editor'
import { useJobsStore } from '@/stores/jobs'
import { useProjectStore } from '@/stores/project'
import { useTimelineCommands } from '@/features/timeline/commands'
import { api, errorMessage } from '@/lib/api'
import AssetPreview from './AssetPreview.vue'
import AudioMeters from './AudioMeters.vue'

const props = defineProps<{ browserSkim?: { assetId: string; seconds: number } }>()

const project = useProjectStore()
const assets = useAssetsStore()
const editor = useEditorStore()
const jobs = useJobsStore()

const stage = ref<HTMLDivElement>()
const canvas = ref<HTMLCanvasElement>()
const pool = ref<HTMLDivElement>()
const timecode = ref<HTMLSpanElement>()
const root = ref<HTMLDivElement>()
const player = shallowRef<Player>()
const safeZones = ref(false)
const displaySize = ref({ w: 0, h: 0 })

const scene = computed(() => buildScene(project.doc, project.layout, (id) => assets.get(id)))
const previewAsset = computed(() => assets.get(editor.previewAssetId))
const aspect = computed(() => project.doc.settings.width / project.doc.settings.height)
const timelineName = computed(() => activeTimelineName(project.doc))

function pendingInfo(clipId: string) {
  const d = project.doc
  const clip = d.spine.find((c) => c.id === clipId) ?? d.connected.find((c) => c.id === clipId)?.clip
  if (!clip || clip.kind !== 'media') return undefined
  const take = activeTake(clip)
  const job = take?.generationId ? jobs.byId[take.generationId] : undefined
  if (job && ['failed', 'canceled', 'needs_attention'].includes(job.status)) return { label: `Failed: ${job.error?.message ?? job.label}`, progress: null }
  return { label: take?.label ?? clip.name, progress: job?.progress ?? null }
}

function layout() {
  const el = stage.value
  if (!el || !player.value) return
  const availW = el.clientWidth - 16
  const availH = el.clientHeight - 16
  let w = availW
  let h = w / aspect.value
  if (h > availH) {
    h = availH
    w = h * aspect.value
  }
  displaySize.value = { w: Math.floor(w), h: Math.floor(h) }
  player.value.resize(Math.floor(w), Math.floor(h))
}

let resizeObserver: ResizeObserver | undefined
let unsubscribe: (() => void) | undefined

onMounted(() => {
  const p = markRaw(
    new Player({
      canvas: canvas.value!,
      poolContainer: pool.value!,
      mixer: project.doc.mix ?? defaultMix(),
      asset: (id) => {
        const a = assets.get(id)
        if (!a || a.kind === 'font') return undefined
        return {
          kind: a.kind,
          width: a.width ?? 0,
          height: a.height ?? 0,
          ready: a.status === 'ready' && (a.kind === 'image' || Boolean(a.variants.proxy)),
          hasProxy: Boolean(a.variants.proxy),
          ...(a.kind === 'video' && a.durationFlicks ? { duration: flicksToSeconds(a.durationFlicks) } : {}),
          stills: stillUrls(a),
        }
      },
      pending: pendingInfo,
      onFrame: onPlayerFrame,
      onPlayingChange: (playing) => onPlayerState(playing),
    }),
  )
  player.value = p
  attachPlayer(p)
  p.setScene(scene.value)
  p.seek(editor.playhead)
  resizeObserver = new ResizeObserver(layout)
  resizeObserver.observe(stage.value!)
  layout()
  unsubscribe = playheadBus.subscribe((frame) => {
    if (timecode.value) timecode.value.textContent = formatTimecode(frame, project.doc.settings.fps)
  })
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  unsubscribe?.()
  if (player.value) {
    detachPlayer(player.value)
    player.value.destroy()
  }
})

watch(scene, (s) => {
  player.value?.setScene(s)
  layout()
})
watch(aspect, layout)
watch(
  () => project.doc.mix,
  (mix) => player.value?.setMixer(mix ?? defaultMix()),
)
watch(
  () => jobs.list.map((j) => `${j.id}:${j.progress}:${j.status}`).join(),
  () => player.value?.invalidate(),
)

const commands = useTimelineCommands()
const preview = ref<InstanceType<typeof AssetPreview>>()
const savingFrame = ref(false)
/** A video frame is on screen: the timeline (when it isn't empty) or a previewed video. */
const canSaveFrame = computed(() => (previewAsset.value ? previewAsset.value.kind === 'video' : scene.value.duration > 0))

/**
 * "Save frame to Assets": the exact frame on screen, at the source's full resolution, as a new image asset — from the
 * previewed video at its current time, or the topmost video under the timeline playhead. Playback pauses first.
 */
async function saveFrame() {
  if (savingFrame.value || !canSaveFrame.value) return
  savingFrame.value = true
  try {
    const shown = previewAsset.value
    let id: string | undefined
    if (shown) {
      preview.value?.pause()
      const seconds = preview.value?.currentSeconds()
      if (seconds === undefined || !assets.projectId) return
      const asset = await api.assets.frame(assets.projectId, shown.id, seconds)
      assets.upsert(asset)
      id = asset.id
    } else {
      if (editor.playing) transport.pause()
      id = await commands.grabFrameAtPlayhead()
    }
    if (id) toast.success('Frame added to Assets')
  } catch (err) {
    toast.error('Could not save the frame', { description: errorMessage(err) })
  } finally {
    savingFrame.value = false
  }
}

const skimSeconds = computed(() =>
  props.browserSkim && props.browserSkim.assetId === editor.previewAssetId ? props.browserSkim.seconds : undefined,
)

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen()
  else void root.value?.requestFullscreen()
}

const durationLabel = computed(() => formatTimecode(scene.value.duration, scene.value.fps))
</script>

<template>
  <div ref="root" class="flex h-full min-h-0 flex-col bg-viewer">
    <div class="flex h-9 shrink-0 items-center justify-between px-3 text-[11px] text-muted-foreground">
      <span v-if="previewAsset" class="truncate">{{ previewAsset.name }}</span>
      <span v-else class="flex min-w-0 items-center gap-1.5">
        <span class="truncate">{{ project.name }}</span>
        <span class="text-muted-foreground/50">/</span>
        <span class="flex min-w-0 items-center gap-1 font-medium text-foreground/85" data-active-timeline-name title="Open timeline">
          <ListVideo class="size-3 shrink-0" /><span class="truncate">{{ timelineName }}</span>
        </span>
      </span>
      <div class="flex items-center gap-1">
        <span v-if="!previewAsset">{{ project.doc.settings.width }}×{{ project.doc.settings.height }} · {{ project.doc.settings.fps }} fps</span>
        <Button v-if="previewAsset" variant="ghost" size="icon-xs" title="Back to timeline" @click="editor.previewAssetId = undefined">
          <X />
        </Button>
      </div>
    </div>
    <div class="relative flex min-h-0 flex-1">
      <div ref="stage" class="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden" @click="editor.focus = 'timeline'">
        <div ref="pool" class="pointer-events-none absolute bottom-0 left-0 size-px overflow-hidden opacity-0" />
        <div class="relative" :style="{ width: `${displaySize.w}px`, height: `${displaySize.h}px` }" v-show="!previewAsset">
          <canvas ref="canvas" class="block rounded-[10px] bg-black shadow-2xl" />
          <div v-if="safeZones" class="pointer-events-none absolute inset-0">
            <div class="absolute inset-[5%] border border-white/40" />
            <div class="absolute inset-[10%] border border-dashed border-white/30" />
          </div>
          <div
            v-if="scene.duration === 0"
            class="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center text-xs text-white/50"
          >
            <span>The timeline is empty.</span>
            <span>Drag clips from Assets, or generate a shot →</span>
          </div>
        </div>
        <AssetPreview v-if="previewAsset" ref="preview" :asset="previewAsset" :skim-seconds="skimSeconds" class="absolute inset-0" />
      </div>
      <AudioMeters class="mr-1" />
    </div>
    <div class="flex h-11 shrink-0 items-center gap-1 px-2.5">
      <span ref="timecode" class="w-24 font-mono text-xs text-foreground tabular">00:00:00:00</span>
      <div class="flex flex-1 items-center justify-center gap-0.5">
        <Tooltip>
          <TooltipTrigger as-child><Button variant="ghost" size="icon-sm" @click="transport.goStart()"><SkipBack /></Button></TooltipTrigger>
          <TooltipContent>Start (Home)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child><Button variant="ghost" size="icon-sm" @click="transport.shuttle('j')"><Rewind /></Button></TooltipTrigger>
          <TooltipContent>Reverse (J)</TooltipContent>
        </Tooltip>
        <Button size="icon" class="mx-1 size-9 rounded-full shadow-[0_2px_8px_oklch(0_0_0/0.25)]" @click="transport.toggle()">
          <Pause v-if="editor.playing" class="fill-current" />
          <Play v-else class="fill-current" />
        </Button>
        <Tooltip>
          <TooltipTrigger as-child><Button variant="ghost" size="icon-sm" @click="transport.shuttle('l')"><FastForward /></Button></TooltipTrigger>
          <TooltipContent>Forward (L, again for 2×/4×)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child><Button variant="ghost" size="icon-sm" @click="transport.goEnd()"><SkipForward /></Button></TooltipTrigger>
          <TooltipContent>End (End)</TooltipContent>
        </Tooltip>
      </div>
      <span class="w-24 text-right font-mono text-xs text-muted-foreground tabular">{{ durationLabel }}</span>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon-sm" :disabled="!canSaveFrame || savingFrame" aria-label="Save frame to Assets" @click="saveFrame">
            <Camera />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Save frame to Assets</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon-sm" :class="safeZones && 'text-brand'" @click="safeZones = !safeZones"><SquareDashed /></Button>
        </TooltipTrigger>
        <TooltipContent>Safe zones</TooltipContent>
      </Tooltip>
      <Button variant="ghost" size="icon-sm" @click="toggleFullscreen"><Maximize /></Button>
    </div>
  </div>
</template>
