<script setup lang="ts">
import { ArrowLeft, Compass, Eye, KeyRound, Search, Sparkles, X } from '@lucide/vue'
import type { ProviderId } from '@shared/types/jobs'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppLogo from '@/components/app/AppLogo.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { useSettingsStore } from '@/stores/settings'
import { useTourStore } from '@/stores/tour'
import { ALL_FEATURES, FEATURE_GROUPS, type Feature, type Needs } from './catalog'

const router = useRouter()
const tour = useTourStore()
const settings = useSettingsStore()

const query = ref('')
const newOnly = ref(false)

const PROVIDER_ID: Record<Needs, ProviderId> = { ElevenLabs: 'elevenlabs', Anthropic: 'anthropic', OpenRouter: 'openrouter', Kling: 'kling', 'fal.ai': 'fal' }

function matches(f: Feature, q: string) {
  if (newOnly.value && !f.isNew) return false
  if (!q) return true
  return [f.title, f.summary, f.how, f.shortcut ?? '', ...(f.needs ?? [])].join(' ').toLowerCase().includes(q)
}

const groups = computed(() => {
  const q = query.value.trim().toLowerCase()
  return FEATURE_GROUPS.map((g) => ({ ...g, features: g.features.filter((f) => matches(f, q)) })).filter((g) => g.features.length)
})
const shown = computed(() => groups.value.reduce((n, g) => n + g.features.length, 0))
const newCount = ALL_FEATURES.filter((f) => f.isNew).length

function ready(n: Needs): boolean {
  return settings.providerReady(PROVIDER_ID[n])
}

function goBack() {
  if (window.history.length > 1) router.back()
  else void router.push({ name: 'projects' })
}

function jump(id: string) {
  document.getElementById(`group-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="flex h-12 shrink-0 items-center gap-3 border-b px-4">
      <Button variant="ghost" size="icon-sm" @click="goBack"><ArrowLeft /></Button>
      <AppLogo />
    </header>
    <main class="flex-1 overflow-y-auto">
      <div class="mx-auto max-w-5xl px-6 pb-16">
        <div class="flex flex-wrap items-end justify-between gap-4 pt-8">
          <div>
            <h1 class="text-2xl font-semibold tracking-tight">Features</h1>
            <p class="mt-1 text-sm text-muted-foreground">
              Everything Wildroom can do — {{ ALL_FEATURES.length }} features<template v-if="newCount">, {{ newCount }} of them new</template>. “Show me” jumps to that spot in
              the walkthrough.
            </p>
          </div>
          <Button @click="tour.start()"><Compass /> Start walkthrough</Button>
        </div>

        <div class="sticky top-0 z-10 -mx-6 mt-6 border-b bg-background/95 px-6 py-3 backdrop-blur">
          <div class="flex flex-wrap items-center gap-2">
            <div class="relative min-w-56 flex-1">
              <Search class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input v-model="query" placeholder="Find a feature — e.g. captions, keyframes, reframe" class="h-9 pl-8" />
              <button v-if="query" class="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground" @click="query = ''"><X class="size-4" /></button>
            </div>
            <Button v-if="newCount" :variant="newOnly ? 'default' : 'outline'" size="sm" @click="newOnly = !newOnly"><Sparkles /> New only</Button>
          </div>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <button
              v-for="g in groups"
              :key="g.id"
              type="button"
              class="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
              @click="jump(g.id)"
            >
              {{ g.title }} <span class="opacity-60">{{ g.features.length }}</span>
            </button>
          </div>
        </div>

        <p v-if="!shown" class="py-16 text-center text-sm text-muted-foreground">No feature matches “{{ query }}”.</p>

        <section v-for="g in groups" :id="`group-${g.id}`" :key="g.id" class="scroll-mt-32 pt-8">
          <h2 class="text-lg font-semibold">{{ g.title }}</h2>
          <p class="text-sm text-muted-foreground">{{ g.blurb }}</p>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <article v-for="f in g.features" :key="f.id" class="flex flex-col gap-2 rounded-xl border bg-card p-4">
              <div class="flex items-start gap-2">
                <h3 class="flex-1 font-medium">{{ f.title }}</h3>
                <Badge v-if="f.isNew" class="bg-brand/20 text-[10px] text-brand hover:bg-brand/20">New</Badge>
                <Kbd v-if="f.shortcut" class="text-[10px] whitespace-nowrap">{{ f.shortcut }}</Kbd>
              </div>
              <p class="text-sm leading-relaxed">{{ f.summary }}</p>
              <p class="text-xs leading-relaxed text-muted-foreground"><span class="font-medium text-foreground/80">How:</span> {{ f.how }}</p>
              <div class="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                <span
                  v-for="n in f.needs ?? []"
                  :key="n"
                  class="flex items-center gap-1 rounded-full border px-2 py-px text-[10px]"
                  :class="ready(n) ? 'border-role-music/40 text-role-music' : 'text-muted-foreground'"
                  :title="ready(n) ? `${n} is connected` : `Uses ${n} — add a key in Settings → Providers (demo mode has a free stand-in)`"
                >
                  <KeyRound class="size-2.5" /> {{ n }}
                </span>
                <div class="flex-1" />
                <Button v-if="f.tour" size="xs" variant="ghost" @click="tour.start(f.tour)"><Eye /> Show me</Button>
              </div>
            </article>
          </div>
        </section>
      </div>
    </main>
  </div>
</template>
