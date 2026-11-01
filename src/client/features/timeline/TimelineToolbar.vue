<script setup lang="ts">
import {
  Blend,
  Bookmark,
  Captions,
  Check,
  ChevronDown,
  ListVideo,
  Magnet,
  Maximize2,
  MousePointer2,
  MoveHorizontal,
  Plus,
  Redo2,
  ScanLine,
  Scissors,
  SlidersVertical,
  Sparkles,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from '@lucide/vue'
import { formatTimecode } from '@shared/time/timecode'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { aspectLabel } from '@/features/projects/formats'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Tool } from '@/stores/editor'
import { useEditorStore } from '@/stores/editor'
import { useProjectStore } from '@/stores/project'
import MixerPanel from '@/features/audio/MixerPanel.vue'
import { useTimelineCommands } from './commands'
import { useTimelines } from './timelines'
import { MAX_ZOOM, MIN_ZOOM } from './geometry'
import { timelineZoom } from './zoom'

const editor = useEditorStore()
const project = useProjectStore()
const commands = useTimelineCommands()
const timelines = useTimelines()

const zoomLog = computed({
  get: () => [((Math.log(editor.pxPerFrame) - Math.log(MIN_ZOOM)) / (Math.log(MAX_ZOOM) - Math.log(MIN_ZOOM))) * 100],
  set: (v: number[]) => {
    const t = (v[0] ?? 0) / 100
    // Through the timeline's own zoom, so the view stays anchored on the playhead like ⌘= / ⌘-.
    timelineZoom.set(Math.exp(Math.log(MIN_ZOOM) + t * (Math.log(MAX_ZOOM) - Math.log(MIN_ZOOM))))
  },
})

const tools: { id: Tool; label: string; key: string; icon: unknown }[] = [
  { id: 'select', label: 'Select', key: 'A', icon: MousePointer2 },
  { id: 'trim', label: 'Trim (roll / slip)', key: 'T', icon: MoveHorizontal },
  { id: 'blade', label: 'Blade', key: 'B', icon: Scissors },
]
</script>

<template>
  <div data-tour="timeline-toolbar" class="flex h-11 shrink-0 items-center gap-1 px-2.5">
    <!-- Which timeline this is, first: the tools after it act on it. -->
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button variant="ghost" size="sm" class="h-7 max-w-52 min-w-0 gap-1.5 rounded-lg px-2 text-xs font-semibold" title="Timelines in this project" data-timeline-switcher>
          <ListVideo class="size-3.5 shrink-0" /><span class="truncate">{{ timelines.active.value.name }}</span><ChevronDown class="size-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-64">
        <DropdownMenuLabel>Timelines</DropdownMenuLabel>
        <DropdownMenuItem v-for="t in timelines.list.value" :key="t.id" @select="timelines.open(t.id)">
          <Check :class="t.active ? '' : 'invisible'" />
          <span class="min-w-0 flex-1 truncate">{{ t.name }}</span>
          <span class="shrink-0 text-[10px] text-muted-foreground">{{ aspectLabel(t.settings.width, t.settings.height) }}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem @select="editor.dialog = 'new-timeline'"><Plus /> New timeline…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Separator orientation="vertical" class="mx-1 !h-5" />
    <!-- Tools take no focus from a click (mousedown.prevent): a focused radio owns ←/→, which then moved between the
         tools instead of stepping the playhead. Tab still reaches them. -->
    <ToggleGroup type="single" size="sm" :model-value="editor.tool" @update:model-value="(v) => v && (editor.tool = v as Tool)">
      <Tooltip v-for="t in tools" :key="t.id">
        <TooltipTrigger as-child>
          <ToggleGroupItem :value="t.id" class="size-7 rounded-lg p-0 data-[state=on]:bg-brand/18 data-[state=on]:text-brand" @mousedown.prevent>
            <component :is="t.icon" class="size-3.5" />
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipContent>{{ t.label }} ({{ t.key }})</TooltipContent>
      </Tooltip>
    </ToggleGroup>
    <Separator orientation="vertical" class="mx-1 !h-5" />
    <Tooltip>
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon-sm" :disabled="!project.canUndo" @click="project.undo()"><Undo2 /></Button>
      </TooltipTrigger>
      <TooltipContent>Undo (⌘Z)</TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon-sm" :disabled="!project.canRedo" @click="project.redo()"><Redo2 /></Button>
      </TooltipTrigger>
      <TooltipContent>Redo (⇧⌘Z)</TooltipContent>
    </Tooltip>
    <Separator orientation="vertical" class="mx-1 !h-5" />
    <Tooltip>
      <TooltipTrigger as-child><Button variant="ghost" size="icon-sm" @click="commands.generateHere()"><Sparkles class="text-brand" /></Button></TooltipTrigger>
      <TooltipContent>Generate shot at playhead</TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger as-child><Button variant="ghost" size="icon-sm" @click="commands.addTitle('basic')"><Type /></Button></TooltipTrigger>
      <TooltipContent>Add title</TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger as-child><Button variant="ghost" size="icon-sm" @click="commands.addTransition('dissolve')"><Blend /></Button></TooltipTrigger>
      <TooltipContent>Cross dissolve (⌘T)</TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger as-child><Button variant="ghost" size="icon-sm" @click="commands.addMarker()"><Bookmark /></Button></TooltipTrigger>
      <TooltipContent>Marker (M)</TooltipContent>
    </Tooltip>
    <div data-tour="captions-mixer" class="flex items-center">
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button variant="ghost" size="sm" class="h-7 gap-1.5 rounded-lg px-2 text-xs"><Captions class="size-3.5" /> Captions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem @select="commands.generateCaptions()">Generate from dialogue</DropdownMenuItem>
        <DropdownMenuItem @select="commands.exportCaptions('srt')">Export .srt</DropdownMenuItem>
        <DropdownMenuItem @select="commands.exportCaptions('vtt')">Export .vtt</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" @select="commands.removeCaptions()">Remove all captions</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Separator orientation="vertical" class="mx-1 !h-5" />
    <Popover>
      <PopoverTrigger as-child>
        <Button variant="ghost" size="sm" class="h-7 gap-1.5 rounded-lg px-2 text-xs"><SlidersVertical class="size-3.5" /> Mixer</Button>
      </PopoverTrigger>
      <PopoverContent align="start" class="w-auto">
        <MixerPanel />
      </PopoverContent>
    </Popover>
    </div>
    <div class="flex-1" />
    <span class="mr-2 rounded-md bg-field px-2 py-0.5 font-mono text-[11px] text-muted-foreground tabular">{{ formatTimecode(project.layout.duration, project.doc.settings.fps) }}</span>
    <Tooltip>
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon-sm" :class="editor.snapping && 'text-selection'" @click="editor.snapping = !editor.snapping"><Magnet /></Button>
      </TooltipTrigger>
      <TooltipContent>Snapping (N)</TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon-sm" :class="editor.skimming && 'text-skimmer'" @click="editor.skimming = !editor.skimming"><ScanLine /></Button>
      </TooltipTrigger>
      <TooltipContent>Skimming (S)</TooltipContent>
    </Tooltip>
    <Separator orientation="vertical" class="mx-1 !h-5" />
    <Button variant="ghost" size="icon-sm" @click="timelineZoom.out()"><ZoomOut /></Button>
    <Slider v-model="zoomLog" :min="0" :max="100" :step="0.5" class="w-28" />
    <Button variant="ghost" size="icon-sm" @click="timelineZoom.in()"><ZoomIn /></Button>
    <Tooltip>
      <TooltipTrigger as-child><Button variant="ghost" size="icon-sm" @click="timelineZoom.fit()"><Maximize2 /></Button></TooltipTrigger>
      <TooltipContent>Zoom to fit (⇧Z)</TooltipContent>
    </Tooltip>
  </div>
</template>
