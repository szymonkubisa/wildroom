<script setup lang="ts">
import { Clapperboard, FolderX, Lock, MoreHorizontal, Pin, TriangleAlert } from '@lucide/vue'
import type { ProjectEntry } from '@shared/types/api'
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { relativeTime } from '@/lib/format'
import { aspectLabel } from './formats'
import { KIND_LABELS } from './home'
import ProjectMenu from './ProjectMenu.vue'

/** A project in the Projects page's list view: one row with its kind, tags, status, last edit and format. */
const props = defineProps<{ project: ProjectEntry; duplicating?: boolean; pinned?: boolean; allTags: string[] }>()
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
const poster = computed(() => (props.project.posterUrl && !posterFailed.value && props.project.state !== 'missing' ? props.project.posterUrl : undefined))
const usable = computed(() => props.project.state === 'ok' || props.project.state === 'locked')
const actionable = computed(() => usable.value || props.project.state === 'missing')
const folder = computed(() => props.project.path.split('/').slice(0, -1).join('/').replace(/^\/Users\/[^/]+/, '~'))
const statusText = computed(() => {
  const p = props.project
  if (p.state === 'missing') return 'Folder not found'
  if (p.state === 'newer-format') return 'Made with a newer version'
  if (p.state === 'unreadable') return 'Can’t be read'
  if (p.state === 'locked') return `Open on ${p.lockedBy?.host?.replace(/\.local$/, '') ?? 'another computer'}`
  return p.status ?? ''
})

function activate() {
  if (usable.value) emit('open')
  else if (props.project.state === 'missing') emit('locate')
}
</script>

<template>
  <tr class="group border-b border-border/60 last:border-0 hover:bg-card/60" :data-project-row="project.name">
    <!-- w-full + max-w-0: the name takes the room left and truncates, instead of widening the table. -->
    <td class="w-full max-w-0 py-1.5 pr-3 pl-2">
      <button
        type="button"
        :disabled="!actionable"
        :title="project.path"
        class="flex max-w-full min-w-0 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-70"
        @click="activate"
      >
        <span class="relative flex h-9 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-viewer">
          <img v-if="poster" :src="poster" class="absolute inset-0 size-full object-cover" alt="" @error="posterFailed = true" />
          <FolderX v-else-if="project.state === 'missing'" class="size-4 text-muted-foreground/50" />
          <TriangleAlert v-else-if="!usable" class="size-4 text-muted-foreground/50" />
          <Clapperboard v-else class="size-4 text-muted-foreground/40" />
        </span>
        <span class="min-w-0">
          <span class="flex items-center gap-1.5 text-[13px] font-semibold tracking-tight">
            <span class="truncate">{{ project.name }}</span>
            <Pin v-if="pinned" class="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />
            <Lock v-if="project.state === 'locked'" class="size-3 shrink-0 text-muted-foreground" />
            <span v-else-if="project.open" class="shrink-0 rounded-full bg-brand px-1.5 text-[10px] font-medium text-brand-foreground">Open</span>
          </span>
          <span class="block truncate text-[11px] text-muted-foreground/70">{{ folder }}</span>
        </span>
      </button>
    </td>
    <td class="px-3 text-xs whitespace-nowrap text-muted-foreground">{{ project.kind ? KIND_LABELS[project.kind] : '' }}</td>
    <td class="min-w-28 px-3">
      <span class="flex flex-wrap gap-1">
        <span v-for="tag in project.tags" :key="tag" class="rounded-full bg-field px-1.5 py-px text-[10px] text-muted-foreground">#{{ tag }}</span>
      </span>
    </td>
    <td :class="['max-w-56 truncate px-3 text-xs whitespace-nowrap', usable ? 'text-muted-foreground' : 'text-amber-500']" :title="project.message ?? statusText">{{ statusText }}</td>
    <td class="px-3 text-xs whitespace-nowrap text-muted-foreground tabular">{{ relativeTime(project.updatedAt ?? project.lastOpenedAt ?? '') }}</td>
    <td class="px-3 text-xs whitespace-nowrap text-muted-foreground tabular">
      <template v-if="project.settings">{{ aspectLabel(project.settings.width, project.settings.height) }}</template>
    </td>
    <td class="w-10 pr-2 text-right">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon-sm" :aria-label="`Actions for ${project.name}`" class="rounded-full">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="min-w-48">
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
    </td>
  </tr>
</template>
