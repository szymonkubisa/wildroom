<script setup lang="ts">
import { Check, ImageIcon, Loader2, Sparkles, TriangleAlert, Wand2 } from '@lucide/vue'
import type { DesignTake, StoryCharacter, StoryPlace } from '@shared/types/story'
import { useLocalStorage } from '@vueuse/core'
import { computed, ref, toRaw, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import TextModelPicker from '@/features/director/TextModelPicker.vue'
import { errorMessage } from '@/lib/api'
import { formatUsd } from '@/lib/format'
import { groupByProvider } from '@/lib/providers'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { useSettingsStore } from '@/stores/settings'
import { type Picks, angleOf, anglesFor, composeLook, isPicked, joinLook, lookDetails, picksFor, togglePick } from './design'
import { closeDesigner, designing } from './designer'
import { placeViewOf, placeViewPhoto } from './references'
import { directorApi, isDead, useStory } from './useStory'

/**
 * The look designer: a character's or a place's look on the left — a few quick picks (who, age, hair…; setting, time,
 * weather…) write its first sentence, the details follow in words, and Improve with AI can rewrite them — pictures to
 * choose from on the right, big. Pick the best, draw its other angles from it, approve — the picks become the
 * references every still and clip is drawn from.
 */
const s = useStory()
const assets = useAssetsStore()
const settings = useSettingsStore()
/** The image models the pictures can be drawn with, by where they run (as the story's Models). */
const imageModels = computed(() => groupByProvider(settings.availableModels.filter((m) => m.kind === 'image')))
const stillsModel = computed(() => s.modelFor('image'))

const kind = computed(() => designing.value?.kind ?? 'character')
const hero = computed(() => kind.value === 'character')
const subject = computed<StoryCharacter | StoryPlace | undefined>(() => {
  const t = designing.value
  if (!t) return undefined
  return t.kind === 'character' ? s.story.value.characters.find((c) => c.id === t.id) : s.story.value.places?.find((p) => p.id === t.id)
})
const currentMain = computed(() => (hero.value ? (subject.value as StoryCharacter | undefined)?.refAssetId : subject.value?.refAssetIds?.[0]))
const currentViews = computed(() => (hero.value ? (subject.value?.refAssetIds ?? []) : (subject.value?.refAssetIds ?? []).slice(1)))
/**
 * A place's directions it has no photo of yet, ticked when the designer opens: a shot looking that way needs one, or
 * its keyframe gets the main view behind the people.
 */
function missingPlaceViews(): string[] {
  const p = subject.value as StoryPlace | undefined
  const missing = (['reverse', 'left', 'right'] as const).filter((v) => !p || !placeViewPhoto(p, v))
  return missing.length ? [...missing] : ['reverse']
}

interface Take {
  key: string
  assetId?: string
  angle?: string
  rendering: boolean
  failed: boolean
  current?: boolean
}
const ready = (id?: string) => Boolean(id && assets.get(id)?.status === 'ready')
function takeOf(t: DesignTake): Take {
  const out = s.outputOf(t.generationId)
  const state = s.jobState(t.generationId)
  const failed = isDead(state)
  return { key: t.generationId, assetId: out?.id, angle: t.angle, failed, rendering: !failed && !ready(out?.id) }
}
const takes = computed(() => (subject.value?.designTakes ?? []).map(takeOf))
const fromTakes = computed(() => new Set(takes.value.flatMap((t) => (t.assetId ? [t.assetId] : []))))
const candidates = computed<Take[]>(() => [
  ...(currentMain.value && !fromTakes.value.has(currentMain.value) ? [{ key: `current:${currentMain.value}`, assetId: currentMain.value, rendering: !ready(currentMain.value), failed: false, current: true }] : []),
  ...takes.value.filter((t) => !t.angle),
])
const angleTakes = computed<Take[]>(() => [
  // A place's current photos know their direction: a new "left" then replaces the old one rather than joining it.
  ...currentViews.value
    .filter((id) => !fromTakes.value.has(id))
    .map((id) => ({ key: `current:${id}`, assetId: id, angle: hero.value ? undefined : placeViewOf(subject.value as StoryPlace, id), rendering: !ready(id), failed: false, current: true })),
  ...takes.value.filter((t) => t.angle),
])

// ---- what is picked: the main picture and the angles that go along
const pick = ref<string>()
const chosen = ref(new Set<string>())
/** Takes already there when the designer opened: only new ones get picked by themselves. */
let seen = new Set<string>()
/** The details of the look: what follows the quick picks' sentence. */
const draft = ref('')
const picks = ref<Picks>({})
const composed = computed(() => composeLook(kind.value, picks.value))
const groups = computed(() => picksFor(kind.value))
const light = ref('')
const notes = ref('')
const name = ref('')
const angleSel = ref(new Set<string>())
watch(
  designing,
  (t) => {
    if (!t || !subject.value) return
    picks.value = { ...(subject.value.picks ?? {}) }
    draft.value = lookDetails(t.kind, picks.value, subject.value.description)
    light.value = (subject.value as StoryPlace).light ?? ''
    notes.value = subject.value.pictureNotes ?? ''
    name.value = subject.value.name
    pick.value = currentMain.value ?? candidates.value.filter((c) => c.assetId && !c.rendering).at(-1)?.assetId
    chosen.value = new Set(currentViews.value)
    seen = new Set(takes.value.map((x) => x.key))
    angleSel.value = new Set(t.angles ?? (t.kind === 'character' ? ['side', 'back'] : missingPlaceViews()))
  },
  { immediate: true },
)
// A new picture, once drawn: the first candidate becomes the pick; a new angle replaces the chosen one of its kind.
watch(takes, (list) => {
  for (const t of list) {
    if (seen.has(t.key) || !t.assetId || t.rendering) continue
    seen.add(t.key)
    if (!t.angle) {
      if (!pick.value) pick.value = t.assetId
      continue
    }
    const next = new Set([...chosen.value].filter((id) => angleTakes.value.find((a) => a.assetId === id)?.angle !== t.angle))
    next.add(t.assetId)
    chosen.value = next
  }
})

// ---- the look itself
function patch(label: string, change: (x: StoryCharacter | StoryPlace) => void) {
  const t = designing.value
  if (!t) return
  s.update(label, (st) => {
    const x = t.kind === 'character' ? st.characters.find((c) => c.id === t.id) : st.places?.find((p) => p.id === t.id)
    if (x) change(x)
  })
}
/** The look as it is saved and read by every prompt: the picks' sentence, then the details. */
const look = () => joinLook(kind.value, picks.value, draft.value)
const samePicks = () => JSON.stringify(picks.value) === JSON.stringify(subject.value?.picks ?? {})
function saveDescription(label = hero.value ? 'Describe character' : 'Describe place') {
  const full = look()
  if (full === subject.value?.description && samePicks()) return
  patch(label, (x) => {
    x.description = full
    // Plain values: a reactive list handed to the document's draft was saved as an object of its items.
    const plain = Object.fromEntries(Object.entries(toRaw(picks.value)).map(([k, v]) => [k, Array.isArray(v) ? [...toRaw(v)] : v]))
    if (Object.keys(plain).length) x.picks = plain
    else delete x.picks
  })
}
function choose(groupId: string, value: string) {
  picks.value = togglePick(kind.value, picks.value, groupId, value)
  saveDescription('Look picks')
}
const saveLight = () => patch('Place light', (x) => ((x as StoryPlace).light = light.value.trim() || undefined))
/** Notes for these pictures only (StoryCharacter.pictureNotes): in the look they rode along into every shot. */
const saveNotes = () =>
  notes.value.trim() !== (subject.value?.pictureNotes ?? '') &&
  patch('Picture notes', (x) => {
    if (notes.value.trim()) x.pictureNotes = notes.value.trim()
    else delete x.pictureNotes
  })
const rename = () => name.value.trim() && name.value !== subject.value?.name && patch(hero.value ? 'Rename character' : 'Rename place', (x) => (x.name = name.value.trim()))

/** The subject the designer shows ("character:abc"), and the one whose look is being improved. */
const subjectKey = () => designing.value && `${designing.value.kind}:${designing.value.id}`
const improvingKey = ref<string>()
const improving = computed(() => Boolean(improvingKey.value) && improvingKey.value === subjectKey())
async function improve() {
  const key = subjectKey()
  if (!subject.value || !key || improving.value) return
  improvingKey.value = key
  try {
    const res = await directorApi.improveLook({ kind: kind.value, name: name.value, description: look(), style: s.story.value.style, script: s.story.value.script })
    // The designer moved on to another hero or place meanwhile: the look is this one's (it went into that one's).
    if (subjectKey() !== key) return
    // The picks' sentence stays first; what the AI wrote is the details (all of it, when it reworded the picks too).
    draft.value = lookDetails(kind.value, picks.value, res.description)
    saveDescription()
    toast.success('Look written', { description: `By ${res.model}` })
  } catch (err) {
    toast.error('Couldn’t improve the look', { description: errorMessage(err) })
  } finally {
    if (improvingKey.value === key) improvingKey.value = undefined
  }
}

// ---- drawing
const count = useLocalStorage('design.count', 2)
const blocker = computed(() => {
  if (!designing.value) return undefined
  const plan = s.planDesign(kind.value, designing.value.id)
  return typeof plan === 'string' ? plan : undefined
})
const price = (plans: ReturnType<typeof s.planDesign>[]) => {
  const ok = plans.filter((p): p is Exclude<typeof p, string> => typeof p !== 'string')
  if (!ok.length) return undefined
  const usd = s.estimate(ok)
  return usd == null ? undefined : formatUsd(usd)
}
const generateCost = computed(() => (designing.value && !blocker.value ? price(Array.from({ length: count.value }, () => s.planDesign(kind.value, designing.value!.id))) : undefined))
function generate() {
  const t = designing.value
  if (!t) return
  saveDescription()
  saveNotes()
  void s.run(Array.from({ length: count.value }, () => s.planDesign(t.kind, t.id)))
}

const angles = computed(() => anglesFor(kind.value))
function toggleAngle(id: string) {
  const next = new Set(angleSel.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  angleSel.value = next
}
const anglePlans = () => (designing.value ? [...angleSel.value].map((angle) => s.planDesign(kind.value, designing.value!.id, { angle, from: pick.value })) : [])
const angleBlocker = computed(() => {
  if (!pick.value) return 'Pick the main picture first'
  const problem = anglePlans().find((p) => typeof p === 'string')
  return typeof problem === 'string' ? problem : undefined
})
const angleCost = computed(() => (angleBlocker.value ? undefined : price(anglePlans())))
/**
 * A place's other directions are written out first by the text model (a few cents), then drawn from that: told only
 * to turn the camera, both image models redrew the main view (By the Lake, left view). Without the Director, the
 * prompt still says what moves where.
 */
const writingViews = ref(false)
async function generateAngles() {
  const t = designing.value
  if (!t) return
  saveNotes()
  // Read now: after the Director's minute the designer may show another subject — its pick and angles not this one's.
  const from = pick.value
  const chosenAngles = [...angleSel.value]
  const views: Record<string, string> = {}
  const turned = t.kind === 'place' ? chosenAngles.filter((a): a is 'reverse' | 'left' | 'right' => ['reverse', 'left', 'right'].includes(a)) : []
  if (turned.length) {
    writingViews.value = true
    saveDescription()
    try {
      const written = await Promise.all(
        turned.map((view) =>
          directorApi
            .placeView({ name: name.value, description: draft.value, light: light.value || undefined, view, style: s.story.value.style })
            .then((r) => [view, r.description] as const)
            .catch(() => undefined),
        ),
      )
      for (const w of written) if (w) views[w[0]] = w[1]
      if (Object.keys(views).length < turned.length) toast.warning('Couldn’t write every view', { description: 'Those are drawn from the turn alone.' })
    } finally {
      writingViews.value = false
    }
  }
  void s.run(chosenAngles.map((angle) => s.planDesign(t.kind, t.id, { angle, from, view: views[angle] })))
}

function toggleChosen(assetId: string) {
  const next = new Set(chosen.value)
  if (next.has(assetId)) next.delete(assetId)
  else next.add(assetId)
  chosen.value = next
}

const pickAsset = computed(() => (ready(pick.value) ? assets.get(pick.value) : undefined))
const rendering = computed(() => takes.value.some((t) => t.rendering))
const approveText = computed(() => {
  const n = [...chosen.value].filter((id) => id !== pick.value).length
  return `${hero.value ? 'Front view' : 'Main view'}${n ? ` + ${n} angle${n === 1 ? '' : 's'}` : ''}`
})
function approve() {
  const t = designing.value
  if (!t || !pick.value) return
  s.approveDesign(
    t.kind,
    t.id,
    pick.value,
    [...chosen.value].map((assetId) => ({ assetId, angle: angleTakes.value.find((a) => a.assetId === assetId)?.angle })),
  )
  toast.success(`${name.value || (hero.value ? 'Character' : 'Place')} approved`, { description: `${approveText.value} set as references.` })
  closeDesigner()
}

const label = 'text-[10px] font-medium tracking-wide text-muted-foreground uppercase'
const shape = computed(() => (hero.value ? 'h-28 aspect-[3/4]' : 'h-24 aspect-video'))
</script>

<template>
  <Dialog :open="Boolean(designing && subject)" @update:open="(v) => !v && closeDesigner()">
    <DialogContent class="flex h-[90vh] w-[min(1480px,96vw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none" data-look-designer="">
      <template v-if="subject">
        <header class="flex items-center gap-3 border-b px-5 py-3 pr-14">
          <DialogTitle class="shrink-0 text-sm font-semibold">{{ hero ? 'Character' : 'Place' }}</DialogTitle>
          <Input v-model="name" class="h-8 max-w-64 text-sm font-medium" @change="rename" />
          <DialogDescription class="truncate text-xs text-muted-foreground">
            Pick the basics, add details → draw pictures → pick the best → draw its other angles → approve.
          </DialogDescription>
        </header>

        <div class="grid min-h-0 flex-1 grid-cols-[minmax(360px,520px)_minmax(0,1fr)]">
          <!-- The prompt -->
          <div class="flex min-h-0 flex-col gap-3 overflow-y-auto border-r p-4">
            <section class="grid" data-design-picks="">
              <div :class="cn(label, 'pb-1')">Quick picks</div>
              <!-- A line between the groups: wrapped onto two rows, one group's last chips read as the next one's. -->
              <div v-for="g in groups" :key="g.id" class="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-2 border-b border-border/60 py-1.5 last:border-b-0">
                <span class="pt-1 text-[11px] text-muted-foreground">{{ g.label }}</span>
                <div class="flex flex-wrap gap-1" role="group" :aria-label="g.label">
                  <button
                    v-for="o in g.options"
                    :key="o"
                    type="button"
                    :aria-pressed="isPicked(picks, g.id, o)"
                    :class="cn('rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors', isPicked(picks, g.id, o) ? 'bg-foreground text-background' : 'bg-field text-muted-foreground hover:text-foreground')"
                    :data-pick="`${g.id}:${o}`"
                    @click="choose(g.id, o)"
                  >
                    {{ o }}
                  </button>
                </div>
              </div>
            </section>
            <div class="grid gap-1.5">
              <div class="flex items-center gap-2">
                <span :class="label">Look</span>
                <div class="flex-1" />
                <Button size="xs" variant="ghost" :disabled="improving" data-design-improve="" @click="improve">
                  <Loader2 v-if="improving" class="animate-spin" /><Sparkles v-else /> Improve with AI
                </Button>
              </div>
              <div class="rounded-lg bg-field/60 px-2.5 py-1.5 text-xs leading-snug" data-design-composed="">
                <div class="text-[10px] text-muted-foreground">From your picks</div>
                <span v-if="composed">{{ composed }}</span>
                <span v-else class="text-muted-foreground">Pick a few basics above, or just describe the look below.</span>
              </div>
              <Textarea
                v-model="draft"
                :placeholder="hero ? 'Details the picks don’t cover: clothing colours, distinguishing features, expression…' : 'Architecture, materials, surroundings — and what lies on each side…'"
                aria-label="Details of the look"
                class="h-32 min-h-0 resize-none overflow-y-auto text-sm field-sizing-fixed"
                data-design-look=""
                @change="saveDescription()"
              />
              <TextModelPicker compact />
            </div>
            <label v-if="!hero" class="grid gap-1.5">
              <span :class="label">Light</span>
              <Input v-model="light" placeholder="One source and time of day, e.g. blue hour just after sunset" class="h-8 text-xs" @change="saveLight" />
            </label>
            <label class="grid gap-1.5">
              <span :class="label">Picture notes</span>
              <Input
                v-model="notes"
                :placeholder="hero ? 'Only for drawing these pictures, e.g. full body, hands in pockets' : 'Only for drawing these pictures, e.g. at dawn, no cars'"
                class="h-8 text-xs"
                data-design-notes=""
                @change="saveNotes"
              />
            </label>

            <section class="grid gap-2 rounded-xl bg-field/50 p-3">
              <div :class="label">Pictures to choose from</div>
              <Select :model-value="s.designModel()?.id" @update:model-value="(v) => v && s.setDesignModel(String(v))">
                <SelectTrigger class="h-8 w-full bg-background text-xs" title="The image model these pictures are drawn with" data-design-model="">
                  <SelectValue placeholder="Image model" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup v-for="g in imageModels" :key="g.provider">
                    <SelectLabel class="px-2 pt-2 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{{ g.name }}</SelectLabel>
                    <SelectItem v-for="m in g.models" :key="m.id" :value="m.id">{{ m.label }}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <div class="flex items-center gap-2">
                <ToggleGroup type="single" variant="outline" size="sm" :model-value="String(count)" @update:model-value="(v) => v && (count = Number(v))">
                  <ToggleGroupItem v-for="n in 4" :key="n" :value="String(n)" class="h-8 w-8 text-xs">{{ n }}</ToggleGroupItem>
                </ToggleGroup>
                <Button class="flex-1" :disabled="Boolean(blocker)" data-design-generate="" @click="generate">
                  <Wand2 /> Generate {{ count }}<span v-if="generateCost" class="opacity-70">· {{ generateCost }}</span>
                </Button>
              </div>
              <div v-if="blocker" class="text-[11px] text-role-effects">{{ blocker }}</div>
              <div v-else-if="s.designModel()?.id !== stillsModel?.id" class="text-[11px] text-muted-foreground">
                For the cast’s and places’ pictures only — the stills keep {{ stillsModel?.label ?? 'the story’s image model' }}.
              </div>
            </section>

            <section class="grid gap-2 rounded-xl bg-field/50 p-3">
              <div :class="label">Other angles of the picked picture</div>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="a in angles"
                  :key="a.id"
                  type="button"
                  :class="cn('rounded-md px-2 py-1 text-xs font-medium transition-colors', angleSel.has(a.id) ? 'bg-foreground text-background' : 'bg-field text-muted-foreground hover:text-foreground')"
                  @click="toggleAngle(a.id)"
                >
                  {{ a.label }}
                </button>
              </div>
              <Button variant="outline" :disabled="Boolean(angleBlocker) || !angleSel.size || writingViews" data-design-angles="" @click="generateAngles">
                <template v-if="writingViews"><Loader2 class="animate-spin" /> Writing the views…</template>
                <template v-else><Wand2 /> Generate {{ angleSel.size }} angle{{ angleSel.size === 1 ? '' : 's' }}<span v-if="angleCost" class="opacity-70">· {{ angleCost }}</span></template>
              </Button>
              <div v-if="angleBlocker" class="text-[11px] text-muted-foreground">{{ angleBlocker }}</div>
            </section>
          </div>

          <!-- The pictures -->
          <div class="flex min-h-0 flex-col gap-3 p-4">
            <div class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl bg-viewer" data-design-preview="">
              <img v-if="pickAsset" :src="`/media/${pickAsset.id}/original`" class="max-h-full max-w-full object-contain" alt="" />
              <template v-else-if="rendering">
                <div class="render-glow" />
                <div class="relative flex flex-col items-center gap-2 text-xs text-muted-foreground"><Loader2 class="size-5 animate-spin" /> Drawing…</div>
              </template>
              <div v-else class="flex max-w-xs flex-col items-center gap-2 text-center text-xs text-muted-foreground">
                <ImageIcon class="size-6" />
                Describe the look, then generate a few pictures to choose from.
              </div>
            </div>

            <div class="grid gap-1.5">
              <div :class="label">Pictures · {{ candidates.length }}</div>
              <div class="flex min-h-28 gap-2 overflow-x-auto pb-1">
                <button
                  v-for="t in candidates"
                  :key="t.key"
                  type="button"
                  :disabled="!t.assetId || t.rendering"
                  :class="cn('relative shrink-0 overflow-hidden rounded-lg bg-viewer', shape, t.assetId && t.assetId === pick && 'ring-2 ring-foreground ring-offset-2 ring-offset-sidebar')"
                  :title="t.current ? 'The current picture' : 'Use this one'"
                  @click="t.assetId && (pick = t.assetId)"
                >
                  <img v-if="t.assetId && !t.rendering" :src="`/media/${t.assetId}/poster`" class="size-full object-cover" alt="" />
                  <template v-else-if="t.rendering">
                    <div class="render-glow" />
                    <Loader2 class="absolute inset-0 m-auto size-4 animate-spin text-muted-foreground" />
                  </template>
                  <TriangleAlert v-else-if="t.failed" class="absolute inset-0 m-auto size-4 text-role-effects" />
                  <span v-if="t.current" class="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[9px] text-white">Current</span>
                </button>
                <div v-if="!candidates.length" class="flex items-center text-xs text-muted-foreground">No pictures yet.</div>
              </div>
            </div>

            <div v-if="angleTakes.length" class="grid gap-1.5">
              <div :class="label">Angles · click to include</div>
              <div class="flex gap-2 overflow-x-auto pb-1">
                <button
                  v-for="t in angleTakes"
                  :key="t.key"
                  type="button"
                  :disabled="!t.assetId || t.rendering"
                  :class="cn('relative shrink-0 overflow-hidden rounded-lg bg-viewer', shape, t.assetId && chosen.has(t.assetId) ? 'ring-2 ring-foreground ring-offset-2 ring-offset-sidebar' : 'opacity-70 hover:opacity-100')"
                  @click="t.assetId && toggleChosen(t.assetId)"
                >
                  <img v-if="t.assetId && !t.rendering" :src="`/media/${t.assetId}/poster`" class="size-full object-cover" alt="" />
                  <template v-else-if="t.rendering">
                    <div class="render-glow" />
                    <Loader2 class="absolute inset-0 m-auto size-4 animate-spin text-muted-foreground" />
                  </template>
                  <TriangleAlert v-else-if="t.failed" class="absolute inset-0 m-auto size-4 text-role-effects" />
                  <span class="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[9px] text-white">{{ t.current ? 'Current' : (angleOf(kind, t.angle)?.label ?? 'View') }}</span>
                  <span v-if="t.assetId && chosen.has(t.assetId)" class="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-foreground text-background">
                    <Check class="size-3" />
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <footer class="flex items-center gap-2 border-t px-5 py-3">
          <span class="text-xs text-muted-foreground">Approve sets {{ approveText.toLowerCase() }} as {{ name || (hero ? 'the character' : 'the place') }}’s references.</span>
          <div class="flex-1" />
          <Button variant="ghost" @click="closeDesigner">Close</Button>
          <Button :disabled="!pickAsset" data-design-approve="" @click="approve"><Check /> Approve</Button>
        </footer>
      </template>
    </DialogContent>
  </Dialog>
</template>
