<script setup lang="ts">
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Clapperboard,
  Download,
  FolderSearch,
  Lock,
  PenTool,
  ScanLine,
  Scissors,
  Sparkles,
  Ungroup,
  Unlock,
  Wand2,
} from '@lucide/vue'
import { FRAME_GROUPS, FRAME_PRESETS, framePreset } from '@shared/canvas/framePresets'
import { unionRect } from '@shared/canvas/geometry'
import { ancestorGroups, groupMembers } from '@shared/canvas/groups'
import { LINE, TRIANGLE } from '@shared/canvas/path'
import { toMarkup } from '@shared/canvas/richText'
import { type BlendMode, type CanvasAssetItem, type CanvasItem, type CanvasShapeItem, type CanvasTextItem, NOTE_COLORS, type PictureAdjust, fillColor, type Rect, SHAPE_KINDS, type ShapeKind, type ShapeStroke } from '@shared/types/canvas'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { formatUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { useCanvasStore } from '@/stores/canvas'
import { useGenerateStore } from '@/stores/generate'
import { useJobsStore } from '@/stores/jobs'
import { animate, assetItems, reveal, runImageTool, toolCost, upscale, useAsReference, useInVideo } from './canvasActions'
import FillEditor from './FillEditor.vue'
import FontSelect from './FontSelect.vue'
import { applyFramePreset } from './frames'
import { commitRects, setTextMarkup, ungroupItems, updateItem, updateItems } from './useCanvasDoc'

const canvas = useCanvasStore()
const assets = useAssetsStore()
const jobs = useJobsStore()
const generate = useGenerateStore()

const item = computed(() => (canvas.selectedItems.length === 1 ? canvas.selectedItems[0] : undefined))
const asset = computed(() => (item.value?.kind === 'asset' ? assets.get(item.value.assetId) : undefined))
const job = computed(() => (item.value?.kind === 'asset' && item.value.generationId ? jobs.byId[item.value.generationId] : undefined))
const images = computed(() => assetItems(canvas.selectedItems, 'image'))
const boardId = computed(() => canvas.board.id)
const NOTE_SWATCH: Record<string, string> = { yellow: '#fde68a', pink: '#fbcfe8', blue: '#bfdbfe', green: '#bbf7d0', purple: '#ddd6fe' }

function patch(p: Partial<CanvasItem>, label = 'Change') {
  if (item.value) updateItem(boardId.value, item.value.id, p, label)
}

const SHAPE_LABELS: Record<ShapeKind, string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  polyline: 'Polyline',
  polygon: 'Polygon',
  path: 'Path',
  arc: 'Arc',
}

/** A regular polygon's points in a unit box, the first corner at the top. */
function regularPolygon(sides: number): [number, number][] {
  const n = Math.min(12, Math.max(3, Math.round(sides) || 3))
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n
    return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)] as [number, number]
  })
}

/** Switching kind gives the new kind what it needs to show: points, an arc, a sample curve, a stroke for lines. */
function setShapeKind(kind: ShapeKind) {
  const it = item.value
  if (it?.kind !== 'shape') return
  const p: Partial<CanvasShapeItem> = { shape: kind }
  if (kind === 'polygon' && !it.points?.length) p.points = TRIANGLE
  if (kind === 'line') p.points = LINE
  if (kind === 'polyline' && !it.points?.length) p.points = [[0, 1], [0.33, 0.2], [0.66, 0.8], [1, 0]]
  if (kind === 'arc' && !it.arc) p.arc = { start: -90, end: 90 }
  if (kind === 'path' && !it.d) {
    p.d = `M 0 ${Math.round(it.h)} C ${Math.round(it.w * 0.3)} 0 ${Math.round(it.w * 0.7)} 0 ${Math.round(it.w)} ${Math.round(it.h)}`
    p.pathBox = { w: it.w, h: it.h }
    p.fill = 'none'
  }
  if (['line', 'polyline', 'arc', 'path'].includes(kind) && !it.stroke) p.stroke = { color: fillColor(it.fill, '#ffffff'), width: 6, cap: 'round', join: 'round' }
  patch(p, 'Shape')
}

function patchCrop(c: Partial<{ x: number; y: number; zoom: number }>) {
  const it = item.value
  if (it?.kind !== 'asset') return
  const next = { x: 0.5, y: 0.5, zoom: 1, ...it.crop, ...c }
  patch({ crop: next.zoom === 1 && next.x === 0.5 && next.y === 0.5 ? undefined : next }, 'Crop')
}

type EffectKey = 'shadow' | 'glow' | 'outline'
type Lookable = CanvasAssetItem | CanvasShapeItem | CanvasTextItem
/** The size effects start from: the letters for text, a quarter of the box otherwise. */
const effectUnit = (it: Lookable) => (it.kind === 'text' ? it.fontSize : Math.max(8, Math.min(it.w, it.h) / 4))
const EFFECTS: { key: EffectKey; label: string; textOnly?: boolean; initial: (it: Lookable) => object; fields: { key: string; label: string }[] }[] = [
  {
    key: 'shadow',
    label: 'Shadow',
    initial: (it) => ({ color: '#000000', blur: Math.round(effectUnit(it) / 6), x: 0, y: Math.round(effectUnit(it) / 16) }),
    fields: [{ key: 'blur', label: 'Blur' }, { key: 'x', label: 'X' }, { key: 'y', label: 'Y' }],
  },
  { key: 'glow', label: 'Glow', initial: (it) => ({ color: it.kind === 'text' ? it.color : '#ffffff', blur: Math.round(effectUnit(it) / 3) }), fields: [{ key: 'blur', label: 'Blur' }] },
  { key: 'outline', label: 'Outline', textOnly: true, initial: (it) => ({ color: '#000000', width: Math.max(1, Math.round(effectUnit(it) / 24)) }), fields: [{ key: 'width', label: 'Width' }] },
]
const BLENDS: { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'soft-light', label: 'Soft light' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'difference', label: 'Difference' },
  { value: 'add', label: 'Add (light)' },
]
/** What can mask the element: others in its frame (not its own groups or members), frames and notes excepted. */
const maskChoices = computed(() => {
  const it = item.value
  if (!it || it.kind === 'frame' || it.kind === 'note') return []
  const own = new Set([...ancestorGroups(canvas.byId, it).map((g) => g.id), ...(it.kind === 'group' ? groupMembers(canvas.items, it.id).map((m) => m.id) : [])])
  return canvas.items.filter((i) => i.id !== it.id && !own.has(i.id) && i.frameId === it.frameId && i.kind !== 'frame' && i.kind !== 'note')
})
const maskLabel = (i: CanvasItem) =>
  i.name ?? (i.kind === 'text' ? i.text.slice(0, 30) || 'Text' : i.kind === 'shape' ? SHAPE_LABELS[i.shape] : i.kind === 'group' ? 'Group' : 'Picture')

const lookable = computed(() => (item.value && (item.value.kind === 'asset' || item.value.kind === 'shape' || item.value.kind === 'text') ? item.value : undefined))
const effectOf = (it: Lookable, fx: EffectKey) => (fx === 'outline' ? (it.kind === 'text' ? it.outline : undefined) : it[fx]) as Record<string, string | number> | undefined
function patchEffect(fx: EffectKey, p: Record<string, string | number>) {
  const it = lookable.value
  const now = it && effectOf(it, fx)
  if (now) patch({ [fx]: { ...now, ...p } }, fx === 'shadow' ? 'Shadow' : fx === 'glow' ? 'Glow' : 'Outline')
}

const ADJUST: { key: keyof PictureAdjust; label: string; base: number; max: number }[] = [
  { key: 'brightness', label: 'Brightness', base: 1, max: 2 },
  { key: 'contrast', label: 'Contrast', base: 1, max: 2 },
  { key: 'saturate', label: 'Saturation', base: 1, max: 2 },
  { key: 'bw', label: 'Black & white', base: 0, max: 1 },
]
function patchAdjust(key: keyof PictureAdjust, value: number) {
  const it = item.value
  if (it?.kind !== 'asset') return
  const next: PictureAdjust = { ...it.adjust, [key]: value }
  const base = ADJUST.find((a) => a.key === key)!.base
  if (value === base) delete next[key]
  patch({ adjust: Object.keys(next).length ? next : undefined }, 'Adjust picture')
}

function patchStroke(s: Partial<ShapeStroke>) {
  const it = item.value
  if (it?.kind !== 'shape' || !it.stroke) return
  const next: ShapeStroke = { ...it.stroke, ...s }
  for (const k of Object.keys(next) as (keyof ShapeStroke)[]) if (next[k] === undefined) delete next[k]
  patch({ stroke: next }, 'Stroke')
}

function setGeometry(key: keyof Rect, raw: string | number) {
  const it = item.value
  const v = Number(raw)
  if (!it || !Number.isFinite(v)) return
  const r: Rect = { x: it.x, y: it.y, w: it.w, h: it.h, [key]: key === 'w' || key === 'h' ? Math.max(1, v) : v }
  const rects = new Map<string, Rect>([[it.id, r]])
  // Moving a frame by numbers moves its contents too.
  if (it.kind === 'frame' && (key === 'x' || key === 'y')) {
    const dx = r.x - it.x
    const dy = r.y - it.y
    for (const c of canvas.items) if (c.frameId === it.id) rects.set(c.id, { x: c.x + dx, y: c.y + dy, w: c.w, h: c.h })
  }
  commitRects(boardId.value, rects, key === 'w' || key === 'h' ? 'Resize' : 'Move')
}

/** Lines the selection up along one edge or centre of its bounding box. */
function align(edge: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom') {
  const items = canvas.selectedItems.filter((i) => !i.locked)
  const box = unionRect(items)
  if (!box || items.length < 2) return
  const rects = new Map<string, Rect>()
  for (const i of items) {
    let { x, y } = i
    if (edge === 'left') x = box.x
    if (edge === 'hcenter') x = box.x + (box.w - i.w) / 2
    if (edge === 'right') x = box.x + box.w - i.w
    if (edge === 'top') y = box.y
    if (edge === 'vcenter') y = box.y + (box.h - i.h) / 2
    if (edge === 'bottom') y = box.y + box.h - i.h
    rects.set(i.id, { x, y, w: i.w, h: i.h })
  }
  commitRects(boardId.value, rects, 'Align')
}

const locked = computed(() => canvas.selectedItems.length > 0 && canvas.selectedItems.every((i) => i.locked))
const prompt = computed(() => asset.value?.generation?.prompt ?? (job.value?.params.prompt as string | undefined))
const cutoutCost = computed(() => toolCost('cutout'))
const vectorCost = computed(() => toolCost('vectorize'))
</script>

<template>
  <ScrollArea class="h-full">
    <!-- Nothing selected: the board -->
    <div v-if="!canvas.selectedItems.length" class="grid gap-4 p-3 text-xs">
      <div>
        <div class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Board</div>
        <div class="mt-1 text-sm font-medium">{{ canvas.board.name }}</div>
        <div class="text-muted-foreground">{{ canvas.items.length }} item{{ canvas.items.length === 1 ? '' : 's' }}</div>
      </div>
      <div class="grid gap-2 leading-relaxed text-muted-foreground">
        <p><span class="font-medium text-foreground">Drop</span> images or videos from Finder or the media browser, or <span class="font-medium text-foreground">paste</span> them (⌘V).</p>
        <p><span class="font-medium text-foreground">Select</span> images, then generate in the Composer below — they become the references and the result lands next to them.</p>
        <p>Select a <span class="font-medium text-foreground">frame</span> and generate to fill it at its exact size; export frames as PNG, JPEG or WebP.</p>
        <p>Right-click an image to remove its background, vectorize it, animate it or use it in the video.</p>
      </div>
    </div>

    <!-- Several selected -->
    <div v-else-if="!item" class="grid gap-4 p-3 text-xs">
      <div class="text-xs font-medium tracking-wide text-muted-foreground uppercase">{{ canvas.selectedItems.length }} items</div>
      <div class="grid gap-1.5">
        <span class="text-muted-foreground">Align</span>
        <div class="flex gap-1">
          <Button variant="outline" size="icon-sm" title="Left" @click="align('left')"><AlignStartVertical /></Button>
          <Button variant="outline" size="icon-sm" title="Centre" @click="align('hcenter')"><AlignCenterVertical /></Button>
          <Button variant="outline" size="icon-sm" title="Right" @click="align('right')"><AlignEndVertical /></Button>
          <Button variant="outline" size="icon-sm" title="Top" @click="align('top')"><AlignStartHorizontal /></Button>
          <Button variant="outline" size="icon-sm" title="Middle" @click="align('vcenter')"><AlignCenterHorizontal /></Button>
          <Button variant="outline" size="icon-sm" title="Bottom" @click="align('bottom')"><AlignEndHorizontal /></Button>
        </div>
      </div>
      <div v-if="images.length" class="grid gap-1.5">
        <Button size="sm" class="bg-brand text-brand-foreground hover:bg-brand/90" @click="useAsReference(images.map((i) => i.assetId!))">
          <Sparkles /> Generate from {{ images.length }} images
        </Button>
        <Button variant="outline" size="sm" @click="runImageTool('cutout', images)"><Scissors /> Remove backgrounds</Button>
        <Button variant="outline" size="sm" @click="useInVideo(images.map((i) => i.assetId!))"><Clapperboard /> Use in video</Button>
      </div>
      <Button variant="outline" size="sm" @click="updateItems(boardId, canvas.selection, { locked: !locked }, locked ? 'Unlock' : 'Lock')">
        <component :is="locked ? Unlock : Lock" /> {{ locked ? 'Unlock' : 'Lock' }}
      </Button>
    </div>

    <!-- One item -->
    <div v-else class="grid gap-4 p-3 text-xs">
      <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1">
          <div class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {{ item.kind === 'asset' ? (asset?.kind ?? 'Generating') : item.kind === 'shape' ? SHAPE_LABELS[item.shape] : item.kind }}
          </div>
          <div v-if="item.kind === 'asset'" class="truncate text-sm font-medium">{{ asset?.name ?? job?.label ?? 'Pending' }}</div>
        </div>
        <Button variant="ghost" size="icon-sm" :title="item.locked ? 'Unlock' : 'Lock'" @click="patch({ locked: !item.locked }, item.locked ? 'Unlock' : 'Lock')">
          <component :is="item.locked ? Lock : Unlock" />
        </Button>
      </div>

      <div class="grid grid-cols-4 gap-1.5">
        <label v-for="k in ['x', 'y', 'w', 'h'] as const" :key="k" class="grid gap-0.5">
          <span class="text-[10px] text-muted-foreground uppercase">{{ k }}</span>
          <Input
            :model-value="Math.round(item[k])"
            type="number"
            class="h-7 px-1.5 text-xs"
            :disabled="item.locked"
            @change="(e: Event) => setGeometry(k, (e.target as HTMLInputElement).value)"
          />
        </label>
      </div>
      <!-- A group: its members together (it turns and animates in motion clips, not on the board). -->
      <div v-if="item.kind === 'group'" class="flex items-center justify-between gap-2">
        <span class="text-[11px] text-muted-foreground">{{ canvas.items.filter((i) => i.groupId === item!.id).length }} items · double-click to edit one</span>
        <Button size="xs" variant="outline" @click="ungroupItems(boardId, [item.id])"><Ungroup /> Ungroup</Button>
      </div>
      <label v-if="item.kind !== 'frame' && item.kind !== 'group'" class="grid grid-cols-[1fr_auto] items-center gap-2">
        <span class="text-[10px] text-muted-foreground uppercase">Rotation °</span>
        <Input
          :model-value="Math.round((item.rotation ?? 0) * 10) / 10"
          type="number"
          step="1"
          class="h-7 w-20 px-1.5 text-xs"
          :disabled="item.locked"
          @change="(e: Event) => patch({ rotation: ((((Number((e.target as HTMLInputElement).value) || 0) + 180) % 360) + 360) % 360 - 180 || undefined }, 'Rotate')"
        />
      </label>

      <!-- Frame -->
      <template v-if="item.kind === 'frame'">
        <label class="grid gap-1">
          <span class="text-muted-foreground">Name</span>
          <Input :model-value="item.name ?? ''" class="h-8" @change="(e: Event) => patch({ name: (e.target as HTMLInputElement).value }, 'Rename frame')" />
        </label>
        <div class="grid gap-1">
          <span class="text-muted-foreground">Size preset</span>
          <Select
            :model-value="item.presetId ?? ''"
            @update:model-value="(v) => { const p = framePreset(String(v)); if (p && item?.kind === 'frame') applyFramePreset(item, p) }"
          >
            <SelectTrigger class="h-8 w-full"><SelectValue placeholder="Custom size" /></SelectTrigger>
            <SelectContent class="max-h-80">
              <SelectGroup v-for="g in FRAME_GROUPS" :key="g">
                <SelectLabel class="text-[11px]">{{ g }}</SelectLabel>
                <SelectItem v-for="p in FRAME_PRESETS.filter((x) => x.group === g)" :key="p.id" :value="p.id">
                  {{ p.label }} <span class="text-muted-foreground">{{ p.w }}×{{ p.h }}</span>
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <label class="grid gap-1">
          <span class="text-muted-foreground">Background</span>
          <div class="flex items-center gap-2">
            <FillEditor class="flex-1" :fill="item.fill ?? '#ffffff'" @change="(fill, label) => typeof fill === 'string' || fill.type !== 'pattern' ? patch({ fill }, label === 'Fill' ? 'Frame colour' : label) : undefined" />
            <Button variant="ghost" size="sm" @click="patch({ fill: undefined }, 'Transparent frame')">Transparent</Button>
          </div>
        </label>
        <Button size="sm" variant="outline" @click="canvas.dialog = 'export'"><Download /> Export frame…</Button>
      </template>

      <!-- Image / video -->
      <template v-if="item.kind === 'asset'">
        <div class="grid gap-1.5 rounded-lg border p-2">
          <span class="text-[10px] font-medium text-muted-foreground uppercase">Picture</span>
          <Select :model-value="item.mask ?? 'none'" @update:model-value="(v) => patch({ mask: v === 'none' ? undefined : (v as 'ellipse' | 'rounded') }, 'Mask')">
            <SelectTrigger class="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Rectangle</SelectItem>
              <SelectItem value="ellipse">Circle / ellipse</SelectItem>
              <SelectItem value="rounded">Rounded corners</SelectItem>
            </SelectContent>
          </Select>
          <label v-if="item.mask === 'rounded'" class="grid grid-cols-[1fr_auto] items-center gap-2">
            <span class="text-[10px] text-muted-foreground">Corner radius</span>
            <Input :model-value="Math.round(item.radius ?? Math.min(item.w, item.h) * 0.08)" type="number" min="0" class="h-7 w-20 text-xs" @change="(e: Event) => patch({ radius: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) }, 'Corner radius')" />
          </label>
          <div class="grid grid-cols-3 gap-1.5">
            <label class="grid gap-0.5">
              <span class="text-[10px] text-muted-foreground">Zoom</span>
              <Input :model-value="item.crop?.zoom ?? 1" type="number" min="1" step="0.1" class="h-7 text-xs" @change="(e: Event) => patchCrop({ zoom: Math.max(1, Number((e.target as HTMLInputElement).value) || 1) })" />
            </label>
            <label class="grid gap-0.5">
              <span class="text-[10px] text-muted-foreground">Focus X %</span>
              <Input :model-value="Math.round((item.crop?.x ?? 0.5) * 100)" type="number" class="h-7 text-xs" @change="(e: Event) => patchCrop({ x: (Number((e.target as HTMLInputElement).value) || 0) / 100 })" />
            </label>
            <label class="grid gap-0.5">
              <span class="text-[10px] text-muted-foreground">Focus Y %</span>
              <Input :model-value="Math.round((item.crop?.y ?? 0.5) * 100)" type="number" class="h-7 text-xs" @change="(e: Event) => patchCrop({ y: (Number((e.target as HTMLInputElement).value) || 0) / 100 })" />
            </label>
          </div>
          <label class="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input type="checkbox" :checked="Boolean(item.stroke)" @change="(e) => patch({ stroke: (e.target as HTMLInputElement).checked ? { color: '#ffffff', width: 8 } : undefined }, 'Border')" /> Border
            <template v-if="item.stroke">
              <input type="color" :value="item.stroke.color" class="h-6 w-8 cursor-pointer rounded border bg-transparent" @change="(e) => patch({ stroke: { color: (e.target as HTMLInputElement).value, width: item!.kind === 'asset' ? (item!.stroke?.width ?? 8) : 8 } }, 'Border')" />
              <Input :model-value="item.stroke.width" type="number" min="1" class="h-6 w-16 text-xs" @change="(e: Event) => patch({ stroke: { color: item!.kind === 'asset' ? (item!.stroke?.color ?? '#fff') : '#fff', width: Math.max(1, Number((e.target as HTMLInputElement).value) || 1) } }, 'Border')" />
            </template>
          </label>
        </div>
        <div class="grid gap-1.5 rounded-lg border p-2">
          <span class="text-[10px] font-medium text-muted-foreground uppercase">Colour</span>
          <label v-for="a in ADJUST" :key="a.key" class="grid grid-cols-[1fr_auto] items-center gap-2">
            <span class="text-[10px] text-muted-foreground">{{ a.label }}</span>
            <Input
              :model-value="Math.round((item.adjust?.[a.key] ?? a.base) * 100)"
              type="number"
              min="0"
              :max="a.max * 100"
              class="h-7 w-20 text-xs"
              @change="(e: Event) => patchAdjust(a.key, Math.min(a.max, Math.max(0, (Number((e.target as HTMLInputElement).value) || 0) / 100)))"
            />
          </label>
          <label class="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input type="checkbox" :checked="Boolean(item.duotone)" @change="(e) => patch({ duotone: (e.target as HTMLInputElement).checked ? { dark: '#0b1a4a', light: '#8fb8ff' } : undefined }, 'Duotone')" /> Duotone
            <template v-if="item.duotone">
              <input type="color" title="Shadows" :value="item.duotone.dark" class="h-6 w-8 cursor-pointer rounded border bg-transparent" @change="(e) => item!.kind === 'asset' && patch({ duotone: { ...item!.duotone!, dark: (e.target as HTMLInputElement).value } }, 'Duotone')" />
              <input type="color" title="Highlights" :value="item.duotone.light" class="h-6 w-8 cursor-pointer rounded border bg-transparent" @change="(e) => item!.kind === 'asset' && patch({ duotone: { ...item!.duotone!, light: (e.target as HTMLInputElement).value } }, 'Duotone')" />
            </template>
          </label>
          <label class="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input type="checkbox" :checked="Boolean(item.tint)" @change="(e) => patch({ tint: (e.target as HTMLInputElement).checked ? { color: '#3b6cff', amount: 0.5 } : undefined }, 'Tint')" /> Tint
            <template v-if="item.tint">
              <input type="color" :value="item.tint.color" class="h-6 w-8 cursor-pointer rounded border bg-transparent" @change="(e) => item!.kind === 'asset' && patch({ tint: { ...item!.tint!, color: (e.target as HTMLInputElement).value } }, 'Tint')" />
              <Input :model-value="Math.round(item.tint.amount * 100)" type="number" min="0" max="100" class="h-6 w-16 text-xs" @change="(e: Event) => item!.kind === 'asset' && patch({ tint: { ...item!.tint!, amount: Math.min(1, Math.max(0.01, (Number((e.target as HTMLInputElement).value) || 0) / 100)) } }, 'Tint')" />
            </template>
          </label>
        </div>
        <div v-if="asset" class="grid grid-cols-2 gap-2">
          <div class="rounded-md border p-2">
            <div class="text-muted-foreground">Size</div>
            <div class="font-medium">{{ asset.width ?? '?' }} × {{ asset.height ?? '?' }}</div>
          </div>
          <div class="rounded-md border p-2">
            <div class="text-muted-foreground">Source</div>
            <div class="truncate font-medium">{{ asset.generation?.modelLabel ?? (asset.source === 'import' ? 'Imported' : asset.source) }}</div>
          </div>
        </div>
        <div v-if="prompt" class="grid gap-1">
          <span class="text-muted-foreground">Prompt</span>
          <p class="max-h-40 overflow-y-auto rounded-md border bg-muted/40 p-2 leading-relaxed">{{ prompt }}</p>
          <span v-if="asset?.generation?.costUsd" class="text-[10px] text-muted-foreground">Cost {{ formatUsd(asset.generation.costUsd) }}</span>
        </div>
        <div v-if="asset?.status === 'ready'" class="grid gap-1.5">
          <template v-if="asset.kind === 'image'">
            <Button size="sm" class="bg-brand text-brand-foreground hover:bg-brand/90" @click="useAsReference([asset.id])"><Sparkles /> Generate from this</Button>
            <Button variant="outline" size="sm" @click="animate(asset.id)"><Wand2 /> Animate</Button>
            <Button variant="outline" size="sm" @click="images[0] && runImageTool('cutout', images)">
              <Scissors /> Remove background <span v-if="cutoutCost" class="ml-auto text-[10px] text-muted-foreground">{{ cutoutCost }}</span>
            </Button>
            <Button variant="outline" size="sm" @click="images[0] && runImageTool('vectorize', images)">
              <PenTool /> Vectorize to SVG <span v-if="vectorCost" class="ml-auto text-[10px] text-muted-foreground">{{ vectorCost }}</span>
            </Button>
          </template>
          <Button variant="outline" size="sm" @click="upscale(asset.id)"><ScanLine /> Upscale…</Button>
          <Button variant="outline" size="sm" @click="useInVideo([asset.id])"><Clapperboard /> Use in video</Button>
          <Button variant="ghost" size="sm" @click="reveal(asset.id)"><FolderSearch /> Reveal in Finder</Button>
        </div>
      </template>

      <!-- Text -->
      <template v-if="item.kind === 'text'">
        <Textarea :model-value="toMarkup(item)" rows="3" class="text-xs" @change="(e: Event) => setTextMarkup(boardId, item!.id, (e.target as HTMLTextAreaElement).value)" />
        <p class="-mt-1 text-[10px] leading-snug text-muted-foreground">
          <span class="font-mono">**bold**</span> · <span class="font-mono">*italic*</span> · <span class="font-mono">==highlight==</span> ·
          <span class="font-mono">{#ffd400|colour}</span> · <span class="font-mono">{"Font" w300 i|words}</span>
        </p>
        <div class="grid grid-cols-2 gap-2">
          <FontSelect :model-value="item.fontFamily" @update:model-value="(f) => patch({ fontFamily: f }, 'Font')" />
          <Select :model-value="String(item.fontWeight)" @update:model-value="(v) => patch({ fontWeight: Number(v) }, 'Font weight')">
            <SelectTrigger class="h-8 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="w in [300, 400, 500, 600, 700, 800, 900]" :key="w" :value="String(w)">{{ w }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="grid grid-cols-3 gap-2">
          <label class="grid gap-0.5">
            <span class="text-[10px] text-muted-foreground">Size</span>
            <Input :model-value="item.fontSize" type="number" class="h-7 text-xs" @change="(e: Event) => patch({ fontSize: Math.max(4, Number((e.target as HTMLInputElement).value) || 48) }, 'Font size')" />
          </label>
          <label class="grid gap-0.5">
            <span class="text-[10px] text-muted-foreground">Line height</span>
            <Input :model-value="item.lineHeight" type="number" step="0.05" class="h-7 text-xs" @change="(e: Event) => patch({ lineHeight: Number((e.target as HTMLInputElement).value) || 1.2 }, 'Line height')" />
          </label>
          <label class="grid gap-0.5">
            <span class="text-[10px] text-muted-foreground">Colour</span>
            <input type="color" :value="item.color" class="h-7 w-full cursor-pointer rounded border bg-transparent" @change="(e) => patch({ color: (e.target as HTMLInputElement).value }, 'Text colour')" />
          </label>
        </div>
        <ToggleGroup type="single" variant="outline" size="sm" :model-value="item.align" @update:model-value="(v) => v && patch({ align: v as 'left' | 'center' | 'right' }, 'Align text')">
          <ToggleGroupItem value="left" class="flex-1 text-xs">Left</ToggleGroupItem>
          <ToggleGroupItem value="center" class="flex-1 text-xs">Centre</ToggleGroupItem>
          <ToggleGroupItem value="right" class="flex-1 text-xs">Right</ToggleGroupItem>
        </ToggleGroup>
        <div class="grid grid-cols-3 gap-2">
          <label class="flex items-center gap-1.5 self-end pb-1.5 text-[11px] text-muted-foreground">
            <input type="checkbox" :checked="item.fontStyle === 'italic'" @change="(e) => patch({ fontStyle: (e.target as HTMLInputElement).checked ? 'italic' : undefined }, 'Italic')" /> Italic
          </label>
          <label class="grid gap-0.5">
            <span class="text-[10px] text-muted-foreground">Letter spacing</span>
            <Input :model-value="item.letterSpacing ?? 0" type="number" step="0.5" class="h-7 text-xs" @change="(e: Event) => patch({ letterSpacing: Number((e.target as HTMLInputElement).value) || undefined }, 'Letter spacing')" />
          </label>
          <label class="grid gap-0.5">
            <span class="text-[10px] text-muted-foreground">Case</span>
            <Select :model-value="item.textTransform ?? 'none'" @update:model-value="(v) => patch({ textTransform: v === 'none' ? undefined : (v as 'uppercase' | 'lowercase') }, 'Case')">
              <SelectTrigger class="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">As typed</SelectItem>
                <SelectItem value="uppercase">UPPERCASE</SelectItem>
                <SelectItem value="lowercase">lowercase</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>
      </template>

      <!-- Note -->
      <template v-if="item.kind === 'note'">
        <div class="flex gap-1.5">
          <button
            v-for="c in NOTE_COLORS"
            :key="c"
            :class="cn('size-6 rounded-full border', item.color === c && 'ring-2 ring-brand ring-offset-1 ring-offset-background')"
            :style="{ background: NOTE_SWATCH[c] }"
            :title="c"
            @click="patch({ color: c }, 'Note colour')"
          />
        </div>
        <Button variant="outline" size="sm" :disabled="!item.text.trim()" @click="generate.open('image', { params: { prompt: item.text } })">
          <Sparkles /> Use as prompt
        </Button>
      </template>

      <!-- Shape -->
      <template v-if="item.kind === 'shape'">
        <div class="grid grid-cols-2 gap-2">
          <div class="col-span-2 grid gap-0.5">
            <span class="text-[10px] text-muted-foreground">Fill</span>
            <FillEditor v-if="item.fill !== 'none'" :fill="item.fill" patterns @change="(fill, label) => patch({ fill }, label)" />
          </div>
          <label class="grid gap-0.5">
            <span class="text-[10px] text-muted-foreground">Corner radius</span>
            <Input :model-value="item.radius ?? 0" type="number" class="h-8 text-xs" @change="(e: Event) => patch({ radius: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) }, 'Corner radius')" />
          </label>
        </div>
        <Select :model-value="item.shape" @update:model-value="(v) => setShapeKind(v as ShapeKind)">
          <SelectTrigger class="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem v-for="k in SHAPE_KINDS" :key="k" :value="k">{{ SHAPE_LABELS[k] }}</SelectItem></SelectContent>
        </Select>
        <label v-if="!['line', 'polyline', 'arc'].includes(item.shape)" class="flex items-center gap-2 text-[11px] text-muted-foreground">
          <input type="checkbox" :checked="item.fill === 'none'" @change="(e) => patch({ fill: (e.target as HTMLInputElement).checked ? 'none' : '#7c3aed' }, 'Fill')" /> No fill (outline only)
        </label>
        <label v-if="item.shape === 'polygon'" class="grid gap-0.5">
          <span class="text-[10px] text-muted-foreground">Sides</span>
          <Input :model-value="item.points?.length ?? 3" type="number" min="3" max="12" class="h-8 text-xs" @change="(e: Event) => patch({ points: regularPolygon(Number((e.target as HTMLInputElement).value)) }, 'Sides')" />
        </label>
        <div v-if="item.shape === 'arc'" class="grid grid-cols-2 gap-2">
          <label class="grid gap-0.5">
            <span class="text-[10px] text-muted-foreground">Start °</span>
            <Input :model-value="item.arc?.start ?? -90" type="number" class="h-8 text-xs" @change="(e: Event) => patch({ arc: { start: Number((e.target as HTMLInputElement).value) || 0, end: item!.kind === 'shape' ? (item!.arc?.end ?? 90) : 90 } }, 'Arc')" />
          </label>
          <label class="grid gap-0.5">
            <span class="text-[10px] text-muted-foreground">End °</span>
            <Input :model-value="item.arc?.end ?? 90" type="number" class="h-8 text-xs" @change="(e: Event) => patch({ arc: { start: item!.kind === 'shape' ? (item!.arc?.start ?? -90) : -90, end: Number((e.target as HTMLInputElement).value) || 0 } }, 'Arc')" />
          </label>
        </div>
        <label v-if="item.shape === 'path'" class="grid gap-0.5">
          <span class="text-[10px] text-muted-foreground">Path (SVG d, in a {{ Math.round(item.pathBox?.w ?? item.w) }}×{{ Math.round(item.pathBox?.h ?? item.h) }} box)</span>
          <Textarea :model-value="item.d ?? ''" rows="3" class="min-h-0 font-mono text-[10px]" @change="(e: Event) => patch({ d: (e.target as HTMLTextAreaElement).value }, 'Path')" />
        </label>
        <!-- Stroke -->
        <label class="flex items-center gap-2 text-[11px] text-muted-foreground">
          <input type="checkbox" :checked="Boolean(item.stroke)" @change="(e) => patch({ stroke: (e.target as HTMLInputElement).checked ? { color: '#ffffff', width: 4 } : undefined }, 'Stroke')" /> Stroke
        </label>
        <div v-if="item.stroke" class="grid grid-cols-2 gap-2">
          <label class="grid gap-0.5">
            <span class="text-[10px] text-muted-foreground">Stroke colour</span>
            <input type="color" :value="item.stroke.color" class="h-8 w-full cursor-pointer rounded border bg-transparent" @change="(e) => patchStroke({ color: (e.target as HTMLInputElement).value })" />
          </label>
          <label class="grid gap-0.5">
            <span class="text-[10px] text-muted-foreground">Width</span>
            <Input :model-value="item.stroke.width" type="number" min="0.5" class="h-8 text-xs" @change="(e: Event) => patchStroke({ width: Math.max(0.5, Number((e.target as HTMLInputElement).value) || 1) })" />
          </label>
          <label class="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input type="checkbox" :checked="item.stroke.cap === 'round'" @change="(e) => patchStroke({ cap: (e.target as HTMLInputElement).checked ? 'round' : undefined, join: (e.target as HTMLInputElement).checked ? 'round' : undefined })" /> Round ends
          </label>
          <label class="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input type="checkbox" :checked="Boolean(item.stroke.dash)" @change="(e) => patchStroke({ dash: (e.target as HTMLInputElement).checked ? [item!.kind === 'shape' ? (item!.stroke?.width ?? 4) * 3 : 12, item!.kind === 'shape' ? (item!.stroke?.width ?? 4) * 2 : 8] : undefined })" /> Dashed
          </label>
        </div>
      </template>

      <!-- Look: a shadow, a glow (and a text outline), and how it blends — drawn the same on the board and in the video. -->
      <template v-if="lookable">
        <div v-for="fx in EFFECTS.filter((e) => !e.textOnly || lookable!.kind === 'text')" :key="fx.key" class="grid gap-1.5">
          <label class="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input type="checkbox" :checked="Boolean(effectOf(lookable, fx.key))" @change="(e) => patch({ [fx.key]: (e.target as HTMLInputElement).checked ? fx.initial(lookable!) : undefined }, fx.label)" />
            {{ fx.label }}
          </label>
          <div v-if="effectOf(lookable, fx.key)" class="grid grid-cols-4 gap-1.5">
            <label class="grid gap-0.5">
              <span class="text-[10px] text-muted-foreground">Colour</span>
              <input type="color" :value="String(effectOf(lookable, fx.key)!.color ?? '#000000').slice(0, 7)" class="h-7 w-full cursor-pointer rounded border bg-transparent" @change="(e) => patchEffect(fx.key, { color: (e.target as HTMLInputElement).value })" />
            </label>
            <label v-for="f in fx.fields" :key="f.key" class="grid gap-0.5">
              <span class="text-[10px] text-muted-foreground">{{ f.label }}</span>
              <Input :model-value="Number(effectOf(lookable, fx.key)![f.key] ?? 0)" type="number" class="h-7 text-xs" @change="(e: Event) => patchEffect(fx.key, { [f.key]: Number((e.target as HTMLInputElement).value) || 0 })" />
            </label>
          </div>
        </div>
        <label class="grid grid-cols-[auto_1fr] items-center gap-2">
          <span class="text-[11px] text-muted-foreground">Blend</span>
          <Select :model-value="lookable.blend ?? 'normal'" @update:model-value="(v) => patch({ blend: v === 'normal' ? undefined : (v as BlendMode) }, 'Blend')">
            <SelectTrigger class="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem v-for="b in BLENDS" :key="b.value" :value="b.value">{{ b.label }}</SelectItem></SelectContent>
          </Select>
        </label>
      </template>

      <!-- Clipping: shown only inside (or outside) another element, which then works as a mask. -->
      <template v-if="maskChoices.length && item.kind !== 'frame' && item.kind !== 'note'">
        <label class="grid grid-cols-[auto_1fr] items-center gap-2">
          <span class="text-[11px] text-muted-foreground">Clip to</span>
          <Select :model-value="item.clipBy ?? 'none'" @update:model-value="(v) => patch({ clipBy: v === 'none' ? undefined : String(v), ...(v === 'none' ? { clipInvert: undefined } : {}) }, 'Clip')">
            <SelectTrigger class="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nothing</SelectItem>
              <SelectItem v-for="m in maskChoices" :key="m.id" :value="m.id">{{ maskLabel(m) }}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label v-if="item.clipBy" class="flex items-center gap-2 text-[11px] text-muted-foreground">
          <input type="checkbox" :checked="Boolean(item.clipInvert)" @change="(e) => patch({ clipInvert: (e.target as HTMLInputElement).checked || undefined }, 'Clip')" /> Cut out instead (show only outside it)
        </label>
        <p v-if="item.clipBy" class="text-[10px] leading-snug text-muted-foreground">The mask isn't drawn in exports and videos; on the board it shows faintly so you can move it.</p>
      </template>
    </div>
  </ScrollArea>
</template>
