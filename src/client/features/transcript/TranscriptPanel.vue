<script setup lang="ts">
import { Captions, Eraser, Loader2, Scissors, Timer, Trash2 } from '@lucide/vue'
import * as ops from '@shared/timeline'
import { formatTimecode } from '@shared/time/timecode'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { playheadBus } from '@/engine/playhead'
import { transport } from '@/features/editor/transport'
import { useTimelineCommands } from '@/features/timeline/commands'
import { useClipTools } from '@/features/tools/useClipTools'
import { cn } from '@/lib/utils'
import { useAssetsStore } from '@/stores/assets'
import { useProjectStore } from '@/stores/project'
import { type CutRange, cutRanges, isFiller, paragraphs, pauseRanges, timelineWords } from './transcript'

const project = useProjectStore()
const assets = useAssetsStore()
const commands = useTimelineCommands()
const clipTools = useClipTools()

const fps = computed(() => project.doc.settings.fps)
const scene = computed(() => commands.currentScene())
const words = computed(() => timelineWords(scene.value, (id) => assets.get(id)))
const paras = computed(() => paragraphs(words.value, fps.value))
const fillerCount = computed(() => words.value.filter((w) => isFiller(w.text)).length)
const pauseCount = computed(() => pauseRanges(words.value, fps.value).length)

/** Clips with sound but no word timings yet. */
const untranscribed = computed(() => {
  const ids = new Set<string>()
  for (const seg of scene.value.audio) {
    const a = assets.get(seg.assetId)
    if (seg.audio.enabled && a?.hasAudio && !a.alignment?.words.length && (seg.role.split('.')[0] ?? '') !== 'music') ids.add(a.id)
  }
  return [...ids]
})

// ---- selection (word indices, inclusive range)
const anchor = ref<number>()
const focus = ref<number>()
const selected = computed(() => {
  if (anchor.value === undefined || focus.value === undefined) return new Set<number>()
  const lo = Math.min(anchor.value, focus.value)
  const hi = Math.max(anchor.value, focus.value)
  return new Set(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i))
})

const root = ref<HTMLElement>()

function onWord(index: number, e: MouseEvent) {
  root.value?.focus()
  if (e.shiftKey && anchor.value !== undefined) focus.value = index
  else {
    anchor.value = index
    focus.value = index
    transport.seek(words.value[index]!.start)
  }
}

// ---- live "now speaking" highlight
const current = ref(-1)
let unsubscribe: (() => void) | undefined
onMounted(() => {
  unsubscribe = playheadBus.subscribe((frame) => {
    const list = words.value
    let lo = 0
    let hi = list.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (list[mid]!.start <= frame) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    current.value = found >= 0 && frame < list[found]!.end + fps.value * 0.3 ? found : -1
  })
})
onBeforeUnmount(() => unsubscribe?.())

// ---- edits
function applyCuts(ranges: CutRange[], label: string) {
  if (!ranges.length) return
  const total = ranges.reduce((s, r) => s + (r.end - r.start), 0)
  project.apply((draft, ctx) => {
    for (const r of ranges) ops.rippleDeleteRange(r.start, r.end, r.clipIds)(draft, ctx)
  }, label)
  anchor.value = undefined
  focus.value = undefined
  toast.success(`${label}: ${(total / fps.value).toFixed(1)} s removed`, { description: 'Undo with ⌘Z.' })
}

/** Longest pause removed together with a deleted word (0.3 s). */
const trail = () => Math.round(fps.value * 0.3)

function deleteSelection() {
  if (!selected.value.size) return
  applyCuts(cutRanges(words.value, selected.value, trail()), 'Delete words')
}

function removeFillers() {
  const idx = new Set(words.value.flatMap((w, i) => (isFiller(w.text) ? [i] : [])))
  applyCuts(cutRanges(words.value, idx, trail()), 'Remove filler words')
}

function shortenPauses() {
  applyCuts(pauseRanges(words.value, fps.value), 'Shorten pauses')
}

const transcribing = ref(false)
async function transcribeAll() {
  transcribing.value = true
  try {
    for (const id of untranscribed.value) await clipTools.transcribeAsset(id)
  } finally {
    transcribing.value = false
  }
}

function onKey(e: KeyboardEvent) {
  if ((e.key === 'Backspace' || e.key === 'Delete') && selected.value.size) {
    e.preventDefault()
    e.stopPropagation()
    deleteSelection()
  } else if (e.key === 'Escape') {
    anchor.value = undefined
    focus.value = undefined
  }
}
</script>

<template>
  <div ref="root" class="flex h-full min-h-0 flex-col outline-none" tabindex="0" @keydown="onKey">
    <div class="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
      <Button size="xs" variant="outline" :disabled="!selected.size" @click="deleteSelection"><Scissors /> Cut {{ selected.size || '' }} word{{ selected.size === 1 ? '' : 's' }}</Button>
      <Button size="xs" variant="outline" :disabled="!fillerCount" @click="removeFillers"><Eraser /> Fillers ({{ fillerCount }})</Button>
      <Button size="xs" variant="outline" :disabled="!pauseCount" @click="shortenPauses"><Timer /> Long pauses ({{ pauseCount }})</Button>
      <Button size="xs" variant="ghost" :disabled="!words.length" @click="commands.generateCaptions()"><Captions /> Captions</Button>
    </div>

    <div v-if="untranscribed.length" class="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs">
      <span class="flex-1 text-muted-foreground">{{ untranscribed.length }} clip{{ untranscribed.length === 1 ? ' has' : 's have' }} speech without a transcript</span>
      <Button size="xs" :disabled="transcribing" @click="transcribeAll"><Loader2 v-if="transcribing" class="animate-spin" /> Transcribe</Button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="!words.length" class="p-4 text-xs leading-relaxed text-muted-foreground">
        Nothing to show yet. Voice and dialogue you generate here come with word timings; for other clips, transcribe their speech
        (right-click a clip → Clip tools → Transcribe speech).
        <br /><br />
        Then edit the video like a document: select words (click, ⇧-click) and press Delete — the timeline is cut to match.
      </div>
      <div v-else class="grid gap-3 p-3 text-[13px] leading-relaxed">
        <p v-for="(p, pi) in paras" :key="pi" class="break-words select-none">
          <span class="mr-1.5 font-mono text-[10px] text-muted-foreground">{{ formatTimecode(p.words[0]!.word.start, fps) }}</span>
          <span v-if="p.speaker" class="mr-1 text-[10px] font-medium text-role-dialogue uppercase">{{ p.speaker }}</span>
          <template v-for="w in p.words" :key="w.index">
            <span
              :class="
                cn(
                  'cursor-text rounded-sm',
                  selected.has(w.index) && 'bg-brand/40 text-foreground',
                  !selected.has(w.index) && current === w.index && 'bg-selection/35',
                  isFiller(w.word.text) && !selected.has(w.index) && 'text-muted-foreground underline decoration-dotted',
                )
              "
              @mousedown.prevent="onWord(w.index, $event)"
              >{{ w.word.text }}</span
            >{{ ' ' }}
          </template>
        </p>
      </div>
    </div>
    <div v-if="selected.size" class="flex items-center gap-2 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
      <span class="flex-1">{{ selected.size }} selected · ⌫ cuts them from the timeline</span>
      <Button size="icon-xs" variant="ghost" @click="deleteSelection"><Trash2 /></Button>
    </div>
  </div>
</template>
