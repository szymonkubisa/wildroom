<script setup lang="ts">
import { Check, Clapperboard, Film, FolderOpen, Palette, Sparkles } from '@lucide/vue'
import type { ProjectKind } from '@shared/projects/meta'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, errorMessage } from '@/lib/api'
import { chooseFolderPath } from '@/lib/desktop'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings'
import { FORMAT_PRESETS } from './formats'

const open = defineModel<boolean>('open', { default: false })
const router = useRouter()
const settings = useSettingsStore()

const name = ref('')
/**
 * Where the new project opens (everything is available in every project): a film starts in Plan. `brand` is no longer
 * a workspace: the editor opens Create with Library › Brand (`?ws=brand`).
 */
const startWith = ref<'story' | 'edit' | 'canvas' | 'brand'>('story')
const STARTS = [
  { id: 'story', label: 'Film', detail: 'Script, cast and shots — opens Plan', icon: Clapperboard },
  { id: 'edit', label: 'Edit footage', detail: 'Timeline, shots, sound — opens Edit', icon: Film },
  { id: 'canvas', label: 'Images & social', detail: 'Web and social assets — opens Create', icon: Sparkles },
  { id: 'brand', label: 'Brand', detail: 'Identity, palette, logos — opens Library › Brand', icon: Palette },
] as const
/** What the project is filed as on the Projects page (a brand kit isn't one of the kinds: worked out later). */
const KIND_OF_START: Record<(typeof STARTS)[number]['id'], ProjectKind | undefined> = { story: 'film', edit: 'edit', canvas: 'social', brand: undefined }
const showFormat = computed(() => startWith.value === 'story' || startWith.value === 'edit')
const presetId = ref('1080p')
const fps = ref('auto')
const creating = ref(false)
/** Where the project folder goes (the projects folder unless changed for this project). */
const location = ref<string>()
const folder = computed(() => location.value ?? settings.app?.projectsDir ?? '')
const folderLabel = computed(() => folder.value.replace(/^\/Users\/[^/]+/, '~'))

watch(open, (isOpen) => {
  if (isOpen) location.value = undefined
})

async function chooseLocation() {
  try {
    const path = await chooseFolderPath('Where should the new project folder go?', folder.value || undefined)
    if (path) location.value = path
  } catch (err) {
    toast.error('Could not show the folder picker', { description: errorMessage(err) })
  }
}

async function create() {
  const preset = FORMAT_PRESETS.find((p) => p.id === presetId.value) ?? FORMAT_PRESETS[0]!
  creating.value = true
  try {
    const project = await api.projects.create(
      name.value.trim() || 'Untitled Project',
      {
        width: preset.width,
        height: preset.height,
        fps: fps.value === 'auto' ? 24 : Number(fps.value),
        fpsAuto: fps.value === 'auto',
      },
      location.value,
      KIND_OF_START[startWith.value],
    )
    open.value = false
    name.value = ''
    await router.push({ name: 'editor', params: { id: project.id }, query: startWith.value === 'edit' ? {} : { ws: startWith.value } })
  } catch (err) {
    toast.error('Could not create project', { description: errorMessage(err) })
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>New project</DialogTitle>
        <DialogDescription>Pick where to start. For a film or footage, pick the delivery format; the frame rate can follow your first clip.</DialogDescription>
      </DialogHeader>
      <form class="grid gap-5" @submit.prevent="create">
        <div class="grid gap-2">
          <Label for="project-name">Name</Label>
          <Input id="project-name" v-model="name" placeholder="Untitled Project" autofocus />
        </div>
        <div class="grid gap-2">
          <Label>Start with</Label>
          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="s in STARTS"
              :key="s.id"
              type="button"
              :data-start="s.id"
              :class="cn('flex items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors hover:bg-accent/60', startWith === s.id && 'border-brand bg-brand/10')"
              @click="startWith = s.id"
            >
              <component :is="s.icon" :class="cn('mt-0.5 size-4 shrink-0', startWith === s.id ? 'text-brand' : 'text-muted-foreground')" />
              <div class="min-w-0">
                <div class="text-sm font-medium">{{ s.label }}</div>
                <div class="text-[11px] leading-snug text-muted-foreground">{{ s.detail }}</div>
              </div>
            </button>
          </div>
          <p class="text-xs text-muted-foreground">One project holds everything — switch between Plan, Create and Edit any time from the left rail; the Library (⌘L) holds its media, cast, places and brand kit.</p>
        </div>
        <div v-if="showFormat" class="grid gap-2">
          <Label>Format</Label>
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <button
              v-for="preset in FORMAT_PRESETS"
              :key="preset.id"
              type="button"
              :class="
                cn(
                  'relative flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors hover:bg-accent/60',
                  presetId === preset.id && 'border-brand bg-brand/10',
                )
              "
              @click="presetId = preset.id"
            >
              <div
                class="rounded-[3px] border border-foreground/40 bg-foreground/5"
                :style="{
                  width: `${preset.width >= preset.height ? 36 : Math.round((36 * preset.width) / preset.height)}px`,
                  height: `${preset.height >= preset.width ? 36 : Math.round((36 * preset.height) / preset.width)}px`,
                }"
              />
              <div>
                <div class="text-sm font-medium">{{ preset.label }}</div>
                <div class="text-xs text-muted-foreground">{{ preset.detail }}</div>
              </div>
              <Check v-if="presetId === preset.id" class="absolute top-2 right-2 size-4 text-brand" />
            </button>
          </div>
        </div>
        <div class="grid gap-2">
          <Label>Location</Label>
          <div class="flex items-center gap-2">
            <div class="w-0 min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs" :title="folder">
              {{ folderLabel }}/{{ (name.trim() || 'Untitled Project').replace(/[/:]/g, '-') }}.wildroom
            </div>
            <Button type="button" variant="outline" size="sm" @click="chooseLocation"><FolderOpen /> Change…</Button>
          </div>
          <p class="text-xs text-muted-foreground">The project is one folder holding its timeline, media and render history.</p>
        </div>
        <div v-if="showFormat" class="grid gap-2">
          <Label>Frame rate</Label>
          <Select v-model="fps">
            <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Automatic — from the first video clip</SelectItem>
              <SelectItem value="24">24 fps (film)</SelectItem>
              <SelectItem value="25">25 fps (PAL)</SelectItem>
              <SelectItem value="30">30 fps</SelectItem>
              <SelectItem value="60">60 fps</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" @click="open = false">Cancel</Button>
          <Button type="submit" :disabled="creating">Create project</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
