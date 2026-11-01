<script setup lang="ts">
import { ArrowRight, Brain, ChevronDown, ChevronUp, Clapperboard, Image, Loader2, Megaphone, Scissors, Sparkles } from '@lucide/vue'
import type { ProjectKind } from '@shared/projects/meta'
import { type Component, computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { useTextModels } from '@/features/director/textModels'
import { api, errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings'
import { START_KINDS, nameFromBrief, readLocal, writeLocal } from './home'

/**
 * Home's "What are we making?": a sentence and a kind. Start makes the project in that kind's format and opens it
 * where that kind is made — a film or ad in Plan, where the Director writes the script and then the scenes from the
 * brief (nothing is rendered); a social post on the board; footage in Edit. It floats at the bottom of Home, folded
 * to one bar until opened (the brief typed so far stays when it folds).
 */
const open = defineModel<boolean>('open', { default: false })
const router = useRouter()
const settings = useSettingsStore()
const { label: directorLabel } = useTextModels()

const ICONS: Record<ProjectKind, Component> = { film: Clapperboard, ad: Megaphone, social: Image, edit: Scissors }
const KIND_KEY = 'home.kind'
const saved = readLocal(KIND_KEY)
const kind = ref<ProjectKind>(START_KINDS.some((k) => k.id === saved) ? (saved as ProjectKind) : 'film')
watch(kind, (k) => writeLocal(KIND_KEY, k))
const current = computed(() => START_KINDS.find((k) => k.id === kind.value)!)
const directed = computed(() => kind.value === 'film' || kind.value === 'ad')

const text = ref('')
const starting = ref(false)
const textarea = ref<HTMLTextAreaElement>()

async function start() {
  if (starting.value) return
  starting.value = true
  const k = current.value
  // A brief rides in the address only as far as the editor (a long one is cut).
  const brief = text.value.trim().slice(0, 4000)
  try {
    const project = await api.projects.create(nameFromBrief(brief, k.id), k.settings, undefined, k.id)
    const query: Record<string, string> = { ws: k.workspace }
    if (brief && k.id !== 'edit') Object.assign(query, { brief, kind: k.id })
    text.value = ''
    await router.push({ name: 'editor', params: { id: project.id }, query })
  } catch (err) {
    toast.error('Could not create the project', { description: errorMessage(err) })
  } finally {
    starting.value = false
  }
}

async function expand() {
  open.value = true
  await nextTick()
  textarea.value?.focus()
}

watch(open, (o) => o && nextTick(() => textarea.value?.focus()))

function useExample(example: string) {
  text.value = example
  textarea.value?.focus()
}
</script>

<template>
  <section
    aria-labelledby="home-what"
    class="max-h-[calc(100vh-5rem)] overflow-y-auto rounded-2xl bg-sidebar/95 shadow-[0_-8px_64px_8px_rgb(0_0_0/0.22),0_8px_32px_rgb(0_0_0/0.18)] dark:shadow-[0_-8px_80px_16px_rgb(0_0_0/0.9),0_8px_32px_rgb(0_0_0/0.8),0_0_0_1px_rgb(0_0_0/0.5)] ring-1 ring-border/60 backdrop-blur-md focus-within:ring-brand/50"
    data-home-prompt=""
    :data-open="open || undefined"
    @keydown.esc="open = false"
  >
    <button
      v-if="!open"
      type="button"
      class="flex w-full items-center gap-3 px-4 py-3 text-left"
      aria-expanded="false"
      data-home-prompt-open=""
      @click="expand"
    >
      <Sparkles class="size-4 shrink-0 text-brand" />
      <span id="home-what" class="shrink-0 text-sm font-semibold">What are we making?</span>
      <span class="min-w-0 flex-1 truncate text-sm text-muted-foreground/70">{{ text.trim() || current.placeholder }}</span>
      <span class="flex shrink-0 items-center gap-1 rounded-full bg-field px-2.5 py-1 text-[11px] text-muted-foreground">
        <component :is="ICONS[kind]" class="size-3" /> {{ current.label }}
      </span>
      <ChevronUp class="size-4 shrink-0 text-muted-foreground" />
    </button>

    <div v-else class="grid animate-in gap-3 p-3 duration-200 fade-in slide-in-from-bottom-2">
      <div class="flex items-start gap-3 px-1 pt-1">
        <div class="min-w-0 flex-1">
          <h1 id="home-what" class="text-lg leading-tight font-semibold tracking-tight">What are we making?</h1>
          <p class="mt-0.5 text-xs text-muted-foreground">Describe it in a sentence. A film or an ad starts in Plan, where the Director writes it — nothing is rendered until you say so.</p>
        </div>
        <Button variant="ghost" size="icon" class="size-7 shrink-0 rounded-full" aria-label="Fold" title="Fold (Esc)" aria-expanded="true" @click="open = false">
          <ChevronDown />
        </Button>
      </div>
      <div class="rounded-xl bg-background/40 p-3 ring-1 ring-border/60">
        <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Kind of project">
          <button
            v-for="k in START_KINDS"
            :key="k.id"
            type="button"
            role="radio"
            :aria-checked="kind === k.id"
            :data-kind="k.id"
            :class="
              cn(
                'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                kind === k.id ? 'bg-brand text-brand-foreground' : 'bg-field text-muted-foreground hover:bg-field-hover hover:text-foreground',
              )
            "
            @click="kind = k.id"
          >
            <component :is="ICONS[k.id]" class="size-3.5" /> {{ k.label }}
          </button>
        </div>
        <label for="home-brief" class="sr-only">Describe it</label>
        <textarea
          id="home-brief"
          ref="textarea"
          v-model="text"
          rows="3"
          :placeholder="current.placeholder"
          class="mt-2 w-full resize-none bg-transparent px-1 py-1.5 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/70"
          data-home-brief=""
          @keydown.meta.enter.prevent="start"
          @keydown.ctrl.enter.prevent="start"
        />
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded-full bg-field px-2.5 py-1 text-[11px] text-muted-foreground">{{ current.format }}</span>
          <span v-if="directed" class="flex items-center gap-1 rounded-full bg-field px-2.5 py-1 text-[11px] text-muted-foreground" title="Settings › Director">
            <Brain class="size-3" /> Director · {{ directorLabel }}
          </span>
          <span v-if="settings.app?.demoMode" class="flex items-center gap-1 rounded-full bg-role-effects/15 px-2.5 py-1 text-[11px] text-role-effects">
            <Sparkles class="size-3" /> Demo mode
          </span>
          <span class="flex-1" />
          <Button class="rounded-full px-4" :disabled="starting" data-home-start="" @click="start">
            <Loader2 v-if="starting" class="animate-spin" /><ArrowRight v-else /> Start <span class="ml-0.5 text-[11px] opacity-70">⌘↵</span>
          </Button>
        </div>
        <p class="mt-2 px-1 text-[11px] leading-snug text-muted-foreground">{{ current.hint }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-1.5 px-1 pb-1">
        <span class="text-xs text-muted-foreground">Try</span>
        <button
          v-for="example in current.examples"
          :key="example"
          type="button"
          class="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          @click="useExample(example)"
        >
          {{ example }}
        </button>
      </div>
    </div>
  </section>
</template>
