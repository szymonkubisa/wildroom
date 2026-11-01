<script setup lang="ts">
import { ArrowRight, BookOpen, Loader2, MapPin, PenLine, RefreshCw, Sparkles, UserRound } from '@lucide/vue'
import { type ScriptDiff, diffScript } from '@shared/story/scriptDiff'
import { scenesOfChapter } from '@shared/story/structure'
import { computed, ref, shallowRef } from 'vue'
import { toast } from 'vue-sonner'
import { useConfirm } from '@/components/app/useConfirm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import TextModelPicker from '@/features/director/TextModelPicker.vue'
import { loadTextModels, useTextModels } from '@/features/director/textModels'
import { errorMessage } from '@/lib/api'
import { formatUsd } from '@/lib/format'
import { directorUsd } from '../directorCost'
import InlineConfirm from '../InlineConfirm.vue'
import { openPlanScene } from '../planStep'
import { useStory } from '../useStory'

/**
 * Step 1, Script: the script (a logline, an outline or a screenplay) and its look, and the Director's outline of it —
 * the characters, the places, and the scenes in chapters. No shots yet: those are written scene by scene. Once there
 * are scenes, Update scenes writes again only the scenes whose part of the script changed.
 */
const emit = defineEmits<{ next: [] }>()
const s = useStory()
const { story, update } = s
const busy = ref(false)
const { status, models } = useTextModels()
const confirm = useConfirm()
const via = computed(() => status.value?.via)

const chapters = computed(() => {
  const st = story.value
  if (!st.scenes?.length) return []
  if (!st.chapters?.length) return [{ id: '', title: '', summary: '', scenes: st.scenes }]
  return st.chapters.map((c) => ({ ...c, summary: c.summary ?? '', scenes: scenesOfChapter(st, c.id) }))
})
const sceneNumber = (id: string) => (story.value.scenes ?? []).findIndex((x) => x.id === id) + 1
const placeName = (id?: string) => (id ? story.value.places?.find((p) => p.id === id)?.name : undefined)

/**
 * The text in the box taken as an idea: the AI writes a short screenplay from it in its place (undoable) — read it,
 * change it, then Create scenes.
 */
const writing = ref(false)
/** `idea`: what to write from instead of the box; `quiet`: no questions, no success toast. */
async function writeScriptFromIdea(opts: { idea?: string; quiet?: boolean } = {}): Promise<boolean> {
  const idea = (opts.idea ?? story.value.script).trim()
  if (!idea) {
    toast.warning('Write an idea first')
    return false
  }
  if (
    !opts.quiet &&
    idea.length > 400 &&
    !(await confirm({ title: 'Write a new screenplay from this text?', description: 'It replaces the text in the box — Undo brings it back.', confirmText: 'Write script' }))
  )
    return false
  writing.value = true
  try {
    const res = await s.writeScript(idea)
    if (!opts.quiet) toast.success('Script written', { description: `By ${res.model}. Read it, change what you like, then Create scenes.` })
    return true
  } catch (err) {
    toast.error('Couldn’t write the script', { description: errorMessage(err) })
    return false
  } finally {
    writing.value = false
  }
}

/** The AI reads the script (or a short idea) into heroes, places, chapters and scenes. */
async function createScenes(): Promise<boolean> {
  if (!story.value.script.trim()) {
    toast.warning('Write a script or a short idea first')
    return false
  }
  const shots = story.value.shots.length
  const scenes = story.value.scenes?.length ?? 0
  if (
    (shots || scenes) &&
    !(await confirm({
      title: 'Rebuild all scenes and shots?',
      description: shots
        ? `All ${scenes} scene${scenes === 1 ? '' : 's'} and ${shots} shot${shots === 1 ? '' : 's'} are made again from the script — the chapters, scenes and shots are replaced; Undo brings them back, and their stills and takes stay in the Library. The cast and places are kept.`
        : 'The chapters and scenes are made again from the script (the cast and places are kept); Undo brings them back.',
      confirmText: 'Rebuild everything',
      destructive: true,
    }))
  )
    return false
  pendingUpdate.value = undefined
  busy.value = true
  try {
    const res = await s.outlineStory()
    const n = res.outline.chapters.reduce((k, c) => k + c.scenes.length, 0)
    toast.success(`${n} scene${n === 1 ? '' : 's'} in ${res.outline.chapters.length} chapter${res.outline.chapters.length === 1 ? '' : 's'}`, {
      description: `By ${res.model}. Next: check the cast and places, and give them pictures.`,
    })
    return true
  } catch (err) {
    toast.error('Couldn’t create the scenes', { description: errorMessage(err) })
    return false
  } finally {
    busy.value = false
  }
}

// ---- Update scenes: only the scenes whose part of the script changed

const hasScenes = computed(() => Boolean(story.value.scenes?.length))
/** The script was edited since the scenes were made from it (known for scenes made since that was recorded). */
const scriptEdited = computed(() => story.value.outlinedFrom !== undefined && story.value.outlinedFrom.trim() !== story.value.script.trim())
/** The comparison on the card, as it was when Update scenes was pressed. */
const pendingUpdate = shallowRef<ScriptDiff>()
const updating = ref(false)
const sceneNo = (id: string) => (story.value.scenes ?? []).findIndex((x) => x.id === id) + 1
const sceneById = (id: string) => story.value.scenes?.find((x) => x.id === id)
const numbers = (ids: string[]) => ids.map(sceneNo).filter(Boolean).join(', ')

function askUpdate() {
  if (!story.value.script.trim()) return void toast.warning('Write a script first')
  void loadTextModels()
  pendingUpdate.value = diffScript(story.value.script, story.value.scenes ?? [])
}

/** What the scene has made that rewriting keeps (as it is, or as earlier versions). */
function sceneMade(sceneId: string): string {
  const w = s.sceneWork(sceneId)
  if (!w.shots) return 'no shots yet'
  if (!w.keyframes && !w.takes) return `${w.shots} shot${w.shots === 1 ? '' : 's'}, nothing made yet`
  return `${w.keyframes} still${w.keyframes === 1 ? '' : 's'}, ${w.takes} take${w.takes === 1 ? '' : 's'} kept`
}

const updateCard = computed(() => {
  const d = pendingUpdate.value
  if (!d) return undefined
  const changed = d.changed.filter((c) => sceneById(c.sceneId))
  const lines: { text: string; value?: string; warn?: boolean }[] = changed.map((c) => ({
    text: `Scene ${sceneNo(c.sceneId)} · ${sceneById(c.sceneId)!.title}: ${s.sceneWork(c.sceneId).shots ? 'shots written again from the new text' : 'its part of the script, new'}`,
    value: sceneMade(c.sceneId),
  }))
  if (d.unchanged.length) lines.push({ text: `Scene${d.unchanged.length === 1 ? '' : 's'} ${numbers(d.unchanged)}: no change in the text`, value: 'untouched' })
  if (d.notCompared.length) lines.push({ text: `Scene${d.notCompared.length === 1 ? '' : 's'} ${numbers(d.notCompared)}: not made from the script`, value: 'untouched' })
  for (const h of d.newHeadings) {
    lines.push({ text: `A new heading in scene ${sceneNo(h.sceneId)}’s part (“${h.heading}”) goes into its shots — Rebuild all makes it a scene of its own`, warn: true })
  }
  const requests = changed.map((c) => s.updateRequest(c)).filter((r): r is NonNullable<typeof r> => Boolean(r))
  const demo = status.value?.via === 'demo'
  const usd = demo ? 0 : directorUsd(requests, models.value.find((m) => m.id === status.value?.model))
  const calls = `${requests.length} Director call${requests.length === 1 ? '' : 's'} · ≈ 1 min`
  const total = usd === undefined ? calls : `${demo ? 'free (demo rules)' : `≈ ${formatUsd(usd)}`} · ${calls}`
  const problems = [d.problem && `${d.problem} — Update scenes can’t tell which scene is which: rebuild all scenes instead.`, via.value === 'none' && (status.value?.reason ?? 'Add a Director key first.')].filter(
    (x): x is string => Boolean(x),
  )
  return {
    title: d.problem ? 'The scenes don’t match the script any more' : changed.length ? `Update ${changed.length} scene${changed.length === 1 ? '' : 's'}` : 'The scenes are up to date',
    lines: d.problem ? [] : changed.length ? lines : [{ text: 'Nothing in the script changed since the scenes were made from it.' }],
    total: changed.length && !d.problem ? total : undefined,
    changed,
    problems,
    confirmText: changed.length ? `Update scene${changed.length === 1 ? '' : 's'} ${numbers(changed.map((c) => c.sceneId))}` : 'Update scenes',
  }
})

async function runUpdate() {
  const card = updateCard.value
  if (!card?.changed.length || updating.value) return
  updating.value = true
  const n = card.changed.length
  const id = toast.loading(`Rewriting ${n} scene${n === 1 ? '' : 's'}…`, { description: 'The Director writes each changed scene’s shots again — about a minute.' })
  try {
    const res = await s.updateScenes(card.changed)
    pendingUpdate.value = undefined
    if (!res.scenes) return void toast.error('Couldn’t update the scenes', { id, description: res.error })
    const first = card.changed[0]!.sceneId
    // A new toast, not the loading one updated: an updated toast keeps the timer it was made with (vue-sonner's 4 s),
    // and Show was gone before it could be reached.
    toast.dismiss(id)
    toast.success(`Updated ${res.scenes} scene${res.scenes === 1 ? '' : 's'}: ${res.rewritten} shot${res.rewritten === 1 ? '' : 's'} rewritten, ${res.kept} kept${res.added ? `, ${res.added} new` : ''}`, {
      description: [
        res.rewritten && 'Rewritten shots keep their old still, marked “Still · redo”, until you draw it again.',
        res.dropped && `${res.dropped} shot${res.dropped === 1 ? '' : 's'} no longer in the scene (Undo brings ${res.dropped === 1 ? 'it' : 'them'} back).`,
        res.failed && `${res.failed} scene${res.failed === 1 ? '' : 's'} couldn’t be written${res.error ? `: ${res.error}` : ''} — ${res.failed === 1 ? 'it shows' : 'they show'} as changed next time.`,
      ]
        .filter(Boolean)
        .join(' '),
      // Long enough to reach for; it opens the scene from wherever the user is by then (this step may be gone).
      duration: 8000,
      action: { label: 'Show', onClick: () => openPlanScene(first) },
    })
  } catch (err) {
    toast.error('Couldn’t update the scenes', { id, description: errorMessage(err) })
  } finally {
    updating.value = false
  }
}

function rebuildAll() {
  pendingUpdate.value = undefined
  void createScenes()
}

</script>

<template>
  <div class="grid min-h-0 grid-cols-[minmax(0,1fr)_minmax(300px,420px)] gap-2">
    <div class="panel-card flex min-h-0 flex-col gap-3 bg-sidebar p-4">
      <div>
        <div class="text-[13px] font-semibold tracking-tight">1 · Script</div>
        <div class="text-[11px] text-muted-foreground">
          A screenplay, an outline or just an idea. Dialogue as <span class="font-mono">NAME: line</span>; scene headings (<span class="font-mono">EXT. ROAD — DUSK</span>) help.
        </div>
      </div>
      <Textarea
        :model-value="story.script"
        class="min-h-0 flex-1 resize-none font-mono text-xs leading-relaxed"
        placeholder="A family drives home at dusk and sees smoke rising over the forest…&#10;&#10;— or a screenplay:&#10;&#10;EXT. LIGHTHOUSE — DAWN&#10;Waves crash against the rocks. ANNA (30s, yellow raincoat) climbs the stairs.&#10;&#10;ANNA: [out of breath] It's still here…"
        data-story-script=""
        @change="(e: Event) => update('Edit script', (s) => (s.script = (e.target as HTMLTextAreaElement).value))"
      />
      <div class="grid gap-1.5">
        <Label class="text-[11px] font-medium text-muted-foreground">Visual style</Label>
        <Input
          :model-value="story.style"
          placeholder="e.g. 35mm film, soft morning light, teal and orange"
          class="h-8 text-xs"
          @change="(e: Event) => update('Visual style', (s) => (s.style = (e.target as HTMLInputElement).value))"
        />
      </div>
      <InlineConfirm
        v-if="updateCard"
        :title="updateCard.title"
        :total="updateCard.total"
        :lines="updateCard.lines"
        :problems="updateCard.problems"
        :note="
          updateCard.changed.length
            ? 'Shots whose action didn’t change keep their still and takes. Rewritten shots keep the old still, marked “Still · redo”, until you draw them again; Undo puts the old shots back.'
            : undefined
        "
        :confirm-text="updateCard.confirmText"
        :disabled="!updateCard.changed.length || Boolean(pendingUpdate?.problem) || via === 'none'"
        :busy="updating"
        alt="Rebuild all scenes instead…"
        data-update-scenes-card=""
        @confirm="runUpdate"
        @cancel="pendingUpdate = undefined"
        @alt="rebuildAll"
      />
      <div class="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          :disabled="busy || writing || updating || via === 'none' || !story.script.trim()"
          title="Take the text above as an idea: the AI writes a short screenplay from it in its place (Undo brings it back)"
          data-write-script=""
          @click="writeScriptFromIdea()"
        >
          <Loader2 v-if="writing" class="animate-spin" /><PenLine v-else /> Write script from idea
        </Button>
        <Button
          v-if="hasScenes"
          :disabled="busy || writing || updating || !story.script.trim()"
          title="Compare the script with the one the scenes were made from, and write again only the scenes whose text changed"
          data-update-scenes=""
          @click="askUpdate"
        >
          <Loader2 v-if="updating || busy" class="animate-spin" /><RefreshCw v-else /> Update scenes
        </Button>
        <Button
          v-else
          :disabled="busy || writing || via === 'none' || !story.script.trim()"
          title="The AI reads the script (or a short idea) into characters, places and scenes in chapters"
          data-outline-story=""
          @click="createScenes()"
        >
          <Loader2 v-if="busy" class="animate-spin" /><Sparkles v-else /> Create scenes
        </Button>
        <TextModelPicker compact />
      </div>
      <p class="text-[11px] text-muted-foreground" data-script-status="">
        <template v-if="!hasScenes">
          Create scenes: the AI reads the script into characters, places and scenes grouped in chapters — no shots yet. You write each scene's shots in Shots, once the cast has its pictures.
        </template>
        <template v-else-if="scriptEdited">The script changed since the scenes were made — Update scenes writes again only the scenes whose text changed; the stills and takes you made stay.</template>
        <template v-else>Edited the script? Update scenes changes only the scenes you edited; the stills and takes you made stay.</template>
      </p>
      <p v-if="via === 'none'" class="text-[11px] text-muted-foreground">{{ status?.reason ?? 'Add an Anthropic, OpenRouter or fal.ai key to use the Director.' }}</p>
      <p v-else-if="via === 'demo'" class="text-[11px] text-muted-foreground">
        {{ status?.reason ? `Demo rules (no AI) — ${status.reason}` : 'Demo rules (no AI) until a key is added.' }}
      </p>
    </div>

    <div class="panel-card flex min-h-0 flex-col bg-sidebar">
      <div class="flex items-center gap-2 px-4 pt-3 pb-2">
        <BookOpen class="size-4 text-muted-foreground" />
        <div class="text-[13px] font-semibold tracking-tight">Outline</div>
        <div class="flex-1" />
        <Button v-if="chapters.length" size="sm" @click="emit('next')">Cast & Places <ArrowRight /></Button>
      </div>
      <ScrollArea class="min-h-0 flex-1">
        <div v-if="!chapters.length" class="flex flex-col items-center gap-2 px-6 py-16 text-center text-xs text-muted-foreground">
          <BookOpen class="size-5" />
          The chapters and scenes appear here once the story is outlined.
        </div>
        <div v-else class="grid gap-4 px-4 pb-4" data-outline="">
          <div v-if="story.logline" class="text-xs text-muted-foreground italic">{{ story.logline }}</div>
          <section v-for="c in chapters" :key="c.id" class="grid gap-1.5">
            <div v-if="c.title" class="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{{ c.title }}</div>
            <div v-if="c.summary" class="-mt-1 text-[11px] text-muted-foreground">{{ c.summary }}</div>
            <div v-for="sc in c.scenes" :key="sc.id" class="grid gap-0.5 rounded-lg bg-card px-2.5 py-2">
              <div class="flex items-baseline gap-2 text-xs">
                <span class="font-semibold tabular">{{ sceneNumber(sc.id) }}</span>
                <span class="font-medium">{{ sc.title }}</span>
              </div>
              <div v-if="sc.summary" class="text-[11px] leading-snug text-muted-foreground">{{ sc.summary }}</div>
              <div class="flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
                <span v-if="placeName(sc.placeId)" class="flex items-center gap-0.5"><MapPin class="size-3" />{{ placeName(sc.placeId) }}</span>
                <span v-if="sc.castIds?.length" class="flex items-center gap-0.5">
                  <UserRound class="size-3" />{{ sc.castIds.map((id) => story.characters.find((x) => x.id === id)?.name).filter(Boolean).join(', ') }}
                </span>
              </div>
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  </div>
</template>
