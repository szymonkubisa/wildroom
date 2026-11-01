<script setup lang="ts">
import { Compass, FolderOpen, Grid2x2, Grid3x3, List, ListChecks, Loader2, Plus, RefreshCw, Search, Settings, Sparkles, X } from '@lucide/vue'
import type { ProjectKind } from '@shared/projects/meta'
import type { ProjectEntry } from '@shared/types/api'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import AppLogo from '@/components/app/AppLogo.vue'
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
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { openSettings } from '@/features/settings/settingsSheet'
import { api, errorMessage } from '@/lib/api'
import { chooseProjectPath, desktop, droppedPath } from '@/lib/desktop'
import { onServerEvent, onServerReconnect } from '@/lib/sse'
import { cn } from '@/lib/utils'
import { useProjectOpener } from '@/stores/projectOpener'
import { useSettingsStore } from '@/stores/settings'
import { useTourStore } from '@/stores/tour'
import GpuSessionChip from '@/features/gpu/GpuSessionChip.vue'
import RendersPanel from '@/features/jobs/RendersPanel.vue'
import HomePrompt from './HomePrompt.vue'
import { PROJECT_SORTS, type ProjectSort, START_KINDS, filterProjects, readLocal, tagCounts, writeLocal } from './home'
import NewProjectDialog from './NewProjectDialog.vue'
import ProjectCard from './ProjectCard.vue'
import ProjectRow from './ProjectRow.vue'

/**
 * Home: every project — searchable by name, tag and status, filtered by kind and tags, sorted, in a grid or a list,
 * pinned ones first — and, floating at the bottom, "What are we making?" (a brief and a kind → a new project, opened
 * where that kind is made).
 */
const router = useRouter()
const route = useRoute()

const PROMPT_KEY = 'home.promptOpen'
const promptOpen = ref(readLocal(PROMPT_KEY) === '1')
watch(promptOpen, (o) => writeLocal(PROMPT_KEY, o ? '1' : null))
const queryClient = useQueryClient()
const settings = useSettingsStore()
const tour = useTourStore()
const opener = useProjectOpener()
const { data: projects, isLoading, isError, error, isFetching, refetch } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list })

const showNew = ref(false)
const renaming = ref<ProjectEntry>()
const renameValue = ref('')
const trashing = ref<ProjectEntry>()
const dragging = ref(false)
// In flight: a second click before the server answers would rename twice, trash twice or make a second copy.
const renameBusy = ref(false)
const trashBusy = ref(false)
const duplicating = ref(new Set<string>())

// ---------------------------------------------------------------- how the projects are shown (per machine)

/** List, or a grid of compact (more per row) or large cards (wider, bigger posters and titles). */
type Display = 'list' | 'compact' | 'large'
const VIEW_KEY = 'projects.view'
const CARD_SIZE_KEY = 'projects.cardSize'
const display = ref<Display>(readLocal(VIEW_KEY) === 'list' ? 'list' : readLocal(CARD_SIZE_KEY) === 'large' ? 'large' : 'compact')
watch(display, (d) => {
  writeLocal(VIEW_KEY, d === 'list' ? 'list' : 'grid')
  if (d !== 'list') writeLocal(CARD_SIZE_KEY, d)
})
/** Large cards use most of the window's width; compact ones and the list keep the page to a reading width. */
const pageWidth = computed(() => (display.value === 'large' ? 'max-w-[1800px] px-8' : 'max-w-6xl px-6'))
const gridClass = computed(() =>
  display.value === 'large' ? 'grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4' : 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
)

const SORT_KEY = 'projects.sort'
const sort = ref<ProjectSort>(PROJECT_SORTS.some((s) => s.id === readLocal(SORT_KEY)) ? (readLocal(SORT_KEY) as ProjectSort) : 'edited')
watch(sort, (s) => writeLocal(SORT_KEY, s))

/** Pinned projects (by folder) come first — on this Mac only. */
const PINNED_KEY = 'projects.pinned'
function readPinned(): Set<string> {
  try {
    const list: unknown = JSON.parse(readLocal(PINNED_KEY) ?? '[]')
    return new Set(Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [])
  } catch {
    return new Set()
  }
}
const pinned = ref(readPinned())
function setPinned(path: string, on: boolean) {
  const next = new Set(pinned.value)
  if (on) next.add(path)
  else next.delete(path)
  pinned.value = next
  writeLocal(PINNED_KEY, next.size ? JSON.stringify([...next]) : null)
}

// ---------------------------------------------------------------- search and filters (this visit only)

const query = ref('')
const kind = ref<ProjectKind | 'all'>('all')
const tags = ref<string[]>([])
const KIND_FILTERS: { id: ProjectKind | 'all'; label: string }[] = [{ id: 'all', label: 'All' }, ...START_KINDS.map((k) => ({ id: k.id, label: k.plural }))]

const allTags = computed(() => tagCounts(projects.value ?? []))
const tagNames = computed(() => allTags.value.map((t) => t.tag))
const filtering = computed(() => Boolean(query.value.trim() || kind.value !== 'all' || tags.value.length))
const shown = computed(() => filterProjects(projects.value ?? [], { query: query.value, kind: kind.value, tags: tags.value, sort: sort.value, pinned: pinned.value }))
// A tag nobody has any more (removed from its last project) stops filtering.
watch(tagNames, (names) => {
  if (tags.value.some((t) => !names.includes(t))) tags.value = tags.value.filter((t) => names.includes(t))
})

function toggleTag(tag: string) {
  tags.value = tags.value.includes(tag) ? tags.value.filter((t) => t !== tag) : [...tags.value, tag]
}
function clearFilters() {
  query.value = ''
  kind.value = 'all'
  tags.value = []
}

// File → New Project in the desktop app lands here with ?new=1.
watch(
  () => route.query.new,
  (value) => {
    if (!value) return
    showNew.value = true
    void router.replace({ query: {} })
  },
  { immediate: true },
)

// The first time the app opens: the walkthrough starts by itself, once (it's marked seen when it ends or is skipped).
watch(
  () => !isLoading.value && settings.loaded,
  (ready) => {
    if (ready && !tour.seen() && !tour.active) tour.start()
  },
  { immediate: true },
)
const projectsDir = computed(() => settings.app?.projectsDir?.replace(/^\/Users\/[^/]+/, '~'))

function refresh() {
  void queryClient.invalidateQueries({ queryKey: ['projects'] })
}

const stopEvents = onServerEvent((event) => {
  if (event.type === 'projects.changed') refresh()
})
// Back after a restart: a list that failed to load meanwhile (or went stale) loads again.
const stopReconnect = onServerReconnect(refresh)
onBeforeUnmount(() => {
  stopEvents()
  stopReconnect()
})

function open(project: ProjectEntry) {
  void opener.openPath(project.path, { name: project.name })
}

/** A missing project: the user points at its new location (moved, renamed, or on another drive). */
async function locate(project: ProjectEntry) {
  try {
    const path = await chooseProjectPath()
    if (!path) return
    if (await opener.openPath(path)) {
      if (project.recent) await api.projects.forget(project.path).catch(() => {})
    }
  } catch (err) {
    toast.error('Could not locate the project', { description: errorMessage(err) })
  }
}

/**
 * Runs an action that needs the project open on the server, closing it again if it wasn't. Opened by its folder,
 * never by id: a copy made in Finder shares its original's id until it is opened (which gives it its own).
 */
async function withProject<T>(project: ProjectEntry, run: (id: string) => Promise<T>): Promise<T> {
  const { id } = await api.projects.open(project.path)
  try {
    return await run(id)
  } finally {
    if (!project.open) await api.projects.close(id).catch(() => {})
  }
}

function startRename(project: ProjectEntry) {
  renaming.value = project
  renameValue.value = project.name
}

async function confirmRename() {
  const project = renaming.value
  if (!project || renameBusy.value) return
  renameBusy.value = true
  try {
    const renamed = await withProject(project, (id) => api.projects.rename(id, renameValue.value))
    // A pin follows the folder's new name.
    if (pinned.value.has(project.path) && renamed.path !== project.path) {
      setPinned(project.path, false)
      setPinned(renamed.path, true)
    }
    renaming.value = undefined
    refresh()
  } catch (err) {
    toast.error('Rename failed', { description: errorMessage(err) })
  } finally {
    renameBusy.value = false
  }
}

/** The list as shown changes at once; the server's answer (tags cleaned up) or its refusal follows. */
function patchEntry(path: string, patch: Partial<ProjectEntry>) {
  queryClient.setQueryData<ProjectEntry[]>(['projects'], (list) => list?.map((p) => (p.path === path ? { ...p, ...patch } : p)))
}

async function setTags(project: ProjectEntry, next: string[]) {
  const before = project.tags ?? []
  patchEntry(project.path, { tags: next })
  try {
    patchEntry(project.path, { tags: (await api.projects.setTags(project.path, next)).tags })
  } catch (err) {
    patchEntry(project.path, { tags: before })
    toast.error('Could not change the tags', { description: errorMessage(err) })
  }
}

async function duplicate(project: ProjectEntry) {
  if (duplicating.value.has(project.path)) return
  duplicating.value.add(project.path)
  // Copying a project's media can take a while: say it has started.
  const toastId = toast.loading(`Duplicating “${project.name}”…`)
  try {
    const copy = await withProject(project, (id) => api.projects.duplicate(id))
    toast.success(`Duplicated as “${copy.name}”`, { id: toastId })
    refresh()
  } catch (err) {
    toast.error('Duplicate failed', { id: toastId, description: errorMessage(err) })
  } finally {
    duplicating.value.delete(project.path)
  }
}

async function reveal(project: ProjectEntry) {
  try {
    await api.projects.reveal(project.path)
  } catch (err) {
    toast.error('Could not show the project', { description: errorMessage(err) })
  }
}

async function forget(project: ProjectEntry) {
  try {
    await api.projects.forget(project.path)
    refresh()
  } catch (err) {
    toast.error('Could not remove the project from the list', { description: errorMessage(err) })
  }
}

/** The folder goes to the macOS Trash (put it back from there: the app can't, so there is no Undo here). */
async function confirmTrash() {
  const project = trashing.value
  if (!project || trashBusy.value) return
  trashBusy.value = true
  try {
    await api.projects.trash(project.path)
    setPinned(project.path, false)
    trashing.value = undefined
    refresh()
  } catch (err) {
    toast.error('Could not move the project to the Trash', { description: errorMessage(err) })
  } finally {
    trashBusy.value = false
  }
}

// Desktop app: drop a project folder onto the page to open it.
function onDragOver(event: DragEvent) {
  if (!desktop || !event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  dragging.value = true
}

/** The pointer left the page (not just moved onto a child, which also fires dragleave). */
function onDragLeave(event: DragEvent) {
  if (!(event.currentTarget as Node).contains(event.relatedTarget as Node | null)) dragging.value = false
}

function onDrop(event: DragEvent) {
  dragging.value = false
  const file = event.dataTransfer?.files[0]
  if (!desktop || !file) return
  event.preventDefault()
  const path = droppedPath(file)
  if (path?.endsWith('.wildroom')) void opener.openPath(path)
  else toast.error('Drop a project (a folder ending in .wildroom) to open it')
}
</script>

<template>
  <div class="relative flex h-full flex-col" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
    <header class="flex h-12 shrink-0 items-center justify-between px-4">
      <AppLogo />
      <div class="flex items-center gap-1.5">
        <GpuSessionChip />
        <RendersPanel />
        <Button variant="ghost" size="sm" class="rounded-full text-muted-foreground hover:text-foreground" @click="tour.start()"><Compass /> Walkthrough</Button>
        <Button variant="ghost" size="sm" class="rounded-full text-muted-foreground hover:text-foreground" @click="router.push({ name: 'features' })"><ListChecks /> Features</Button>
        <Button variant="ghost" size="sm" class="rounded-full text-muted-foreground hover:text-foreground" data-home-settings="" @click="openSettings()">
          <Settings /> Settings
        </Button>
      </div>
    </header>
    <main :class="['min-h-0 flex-1 overflow-y-auto transition-colors', dragging && 'bg-brand/5']">
      <!-- pb-32: the last row scrolls clear of the folded prompt bar. -->
      <section :class="['mx-auto w-full pt-6 pb-32', pageWidth]" aria-labelledby="home-projects">
        <div class="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div class="min-w-0">
            <h2 id="home-projects" class="text-lg font-semibold tracking-tight">
              Projects<span v-if="projects?.length" class="font-normal text-muted-foreground tabular">
                · {{ filtering ? `${shown.length} of ${projects.length}` : projects.length }}</span
              >
            </h2>
            <button
              v-if="projectsDir"
              class="truncate text-xs text-muted-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
              title="Each project is one folder with everything in it — copy it to another Mac, or keep it in iCloud or Dropbox."
              @click="api.system.reveal('projects')"
            >
              {{ projectsDir }}
            </button>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" class="rounded-full" :disabled="opener.opening" @click="opener.openWithDialog(settings.app?.projectsDir)">
              <FolderOpen /> Open…
            </Button>
            <Button variant="outline" size="sm" class="rounded-full" title="Name, format, frame rate and folder" data-new-project="" @click="showNew = true">
              <Plus /> New project…
            </Button>
          </div>
        </div>

        <!-- Search, kind, sort and layout; tags under them. -->
        <div v-if="projects?.length" class="mb-4 grid gap-2.5">
          <div class="flex flex-wrap items-center gap-2">
            <div class="relative min-w-52 flex-1">
              <Search class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input v-model="query" placeholder="Search names, tags and status" class="h-8 pr-8 pl-8" aria-label="Search projects" data-project-search="" />
              <button
                v-if="query"
                type="button"
                class="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
                @click="query = ''"
              >
                <X class="size-4" />
              </button>
            </div>
            <ToggleGroup
              type="single"
              class="gap-0.5 rounded-lg bg-field p-0.5"
              aria-label="Kind"
              :model-value="kind"
              data-kind-filter=""
              @update:model-value="(v) => v && (kind = v as ProjectKind | 'all')"
            >
              <ToggleGroupItem
                v-for="k in KIND_FILTERS"
                :key="k.id"
                :value="k.id"
                class="h-7 rounded-md px-2.5 text-xs data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
              >
                {{ k.label }}
              </ToggleGroupItem>
            </ToggleGroup>
            <Select v-model="sort">
              <SelectTrigger class="h-8 w-36 text-xs" aria-label="Sort projects"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="s in PROJECT_SORTS" :key="s.id" :value="s.id">{{ s.label }}</SelectItem>
              </SelectContent>
            </Select>
            <ToggleGroup type="single" aria-label="Layout" :model-value="display" @update:model-value="(v) => v && (display = v as Display)">
              <!-- A plain title, not a Tooltip: a tooltip trigger's data-state would hide the pressed (data-state=on) look. -->
              <ToggleGroupItem value="list" class="h-8 px-2.5" aria-label="List" title="List"><List /></ToggleGroupItem>
              <ToggleGroupItem value="compact" class="h-8 px-2.5" aria-label="Compact cards" title="Compact cards"><Grid3x3 /></ToggleGroupItem>
              <ToggleGroupItem value="large" class="h-8 px-2.5" aria-label="Large cards" title="Large cards — bigger posters and titles"><Grid2x2 /></ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div v-if="allTags.length || filtering" class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by tag (projects with every tag picked)">
            <button
              v-for="t in allTags"
              :key="t.tag"
              type="button"
              :aria-pressed="tags.includes(t.tag)"
              :data-tag-chip="t.tag"
              :class="
                cn(
                  'flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs transition-colors',
                  tags.includes(t.tag) ? 'bg-brand text-brand-foreground' : 'bg-field text-muted-foreground hover:bg-field-hover hover:text-foreground',
                )
              "
              @click="toggleTag(t.tag)"
            >
              #{{ t.tag }}<span class="text-[10px] tabular opacity-70">{{ t.count }}</span>
            </button>
            <button v-if="filtering" type="button" class="ml-1 text-xs text-brand hover:underline" @click="clearFilters">Clear filters</button>
          </div>
        </div>

        <!-- pt-1: room for a card's hover lift. -->
        <div class="pt-1">
          <div v-if="isLoading" :class="gridClass">
            <Skeleton v-for="i in 4" :key="i" class="aspect-[4/3] rounded-2xl" />
          </div>
          <!-- Only when there is nothing to show: a failed refetch keeps the cards already loaded. -->
          <div
            v-else-if="isError && !projects"
            class="flex flex-col items-center justify-center rounded-2xl border border-dashed border-foreground/10 py-20 text-center"
          >
            <div class="text-base font-medium">Could not load your projects</div>
            <p class="mt-1 max-w-sm text-sm text-muted-foreground">{{ errorMessage(error) }}</p>
            <div class="mt-4 flex gap-2">
              <Button variant="outline" :disabled="isFetching" @click="refetch()">
                <RefreshCw :class="isFetching && 'animate-spin'" /> Try again
              </Button>
            </div>
          </div>
          <div
            v-else-if="!projects?.length"
            class="flex flex-col items-center justify-center rounded-2xl border border-dashed border-foreground/10 py-16 text-center"
          >
            <div class="text-base font-medium">No projects yet</div>
            <p class="mt-1 max-w-sm text-sm text-muted-foreground">
              Describe one and Start — or open a project folder copied from another computer.
            </p>
            <div class="mt-4 flex gap-2">
              <Button @click="promptOpen = true"><Sparkles /> Describe it…</Button>
              <Button variant="outline" @click="opener.openWithDialog(settings.app?.projectsDir)"><FolderOpen /> Open…</Button>
              <Button variant="outline" @click="showNew = true"><Plus /> New project…</Button>
            </div>
          </div>
          <div
            v-else-if="!shown.length"
            class="flex flex-col items-center justify-center rounded-2xl border border-dashed border-foreground/10 py-14 text-center"
            data-projects-empty=""
          >
            <div class="text-base font-medium">No projects match</div>
            <p class="mt-1 text-sm text-muted-foreground">Try another word, kind or tag.</p>
            <Button class="mt-4" variant="outline" size="sm" @click="clearFilters">Clear filters</Button>
          </div>
          <div v-else-if="display === 'list'" class="overflow-x-auto rounded-2xl bg-sidebar">
            <table class="w-full min-w-[640px] text-left">
              <thead class="text-[11px] tracking-wide text-muted-foreground uppercase">
                <tr class="border-b border-border">
                  <th class="py-2 pr-3 pl-2 font-medium">Name</th>
                  <th class="px-3 font-medium">Kind</th>
                  <th class="px-3 font-medium">Tags</th>
                  <th class="px-3 font-medium">Status</th>
                  <th class="px-3 font-medium">Edited</th>
                  <th class="px-3 font-medium">Format</th>
                  <th class="pr-2"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                <ProjectRow
                  v-for="project in shown"
                  :key="project.path"
                  :project="project"
                  :pinned="pinned.has(project.path)"
                  :all-tags="tagNames"
                  :duplicating="duplicating.has(project.path)"
                  @open="open(project)"
                  @locate="locate(project)"
                  @rename="startRename(project)"
                  @duplicate="duplicate(project)"
                  @reveal="reveal(project)"
                  @forget="forget(project)"
                  @trash="trashing = project"
                  @pin="setPinned(project.path, !pinned.has(project.path))"
                  @tags="(next) => setTags(project, next)"
                />
              </tbody>
            </table>
          </div>
          <div v-else :class="gridClass">
            <ProjectCard
              v-for="project in shown"
              :key="project.path"
              :project="project"
              :size="display === 'large' ? 'large' : 'compact'"
              :pinned="pinned.has(project.path)"
              :all-tags="tagNames"
              :duplicating="duplicating.has(project.path)"
              @open="open(project)"
              @locate="locate(project)"
              @rename="startRename(project)"
              @duplicate="duplicate(project)"
              @reveal="reveal(project)"
              @forget="forget(project)"
              @trash="trashing = project"
              @pin="setPinned(project.path, !pinned.has(project.path))"
              @tags="(next) => setTags(project, next)"
            />
          </div>
        </div>
      </section>
    </main>

    <div class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-background via-background/60 to-transparent px-6 pt-20 pb-4">
      <HomePrompt v-model:open="promptOpen" class="pointer-events-auto w-full max-w-3xl" />
    </div>

    <NewProjectDialog v-model:open="showNew" />

    <Dialog :open="Boolean(renaming)" @update:open="(v) => !v && (renaming = undefined)">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader><DialogTitle>Rename project</DialogTitle></DialogHeader>
        <form class="grid gap-4" @submit.prevent="confirmRename">
          <Input v-model="renameValue" autofocus />
          <p class="text-xs text-muted-foreground">The project folder is renamed too.</p>
          <DialogFooter>
            <Button type="button" variant="ghost" @click="renaming = undefined">Cancel</Button>
            <Button type="submit" :disabled="renameBusy"><Loader2 v-if="renameBusy" class="animate-spin" /> Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <AlertDialog :open="Boolean(trashing)" @update:open="(v) => !v && (trashing = undefined)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Move “{{ trashing?.name }}” to the Trash?</AlertDialogTitle>
          <AlertDialogDescription>
            The project folder and all its media go to the Trash, where you can still restore them. If the folder is in
            iCloud Drive or Dropbox, it disappears from your other computers too.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" :disabled="trashBusy" @click="confirmTrash">
            <Loader2 v-if="trashBusy" class="animate-spin" /> Move to Trash
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
