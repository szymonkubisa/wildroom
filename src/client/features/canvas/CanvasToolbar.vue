<script setup lang="ts">
import { Download, Frame, Hand, MousePointer2, Minus, Plus, Slash, Square, Spline, Sparkles, StickyNote, Type, Maximize } from '@lucide/vue'
import { FRAME_GROUPS, FRAME_PRESETS } from '@shared/canvas/framePresets'
import { zoomAt } from '@shared/canvas/geometry'
import type { Component } from 'vue'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuShortcut, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { type CanvasTool, useCanvasStore } from '@/stores/canvas'
import { addFrame } from './frames'

const canvas = useCanvasStore()

const TOOLS: { id: CanvasTool; icon: Component; label: string; key: string }[] = [
  { id: 'select', icon: MousePointer2, label: 'Select', key: 'V' },
  { id: 'hand', icon: Hand, label: 'Hand — pan the board', key: 'H' },
  { id: 'text', icon: Type, label: 'Text', key: 'T' },
  { id: 'note', icon: StickyNote, label: 'Sticky note — prompts and context', key: 'N' },
  { id: 'rect', icon: Square, label: 'Rectangle', key: 'R' },
  { id: 'line', icon: Slash, label: 'Line — drag its direction', key: 'L' },
]

function zoomBy(factor: number) {
  canvas.viewport = zoomAt(canvas.viewport, { x: canvas.viewSize.w / 2, y: canvas.viewSize.h / 2 }, factor)
}

const btn = 'flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
</script>

<template>
  <div class="pointer-events-auto flex items-center gap-0.5 rounded-xl border bg-background/95 p-1 shadow-lg backdrop-blur">
    <Tooltip v-for="t in TOOLS.slice(0, 2)" :key="t.id">
      <TooltipTrigger as-child>
        <button :class="cn(btn, canvas.tool === t.id && 'bg-brand/15 text-brand hover:bg-brand/20 hover:text-brand')" @click="canvas.tool = t.id">
          <component :is="t.icon" class="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{{ t.label }} <span class="ml-1 opacity-60">{{ t.key }}</span></TooltipContent>
    </Tooltip>
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger as-child>
          <DropdownMenuTrigger as-child>
            <button :class="cn(btn, canvas.tool === 'frame' && 'bg-brand/15 text-brand')"><Frame class="size-4" /></button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Frame — exact sizes for web, social, ads <span class="ml-1 opacity-60">F</span></TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" class="max-h-[70vh] w-72 overflow-y-auto">
        <DropdownMenuItem @select="canvas.tool = 'frame'">Draw a custom frame <DropdownMenuShortcut>F</DropdownMenuShortcut></DropdownMenuItem>
        <template v-for="g in FRAME_GROUPS" :key="g">
          <DropdownMenuLabel class="text-[11px] text-muted-foreground">{{ g }}</DropdownMenuLabel>
          <DropdownMenuItem v-for="p in FRAME_PRESETS.filter((x) => x.group === g)" :key="p.id" @select="addFrame(p)">
            <span class="truncate">{{ p.label }}</span>
            <DropdownMenuShortcut>{{ p.w }}×{{ p.h }}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenu>
    <Tooltip v-for="t in TOOLS.slice(2)" :key="t.id">
      <TooltipTrigger as-child>
        <button :class="cn(btn, canvas.tool === t.id && 'bg-brand/15 text-brand hover:bg-brand/20 hover:text-brand')" @click="canvas.tool = t.id">
          <component :is="t.icon" class="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{{ t.label }} <span class="ml-1 opacity-60">{{ t.key }}</span></TooltipContent>
    </Tooltip>

    <div class="mx-1 h-5 w-px bg-border" />

    <Tooltip>
      <TooltipTrigger as-child><button :class="btn" @click="zoomBy(1 / 1.25)"><Minus class="size-4" /></button></TooltipTrigger>
      <TooltipContent>Zoom out <span class="ml-1 opacity-60">⌥-scroll</span></TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger as-child>
        <button class="tabular h-8 w-12 rounded-md text-xs text-muted-foreground hover:bg-accent hover:text-foreground" @click="canvas.requestZoom('actual')">
          {{ Math.round(canvas.viewport.zoom * 100) }}%
        </button>
      </TooltipTrigger>
      <TooltipContent>Zoom to 100% <span class="ml-1 opacity-60">⇧0</span></TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger as-child><button :class="btn" @click="zoomBy(1.25)"><Plus class="size-4" /></button></TooltipTrigger>
      <TooltipContent>Zoom in</TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger as-child><button :class="btn" @click="canvas.requestZoom('fit')"><Maximize class="size-4" /></button></TooltipTrigger>
      <TooltipContent>Zoom to fit <span class="ml-1 opacity-60">⇧1</span></TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger as-child>
        <button :class="cn(btn, canvas.showLineage && 'text-brand')" @click="canvas.showLineage = !canvas.showLineage"><Spline class="size-4" /></button>
      </TooltipTrigger>
      <TooltipContent>{{ canvas.showLineage ? 'Hide' : 'Show' }} links from source images to what was made from them</TooltipContent>
    </Tooltip>

    <div class="mx-1 h-5 w-px bg-border" />

    <Tooltip>
      <TooltipTrigger as-child>
        <button class="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-brand hover:bg-brand/10" @click="canvas.dialog = 'asset-set'">
          <Sparkles class="size-4" /> Brief
        </button>
      </TooltipTrigger>
      <TooltipContent>Describe a brand or a page — get a whole set of matching assets planned and generated</TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger as-child>
        <button :class="btn" @click="canvas.dialog = 'export'"><Download class="size-4" /></button>
      </TooltipTrigger>
      <TooltipContent>Export frames and images <span class="ml-1 opacity-60">⌘E</span></TooltipContent>
    </Tooltip>
  </div>
</template>
