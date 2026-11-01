<script setup lang="ts">
import { Clapperboard, FolderX, Lock, MoreHorizontal, Pin, TriangleAlert } from '@lucide/vue'
import type { ProjectEntry } from '@shared/types/api'
import { formatTimecode } from '@shared/time/timecode'
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { relativeTime } from '@/lib/format'
import { aspectLabel } from './formats'
import { KIND_LABELS } from './home'
import ProjectMenu from './ProjectMenu.vue'

/**
 * `large`: the home grid's wide cards, with a bigger title and details. `duplicating`: a copy is being made.
 * `pinned`: first on this Mac. `allTags`: every tag in use (the menu's Tags).
 */
const props = defineProps<{ project: ProjectEntry; size?: 'compact' | 'large'; duplicating?: boolean; pinned?: boolean; allTags: string[] }>()
const large = computed(() => props.size === 'large')
const emit = defineEmits<{
  open: []
  rename: []
  duplicate: []
  reveal: []
  locate: []
  forget: []
  trash: []
  pin: []
  tags: [tags: string[]]
}>()

const posterFailed = ref(false)
const poster = computed(() => (props.project.posterUrl && !posterFailed.value ? props.project.posterUrl : undefined))
const settings = computed(() => props.project.settings)
const usable = computed(() => props.project.state === 'ok' || props.project.state === 'locked')
const lockedHost = computed(() => props.project.lockedBy?.host?.replace(/\.local$/, '') ?? 'another computer')
const actionable = computed(() => usable.value || props.project.state === 'missing')

function activate() {
  if (usable.value) emit('open')
  else if (props.project.state === 'missing') emit('locate')
}
</script>

<template>
  <div
    :class="[
      'group relative flex flex-col overflow-hidden rounded-2xl bg-sidebar transition-all',
      large ? 'p-2' : 'p-1.5',
      actionable
        ? 'cursor-pointer outline-none hover:-translate-y-0.5 hover:bg-card hover:shadow-pop focus-visible:ring-2 focus-visible:ring-ring/60'
        : 'cursor-default opacity-70',
    ]"
    :title="project.path"
    :role="actionable ? 'button' : undefined"
    :tabindex="actionable ? 0 : undefined"
    :aria-label="actionable ? `${project.state === 'missing' ? 'Locate' : 'Open'} ${project.name}` : undefined"
    :data-project-card="project.name"
    @click="activate"
    @keydown.enter.self.prevent="activate"
    @keydown.space.self.prevent="activate"
  >
    <div class="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-viewer">
      <!-- Every poster fills the card (vertical and square ones cropped), so the grid reads as one even wall. -->
      <img
        v-if="poster && project.state !== 'missing'"
        :src="poster"
        class="absolute inset-0 size-full object-cover"
        alt=""
        @error="posterFailed = true"
      />
      <FolderX v-else-if="project.state === 'missing'" class="size-8 text-muted-foreground/50" />
      <TriangleAlert v-else-if="!usable" class="size-8 text-muted-foreground/50" />
      <Clapperboard v-else class="size-8 text-muted-foreground/40" />
      <span
        v-if="settings && usable"
        class="absolute right-2 bottom-2 rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[11px] text-white tabular backdrop-blur-sm"
      >
        {{ formatTimecode(project.durationFrames, settings.fps) }}
      </span>
      <span
        v-if="project.state === 'locked'"
        class="absolute top-2 left-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white backdrop-blur-sm"
      >
        <Lock class="size-3" /> Open on {{ lockedHost }}
      </span>
      <span v-else-if="project.open" class="absolute top-2 left-2 rounded-full bg-brand px-2 py-0.5 text-[11px] font-medium text-brand-foreground">Open</span>
      <span v-if="pinned" class="absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm" title="Pinned">
        <Pin class="size-3" />
      </span>
    </div>
    <div :class="['flex items-start justify-between gap-2', large ? 'px-2.5 pt-3 pb-2' : 'px-2 pt-2.5 pb-1.5']">
      <div class="min-w-0">
        <div :class="['truncate font-semibold tracking-tight', large ? 'text-lg' : 'text-[13px]']">{{ project.name }}</div>
        <div v-if="project.state === 'missing'" class="mt-0.5 text-xs text-amber-500">Folder not found — click to locate it</div>
        <div v-else-if="project.state === 'newer-format'" class="mt-0.5 text-xs text-amber-500">Made with a newer version of the app</div>
        <div v-else-if="project.state === 'unreadable'" class="mt-0.5 truncate text-xs text-amber-500" :title="project.message">
          Can't be read: {{ project.message }}
        </div>
        <div v-else-if="settings" :class="['mt-0.5 text-muted-foreground', large ? 'text-sm' : 'text-xs']">
          <template v-if="project.kind">{{ KIND_LABELS[project.kind] }} · </template>{{ aspectLabel(settings.width, settings.height) }} ·
          {{ settings.fpsAuto ? 'auto' : settings.fps }} fps · {{ relativeTime(project.updatedAt ?? project.lastOpenedAt ?? '') }}
        </div>
        <div v-if="usable && project.status" class="mt-0.5 truncate text-[11px] text-muted-foreground/70">{{ project.status }}</div>
        <div v-if="project.tags?.length" class="mt-1.5 flex flex-wrap gap-1">
          <span v-for="tag in project.tags" :key="tag" class="rounded-full bg-field px-1.5 py-px text-[10px] text-muted-foreground">#{{ tag }}</span>
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger as-child @click.stop>
          <Button
            variant="ghost"
            size="icon-sm"
            :aria-label="`Actions for ${project.name}`"
            class="shrink-0 rounded-full opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="min-w-48" @click.stop>
          <ProjectMenu
            :project="project"
            :pinned="Boolean(pinned)"
            :duplicating="duplicating"
            :all-tags="allTags"
            @pin="emit('pin')"
            @rename="emit('rename')"
            @duplicate="emit('duplicate')"
            @reveal="emit('reveal')"
            @locate="emit('locate')"
            @forget="emit('forget')"
            @trash="emit('trash')"
            @tags="(tags) => emit('tags', tags)"
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</template>
