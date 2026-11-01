<script setup lang="ts">
import { AudioLines, Loader2, SlidersHorizontal, Sparkles, Trash2, Wand2 } from '@lucide/vue'
import { workflowFor } from '@shared/models/workflow'
import type { StoryCharacter } from '@shared/types/story'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import AssetSlot from '@/features/generate/AssetSlot.vue'
import VoicePicker from '@/features/generate/VoicePicker.vue'
import KlingElementSync from './KlingElementSync.vue'
import { genderOf } from './cast'
import { openDesigner, useQuickLook } from './designer'
import { castUsage } from './modelInfo'
import { inFlight, useStory } from './useStory'

/** One character of the Cast: look, voice, reference pictures, and what the story's models need from them. */
const props = defineProps<{ character: StoryCharacter }>()
const s = useStory()
const { story, update } = s
const c = computed(() => props.character)
const quick = useQuickLook('character', () => c.value.id)

/** How the story's video model uses each character's pictures ("Kling elements: front + 1–3 angles…"). */
const usage = computed(() => castUsage(s.modelFor('video')))
/** The story's model takes characters as Kling elements, which need a front view plus another angle. */
const needsAngles = computed(() => Boolean(s.workflowOf().cast?.needsAngles))
/**
 * Kling's element library is only for Kling's own API: the sync shows while the story's model, or a group's or shot's
 * "Render with…" model, is one.
 */
const usesKlingDirect = computed(() => [s.modelFor('video'), ...story.value.shots.map((shot) => s.modelForShot(shot))].some((m) => m?.provider === 'kling'))
/** LTX renders some shot or group: its subject references copy what is around the person, so it takes a video reference and voice samples. */
const usesLtx = computed(() => [s.modelFor('video'), ...story.value.shots.map((shot) => s.modelForShot(shot))].some((m) => m && workflowFor(m).dialect === 'ltx'))

/** A slot's action beside it: a tile as tall as the slot, icon over label. */
const tileAction = 'h-auto shrink-0 flex-col gap-1 rounded-lg px-3 text-[11px] font-medium'

const rendering = (generationId?: string) => inFlight(s.jobState(generationId))

function patch(label: string, change: Record<string, string | undefined>) {
  update(label, (s) => {
    const x = s.characters.find((x) => x.id === c.value.id)
    if (x) Object.assign(x, change)
  })
}

function setVideoRef(assetId: string | undefined) {
  update('Video reference', (s) => {
    const x = s.characters.find((x) => x.id === c.value.id)
    if (!x) return
    x.videoRefAssetId = assetId
    x.videoRefGenerationId = undefined
  })
}

function setExtraRef(index: number, assetId: string | undefined) {
  update('Reference images', (s) => {
    const x = s.characters.find((x) => x.id === c.value.id)
    if (!x) return
    const refs = [...(x.refAssetIds ?? [])]
    if (assetId) refs[index] = assetId
    else refs.splice(index, 1)
    x.refAssetIds = refs.filter(Boolean)
  })
}

function remove() {
  const id = c.value.id
  update('Remove character', (s) => {
    s.characters = s.characters.filter((x) => x.id !== id)
    for (const shot of s.shots) {
      shot.characterIds = shot.characterIds.filter((x) => x !== id)
      if (shot.partialIds) shot.partialIds = shot.partialIds.filter((x) => x !== id)
      if (shot.hiddenIds) shot.hiddenIds = shot.hiddenIds.filter((x) => x !== id)
      for (const line of shot.dialogue) if (line.characterId === id) line.characterId = undefined
    }
    for (const scene of s.scenes ?? []) if (scene.castIds) scene.castIds = scene.castIds.filter((x) => x !== id)
  })
}
</script>

<template>
  <div class="grid grid-cols-1 content-start gap-2 rounded-xl bg-card p-2.5">
    <!-- The face first: the front view is what every keyframe and clip copies. -->
    <AssetSlot cover aspect="4 / 5" kind="image" label="Front view" :model-value="c.refAssetId" data-front-view="" @update:model-value="(v) => patch('Reference image', { refAssetId: v })" />
    <!-- No face yet: one drawn and used right away, or the designer to choose between a few. -->
    <div v-if="!c.refAssetId" class="flex gap-1.5">
      <Button
        size="sm"
        class="min-w-0 flex-1 rounded-full bg-brand text-brand-foreground hover:bg-brand/90"
        :disabled="quick.drawing.value || Boolean(quick.blocker.value)"
        :title="quick.blocker.value ?? 'Draw one front view from the look and use it — Design to choose between a few'"
        data-quick-look=""
        @click="quick.start"
      >
        <template v-if="quick.drawing.value"><Loader2 class="animate-spin" /> Drawing…</template>
        <template v-else><Wand2 /> Generate<span v-if="quick.cost.value" class="opacity-70">· {{ quick.cost.value }}</span></template>
      </Button>
      <Button size="sm" variant="outline" class="rounded-full" title="Design the look: pictures to choose from, other angles" data-design-look="" @click="openDesigner('character', c.id)">
        <SlidersHorizontal /> Design
      </Button>
    </div>
    <div class="grid grid-cols-3 gap-1.5">
      <AssetSlot
        v-for="i in Math.min(3, (c.refAssetIds?.length ?? 0) + 1)"
        :key="i"
        cover
        aspect="1 / 1"
        kind="image"
        :label="`View ${i + 1}`"
        :model-value="c.refAssetIds?.[i - 1]"
        @update:model-value="(v) => setExtraRef(i - 1, v)"
      />
    </div>
    <div class="flex items-center gap-1.5">
      <Input :model-value="c.name" class="h-7 text-sm font-medium" @change="(e: Event) => patch('Rename character', { name: (e.target as HTMLInputElement).value })" />
      <Button variant="ghost" size="icon-sm" title="Design the look: pictures to choose from, other angles" data-open-designer="" @click="openDesigner('character', c.id)"><Wand2 /></Button>
      <Button variant="ghost" size="icon-sm" title="Remove character" @click="remove"><Trash2 /></Button>
    </div>
    <slot name="header" />
    <label class="grid gap-1">
      <span class="px-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Look</span>
      <Textarea
        :model-value="c.description"
        placeholder="Age, build, face and hair; clothing and distinguishing features…"
        class="h-24 min-h-0 resize-none overflow-y-auto text-xs field-sizing-fixed"
        @change="(e: Event) => patch('Describe character', { description: (e.target as HTMLTextAreaElement).value })"
      />
    </label>
    <div v-if="usage" class="text-[11px] leading-snug text-muted-foreground" data-cast-usage="">
      {{ usage }}
      <span v-if="needsAngles && c.refAssetId && !c.refAssetIds?.length" class="text-role-effects">Add another angle so {{ c.name }} can go in as an element.</span>
    </div>
    <span class="-mb-1 px-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Voice</span>
    <VoicePicker compact :model-value="c.voiceId" @update:model-value="(v) => patch('Character voice', { voiceId: v })" />
    <Input
      :model-value="c.voice ?? ''"
      :placeholder="`How they sound: ${genderOf(c) === 'male' ? 'deep, quiet male voice' : genderOf(c) === 'female' ? 'warm, low female voice' : 'warm, low voice'}…`"
      class="h-7 text-xs"
      title="Told to video models that speak the lines (LTX, Veo…), so a line isn't given to the wrong voice"
      data-character-voice=""
      @change="(e: Event) => patch('Character voice', { voice: (e.target as HTMLInputElement).value.trim() || undefined })"
    />
    <!-- The slot and its action side by side, the same height; narrow, the action shows its icon only. -->
    <div class="@container flex items-stretch gap-1.5">
      <AssetSlot
        kind="audio"
        label="Voice sample"
        compact
        class="min-w-0 flex-1"
        :model-value="c.voiceSampleAssetId"
        @update:model-value="(v) => patch('Voice sample', { voiceSampleAssetId: v })"
      />
      <Button
        variant="outline"
        :class="tileAction"
        :disabled="s.makingVoiceSample(c.id)"
        title="A few seconds of this character's ElevenLabs voice saying their own lines, over a quiet bed of the scene's sound (a few cents) — LTX uses it as Audio 1/2, so lines keep to the right voice"
        data-make-voice-sample=""
        @click="s.makeVoiceSample(c.id)"
      >
        <Loader2 v-if="s.makingVoiceSample(c.id)" class="animate-spin" /><AudioLines v-else /> <span class="hidden @[13rem]:inline">Make</span>
      </Button>
    </div>
    <template v-if="usesLtx">
      <div class="@container flex items-stretch gap-1.5">
        <AssetSlot kind="image" label="Video reference (LTX)" compact class="min-w-0 flex-1" :model-value="s.videoRefOf(c)" @update:model-value="setVideoRef" />
        <Button
          variant="outline"
          :class="tileAction"
          :disabled="rendering(c.videoRefGenerationId)"
          title="Redraw this character from their pictures standing on plain grey, in full wardrobe — LTX copies whatever is around the face in a reference (a skyline, a chair). Uses the story's image model."
          data-make-video-ref=""
          @click="s.run([s.planVideoRef(c.id)])"
        >
          <Loader2 v-if="rendering(c.videoRefGenerationId)" class="animate-spin" /><Sparkles v-else /> <span class="hidden @[13rem]:inline">Generate</span>
        </Button>
      </div>
      <div v-if="!s.videoRefOf(c)" class="-mt-1 text-[11px] text-muted-foreground">LTX uses the front view until there is one — and copies its background.</div>
    </template>
    <KlingElementSync v-if="usesKlingDirect" :character-id="c.id" />
  </div>
</template>
