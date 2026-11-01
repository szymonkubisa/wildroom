<script setup lang="ts">
import { CheckCircle2, FolderSearch, Loader2 } from '@lucide/vue'
import { motionAssetIds } from '@shared/motion/evaluate'
import { flicksToSeconds } from '@shared/time/flicks'
import { formatTimecode } from '@shared/time/timecode'
import { timelineExportName } from '@shared/timeline/timelines'
import type { AssetDTO } from '@shared/types/assets'
import { defaultMix } from '@shared/types/project-doc'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { buildScene } from '@/engine/buildScene'
import { stillUrls } from '@/engine/canvasDraw'
import { type ExportStage, runExport, supportedCodecs } from '@/engine/export/exporter'
import type { ExportAssetInfo, ExportCodec, ExportQuality } from '@/engine/export/types'
import { fontSpecs } from '@/engine/fonts'
import { captionCuesFromTimeline, cuesInRange, cuesToSrt, downloadText } from '@/features/captions/captions'
import { api, errorMessage } from '@/lib/api'
import { useTimelineCommands } from '@/features/timeline/commands'
import { useAssetsStore } from '@/stores/assets'
import { useEditorStore } from '@/stores/editor'
import { useProjectStore } from '@/stores/project'

const open = defineModel<boolean>('open', { default: false })
/** Claude asked for this export (over MCP): it starts by itself with the defaults, and says how it went. */
const props = defineProps<{ request?: { id: string; name?: string } }>()
const emit = defineEmits<{ requestDone: [] }>()
const commands = useTimelineCommands()
const project = useProjectStore()
const assets = useAssetsStore()
const editor = useEditorStore()

const name = ref('')
const range = ref<'all' | 'range'>('all')
const size = ref('project')
const codec = ref<ExportCodec>('avc')
const quality = ref<ExportQuality>('high')
const loudness = ref('-14')
const captions = ref<'burn' | 'burn+srt' | 'srt' | 'none'>('burn')
const codecs = ref<ExportCodec[]>(['avc'])
const running = ref(false)
const stage = ref<ExportStage>()
const progress = ref<Record<ExportStage, number>>({ video: 0, audio: 0, finalize: 0 })
const result = ref<AssetDTO>()
let controller: AbortController | undefined

const settings = computed(() => project.doc.settings)
const hasRange = computed(() => editor.rangeIn !== undefined || editor.rangeOut !== undefined)
const sizes = computed(() => {
  const { width, height } = settings.value
  const byHeight = (h: number) => {
    const scale = h / Math.min(width, height)
    const w = Math.round((width * scale) / 2) * 2
    const hh = Math.round((height * scale) / 2) * 2
    return { w, h: hh }
  }
  const list = [{ id: 'project', label: `Project (${width}×${height})`, w: width, h: height }]
  for (const [id, h] of [['2160', 2160], ['1080', 1080], ['720', 720]] as const) {
    const s = byHeight(h)
    if (s.w !== width || s.h !== height) list.push({ id, label: `${s.w}×${s.h}`, w: s.w, h: s.h })
  }
  return list
})
const frames = computed(() => {
  const end = project.layout.duration
  if (range.value === 'range' && hasRange.value) {
    const a = editor.rangeIn ?? 0
    const b = editor.rangeOut ?? end
    return { start: Math.max(0, Math.min(a, b)), end: Math.min(end, Math.max(a, b)) }
  }
  return { start: 0, end }
})

watch(open, async (v) => {
  if (!v) return
  // The open timeline is what gets exported; with several timelines its name joins the project's.
  name.value = timelineExportName(project.name, project.doc)
  result.value = undefined
  stage.value = undefined
  range.value = hasRange.value ? 'range' : 'all'
  // The sizes offered follow the open timeline's format: a size picked for another timeline may be gone.
  if (!sizes.value.some((s) => s.id === size.value)) size.value = 'project'
  codecs.value = await supportedCodecs(settings.value.width, settings.value.height)
  if (!codecs.value.includes(codec.value)) codec.value = codecs.value[0] ?? 'avc'
  if (props.request && open.value && !running.value) {
    // What export_video promises: the whole timeline at the project's size with captions burnt in (no .srt download
    // in the user's window), whatever was picked here last time.
    if (props.request.name) name.value = props.request.name
    range.value = 'all'
    size.value = 'project'
    captions.value = 'burn'
    void start()
  }
})

/** Tells the server (and so Claude) how the requested export went. */
function report(outcome: { ok: true; result: { assetId: string } } | { ok: false; error: string }) {
  const request = props.request
  if (!request) return
  emit('requestDone')
  void api.appRequests.done(request.id, outcome).catch(() => {})
}

// Closed before a requested export started: say so instead of leaving Claude waiting.
watch(open, (v) => {
  if (!v && props.request && !running.value && !result.value) report({ ok: false, error: 'The export window was closed' })
})

async function start() {
  const target = sizes.value.find((s) => s.id === size.value) ?? sizes.value[0]!
  const scene = buildScene(project.doc, project.layout, (id) => assets.get(id))
  if (captions.value === 'srt' || captions.value === 'none') {
    scene.video = scene.video.filter((l) => !(l.kind === 'title' && l.title?.template === 'caption'))
  }
  if (captions.value === 'srt' || captions.value === 'burn+srt') {
    // An In/Out export starts at 0: a caption already showing at the In point is cut to it (it was written as negative time).
    const cues = cuesInRange(captionCuesFromTimeline(project.layout), frames.value.start, frames.value.end)
    if (cues.length) downloadText(`${name.value.trim() || project.name}.srt`, cuesToSrt(cues, settings.value.fps, frames.value.start), 'application/x-subrip')
  }
  const infos: Record<string, ExportAssetInfo> = {}
  for (const layer of scene.video) {
    // Motion clips: the pictures and videos inside the frame.
    for (const id of [layer.assetId, ...motionAssetIds(layer.motion?.items ?? [])]) {
      const a = id ? assets.get(id) : undefined
      if (a && a.kind !== 'font')
        infos[a.id] = {
          kind: a.kind,
          width: a.width ?? 0,
          height: a.height ?? 0,
          timeOffset: a.timeOffset ?? 0,
          ...(a.kind === 'video' && a.durationFlicks ? { duration: flicksToSeconds(a.durationFlicks) } : {}),
          stills: stillUrls(a),
        }
    }
  }
  if (scene.video.some((l) => l.kind === 'pending' && l.start < frames.value.end && l.end > frames.value.start)) {
    toast.warning('Some shots are still generating — they will render as placeholders.')
  }
  running.value = true
  progress.value = { video: 0, audio: 0, finalize: 0 }
  // This run's own controller: a canceled run that is still winding down must not end a newer one.
  const run = new AbortController()
  controller = run
  try {
    result.value = await runExport(
      scene,
      infos,
      project.doc.mix ?? defaultMix(),
      {
        projectId: project.id!,
        name: name.value.trim() || project.name,
        startFrame: frames.value.start,
        endFrame: frames.value.end,
        width: target.w,
        height: target.h,
        codec: codec.value,
        quality: quality.value,
        loudness: loudness.value === 'off' ? null : Number(loudness.value),
        fonts: fontSpecs(assets.list),
      },
      (s, fraction) => {
        stage.value = s
        progress.value = { ...progress.value, [s]: fraction }
      },
      run.signal,
    )
    assets.upsert(result.value)
    toast.success('Export finished', { description: result.value.name })
    report({ ok: true, result: { assetId: result.value.id } })
  } catch (err) {
    if (!run.signal.aborted) toast.error('Export failed', { description: errorMessage(err) })
    report({ ok: false, error: run.signal.aborted ? 'The export was canceled' : errorMessage(err) })
  } finally {
    if (controller === run) running.value = false
  }
}

function cancel() {
  controller?.abort()
  running.value = false
}

const stages: { id: ExportStage; label: string }[] = [
  { id: 'video', label: 'Rendering picture' },
  { id: 'audio', label: 'Mixing audio' },
  { id: 'finalize', label: 'Muxing & loudness' },
]
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md" @interact-outside="(e) => running && e.preventDefault()">
      <DialogHeader>
        <DialogTitle>Export</DialogTitle>
        <DialogDescription>
          Renders with the same engine as the viewer. {{ formatTimecode(frames.end - frames.start, settings.fps) }} at {{ settings.fps }} fps.
        </DialogDescription>
      </DialogHeader>

      <div v-if="result" class="grid gap-3 py-2">
        <div class="flex items-center gap-2 text-sm"><CheckCircle2 class="size-4 text-role-music" /> {{ result.name }} is in Assets.</div>
        <video :src="`/media/${result.id}/original`" controls class="w-full rounded-md bg-black" />
      </div>

      <div v-else-if="running" class="grid gap-3 py-2">
        <div v-for="s in stages" :key="s.id" class="grid gap-1">
          <div class="flex items-center justify-between text-xs">
            <span :class="stage === s.id ? 'text-foreground' : 'text-muted-foreground'">{{ s.label }}</span>
            <span class="font-mono tabular text-muted-foreground">{{ Math.round(progress[s.id] * 100) }}%</span>
          </div>
          <Progress :model-value="progress[s.id] * 100" class="h-1.5" />
        </div>
        <p class="text-[11px] text-muted-foreground">Keep this tab open while exporting.</p>
      </div>

      <form v-else class="grid gap-4" @submit.prevent="start">
        <div class="grid gap-1.5">
          <Label for="export-name" class="text-xs">Name</Label>
          <Input id="export-name" v-model="name" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-1.5">
            <Label class="text-xs">Range</Label>
            <Select v-model="range">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Entire timeline</SelectItem>
                <SelectItem value="range" :disabled="!hasRange">In / out range</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid gap-1.5">
            <Label class="text-xs">Resolution</Label>
            <Select v-model="size">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem v-for="s in sizes" :key="s.id" :value="s.id">{{ s.label }}</SelectItem></SelectContent>
            </Select>
          </div>
          <div class="grid gap-1.5">
            <Label class="text-xs">Codec</Label>
            <Select v-model="codec">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="avc">H.264 (most compatible)</SelectItem>
                <SelectItem value="hevc" :disabled="!codecs.includes('hevc')">HEVC / H.265</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid gap-1.5">
            <Label class="text-xs">Quality</Label>
            <Select v-model="quality">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="medium">Medium (smaller)</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="very-high">Very high</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div class="grid gap-1.5">
          <Label class="text-xs">Captions</Label>
          <Select v-model="captions">
            <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="burn">Burn into the picture</SelectItem>
              <SelectItem value="burn+srt">Burn in + save .srt</SelectItem>
              <SelectItem value="srt">Only save .srt (clean picture)</SelectItem>
              <SelectItem value="none">None</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="grid gap-1.5">
          <Label class="text-xs">Loudness</Label>
          <Select v-model="loudness">
            <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="-14">−14 LUFS · YouTube, Spotify, social</SelectItem>
              <SelectItem value="-16">−16 LUFS · Apple, podcasts</SelectItem>
              <SelectItem value="-23">−23 LUFS · broadcast (EBU R128)</SelectItem>
              <SelectItem value="off">Off — keep the mix as is</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </form>

      <DialogFooter>
        <template v-if="result">
          <Button variant="outline" @click="api.assets.reveal(result.id)"><FolderSearch /> Reveal in Finder</Button>
          <Button @click="open = false">Done</Button>
        </template>
        <Button v-else-if="running" variant="outline" @click="cancel"><Loader2 class="animate-spin" /> Cancel</Button>
        <template v-else>
          <Button variant="ghost" class="mr-auto" title="Continue the edit in Final Cut Pro" @click="commands.exportFcpxml()">Final Cut Pro XML</Button>
          <Button variant="ghost" @click="open = false">Cancel</Button>
          <Button :disabled="frames.end - frames.start <= 0" @click="start">Export</Button>
        </template>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
