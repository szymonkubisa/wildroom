<script setup lang="ts">
import { Bookmark, Filter, Grid3x3, Heart, ListVideo, Loader2, Plus, ScanEye, Search, Sparkles, Square, Trash2, Upload, X } from '@lucide/vue'
import { useLocalStorage } from '@vueuse/core'
import type { AssetDTO, AssetKind } from '@shared/types/assets'
import type { SmartCollection } from '@shared/types/project-doc'
import { nanoid } from 'nanoid'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import GenerationDetailsDialog from '@/features/jobs/GenerationDetailsDialog.vue'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Slider } from '@/components/ui/slider'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTimelineCommands } from '@/features/timeline/commands'
import { useTimelines } from '@/features/timeline/timelines'
import type { TimelineSummary } from '@shared/timeline/timelines'
import { api, errorMessage } from '@/lib/api'
import { formatUsd } from '@/lib/format'
import { useAssetsStore } from '@/stores/assets'
import { useEditorStore } from '@/stores/editor'
import { useGenerateStore } from '@/stores/generate'
import { useJobsStore } from '@/stores/jobs'
import { useClipTools, withToast } from '@/features/tools/useClipTools'
import { useResultActions } from '@/features/generate/resultActions'
import { useProjectStore } from '@/stores/project'
import { addAssetsToBoard } from '@/features/canvas/useCanvasDoc'
import AssetCard from './AssetCard.vue'
import TimelineCard from './TimelineCard.vue'
import { setAssetDrag } from './drag'
import { matchHint, scoreAsset, scoreName, tokenize } from './search'
import type { AssetAction, TimelineAction } from './types'

const assets = useAssetsStore()
const jobs = useJobsStore()
const editor = useEditorStore()
const generate = useGenerateStore()
const commands = useTimelineCommands()
const project = useProjectStore()
const clipTools = useClipTools()
const timelines = useTimelines()
const results = useResultActions()

type KindFilter = 'all' | AssetKind | 'timeline'
type RoleFilter = 'all' | 'dialogue' | 'music' | 'effects'

const kind = ref<KindFilter>('all')
const role = ref<RoleFilter>('all')
const query = ref('')
const favoritesOnly = ref(false)
const showRejected = ref(false)
const dragOver = ref(false)
const fileInput = ref<HTMLInputElement>()
/** The render whose prompt, inputs and request are shown (right-click → What was sent). */
const detailsFor = ref<string>()
const renaming = ref<AssetDTO>()
const renameValue = ref('')

const keywordFilter = ref<string[]>([])
const activeCollection = ref<string>()

/** Every keyword used in this project, most used first. */
const allKeywords = computed(() => {
  const counts = new Map<string, number>()
  for (const a of assets.list) for (const k of a.keywords) counts.set(k, (counts.get(k) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k)
})

const tokens = computed(() => tokenize(query.value))

const filtered = computed(() => {
  const t = tokens.value
  const scored: { a: AssetDTO; score: number }[] = []
  for (const a of kind.value === 'timeline' ? [] : assets.list) {
    if (kind.value !== 'all' && a.kind !== kind.value) continue
    if (kind.value === 'audio' && role.value !== 'all' && (a.role ?? '').split('.')[0] !== role.value) continue
    if (favoritesOnly.value && a.rating !== 1) continue
    if (!showRejected.value && a.rating === -1) continue
    if (keywordFilter.value.some((k) => !a.keywords.includes(k))) continue
    const score = scoreAsset(a, t)
    if (score > 0) scored.push({ a, score })
  }
  // Newest first when browsing; best match first when searching.
  if (t.length) scored.sort((x, y) => y.score - x.score)
  return scored.map((x) => x.a)
})

/**
 * The project's timelines, listed like media (not on the canvas, where they mean nothing). They have a name only:
 * a rating or keyword filter hides them, a search matches their name.
 */
const filteredTimelines = computed(() => {
  if (editor.workspace === 'canvas' || (kind.value !== 'all' && kind.value !== 'timeline')) return []
  if (favoritesOnly.value || keywordFilter.value.length) return []
  const t = tokens.value
  const scored = timelines.list.value.map((tl) => ({ tl, score: scoreName(tl.name, t) })).filter((x) => x.score > 0)
  if (t.length) scored.sort((x, y) => y.score - x.score)
  return scored.map((x) => x.tl)
})
const itemCount = computed(() => filtered.value.length + filteredTimelines.value.length)

function onSelectTimeline(t: TimelineSummary) {
  editor.focus = 'browser'
  editor.selectedAssetIds = []
  editor.selectedTimelineId = t.id
  editor.previewAssetId = undefined
}

const renamingTimeline = ref<TimelineSummary>()
const timelineName = ref('')
const deletingTimeline = ref<TimelineSummary>()

function onTimelineAction(t: TimelineSummary, action: TimelineAction) {
  switch (action) {
    case 'open':
      return timelines.open(t.id)
    case 'rename':
      renamingTimeline.value = t
      timelineName.value = t.name
      return
    case 'duplicate':
      return void timelines.duplicate(t.id)
    case 'delete':
      deletingTimeline.value = t
      return
  }
}

function confirmTimelineRename() {
  if (renamingTimeline.value) timelines.rename(renamingTimeline.value.id, timelineName.value)
  renamingTimeline.value = undefined
}

function confirmTimelineDelete() {
  if (deletingTimeline.value) timelines.remove(deletingTimeline.value.id)
  deletingTimeline.value = undefined
}

function toggleKeyword(k: string) {
  keywordFilter.value = keywordFilter.value.includes(k) ? keywordFilter.value.filter((x) => x !== k) : [...keywordFilter.value, k]
  activeCollection.value = undefined
}

// ---- smart collections (saved filters, stored in the project)
const collections = computed(() => project.doc.collections ?? [])
const naming = ref(false)
const collectionName = ref('')
const hasFilter = computed(() => Boolean(query.value.trim() || keywordFilter.value.length || kind.value !== 'all' || favoritesOnly.value))

function applyCollection(c: SmartCollection) {
  activeCollection.value = c.id
  query.value = c.query ?? ''
  // The Canvas has no timelines: a Timelines collection shows everything there.
  kind.value = c.kind === 'timeline' && editor.workspace === 'canvas' ? 'all' : (c.kind ?? 'all')
  role.value = (c.role as RoleFilter) ?? 'all'
  keywordFilter.value = [...(c.keywords ?? [])]
  favoritesOnly.value = Boolean(c.favoritesOnly)
}

function clearFilters() {
  activeCollection.value = undefined
  query.value = ''
  kind.value = 'all'
  role.value = 'all'
  keywordFilter.value = []
  favoritesOnly.value = false
}

function saveCollection() {
  const name = collectionName.value.trim()
  if (!name) return
  const c: SmartCollection = { id: nanoid(8), name }
  if (query.value.trim()) c.query = query.value.trim()
  if (kind.value !== 'all') c.kind = kind.value
  if (kind.value === 'audio' && role.value !== 'all') c.role = role.value
  if (keywordFilter.value.length) c.keywords = [...keywordFilter.value]
  if (favoritesOnly.value) c.favoritesOnly = true
  project.apply((d) => {
    d.collections = [...(d.collections ?? []), c]
  }, 'Save collection')
  activeCollection.value = c.id
  naming.value = false
  collectionName.value = ''
}

function removeCollection(id: string) {
  project.apply((d) => {
    d.collections = (d.collections ?? []).filter((c) => c.id !== id)
  }, 'Delete collection')
  if (activeCollection.value === id) activeCollection.value = undefined
}

// ---- keywords dialog
const keywordAssets = ref<string[]>()
const keywordText = ref('')

function openKeywords(asset: AssetDTO) {
  keywordAssets.value = targetIds(asset)
  const shared = asset.keywords.filter((k) => keywordAssets.value!.every((id) => assets.get(id)?.keywords.includes(k)))
  keywordText.value = shared.join(', ')
}

async function saveKeywords() {
  const ids = keywordAssets.value ?? []
  const words = keywordText.value.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)
  keywordAssets.value = undefined
  try {
    for (const id of ids) {
      const a = assets.get(id)
      if (!a) continue
      // Multiple selection: add keywords; single asset: replace them.
      await assets.update(id, { keywords: ids.length > 1 ? [...new Set([...a.keywords, ...words])] : words })
    }
  } catch (err) {
    toast.error('Could not save keywords', { description: errorMessage(err) })
  }
}

// ---- AI descriptions for natural-language search
const describing = ref(false)
async function describeAll() {
  const todo = assets.list.filter((a) => (a.kind === 'image' || a.kind === 'video') && a.status === 'ready' && !a.description)
  if (!todo.length) return toast('Every picture already has a description')
  describing.value = true
  let done = 0
  const id = toast.loading(`Describing media… 0 / ${todo.length}`)
  try {
    for (const a of todo) {
      assets.upsert(await api.assets.describe(a.id))
      toast.loading(`Describing media… ${++done} / ${todo.length}`, { id })
    }
    toast.success(`Described ${done} item${done === 1 ? '' : 's'} — search now finds what is in the picture`, { id })
  } catch (err) {
    toast.error(`Stopped after ${done}`, { id, description: errorMessage(err) })
  } finally {
    describing.value = false
  }
}

const pending = computed(() => jobs.active)

function onSelect(asset: AssetDTO, additive: boolean) {
  editor.focus = 'browser'
  editor.selectedTimelineId = undefined
  editor.selectedAssetIds = additive
    ? editor.selectedAssetIds.includes(asset.id)
      ? editor.selectedAssetIds.filter((id) => id !== asset.id)
      : [...editor.selectedAssetIds, asset.id]
    : [asset.id]
  editor.previewAssetId = asset.id
}

function targetIds(asset: AssetDTO): string[] {
  return editor.selectedAssetIds.includes(asset.id) ? editor.selectedAssetIds : [asset.id]
}

/** Dragging a selected card carries the whole selection, in the order it was picked. */
function onDrag(asset: AssetDTO, e: DragEvent) {
  const list = targetIds(asset)
    .map((id) => assets.get(id))
    .filter((a): a is AssetDTO => a?.status === 'ready')
  if (e.dataTransfer && list.length) setAssetDrag(e.dataTransfer, list)
}

function selectionOrder(asset: AssetDTO): number | undefined {
  if (editor.selectedAssetIds.length < 2) return undefined
  const i = editor.selectedAssetIds.indexOf(asset.id)
  return i >= 0 ? i + 1 : undefined
}

async function onAction(asset: AssetDTO, action: AssetAction) {
  try {
    switch (action) {
      case 'addToCanvas':
        return addAssetsToBoard(targetIds(asset))
      case 'append':
        return commands.appendAssets(targetIds(asset))
      case 'insert':
        return commands.insertAssets(targetIds(asset))
      case 'connect':
        return commands.connectAssets(targetIds(asset))
      case 'overwrite':
        return commands.overwriteAssets(targetIds(asset))
      // The same as every result's actions (board, Feed): the Composer set up with this picture or clip.
      case 'animate':
      case 'startFrame':
        return results.startFrame(asset)
      case 'extend':
        return await results.extend(asset)
      case 'extendVeo':
        return generate.open('video', { modelId: 'fal-veo3.1-extend', params: { video: asset.id, prompt: asset.generation?.prompt ?? '' } })
      case 'upscale':
        return results.upscale(asset)
      case 'favorite':
        return await assets.update(asset.id, { rating: 1 })
      case 'reject':
        return await assets.update(asset.id, { rating: -1 })
      case 'unrate':
        return await assets.update(asset.id, { rating: 0 })
      case 'keywords':
        return openKeywords(asset)
      case 'describe':
        return void (await withToast('Describing', () => api.assets.describe(asset.id).then((a) => (assets.upsert(a), a)), (a) => a.description?.slice(0, 120)))
      case 'transcribe':
        return void (await clipTools.transcribeAsset(asset.id))
      case 'rename':
        renaming.value = asset
        renameValue.value = asset.name
        return
      case 'reveal':
        return await api.assets.reveal(asset.id)
      case 'revealVector':
        return await api.assets.reveal(asset.id, true)
      case 'details':
        detailsFor.value = asset.generation?.generationId
        return
      case 'remove':
        if (commands.isAssetUsed(asset.id)) {
          toast.warning('This media is in use', { description: 'Remove it from every timeline, the canvas and the brand kit first.' })
          return
        }
        return await assets.remove(asset.id)
    }
  } catch (err) {
    toast.error('Action failed', { description: errorMessage(err) })
  }
}

async function confirmRename() {
  if (!renaming.value) return
  try {
    await assets.update(renaming.value.id, { name: renameValue.value.trim() || renaming.value.name })
    renaming.value = undefined
  } catch (err) {
    toast.error('Could not rename', { description: errorMessage(err) })
  }
}

function onFiles(list: FileList | null | undefined) {
  if (!list?.length) return
  void assets.importFiles([...list])
}

function onDrop(e: DragEvent) {
  dragOver.value = false
  if (e.dataTransfer?.files.length) onFiles(e.dataTransfer.files)
}

function onDragOver(e: DragEvent) {
  if (e.dataTransfer?.types.includes('Files')) {
    e.preventDefault()
    dragOver.value = true
  }
}

/** The pointer left the panel (not just moved onto a child, which also fires dragleave). */
function onDragLeave(e: DragEvent) {
  if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) dragOver.value = false
}

function onHover(asset: AssetDTO, inside: boolean) {
  if (inside) editor.hoverAsset = { assetId: asset.id, seconds: editor.hoverAsset?.assetId === asset.id ? editor.hoverAsset.seconds : undefined }
  else if (editor.hoverAsset?.assetId === asset.id) editor.hoverAsset = undefined
}

function onSkim(asset: AssetDTO, seconds: number | undefined) {
  if (seconds !== undefined) editor.hoverAsset = { assetId: asset.id, seconds }
  // While a preview plays, skimming and leaving the card must not interrupt it (Space pauses it).
  if (!editor.skimming || editor.previewPlaying) return
  editor.previewAssetId = seconds === undefined ? editor.selectedAssetIds[0] : asset.id
  browserSkim.value = seconds === undefined ? undefined : { assetId: asset.id, seconds }
}

const browserSkim = defineModel<{ assetId: string; seconds: number } | undefined>('skim')

/** The cards' smallest width (px): the grid fits as many as it can, the same in every workspace. */
const thumbSize = useLocalStorage('assets.thumbSize', 120)
const thumbSlider = computed({ get: () => [thumbSize.value], set: (v: number[]) => (thumbSize.value = v[0] ?? 120) })

defineExpose({ openImport: () => fileInput.value?.click() })
</script>

<template>
  <div
    class="relative flex h-full min-h-0 flex-col bg-sidebar"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div class="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-2.5 pt-2.5 pb-1">
      <!-- Never wider than the panel: in a narrow side panel (a 1024 px window) it scrolls instead of running past the edge. -->
      <ToggleGroup
        v-model="kind"
        type="single"
        size="sm"
        variant="outline"
        class="max-w-full gap-0 overflow-x-auto [scrollbar-width:none]"
        @update:model-value="(v) => (kind = (v as KindFilter) || 'all')"
      >
        <ToggleGroupItem value="all" class="h-6 px-2 text-xs">All</ToggleGroupItem>
        <ToggleGroupItem value="video" class="h-6 px-2 text-xs">Video</ToggleGroupItem>
        <ToggleGroupItem value="image" class="h-6 px-2 text-xs">Image</ToggleGroupItem>
        <ToggleGroupItem value="audio" class="h-6 px-2 text-xs">Audio</ToggleGroupItem>
        <ToggleGroupItem v-if="editor.workspace !== 'canvas'" value="timeline" class="h-6 px-1.5" title="Timelines" aria-label="Timelines">
          <ListVideo class="size-3.5" />
        </ToggleGroupItem>
      </ToggleGroup>
      <div class="flex-1" />
      <!-- How big the cards are: small for a long list, big to see what is in the shot. -->
      <div class="flex items-center gap-1.5 px-1 text-muted-foreground" title="Thumbnail size" data-assets-size="">
        <Grid3x3 class="size-3.5 shrink-0" />
        <Slider v-model="thumbSlider" :min="80" :max="320" :step="10" class="w-20" aria-label="Thumbnail size" />
        <Square class="size-3.5 shrink-0" />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button data-tour="assets-collections" variant="ghost" size="icon-sm" :class="activeCollection && 'text-brand'" title="Smart collections"><Bookmark /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-60">
          <DropdownMenuLabel>Smart collections</DropdownMenuLabel>
          <div v-if="!collections.length" class="px-2 py-1.5 text-xs text-muted-foreground">Save a search or filter to find it again in one click.</div>
          <div v-for="c in collections" :key="c.id" class="group flex items-center">
            <DropdownMenuItem class="flex-1" @select="applyCollection(c)">
              <Bookmark :class="activeCollection === c.id ? 'fill-current text-brand' : ''" /> {{ c.name }}
            </DropdownMenuItem>
            <button class="mr-1 rounded-md p-1 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive" title="Delete collection" @click="removeCollection(c.id)">
              <Trash2 class="size-3.5" />
            </button>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem :disabled="!hasFilter" @select="naming = true">Save current filter…</DropdownMenuItem>
          <DropdownMenuItem :disabled="!hasFilter" @select="clearFilters">Show everything</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon-sm" title="Filter" aria-label="Filter" :class="(favoritesOnly || showRejected || role !== 'all') && 'text-brand'">
            <Filter />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-48">
          <DropdownMenuCheckboxItem v-model="favoritesOnly">Favorites only</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem v-model="showRejected">Show rejected</DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem :disabled="describing" @select="describeAll"><ScanEye /> Describe all media with AI</DropdownMenuItem>
          <template v-if="kind === 'audio'">
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Role</DropdownMenuLabel>
            <DropdownMenuRadioGroup v-model="role">
              <DropdownMenuRadioItem value="all">All audio</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dialogue">Dialogue</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="music">Music</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="effects">Effects</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
      <!-- Outside the canvas, "+" adds media or a new timeline (timelines are items here too). -->
      <DropdownMenu v-if="editor.workspace !== 'canvas'">
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon-sm" title="Add" aria-label="Add media or a timeline" data-assets-add><Plus /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-48">
          <DropdownMenuItem @select="fileInput?.click()"><Upload /> Import media… <span class="ml-auto text-xs text-muted-foreground">⌘I</span></DropdownMenuItem>
          <DropdownMenuItem data-new-timeline @select="editor.dialog = 'new-timeline'"><ListVideo /> New timeline…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip v-else>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon-sm" aria-label="Import media" @click="fileInput?.click()"><Upload /></Button>
        </TooltipTrigger>
        <TooltipContent>Import media (⌘I)</TooltipContent>
      </Tooltip>
      <input
        ref="fileInput"
        type="file"
        multiple
        accept="video/*,audio/*,image/*,.ttf,.otf,.woff,.woff2"
        class="hidden"
        @change="onFiles(($event.target as HTMLInputElement).files); ($event.target as HTMLInputElement).value = ''"
      />
    </div>
    <div data-tour="assets-search" class="px-2.5 py-1.5">
      <div class="relative">
        <Search class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="query" placeholder="Search — what's in the shot, what's said…" class="h-8 rounded-lg pl-7 text-xs" @update:model-value="activeCollection = undefined" />
        <button v-if="query" type="button" class="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground" aria-label="Clear search" @click="query = ''">
          <X class="size-3.5" />
        </button>
      </div>
      <div v-if="allKeywords.length" class="mt-1.5 flex flex-wrap gap-1">
        <button
          v-for="k in allKeywords.slice(0, 14)"
          :key="k"
          type="button"
          class="rounded-full bg-field px-1.5 py-px text-[10px] transition-colors"
          :class="keywordFilter.includes(k) ? 'bg-brand/20 text-foreground' : 'text-muted-foreground hover:text-foreground'"
          @click="toggleKeyword(k)"
        >
          {{ k }}
        </button>
      </div>
    </div>

    <ScrollArea class="min-h-0 flex-1">
      <div class="grid gap-2 p-2.5" :style="{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbSize}px, 1fr))` }" data-assets-grid="">
        <div v-for="u in assets.uploads" :key="u.id" class="flex flex-col overflow-hidden rounded-xl border border-dashed border-foreground/15 bg-card">
          <div class="flex aspect-video flex-col items-center justify-center gap-2 px-3">
            <Upload class="size-4 text-muted-foreground" />
            <Progress :model-value="u.progress * 100" class="h-1" />
          </div>
          <div class="truncate px-1.5 py-1 text-[11px] text-muted-foreground">{{ u.name }}</div>
        </div>
        <div
          v-for="job in pending"
          :key="job.id"
          class="flex flex-col overflow-hidden rounded-xl border border-brand/40 bg-card"
          :title="job.label"
        >
          <div class="relative flex aspect-video flex-col items-center justify-center gap-2 overflow-hidden bg-brand/5 px-3">
            <div class="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-brand/10 to-transparent" />
            <Loader2 class="size-4 animate-spin text-brand" />
            <Progress v-if="job.progress != null" :model-value="job.progress * 100" class="h-1" />
            <span class="text-[10px] text-muted-foreground capitalize">{{ job.status.replace('_', ' ') }}</span>
          </div>
          <div class="flex items-center gap-1 px-1.5 py-1">
            <Sparkles class="size-3 shrink-0 text-brand" />
            <span class="min-w-0 flex-1 truncate text-[11px]">{{ job.label }}</span>
            <span class="shrink-0 text-[10px] text-muted-foreground">{{ formatUsd(job.costEstimateUsd) }}</span>
          </div>
        </div>
        <TimelineCard
          v-for="t in filteredTimelines"
          :key="`timeline:${t.id}`"
          :timeline="t"
          :poster="assets.get(t.posterAssetId)"
          :selected="editor.selectedTimelineId === t.id"
          :can-delete="timelines.list.value.length > 1"
          @select="onSelectTimeline(t)"
          @action="(a) => onTimelineAction(t, a)"
        />
        <AssetCard
          v-for="asset in filtered"
          :key="asset.id"
          :asset="asset"
          :selected="editor.selectedAssetIds.includes(asset.id)"
          :order="selectionOrder(asset)"
          :hint="tokens.length ? matchHint(asset, tokens) : undefined"
          @select="(additive) => onSelect(asset, additive)"
          @drag="(e) => onDrag(asset, e)"
          :canvas-mode="editor.workspace === 'canvas'"
          @preview="editor.workspace === 'canvas' ? addAssetsToBoard(targetIds(asset)) : onSelect(asset, false)"
          @skim="(s) => onSkim(asset, s)"
          @hover="(inside) => onHover(asset, inside)"
          @action="(a) => onAction(asset, a)"
        />
      </div>
      <div
        v-if="!assets.loading && !itemCount && !pending.length && !assets.uploads.length"
        class="flex flex-col items-center gap-2 px-6 py-12 text-center text-xs text-muted-foreground"
      >
        <Heart v-if="favoritesOnly" class="size-5" />
        <template v-else>
          <Sparkles class="size-5" />
          <div>Nothing here yet.</div>
          <div>Generate shots, voices and music on the right, or drop files from Finder.</div>
        </template>
      </div>
    </ScrollArea>

    <div class="border-t px-2 py-1 text-[11px] text-muted-foreground">
      {{ itemCount }} item{{ itemCount === 1 ? '' : 's' }}
    </div>

    <div
      v-if="dragOver"
      class="pointer-events-none absolute inset-1 flex items-center justify-center rounded-lg border-2 border-dashed border-brand bg-brand/10 text-sm font-medium"
    >
      Drop to import
    </div>

    <GenerationDetailsDialog v-model:id="detailsFor" />
    <Dialog :open="naming" @update:open="(v) => (naming = v)">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader><DialogTitle>Save smart collection</DialogTitle></DialogHeader>
        <form class="grid gap-4" @submit.prevent="saveCollection">
          <Input v-model="collectionName" placeholder="e.g. Night exteriors" autofocus />
          <DialogFooter>
            <Button type="button" variant="ghost" @click="naming = false">Cancel</Button>
            <Button type="submit" :disabled="!collectionName.trim()">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog :open="Boolean(keywordAssets)" @update:open="(v) => !v && (keywordAssets = undefined)">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader><DialogTitle>Keywords{{ (keywordAssets?.length ?? 0) > 1 ? ` · ${keywordAssets!.length} items` : '' }}</DialogTitle></DialogHeader>
        <form class="grid gap-3" @submit.prevent="saveKeywords">
          <Input v-model="keywordText" placeholder="hero, night, take 2" autofocus />
          <p class="text-xs text-muted-foreground">Comma-separated.{{ (keywordAssets?.length ?? 0) > 1 ? ' They are added to every selected item.' : '' }}</p>
          <DialogFooter>
            <Button type="button" variant="ghost" @click="keywordAssets = undefined">Cancel</Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog :open="Boolean(renamingTimeline)" @update:open="(v) => !v && (renamingTimeline = undefined)">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader><DialogTitle>Rename timeline</DialogTitle></DialogHeader>
        <form class="grid gap-4" @submit.prevent="confirmTimelineRename">
          <Input v-model="timelineName" autofocus />
          <DialogFooter>
            <Button type="button" variant="ghost" @click="renamingTimeline = undefined">Cancel</Button>
            <Button type="submit" :disabled="!timelineName.trim()">Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <AlertDialog :open="Boolean(deletingTimeline)" @update:open="(v) => !v && (deletingTimeline = undefined)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete the timeline “{{ deletingTimeline?.name }}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Its edit goes; the media stays in Assets.{{ deletingTimeline?.active ? ' Another timeline opens in its place.' : '' }} Undo (⌘Z) brings it back.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" data-confirm-delete-timeline @click="confirmTimelineDelete">Delete timeline</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <Dialog :open="Boolean(renaming)" @update:open="(v) => !v && (renaming = undefined)">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader><DialogTitle>Rename</DialogTitle></DialogHeader>
        <form class="grid gap-4" @submit.prevent="confirmRename">
          <Input v-model="renameValue" autofocus />
          <DialogFooter>
            <Button type="button" variant="ghost" @click="renaming = undefined">Cancel</Button>
            <Button type="submit">Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
