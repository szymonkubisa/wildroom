<script setup lang="ts">
import { ArrowDown, ArrowUp, ChevronDown, FolderPlus, Merge, MoreHorizontal, Plus, Trash2 } from '@lucide/vue'
import { addScene, mergeWithPrevious, moveScene, removeChapter, removeScene, scenesOfChapter } from '@shared/story/structure'
import type { StoryChapter, StoryScene } from '@shared/types/story'
import { nanoid } from 'nanoid'
import { computed, ref } from 'vue'
import { useConfirm } from '@/components/app/useConfirm'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useStory } from '../useStory'

/** The story's chapters and their scenes, numbered, with how far each scene is; picks the scene the board shows. */
const sceneId = defineModel<string | undefined>('sceneId')
const s = useStory()
const confirm = useConfirm()
const { story, update } = s
const folded = ref(new Set<string>())

const scenes = computed(() => story.value.scenes ?? [])
const groups = computed<{ chapter?: StoryChapter; scenes: StoryScene[] }[]>(() =>
  story.value.chapters?.length ? story.value.chapters.map((c) => ({ chapter: c, scenes: scenesOfChapter(story.value, c.id) })) : [{ scenes: scenes.value }],
)
const numberOf = (id: string) => scenes.value.findIndex((x) => x.id === id) + 1
const placeName = (id?: string) => (id ? story.value.places?.find((p) => p.id === id)?.name : undefined)

/** How far the scene is, 0–100: its stills and takes made, of those it needs (a bar under its name). */
function done(id: string): number {
  const p = s.sceneProgress(id)
  const need = p.stillsNeeded + p.renders
  return need ? Math.round(((p.stills + p.animated) / need) * 100) : 0
}

/** A dot for how far the scene is: no shots, written, stills made, animated. */
function status(id: string): { dot: string; text: string } {
  const p = s.sceneProgress(id)
  if (p.rendering) return { dot: 'bg-brand animate-pulse', text: 'Rendering…' }
  if (!p.shots) return { dot: 'border border-muted-foreground/40', text: 'No shots yet' }
  if (p.renders && p.animated === p.renders) return { dot: 'bg-brand', text: 'Every shot animated' }
  if (p.stillsNeeded && p.stills === p.stillsNeeded) return { dot: 'bg-role-effects', text: `Stills ready · ${p.animated}/${p.renders} animated` }
  return { dot: 'bg-muted-foreground/40', text: `${p.shots} shot${p.shots === 1 ? '' : 's'} · ${p.stills}/${p.stillsNeeded} stills` }
}

function toggle(id: string) {
  const next = new Set(folded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  folded.value = next
}

function newScene(chapterId?: string) {
  const id = nanoid(8)
  const after = chapterId ? scenesOfChapter(story.value, chapterId).at(-1)?.id : (sceneId.value ?? scenes.value.at(-1)?.id)
  update('Add scene', (st) => addScene(st, { id, title: `Scene ${(st.scenes?.length ?? 0) + 1}`, ...(chapterId ? { chapterId } : {}) }, after))
  sceneId.value = id
}

function newChapter() {
  update('Add chapter', (st) => (st.chapters ??= []).push({ id: nanoid(8), title: `Chapter ${(st.chapters?.length ?? 0) + 1}` }))
}

function renameChapter(id: string, title: string) {
  s.updateChapter(id, 'Rename chapter', (c) => (c.title = title.trim() || c.title))
}

async function deleteScene(sc: StoryScene) {
  const n = s.sceneProgress(sc.id).shots
  if (n && !(await confirm({ title: `Delete “${sc.title}” and its ${n} shot${n === 1 ? '' : 's'}?`, description: 'Undo brings them back.', confirmText: 'Delete scene', destructive: true }))) return
  const k = scenes.value.findIndex((x) => x.id === sc.id)
  // Its renders still queued or rendering aren't wanted any more (they went on, paid for, into shots that were gone).
  s.cancelSceneRenders(sc.id)
  update('Delete scene', (st) => removeScene(st, sc.id))
  if (sceneId.value === sc.id) sceneId.value = scenes.value[Math.max(0, k - 1)]?.id
}

function merge(sc: StoryScene) {
  const k = scenes.value.findIndex((x) => x.id === sc.id)
  const previous = scenes.value[k - 1]
  update('Merge scenes', (st) => void mergeWithPrevious(st, sc.id))
  if (previous) sceneId.value = previous.id
}
</script>

<template>
  <div class="flex min-h-0 flex-col bg-sidebar">
    <div class="flex items-center gap-1 px-3 pt-3 pb-2">
      <div class="text-[13px] font-semibold tracking-tight">Scenes</div>
      <span class="text-[11px] text-muted-foreground tabular">{{ scenes.length }}</span>
      <div class="flex-1" />
      <Button size="icon-sm" variant="ghost" title="Add a chapter" @click="newChapter"><FolderPlus /></Button>
      <Button size="icon-sm" variant="ghost" title="Add a scene after this one" @click="newScene()"><Plus /></Button>
    </div>
    <ScrollArea class="min-h-0 flex-1">
      <div class="grid gap-3 px-2 pb-3" data-scene-outline="">
        <section v-for="g in groups" :key="g.chapter?.id ?? 'all'" class="grid gap-0.5">
          <div v-if="g.chapter" class="group/chapter flex items-center gap-1 pr-1">
            <button type="button" class="flex size-5 items-center justify-center text-muted-foreground" @click="toggle(g.chapter.id)">
              <ChevronDown :class="cn('size-3.5 transition-transform', folded.has(g.chapter.id) && '-rotate-90')" />
            </button>
            <Input
              :model-value="g.chapter.title"
              class="h-6 border-transparent bg-transparent px-1 text-[11px] font-semibold tracking-wide uppercase shadow-none hover:border-border focus-visible:bg-field"
              @change="(e: Event) => renameChapter(g.chapter!.id, (e.target as HTMLInputElement).value)"
            />
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button size="icon-sm" variant="ghost" class="size-6 opacity-0 group-hover/chapter:opacity-100"><MoreHorizontal /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem @select="newScene(g.chapter.id)"><Plus /> Add scene here</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" @select="update('Delete chapter', (st) => removeChapter(st, g.chapter!.id))">
                  <Trash2 /> Delete chapter (keeps its scenes)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <template v-if="!g.chapter || !folded.has(g.chapter.id)">
            <div
              v-for="sc in g.scenes"
              :key="sc.id"
              :class="cn('group/scene flex items-center gap-1 rounded-lg pr-1', sceneId === sc.id ? 'bg-field' : 'hover:bg-field/60')"
            >
              <button type="button" class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left" :data-scene="sc.id" @click="sceneId = sc.id">
                <span class="w-5 shrink-0 text-right text-[11px] font-semibold text-muted-foreground tabular">{{ numberOf(sc.id) }}</span>
                <span class="grid min-w-0 flex-1 leading-tight">
                  <span class="truncate text-xs font-medium">{{ sc.title }}</span>
                  <span v-if="placeName(sc.placeId)" class="truncate text-[10px] text-muted-foreground">{{ placeName(sc.placeId) }}</span>
                  <span v-if="s.sceneProgress(sc.id).shots" class="mt-1 block h-[3px] w-full overflow-hidden rounded-full bg-field-hover" :title="status(sc.id).text" data-scene-progress="">
                    <span class="block h-full rounded-full bg-brand transition-[width] duration-300" :style="{ width: `${done(sc.id)}%` }" />
                  </span>
                </span>
                <span :class="cn('size-2 shrink-0 rounded-full', status(sc.id).dot)" :title="status(sc.id).text" />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button size="icon-sm" variant="ghost" class="size-6 opacity-0 group-hover/scene:opacity-100"><MoreHorizontal /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem :disabled="numberOf(sc.id) === 1" @select="update('Move scene', (st) => moveScene(st, sc.id, -1))"><ArrowUp /> Move up</DropdownMenuItem>
                  <DropdownMenuItem :disabled="numberOf(sc.id) === scenes.length" @select="update('Move scene', (st) => moveScene(st, sc.id, 1))"><ArrowDown /> Move down</DropdownMenuItem>
                  <DropdownMenuItem :disabled="numberOf(sc.id) === 1" @select="merge(sc)"><Merge /> Merge into the scene before</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" @select="deleteScene(sc)"><Trash2 /> Delete scene</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div v-if="g.chapter && !g.scenes.length" class="px-8 py-1 text-[11px] text-muted-foreground">No scenes</div>
          </template>
        </section>
      </div>
    </ScrollArea>
  </div>
</template>
