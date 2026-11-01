<script setup lang="ts">
import { remapIds } from '@shared/types/remapIds'
import { Loader2, RectangleVertical } from '@lucide/vue'
import { type Clip, activeTake } from '@shared/types/project-doc'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { type FrameRef, api, errorMessage } from '@/lib/api'
import { useAssetsStore } from '@/stores/assets'
import { useProjectStore } from '@/stores/project'
import { type SubjectPoint, reframeDoc } from './reframe'
import { useClipTools } from './useClipTools'

const open = defineModel<boolean>('open', { default: false })
const project = useProjectStore()
const assets = useAssetsStore()
const clipTools = useClipTools()
const router = useRouter()

const FORMATS = {
  '9:16': { width: 1080, height: 1920, label: 'Vertical 9:16' },
  '1:1': { width: 1080, height: 1080, label: 'Square 1:1' },
  '4:5': { width: 1080, height: 1350, label: 'Portrait 4:5' },
  '16:9': { width: 1920, height: 1080, label: 'Landscape 16:9' },
} as const
type FormatKey = keyof typeof FORMATS

const format = ref<FormatKey>(project.doc.settings.width >= project.doc.settings.height ? '9:16' : '16:9')
const follow = ref(true)
const busy = ref(false)
const progress = ref('')

/** Picture clips on the timeline, with the frames to look at. */
const samples = computed(() => {
  const out: { clipId: string; frame: number; ref: FrameRef }[] = []
  const clips: Clip[] = [...project.doc.spine, ...project.doc.connected.map((c) => c.clip)]
  for (const clip of clips) {
    if (clip.kind !== 'media' || !clip.video) continue
    const asset = assets.get(activeTake(clip)?.assetId)
    if (!asset || asset.kind === 'audio') continue
    const start = clipTools.startOf(clip.id)
    if (start === undefined) continue
    const locals = asset.kind === 'image' || !follow.value ? [Math.floor(clip.duration / 2)] : [0.1, 0.5, 0.9].map((p) => Math.floor(clip.duration * p))
    for (const f of locals) {
      out.push({ clipId: clip.id, frame: f, ref: { assetId: asset.id, seconds: asset.kind === 'image' ? 0 : clipTools.sourceSecondsAt(clip, start + f) } })
    }
  }
  return out
})

async function create() {
  if (!project.id) return
  busy.value = true
  try {
    const subjects = new Map<string, SubjectPoint[]>()
    const all = samples.value
    for (let i = 0; i < all.length; i += 30) {
      progress.value = `Finding subjects… ${Math.min(all.length, i + 30)} / ${all.length}`
      const chunk = all.slice(i, i + 30)
      const res = await api.analysis.subjects(chunk.map((s) => s.ref))
      chunk.forEach((s, k) => {
        const p = res.points[k]
        if (!p) return
        subjects.set(s.clipId, [...(subjects.get(s.clipId) ?? []), { frame: s.frame, x: p.x, y: p.y }])
      })
    }
    progress.value = 'Creating the new version…'
    await project.save()
    if (project.saveState === 'error') throw new Error('The project could not be saved — fix that first (see the message above)')
    const size = FORMATS[format.value]
    const doc = reframeDoc(project.doc, size, subjects, (id) => assets.get(id))
    // The copy is its own project folder with its own asset ids: the reframed doc follows them.
    const copy = await api.projects.duplicate(project.id)
    if (!copy.id) throw new Error('The copy could not be read')
    const opened = await api.projects.open(copy.path)
    await api.projects.saveDoc(opened.id, remapIds(doc, copy.idMap), opened.revision)
    await api.projects.rename(opened.id, `${project.name} — ${format.value}`)
    open.value = false
    toast.success(`Created the ${size.label.toLowerCase()} version`, { description: 'Each shot follows its subject; adjust Position in the Inspector where needed.' })
    await router.push({ name: 'editor', params: { id: opened.id } })
  } catch (err) {
    toast.error('Reframe failed', { description: errorMessage(err) })
  } finally {
    busy.value = false
    progress.value = ''
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2"><RectangleVertical class="size-4" /> Smart reframe</DialogTitle>
        <DialogDescription>
          Makes a copy of this project in another shape. Every shot fills the new frame and is positioned on its main subject.
        </DialogDescription>
      </DialogHeader>
      <div class="grid gap-4 py-1">
        <ToggleGroup type="single" variant="outline" class="w-full" :model-value="format" @update:model-value="(v) => v && (format = v as FormatKey)">
          <ToggleGroupItem v-for="(f, key) in FORMATS" :key="key" :value="key" class="h-auto flex-1 flex-col gap-1 py-2 text-xs">
            <span class="rounded-[2px] border border-current" :style="{ width: `${(f.width / Math.max(f.width, f.height)) * 22}px`, height: `${(f.height / Math.max(f.width, f.height)) * 22}px` }" />
            {{ key }}
          </ToggleGroupItem>
        </ToggleGroup>
        <label class="flex items-center justify-between gap-3 text-sm">
          <span>
            Follow the subject within each shot
            <span class="block text-xs text-muted-foreground">Adds position keyframes when the subject moves (3 frames per shot are analysed).</span>
          </span>
          <Switch v-model="follow" />
        </label>
        <p class="text-xs text-muted-foreground">{{ samples.length }} frame{{ samples.length === 1 ? '' : 's' }} to analyse · without an Anthropic key the brightest area is used instead of the subject.</p>
      </div>
      <DialogFooter>
        <span v-if="busy" class="mr-auto flex items-center gap-2 text-xs text-muted-foreground"><Loader2 class="size-3.5 animate-spin" /> {{ progress }}</span>
        <Button variant="ghost" :disabled="busy" @click="open = false">Cancel</Button>
        <Button :disabled="busy || !samples.length" @click="create">Create {{ format }} version</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
