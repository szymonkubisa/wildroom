<script setup lang="ts">
import { Check, Heart, ImagePlus, Loader2, Search, Upload, X } from '@lucide/vue'
import { mentionables } from '@shared/prompt/mentions'
import type { AssetDTO } from '@shared/types/assets'
import { useLocalStorage } from '@vueuse/core'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useStory } from '@/features/story/useStory'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'

/**
 * The reference pictures a model takes, picked from what the project has: what was generated (newest first), what was
 * uploaded, the cast's and places' pictures, the favourites — a click adds or takes one out, up to the model's limit.
 * The ones in, in order, along the top (× takes one out); Upload adds files from the computer.
 */
const props = defineProps<{ ids: string[]; max: number; label: string; help?: string }>()
const emit = defineEmits<{ update: [ids: string[]] }>()
const assets = useAssetsStore()
const story = useStory()

type Tab = 'generated' | 'uploads' | 'cast' | 'liked'
const TABS: { id: Tab; label: string }[] = [
  { id: 'generated', label: 'Generated' },
  { id: 'uploads', label: 'Uploads' },
  { id: 'cast', label: 'Cast & places' },
  { id: 'liked', label: 'Liked' },
]
/** The tab last looked in (kept across reloads). */
const tab = useLocalStorage<Tab>('composer.refTab', 'generated')
if (!TABS.some((t) => t.id === tab.value)) tab.value = 'generated'
const query = ref('')

const pictures = computed(() => assets.list.filter((a) => a.kind === 'image' && a.status === 'ready' && a.rating !== -1))
const inTab: Record<Exclude<Tab, 'cast'>, (a: AssetDTO) => boolean> = {
  generated: (a) => a.source === 'generation' || a.source === 'derived',
  uploads: (a) => a.source === 'import',
  liked: (a) => a.rating === 1,
}
const matches = (a: AssetDTO) => {
  const q = query.value.trim().toLowerCase()
  return !q || [a.name, a.generation?.prompt, a.description].some((t) => t?.toLowerCase().includes(q))
}
/** The cast's and places' pictures, under each one's name. */
const people = computed(() => {
  const q = query.value.trim().toLowerCase()
  return mentionables(story.story.value, (id) => assets.get(id)?.status === 'ready')
    .filter((m) => m.views.length && (!q || m.name.toLowerCase().includes(q)))
    .map((m) => ({ id: m.id, name: m.name, kind: m.kind, views: m.views.map((id) => assets.get(id)).filter((a) => a !== undefined) }))
})
const shown = computed(() => (tab.value === 'cast' ? [] : pictures.value.filter((a) => inTab[tab.value as Exclude<Tab, 'cast'>](a) && matches(a))))
const count = (t: Tab) => (t === 'cast' ? people.value.length : pictures.value.filter(inTab[t]).length)

const full = computed(() => props.ids.length >= props.max)
function toggle(id: string) {
  if (props.ids.includes(id)) return emit('update', props.ids.filter((x) => x !== id))
  if (full.value) return void toast.warning(`This model takes up to ${props.max} — take one out first`)
  emit('update', [...props.ids, id])
}
const poster = (id: string) => (assets.get(id)?.variants.poster ? `/media/${id}/poster` : undefined)

const fileInput = ref<HTMLInputElement>()
const uploading = ref(false)
async function onFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const files = [...(input.files ?? [])].filter((f) => f.type.startsWith('image/'))
  input.value = ''
  if (!files.length) return
  uploading.value = true
  try {
    const added = (await assets.importFiles(files)).map((a) => a.id).filter((id) => !props.ids.includes(id))
    const room = Math.max(0, props.max - props.ids.length)
    if (added.length > room) toast.warning(`This model takes up to ${props.max} — the first ${room} are in`)
    emit('update', [...props.ids, ...added.slice(0, room)])
    tab.value = 'uploads'
  } finally {
    uploading.value = false
  }
}
</script>

<template>
  <div class="grid w-[min(856px,calc(100vw-3rem))] gap-2" data-reference-picker="">
    <div class="flex items-center justify-between gap-3 px-0.5">
      <span class="text-xs font-medium">
        {{ label }} <span class="text-muted-foreground tabular-nums">{{ ids.length }}/{{ max }}</span>
      </span>
      <button
        type="button"
        class="flex h-7 items-center gap-1.5 rounded-full bg-field px-2.5 text-xs font-medium hover:bg-field-hover disabled:opacity-50"
        :disabled="uploading || full"
        data-reference-upload=""
        @click="fileInput?.click()"
      >
        <Loader2 v-if="uploading" class="size-3.5 animate-spin" />
        <Upload v-else class="size-3.5" /> Upload
      </button>
      <input ref="fileInput" type="file" accept="image/*" multiple class="hidden" @change="onFiles" />
    </div>

    <!-- In, in order. -->
    <div class="flex min-h-14 flex-wrap gap-1.5 rounded-lg bg-field/60 p-1.5" data-reference-chosen="">
      <span v-if="!ids.length" class="self-center px-1.5 text-[11px] text-muted-foreground">Pick pictures below, upload some, or drop them on the tile.</span>
      <span v-for="(id, i) in ids" :key="id" class="group/ref relative h-11 w-16 overflow-hidden rounded-md bg-viewer" :title="assets.get(id)?.name">
        <img v-if="poster(id)" :src="poster(id)" class="size-full object-cover" alt="" />
        <span class="absolute top-0.5 left-0.5 rounded bg-black/60 px-1 font-mono text-[9px] text-white">{{ i + 1 }}</span>
        <button
          type="button"
          class="absolute top-0.5 right-0.5 grid size-4 place-items-center rounded bg-black/60 text-white opacity-0 group-hover/ref:opacity-100 hover:bg-black/80"
          :aria-label="`Take ${assets.get(id)?.name ?? 'it'} out`"
          @click="toggle(id)"
        >
          <X class="size-3" />
        </button>
      </span>
    </div>

    <div class="flex items-center gap-1">
      <div class="flex gap-0.5 rounded-lg bg-field p-0.5" role="tablist">
        <button
          v-for="t in TABS"
          :key="t.id"
          type="button"
          role="tab"
          :aria-selected="tab === t.id"
          :class="cn('flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors', tab === t.id ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')"
          :data-reference-tab="t.id"
          @click="tab = t.id"
        >
          <Heart v-if="t.id === 'liked'" class="size-3" />{{ t.label }}
          <span class="font-mono text-[10px] text-muted-foreground tabular-nums">{{ count(t.id) }}</span>
        </button>
      </div>
      <label class="ml-auto flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-field px-2 text-xs">
        <Search class="size-3.5 shrink-0 text-muted-foreground" />
        <input v-model="query" type="search" placeholder="Search" class="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground" />
      </label>
    </div>

    <ScrollArea class="h-[min(28rem,55vh)]">
      <!-- The cast and places: each one's pictures under its name. -->
      <div v-if="tab === 'cast'" class="grid gap-2.5 pr-2">
        <p v-if="!people.length" class="p-6 text-center text-xs text-muted-foreground">No cast or places with pictures yet — add them in Library › Cast and Places.</p>
        <section v-for="p in people" :key="p.id" class="grid gap-1">
          <h5 class="px-0.5 text-[11px] font-medium">
            {{ p.name }} <span v-if="p.kind === 'place'" class="font-mono text-[9.5px] tracking-wider text-brand uppercase">Place</span>
          </h5>
          <div class="grid grid-cols-4 gap-2.5">
            <button
              v-for="a in p.views"
              :key="a.id"
              type="button"
              :class="cn('relative aspect-video overflow-hidden rounded-lg bg-viewer hover:ring-1 hover:ring-foreground/40', ids.includes(a.id) && 'ring-2 ring-brand hover:ring-brand')"
              :title="a.name"
              :data-reference-pick="a.id"
              @click="toggle(a.id)"
            >
              <img v-if="a.variants.poster" :src="`/media/${a.id}/poster`" class="size-full object-cover" alt="" />
              <span v-if="ids.includes(a.id)" class="absolute top-0.5 right-0.5 grid size-4 place-items-center rounded-full bg-brand text-white"><Check class="size-3" /></span>
            </button>
          </div>
        </section>
      </div>
      <div v-else class="pr-2">
        <p v-if="!shown.length" class="p-6 text-center text-xs text-muted-foreground">
          {{ query.trim() ? 'Nothing matches.' : tab === 'liked' ? 'Nothing marked ♥ yet.' : tab === 'uploads' ? 'Nothing uploaded yet.' : 'Nothing generated yet.' }}
        </p>
        <div class="grid grid-cols-4 gap-2.5">
          <button
            v-for="a in shown"
            :key="a.id"
            type="button"
            :class="cn('relative grid aspect-video place-items-center overflow-hidden rounded-lg bg-viewer hover:ring-1 hover:ring-foreground/40', ids.includes(a.id) && 'ring-2 ring-brand hover:ring-brand')"
            :title="a.generation?.prompt ?? a.name"
            :data-reference-pick="a.id"
            @click="toggle(a.id)"
          >
            <img v-if="a.variants.poster" :src="`/media/${a.id}/poster`" class="absolute inset-0 size-full object-cover" alt="" />
            <ImagePlus v-else class="size-4 text-muted-foreground" />
            <span v-if="ids.includes(a.id)" class="absolute top-0.5 right-0.5 grid size-4 place-items-center rounded-full bg-brand font-mono text-[9px] text-white">{{ ids.indexOf(a.id) + 1 }}</span>
          </button>
        </div>
      </div>
    </ScrollArea>
    <p v-if="help" class="px-0.5 text-[10.5px] text-muted-foreground">{{ help }}</p>
  </div>
</template>
