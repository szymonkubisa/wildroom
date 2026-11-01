<script setup lang="ts">
import { FolderOpen, ImagePlus, Loader2 } from '@lucide/vue'
import { primaryColor } from '@shared/types/brand'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { useConfirm } from '@/components/app/useConfirm'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api, errorMessage } from '@/lib/api'
import { chooseFolderPath } from '@/lib/desktop'
import { useAssetsStore } from '@/stores/assets'
import { useCanvasStore } from '@/stores/canvas'
import { useProjectStore } from '@/stores/project'
import { FAVICON_PNGS, buildFaviconPack, iconSources } from './export/faviconPack'
import { frameContents, renderArea } from './export/renderFrame'

const canvas = useCanvasStore()
const assets = useAssetsStore()
const project = useProjectStore()
const confirm = useConfirm()
const open = computed({ get: () => canvas.dialog === 'favicon', set: (v) => (canvas.dialog = v ? 'favicon' : undefined) })

/** The selected image or frame the icons are made from. */
const source = computed(() => {
  const it = canvas.selectedItems.length === 1 ? canvas.selectedItems[0] : undefined
  if (it?.kind === 'frame') return { kind: 'frame' as const, item: it, label: it.name ?? 'Frame' }
  const a = it?.kind === 'asset' ? assets.get(it.assetId) : undefined
  if (a?.kind === 'image') return { kind: 'image' as const, asset: a, label: a.name }
  return undefined
})

const appName = ref('')
const themeColor = ref('#ffffff')
const backgroundColor = ref('#ffffff')
const previews = ref<{ size: number; url: string }[]>([])
const busy = ref(false)
let files: Awaited<ReturnType<typeof buildFaviconPack>> = []

function clearPreviews() {
  for (const p of previews.value) URL.revokeObjectURL(p.url)
  previews.value = []
}
onBeforeUnmount(clearPreviews)

let buildId = 0
async function build() {
  const s = source.value
  if (!s) return
  // Colour changes rebuild while a build runs: only the newest result counts.
  const id = ++buildId
  busy.value = true
  try {
    let image: Blob
    let svg: Blob | undefined
    if (s.kind === 'image') ({ image, svg } = await iconSources(s.asset))
    else {
      const side = Math.max(s.item.w, s.item.h)
      image = await renderArea({ area: s.item, items: frameContents(canvas.items, s.item.id), fill: s.item.fill, scale: Math.max(1, 512 / side), format: 'png', asset: (id) => assets.get(id) })
    }
    const built = await buildFaviconPack(image, { appName: appName.value || 'App', themeColor: themeColor.value, backgroundColor: backgroundColor.value, svg: Boolean(svg), svgSource: svg })
    if (id !== buildId) return
    files = built
    clearPreviews()
    previews.value = FAVICON_PNGS.map(({ name, size }) => ({ size, url: URL.createObjectURL(files.find((f) => f.name === name)!.data) }))
  } catch (err) {
    toast.error('Could not make the icons', { description: errorMessage(err) })
  } finally {
    if (id === buildId) busy.value = false
  }
}

watch(open, (v) => {
  if (!v) return clearPreviews()
  const brand = project.doc.brand
  appName.value = brand?.name || project.name
  themeColor.value = primaryColor(brand) ?? '#ffffff'
  backgroundColor.value = brand?.colors.find((c) => c.role === 'background')?.hex ?? '#ffffff'
  void build()
})
watch([themeColor, backgroundColor, appName], () => open.value && void build())

async function save() {
  try {
    const dir = await chooseFolderPath('Where should the favicon files go? (usually your site’s public folder)', localStorage.getItem('canvas.exportDir') ?? undefined)
    if (!dir || !files.length) return
    localStorage.setItem('canvas.exportDir', dir)
    // A site's public folder usually has icons and a manifest already: replace them only when the user says so.
    const { existing } = await api.system.existingFiles(dir, files.map((f) => f.name))
    if (
      existing.length &&
      !(await confirm({
        title: `Replace ${existing.length === 1 ? existing[0] : `${existing.length} existing files`} in that folder?`,
        description: existing.join('\n'),
        confirmText: 'Replace',
        destructive: true,
      }))
    )
      return
    busy.value = true
    const written: string[] = []
    for (const f of files) written.push((await api.system.writeFile(dir, f.name, f.data, true)).path)
    toast.success(`Saved ${written.length} files`, {
      description: 'Paste favicon-snippet.html into your site’s <head>.',
      action: { label: 'Show in Finder', onClick: () => void api.system.revealPath(written[0]!) },
    })
    open.value = false
  } catch (err) {
    toast.error('Could not save the icons', { description: errorMessage(err) })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Favicon & app icons</DialogTitle>
        <DialogDescription>
          favicon.ico (16/32/48), PNG icons for browsers, iOS and Android, a web manifest and the HTML to paste — cropped square from the centre.
        </DialogDescription>
      </DialogHeader>
      <div v-if="!source" class="flex flex-col items-center gap-2 rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
        <ImagePlus class="size-5" /> Select one image or frame on the board first (a square logo mark works best).
      </div>
      <template v-else>
        <div class="flex items-end gap-4 rounded-md border bg-muted/30 p-4">
          <Loader2 v-if="busy && !previews.length" class="size-5 animate-spin text-muted-foreground" />
          <div v-for="p in previews.filter((x) => x.size !== 192)" :key="p.size" class="flex flex-col items-center gap-1">
            <img :src="p.url" :style="{ width: `${Math.min(p.size, 96)}px`, height: `${Math.min(p.size, 96)}px` }" class="rounded-sm [image-rendering:auto]" alt="" />
            <span class="tabular text-[10px] text-muted-foreground">{{ p.size }}</span>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-3 text-xs">
          <label class="col-span-3 grid gap-1">
            <span class="text-muted-foreground">App name (in the manifest)</span>
            <Input v-model.lazy="appName" class="h-8" />
          </label>
          <label class="grid gap-1">
            <span class="text-muted-foreground">Theme colour</span>
            <input v-model.lazy="themeColor" type="color" class="h-8 w-full cursor-pointer rounded border bg-transparent" />
          </label>
          <label class="grid gap-1">
            <span class="text-muted-foreground">Background (iOS)</span>
            <input v-model.lazy="backgroundColor" type="color" class="h-8 w-full cursor-pointer rounded border bg-transparent" />
          </label>
          <div class="grid gap-1 text-[11px] leading-snug text-muted-foreground">From: <span class="truncate font-medium text-foreground">{{ source.label }}</span></div>
        </div>
      </template>
      <DialogFooter>
        <Button variant="ghost" @click="open = false">Cancel</Button>
        <Button :disabled="busy || !source || !previews.length" class="bg-brand text-brand-foreground hover:bg-brand/90" @click="save">
          <Loader2 v-if="busy" class="animate-spin" /><FolderOpen v-else /> Save to folder…
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
