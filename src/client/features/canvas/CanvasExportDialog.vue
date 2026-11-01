<script setup lang="ts">
import { Download, Folder, FolderOpen, Frame, Image as ImageIcon, Loader2 } from '@lucide/vue'
import type { CanvasAssetItem, CanvasFrameItem } from '@shared/types/canvas'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, errorMessage } from '@/lib/api'
import { chooseFolderPath } from '@/lib/desktop'
import { useAssetsStore } from '@/stores/assets'
import { useCanvasStore } from '@/stores/canvas'
import { type ExportFormat, FORMAT_EXT, coverCrop, exportName, frameContents, renderArea } from './export/renderFrame'

const canvas = useCanvasStore()
const assets = useAssetsStore()
const open = computed({ get: () => canvas.dialog === 'export', set: (v) => (canvas.dialog = v ? 'export' : undefined) })

type Target = { id: string; kind: 'frame'; item: CanvasFrameItem } | { id: string; kind: 'image'; item: CanvasAssetItem }

/** What can be exported: frames, and images that aren't inside a frame. */
const candidates = computed<Target[]>(() =>
  canvas.items.flatMap((i): Target[] => {
    if (i.kind === 'frame') return [{ id: i.id, kind: 'frame', item: i }]
    if (i.kind === 'asset' && i.assetId && !i.frameId && assets.get(i.assetId)?.kind === 'image') return [{ id: i.id, kind: 'image', item: i }]
    return []
  }),
)
const chosen = ref<Set<string>>(new Set())
const format = ref<ExportFormat>('png')
const scale = ref('1')
const toLibrary = ref(false)
const withSvg = ref(true)
const folder = ref<string | undefined>(localStorage.getItem('canvas.exportDir') ?? undefined)
const busy = ref(false)

// Opening: the selected frames/images, else every frame on the board.
watch(open, (v) => {
  if (!v) return
  const sel = new Set(canvas.selection)
  const picked = candidates.value.filter((c) => sel.has(c.id))
  chosen.value = new Set((picked.length ? picked : candidates.value.filter((c) => c.kind === 'frame')).map((c) => c.id))
})

const targets = computed(() => candidates.value.filter((c) => chosen.value.has(c.id)))
const hasVector = computed(() => targets.value.some((t) => t.kind === 'image' && assets.get(t.item.assetId)?.vector))
const folderLabel = computed(() => folder.value?.replace(/^\/Users\/[^/]+/, '~'))

function toggle(id: string, on: boolean) {
  const next = new Set(chosen.value)
  if (on) next.add(id)
  else next.delete(id)
  chosen.value = next
}

function sizeLabel(t: Target): string {
  const k = Number(scale.value)
  if (t.kind === 'frame') return `${Math.round(t.item.w * k)} × ${Math.round(t.item.h * k)}`
  const a = assets.get(t.item.assetId)
  if (!a?.width || !a.height) return ''
  const crop = coverCrop(a.width, a.height, t.item)
  return `${Math.round(crop.w * k)} × ${Math.round(crop.h * k)}`
}

async function pickFolder() {
  try {
    const path = await chooseFolderPath('Where should the exported files go?', folder.value)
    if (path) {
      folder.value = path
      localStorage.setItem('canvas.exportDir', path)
    }
  } catch (err) {
    toast.error('Could not show the folder picker', { description: errorMessage(err) })
  }
}

async function render(t: Target): Promise<Blob> {
  const k = Number(scale.value)
  if (t.kind === 'frame') {
    return renderArea({ area: t.item, items: frameContents(canvas.items, t.item.id), fill: t.item.fill, scale: k, format: format.value, asset: (id) => assets.get(id) })
  }
  // A free image exports at its own resolution (the part the board shows).
  const a = assets.get(t.item.assetId)!
  const crop = a.width && a.height ? coverCrop(a.width, a.height, t.item) : { w: t.item.w }
  return renderArea({ area: t.item, items: [t.item], scale: (crop.w / t.item.w) * k, format: format.value, asset: (id) => assets.get(id) })
}

async function run() {
  if (!targets.value.length) return
  if (!folder.value && !toLibrary.value) await pickFolder()
  if (!folder.value && !toLibrary.value) return
  busy.value = true
  const written: string[] = []
  const id = toast.loading(`Exporting 0 / ${targets.value.length}…`)
  try {
    for (const [n, t] of targets.value.entries()) {
      const name = exportName(t.kind === 'frame' ? t.item.name : assets.get(t.item.assetId)?.name, t.kind === 'frame' ? 'Frame' : 'Image')
      const suffix = scale.value === '1' ? '' : `@${scale.value}x`
      const file = `${name}${suffix}.${FORMAT_EXT[format.value]}`
      const blob = await render(t)
      if (folder.value) written.push((await api.system.writeFile(folder.value, file, blob)).path)
      if (t.kind === 'image' && withSvg.value && folder.value && assets.get(t.item.assetId)?.vector) {
        const svg = await fetch(`/media/${t.item.assetId}/svg`).then((r) => (r.ok ? r.blob() : undefined))
        if (svg) written.push((await api.system.writeFile(folder.value, `${name}.svg`, svg)).path)
      }
      if (toLibrary.value && assets.projectId) {
        // Only this project's media: the server refuses sources it doesn't know (e.g. pasted from another project).
        const parents = (
          t.kind === 'frame' ? frameContents(canvas.items, t.item.id).flatMap((i) => (i.kind === 'asset' && i.assetId ? [i.assetId] : [])) : [t.item.assetId!]
        ).filter((id) => assets.get(id))
        assets.upsert(await api.assets.upload(assets.projectId, new File([blob], file, { type: blob.type }), undefined, { parentIds: parents, label: name }))
      }
      toast.loading(`Exporting ${n + 1} / ${targets.value.length}…`, { id })
    }
    const where = folder.value ? folderLabel.value : 'the media library'
    toast.success(`Exported ${targets.value.length} file${targets.value.length === 1 ? '' : 's'} to ${where}`, {
      id,
      ...(written[0] ? { action: { label: 'Show in Finder', onClick: () => void api.system.revealPath(written[0]!) } } : {}),
    })
    open.value = false
  } catch (err) {
    toast.error('Export failed', { id, description: errorMessage(err) })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Export from the board</DialogTitle>
        <DialogDescription>Frames export at their exact size (or 2×, 3× for retina); images at the resolution of what the board shows.</DialogDescription>
      </DialogHeader>

      <div v-if="!candidates.length" class="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
        Nothing to export yet — add a frame or an image to the board.
      </div>
      <div v-else class="grid max-h-64 gap-1 overflow-y-auto rounded-md border p-1.5">
        <label v-for="t in candidates" :key="t.id" class="flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-xs hover:bg-accent">
          <Checkbox :model-value="chosen.has(t.id)" @update:model-value="(v) => toggle(t.id, v === true)" />
          <component :is="t.kind === 'frame' ? Frame : ImageIcon" class="size-3.5 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate">{{ t.kind === 'frame' ? (t.item.name ?? 'Frame') : (assets.get(t.item.assetId)?.name ?? 'Image') }}</span>
          <span class="tabular shrink-0 text-[10px] text-muted-foreground">{{ sizeLabel(t) }}</span>
        </label>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div class="grid gap-1.5">
          <span class="text-xs text-muted-foreground">Format</span>
          <ToggleGroup type="single" variant="outline" size="sm" :model-value="format" @update:model-value="(v) => v && (format = v as ExportFormat)">
            <ToggleGroupItem value="png" class="flex-1 text-xs">PNG</ToggleGroupItem>
            <ToggleGroupItem value="jpeg" class="flex-1 text-xs">JPEG</ToggleGroupItem>
            <ToggleGroupItem value="webp" class="flex-1 text-xs">WebP</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div class="grid gap-1.5">
          <span class="text-xs text-muted-foreground">Scale</span>
          <ToggleGroup type="single" variant="outline" size="sm" :model-value="scale" @update:model-value="(v) => v && (scale = String(v))">
            <ToggleGroupItem value="0.5" class="flex-1 text-xs">0.5×</ToggleGroupItem>
            <ToggleGroupItem value="1" class="flex-1 text-xs">1×</ToggleGroupItem>
            <ToggleGroupItem value="2" class="flex-1 text-xs">2×</ToggleGroupItem>
            <ToggleGroupItem value="3" class="flex-1 text-xs">3×</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      <div class="grid gap-2 text-xs">
        <div class="flex items-center gap-2">
          <Folder class="size-3.5 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate font-mono" :title="folder">{{ folderLabel ?? 'No folder chosen' }}</span>
          <Button variant="outline" size="sm" @click="pickFolder"><FolderOpen /> {{ folder ? 'Change…' : 'Choose…' }}</Button>
        </div>
        <label class="flex items-center gap-2">
          <Checkbox v-model="toLibrary" /> Also add the exports to the media library (to use them in videos)
        </label>
        <label v-if="hasVector" class="flex items-center gap-2">
          <Checkbox v-model="withSvg" /> Include the SVG of vector images
        </label>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="open = false">Cancel</Button>
        <Button :disabled="busy || !targets.length" class="bg-brand text-brand-foreground hover:bg-brand/90" @click="run">
          <Loader2 v-if="busy" class="animate-spin" /><Download v-else /> Export {{ targets.length || '' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
