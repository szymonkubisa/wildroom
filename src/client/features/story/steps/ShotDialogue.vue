<script setup lang="ts">
import { AlertTriangle, Languages, Loader2, Mic, Play, Plus, Scissors, Sparkles, X } from '@lucide/vue'
import type { StoryShot } from '@shared/types/story'
import { nanoid } from 'nanoid'
import { computed, onBeforeUnmount, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { modelSpeaking, speechWarning, storyboardModels } from '../modelInfo'
import { speaksAudio, storyLanguage } from '../soundtrack'
import { inFlight, useStory } from '../useStory'
import { costLabel, useShotRender } from './shotRender'

/**
 * The shot's lines: who says what (dialogue never goes into a prompt as text to draw), voiced with ElevenLabs where the
 * model doesn't speak them itself — and what to do when they don't fit the shot, or the model can't speak the story's
 * language.
 */
const props = defineProps<{ shot: StoryShot }>()
const s = useStory()
const { starting, startRender } = useShotRender(() => props.shot.id)
const busy = inFlight
const failed = (state?: { status: string }) => state && ['failed', 'needs_attention'].includes(state.status)

function edit(label: string, mutate: (shot: StoryShot) => void) {
  s.updateShot(props.shot.id, label, mutate)
}

const spoken = computed(() => props.shot.dialogue.filter((l) => l.text.trim()))
/** Voices the lines that have no voice yet (or failed); with every line voiced, all of them again (a re-take). */
function voiceLines() {
  if (spoken.value.some((l) => busy(s.jobState(l.generationId)))) return void toast('Lines are still being voiced')
  const todo = spoken.value.filter((l) => !s.outputOf(l.generationId))
  void startRender(() => s.planLines({ ...props.shot, dialogue: todo.length ? todo : spoken.value }))
}
const voiceCost = computed(() => {
  const todo = spoken.value.filter((l) => !s.outputOf(l.generationId))
  return spoken.value.length ? costLabel(s.planLines({ ...props.shot, dialogue: todo.length ? todo : spoken.value })) : ''
})

let audio: HTMLAudioElement | undefined
function playLine(generationId?: string) {
  const asset = s.outputOf(generationId)
  if (!asset) return
  audio?.pause()
  audio = new Audio(`/media/${asset.id}/original`)
  void audio.play()
}
onBeforeUnmount(() => audio?.pause())

// Dialogue that doesn't fit the shot.
const fit = computed(() => s.dialogueFitOf(props.shot))
const fmt = (n: number) => String(Math.round(n * 10) / 10)
const shortening = ref(false)
async function shorten() {
  shortening.value = true
  try {
    await s.shortenLines(props.shot)
  } finally {
    shortening.value = false
  }
}

// The story's language vs. the shot's model (a shot in a group: the group bar warns).
const group = computed(() => s.groupOf(props.shot))
const oneClip = computed(() => Boolean(group.value && !s.groupShotByShot(group.value)))
const videoModel = computed(() => s.modelForShot(props.shot))
const storyModel = computed(() => s.modelFor('video'))
const ready = computed(() => storyboardModels(s.readyVideoModels()))
const language = computed(() => storyLanguage(s.story.value))
const languageWarning = computed(() => {
  const m = videoModel.value
  if (group.value || !m || !spoken.value.length || !speaksAudio(m, s.renderSettings(m, false))) return undefined
  return speechWarning(m, s.workflowOf(m), language.value)
})
const speakingModel = computed(() =>
  languageWarning.value && language.value
    ? modelSpeaking(language.value, ready.value, { preferred: storyModel.value, except: videoModel.value, settingsFor: (m) => s.renderSettings(m, false) })
    : undefined,
)
const switchToSpeaking = () => speakingModel.value && s.setShotModel(props.shot, speakingModel.value.id === storyModel.value?.id ? undefined : speakingModel.value.id)

/**
 * How an LTX dialogue shot (not in a group's one clip) gets its voices: made from its still to its ElevenLabs lines
 * (lip sync), or — while a speaker has no ElevenLabs voice — LTX speaking the lines itself.
 */
const voiceNote = computed((): { text: string; warn?: boolean } | undefined => {
  const m = videoModel.value
  if (oneClip.value || !m || s.workflowOf(m).dialect !== 'ltx' || !spoken.value.length) return undefined
  if (s.followsVoices(props.shot)) {
    if (!s.keyframeOf(props.shot)) return { text: 'Make a still: this shot is made from it to its ElevenLabs lines (lip sync).', warn: true }
    return { text: s.voiceTrackOf(props.shot) ? 'Lip-syncs to its ElevenLabs lines — voice track ready.' : 'Lip-syncs to its ElevenLabs lines — they are voiced first when you animate.' }
  }
  const unvoiced = [...new Set(spoken.value.map((l) => s.story.value.characters.find((c) => c.id === l.characterId)))]
    .filter((c) => c && !c.voiceId && props.shot.characterIds.includes(c.id))
    .map((c) => c!.name)
  return unvoiced.length ? { text: `LTX speaks these lines itself. Pick an ElevenLabs voice for ${unvoiced.join(', ')} in the Cast to lip-sync the exact words.`, warn: true } : undefined
})

const label = 'text-[10px] font-medium tracking-wide text-muted-foreground uppercase'
</script>

<template>
  <div class="grid gap-1.5" data-shot-dialogue="">
    <div class="flex items-center gap-2">
      <span :class="label">Dialogue</span>
      <div class="flex-1" />
      <Button v-if="spoken.length" size="xs" variant="ghost" class="text-muted-foreground" :disabled="starting" title="ElevenLabs voices for the lines that have none yet (all of them again, once every line has one)" @click="voiceLines">
        <Mic /> Voice lines{{ voiceCost }}
      </Button>
    </div>
    <div v-for="line in shot.dialogue" :key="line.id" class="flex items-center gap-1.5">
      <Select
        :model-value="line.characterId ?? 'none'"
        @update:model-value="
          (v) =>
            edit('Line speaker', (x) => {
              const l = x.dialogue.find((d) => d.id === line.id)
              if (l) l.characterId = v === 'none' ? undefined : String(v)
            })
        "
      >
        <SelectTrigger class="h-7 w-32 text-xs"><span class="truncate">{{ s.characterName(line.characterId) ?? 'Narrator' }}</span></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Narrator</SelectItem>
          <SelectItem v-for="c in s.story.value.characters" :key="c.id" :value="c.id">{{ c.name }}</SelectItem>
        </SelectContent>
      </Select>
      <Input
        :model-value="line.text"
        class="h-7 flex-1 text-xs"
        placeholder="[quietly] First phrase. [glances away] Next phrase…"
        @change="
          (e: Event) =>
            edit('Edit line', (x) => {
              const l = x.dialogue.find((d) => d.id === line.id)
              if (l) {
                l.text = (e.target as HTMLInputElement).value
                l.generationId = undefined
              }
            })
        "
      />
      <Loader2 v-if="busy(s.jobState(line.generationId))" class="size-3.5 shrink-0 animate-spin text-brand" />
      <Button v-else-if="s.outputOf(line.generationId)" variant="ghost" size="icon-xs" title="Play line" aria-label="Play line" @click="playLine(line.generationId)"><Play /></Button>
      <AlertTriangle v-else-if="failed(s.jobState(line.generationId))" class="size-3.5 shrink-0 text-destructive" />
      <Button variant="ghost" size="icon-xs" title="Remove line" aria-label="Remove line" @click="edit('Remove line', (x) => (x.dialogue = x.dialogue.filter((d) => d.id !== line.id)))"><X /></Button>
    </div>
    <Button variant="ghost" size="xs" class="justify-self-start text-muted-foreground" @click="edit('Add line', (x) => x.dialogue.push({ id: nanoid(8), text: '' }))"><Plus /> Line</Button>
    <div v-if="fit.tight" class="flex flex-wrap items-center gap-1 rounded-lg bg-role-effects/10 py-0.5 pr-0.5 pl-2 text-[11px]">
      <AlertTriangle class="size-3.5 shrink-0 text-role-effects" />
      <span class="tabular">≈{{ Math.round(fit.spoken) }} s of dialogue in a {{ fmt(fit.available) }} s shot</span>
      <div class="flex-1" />
      <Button size="xs" variant="ghost" :disabled="fit.target <= shot.duration" :title="`The video model renders at most ${fit.cap} s per shot`" @click="s.lengthenForDialogue(shot)">
        Lengthen to {{ fit.target }} s<template v-if="fit.target < fit.needed"> (max)</template>
      </Button>
      <Button
        size="xs"
        variant="ghost"
        :disabled="spoken.length < 2"
        :title="spoken.length < 2 ? 'Only one line — shorten it or lengthen the shot' : 'Move the lines that don’t fit into a new shot right after this one'"
        @click="s.splitForDialogue(shot)"
      >
        <Scissors /> Split shot
      </Button>
      <Button size="xs" variant="ghost" :disabled="shortening" title="Have the Director shorten the lines to fit" @click="shorten">
        <Loader2 v-if="shortening" class="animate-spin" /><Sparkles v-else /> Shorten lines
      </Button>
    </div>
    <div v-if="voiceNote" :class="['flex items-center gap-1.5 rounded-lg px-2 py-0.5 text-[11px]', voiceNote.warn ? 'bg-role-effects/10' : 'bg-muted/60 text-muted-foreground']" data-voice-note="">
      <Mic :class="['size-3.5 shrink-0', voiceNote.warn && 'text-role-effects']" /><span>{{ voiceNote.text }}</span>
    </div>
    <div v-if="languageWarning" class="flex flex-wrap items-center gap-1.5 rounded-lg bg-role-effects/10 px-2 py-0.5 text-[11px]" data-language-warning="">
      <Languages class="size-3.5 shrink-0 text-role-effects" /><span>{{ languageWarning }}</span>
      <button v-if="speakingModel" type="button" class="font-medium text-brand underline-offset-2 hover:underline" @click="switchToSpeaking">Render this shot with {{ speakingModel.label }} instead</button>
    </div>
  </div>
</template>
