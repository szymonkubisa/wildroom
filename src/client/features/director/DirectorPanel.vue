<script setup lang="ts">
import { ArrowUp, KeyRound, MoreHorizontal, Trash2, X } from '@lucide/vue'
import type { DirectorMessage, StepProgress } from '@shared/director/plan'
import { computed, nextTick, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { openSettings } from '@/features/settings/settingsSheet'
import { useStory } from '@/features/story/useStory'
import { isTyping } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'
import { useDirector } from './director'
import DirectorIcon from './DirectorIcon.vue'
import PlanCard from './PlanCard.vue'
import { VIA_LABELS, loadTextModels, textModelName, useTextModels } from './textModels'

/**
 * The Director, beside Plan, Create and Edit: a chat whose answers are plans — steps with their cost and time that run
 * only once approved. A column on the right of a wide window; on a narrow one it slides over the work, under the top
 * bar. Toggled from the top bar, with ⌘D, and from ⌘K.
 */
const director = useDirector()
const s = useStory()
const { story } = s
const { status, models } = useTextModels()
void loadTextModels()

const who = computed(() => {
  const via = status.value?.via
  if (!via || via === 'none') return 'No Director key yet'
  if (via === 'demo') return 'Demo rules (no AI)'
  return textModelName(status.value?.model, models.value)
})

// ---- messages
const list = ref<HTMLElement>()
const atBottom = ref(true)
function onScroll() {
  const el = list.value
  if (el) atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}
function toBottom(force = false) {
  void nextTick(() => {
    const el = list.value
    if (el && (force || atBottom.value)) el.scrollTop = el.scrollHeight
  })
}
// A new message, and the panel opening, scroll to the end; the typing dots and a running plan's progress only when the
// conversation is already at its end (reading further up stays put).
watch(
  () => [director.messages.length, director.open],
  () => toBottom(true),
  { immediate: true },
)
watch(
  () => [director.sending, director.runningId && director.progressOf(director.messages.find((m) => m.id === director.runningId)!)],
  () => toBottom(),
)

/** The plan waiting for approval is priced now (and again as the project changes); others show what they did. */
const quotes = computed(() => {
  const t = director.tools()
  const out = new Map<string, ReturnType<typeof t.quote>>()
  for (const m of director.messages) if (m.plan?.state === 'ready') out.set(m.id, t.quote(m.plan.steps, director.spentUsd))
  return out
})

function show(where: NonNullable<StepProgress['show']>) {
  director.tools().show(where)
  // On a narrow window the panel covers the work: out of the way, so the result can be seen.
  if (window.matchMedia('(max-width: 1180px)').matches) director.open = false
}

// ---- suggestions: what makes sense next in this project
const suggestions = computed(() => {
  const st = story.value
  const scenes = st.scenes ?? []
  const out: string[] = []
  if (!scenes.length) {
    if (st.script.trim()) out.push('Outline the script into scenes')
    out.push('Write a 30-second film about a lighthouse keeper')
    return out
  }
  const unwritten = scenes.filter((x) => !st.shots.some((shot) => shot.sceneId === x.id))
  if (unwritten.length) out.push(unwritten.length === scenes.length ? 'Write the shots of every scene' : `Write the shots of scene ${scenes.indexOf(unwritten[0]!) + 1}`)
  const noStill = scenes.findIndex((x) => st.shots.some((shot) => shot.sceneId === x.id && (!s.keyframeOf(shot) || shot.stillStale)))
  if (noStill >= 0) out.push(`Draw the stills of scene ${noStill + 1}`)
  const noTake = scenes.findIndex((x) => st.shots.some((shot) => shot.sceneId === x.id && s.keyframeOf(shot) && !shot.videoGenerationIds.length))
  if (noTake >= 0) out.push(`Animate scene ${noTake + 1}`)
  if (scenes.length >= 2) out.push('Make scene 2 golden hour')
  out.push('Add a shot of the main character’s hands', 'Make it 30 seconds', 'Write music for it')
  return out.slice(0, 5)
})

// ---- the message box
const input = ref<HTMLTextAreaElement>()
watch(
  () => director.focusNonce,
  () => void nextTick(() => input.value?.focus()),
)
function autosize() {
  const el = input.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(140, el.scrollHeight)}px`
}
watch(
  () => director.draft,
  () => void nextTick(autosize),
)
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void director.send()
  }
}
function suggest(text: string) {
  director.draft = text
  input.value?.focus()
}

/** Esc in the panel (not while typing) closes it. */
function onPanelKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && !e.defaultPrevented && !isTyping(e.target)) director.open = false
}

const bubble = (m: DirectorMessage) =>
  m.role === 'user'
    ? 'ml-auto w-fit max-w-[88%] rounded-2xl rounded-br-md bg-field px-3 py-2'
    : cn('min-w-0 leading-relaxed', m.tone === 'note' && 'text-muted-foreground', m.tone === 'error' && 'text-destructive')
</script>

<template>
  <aside
    v-show="director.open"
    :class="
      cn(
        'flex w-[372px] shrink-0 flex-col pr-1.5 pb-1.5',
        // A narrow window: over the work, under the top bar.
        'max-[1180px]:absolute max-[1180px]:inset-y-0 max-[1180px]:right-0 max-[1180px]:z-40 max-[1180px]:w-[min(372px,100%)] max-[1180px]:pl-1.5 max-[1180px]:drop-shadow-[0_20px_40px_oklch(0_0_0/0.45)]',
      )
    "
    aria-label="Director"
    data-director=""
    @keydown="onPanelKey"
  >
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-sidebar">
      <header class="flex shrink-0 items-center gap-2.5 border-b py-2.5 pr-1.5 pl-3">
        <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-role-titles/15 text-role-titles"><DirectorIcon class="size-4" /></span>
        <div class="min-w-0 flex-1 leading-tight">
          <div class="text-sm font-semibold">Director</div>
          <div class="truncate text-[11px] text-muted-foreground" :title="status?.reason" data-director-model="">{{ who }} · plans first, spends only when you approve</div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon-sm" aria-label="More"><MoreHorizontal /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem :disabled="!director.messages.length || Boolean(director.runningId) || director.sending" @select="director.clear()"><Trash2 /> Clear the conversation</DropdownMenuItem>
            <DropdownMenuItem @select="openSettings({ tab: 'director' })"><DirectorIcon class="size-4" /> Director model…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon-sm" aria-label="Close the Director" title="Close the Director (⌘D)" @click="director.open = false"><X /></Button>
      </header>

      <div ref="list" class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3.5 text-[13px]" data-director-messages="" @scroll="onScroll">
        <div v-if="!director.messages.length && !director.sending" class="grid gap-2 px-1 pt-6 text-center text-xs text-muted-foreground" data-director-empty="">
          <DirectorIcon class="mx-auto size-6 text-role-titles" />
          <p class="font-medium text-foreground">Ask for something to plan</p>
          <p class="leading-relaxed">
            I answer with a plan — the steps, what each one makes, its cost and time. Nothing is generated until you approve it.
          </p>
          <p v-if="status?.via === 'demo'" class="leading-relaxed">Demo mode: simple rules read your message, not an AI. Add a Director key in Settings › Providers.</p>
        </div>

        <div v-for="m in director.messages" :key="m.id" class="mt-3.5 first:mt-0" :data-director-message="m.role">
          <div v-if="m.role === 'user'" :class="bubble(m)" class="whitespace-pre-wrap">{{ m.text }}</div>
          <div v-else class="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-2">
            <span class="flex size-6 items-center justify-center rounded-md bg-role-titles/15 text-role-titles"><DirectorIcon class="size-3.5" /></span>
            <div :class="bubble(m)">
              <p class="whitespace-pre-wrap" :data-director-tone="m.tone">{{ m.text }}</p>
              <Button v-if="m.action === 'providers'" size="xs" variant="outline" class="mt-1.5" @click="openSettings({ tab: 'providers' })"><KeyRound /> Add a key</Button>
              <PlanCard
                v-if="m.plan"
                :message="m"
                :quote="quotes.get(m.id)"
                :progress="director.progressOf(m)"
                :blocked="Boolean(director.runningId && director.runningId !== m.id)"
                @approve="director.approve(m.id)"
                @change="director.change()"
                @decline="director.decline(m.id)"
                @stop="director.stop()"
                @show="show"
              />
            </div>
          </div>
        </div>

        <div v-if="director.sending" class="mt-3.5 grid grid-cols-[24px_minmax(0,1fr)] items-center gap-2" aria-label="The Director is working" data-director-typing="">
          <span class="flex size-6 items-center justify-center rounded-md bg-role-titles/15 text-role-titles"><DirectorIcon class="size-3.5" /></span>
          <span class="flex gap-1 py-2">
            <i v-for="n in 3" :key="n" class="size-1.5 animate-pulse rounded-full bg-role-titles" :style="{ animationDelay: `${(n - 1) * 150}ms` }" />
          </span>
        </div>
      </div>

      <div class="flex shrink-0 gap-1.5 overflow-x-auto px-3 pb-2 [scrollbar-width:none]" data-director-suggestions="">
        <button
          v-for="q in suggestions"
          :key="q"
          type="button"
          class="shrink-0 rounded-full border bg-card px-2.5 py-1 text-[11px] whitespace-nowrap text-muted-foreground transition-colors hover:bg-field hover:text-foreground"
          @click="suggest(q)"
        >
          {{ q }}
        </button>
      </div>

      <form class="flex shrink-0 items-end gap-1.5 border-t p-2.5" @submit.prevent="director.send()">
        <label for="director-input" class="sr-only">Message the Director</label>
        <textarea
          id="director-input"
          ref="input"
          v-model="director.draft"
          rows="1"
          class="max-h-36 min-h-10 min-w-0 flex-1 resize-none rounded-xl border bg-field px-3 py-2.5 text-[13px] leading-snug outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          placeholder="Ask to plan, change or fix something…"
          data-director-input=""
          @keydown="onKey"
          @input="autosize"
        />
        <Button
          type="submit"
          size="icon"
          class="size-10 shrink-0 rounded-full"
          :disabled="!director.draft.trim() || director.sending"
          aria-label="Send"
          :title="status?.via === 'none' ? (status.reason ?? VIA_LABELS.none) : 'Send (↵)'"
          data-director-send=""
        >
          <ArrowUp />
        </Button>
      </form>
    </div>
  </aside>
</template>
