<script setup lang="ts">
import { Clapperboard, Compass, Film, Library, Settings, Sparkles } from '@lucide/vue'
import type { Component } from 'vue'
import { useRouter } from 'vue-router'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLibrary } from '@/features/library/library'
import { openSettings } from '@/features/settings/settingsSheet'
import { cn } from '@/lib/utils'
import { type Workspace, useEditorStore } from '@/stores/editor'

const editor = useEditorStore()
const library = useLibrary()
const router = useRouter()

/** Plan · Create · Edit, numbered in the order a film is made (each works on its own); then the Library over all three. */
const ITEMS: { id: Workspace; label: string; icon: Component; hint: string; n: number }[] = [
  { id: 'story', label: 'Plan', icon: Clapperboard, n: 1, hint: 'Plan — script, cast & places, then each scene’s shots, stills and takes' },
  { id: 'canvas', label: 'Create', icon: Sparkles, n: 2, hint: 'Create — an infinite board for images, web and social assets; generate from what you select' },
  { id: 'edit', label: 'Edit', icon: Film, n: 3, hint: 'Edit — viewer, magnetic timeline and media browser; generations land at the playhead' },
]

const itemClass = 'group relative flex w-12 flex-col items-center gap-1 rounded-xl py-2 text-[10px] font-medium tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 outline-none'
const activeClass = 'bg-brand/15 font-semibold text-brand hover:bg-brand/20 hover:text-brand'
</script>

<template>
  <nav data-tour="workspace" class="flex w-[60px] shrink-0 flex-col items-center gap-1 pt-1 pb-2">
    <Tooltip v-for="item in ITEMS" :key="item.id">
      <TooltipTrigger as-child>
        <!-- The open workspace: a brand-tinted pill with the icon and label in the brand colour. -->
        <button
          :data-tour="`workspace-${item.id}`"
          :aria-pressed="editor.workspace === item.id"
          :class="cn(itemClass, editor.workspace === item.id && activeClass)"
          @click="editor.workspace = item.id"
        >
          <span class="absolute top-1 right-1.5 font-mono text-[8px] leading-none text-muted-foreground/60" aria-hidden="true">{{ item.n }}</span>
          <component :is="item.icon" :class="cn('size-[18px] transition-colors', editor.workspace === item.id && 'text-brand')" />
          {{ item.label }}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{{ item.hint }}</TooltipContent>
    </Tooltip>
    <div class="my-1 h-px w-8 bg-border" />
    <Tooltip>
      <TooltipTrigger as-child>
        <!-- Not a workspace: a drawer over whichever one is open. -->
        <button data-tour="library" :aria-pressed="library.open" :class="cn(itemClass, library.open && 'bg-accent text-foreground')" @click="library.toggle()">
          <Library class="size-[18px]" />
          Library
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">Library (⌘L) — media, cast, places and the brand kit, over any view</TooltipContent>
    </Tooltip>
    <div class="flex-1" />
    <Tooltip>
      <TooltipTrigger as-child>
        <button class="flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 outline-none" @click="router.push({ name: 'features' })">
          <Compass class="size-[18px]" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">Features & walkthrough</TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger as-child>
        <button class="flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 outline-none" aria-label="Settings" data-rail-settings="" @click="openSettings()">
          <Settings class="size-[18px]" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">Settings</TooltipContent>
    </Tooltip>
  </nav>
</template>
