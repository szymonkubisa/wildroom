<script setup lang="ts">
import { Cpu, Search, X } from '@lucide/vue'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { SHORTCUTS } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project'
import { useSettingsStore } from '@/stores/settings'
import { PROVIDER_META } from './providers'
import SettingItem from './SettingItem.vue'
import { groupRows, type SettingsRow, searchSettings, settingsRows } from './settingsIndex'
import { SETTINGS_TABS, type SettingsTab, useSettingsSheet } from './settingsSheet'

/**
 * Everything in Settings: tabs on top (General · Providers · Models · Director · GPU · Integrations · Projects & storage · Shortcuts ·
 * Help) and one search across all of them — matching rows grouped by tab, with each tab's number of hits. Shown in
 * the sheet over any page and on the /settings page; both follow the sheet store's tab.
 */
const props = defineProps<{ inSheet?: boolean }>()
const sheet = useSettingsSheet()
const settings = useSettingsStore()
const project = useProjectStore()

const query = ref('')
const searching = computed(() => query.value.trim().length > 0)
const scroller = ref<HTMLElement>()
const searchInput = ref<InstanceType<typeof Input>>()

const rows = computed(() =>
  settingsRows({
    providers: PROVIDER_META,
    shortcuts: SHORTCUTS,
    // Under the sheet in a project: its Plan models can be set here too.
    project: Boolean(props.inSheet && project.id),
  }),
)
const found = computed(() => searchSettings(rows.value, query.value))

/** What the body shows: the open tab's groups, or every tab with hits. */
const sections = computed(() => {
  if (!searching.value) {
    const tab = SETTINGS_TABS.find((t) => t.id === sheet.tab)!
    return [{ tab, groups: groupRows(rows.value.filter((r) => r.tab === sheet.tab)) }]
  }
  return SETTINGS_TABS.filter((t) => found.value.counts[t.id] > 0).map((tab) => ({ tab, groups: groupRows(found.value.rows.filter((r) => r.tab === tab.id)) }))
})

/** Provider cards stand alone; other rows share one card per group, divided. */
const cardsOnly = (list: SettingsRow[]) => list.every((r) => r.layout === 'card')

function pickTab(tab: SettingsTab) {
  query.value = ''
  sheet.provider = undefined
  sheet.tab = tab
}

/** Esc clears the search first; with nothing typed it closes the sheet as usual. */
function onEscape(event: KeyboardEvent) {
  if (!query.value) return
  event.stopPropagation()
  event.preventDefault()
  query.value = ''
}

// ---- providers overview (Providers tab)
const connected = computed(() => PROVIDER_META.filter((m) => settings.providers.find((p) => p.id === m.id)?.configured).length)

// ---- cache size (Projects & storage)
const cacheBytes = ref<number>()
async function loadCacheSize() {
  try {
    cacheBytes.value = (await api.settings.cache()).bytes
  } catch {
    cacheBytes.value = undefined
  }
}
onMounted(() => void loadCacheSize())

// A new tab or search starts at the top (a provider card asked for scrolls itself into view).
watch([() => sheet.tab, searching], () => {
  if (!sheet.provider) scroller.value?.scrollTo({ top: 0 })
})

onMounted(async () => {
  await nextTick()
  if (!sheet.provider) (searchInput.value?.$el as HTMLInputElement | undefined)?.focus({ preventScroll: true })
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="shrink-0 px-5 pt-1">
      <div class="relative">
        <Search class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref="searchInput"
          v-model="query"
          placeholder="Search all settings — e.g. GPU, theme, cache, voice, a provider"
          class="h-9 pr-8 pl-8"
          aria-label="Search settings"
          data-settings-search=""
          @keydown.esc="onEscape"
        />
        <button
          v-if="query"
          type="button"
          class="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
          @click="query = ''"
        >
          <X class="size-4" />
        </button>
      </div>
      <!-- Tabs: while searching, each says how many settings in it match (a tab with none dims). -->
      <div class="mt-2 flex flex-wrap gap-0.5 pb-2" role="tablist" aria-label="Settings sections" data-settings-tabs="">
        <button
          v-for="t in SETTINGS_TABS"
          :key="t.id"
          type="button"
          role="tab"
          :aria-selected="!searching && sheet.tab === t.id"
          :data-tab="t.id"
          :class="
            cn(
              'flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors',
              !searching && sheet.tab === t.id ? 'bg-brand text-brand-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              searching && !found.counts[t.id] && 'opacity-45',
            )
          "
          @click="pickTab(t.id)"
        >
          {{ t.label }}
          <span v-if="searching" class="rounded-full bg-muted px-1.5 text-[10px] text-foreground tabular">{{ found.counts[t.id] }}</span>
          <span
            v-else-if="t.id === 'providers'"
            :class="cn('rounded-full px-1.5 text-[10px] tabular', sheet.tab === t.id ? 'bg-white/20' : 'bg-muted')"
          >
            {{ connected }}/{{ PROVIDER_META.length }}
          </span>
        </button>
      </div>
    </div>

    <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto border-t border-border">
      <div class="grid gap-6 px-5 pt-4 pb-8">
        <p v-if="!searching" class="-mb-2 text-sm text-muted-foreground">{{ sections[0]?.tab.blurb }}</p>

        <!-- Providers: how many are connected, above the cards. -->
        <div v-if="!searching && sheet.tab === 'providers'" class="-mb-3 flex items-center gap-3 rounded-xl bg-card p-3.5">
          <div class="flex size-9 items-center justify-center rounded-lg bg-brand/20 text-brand"><Cpu class="size-4" /></div>
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium">{{ connected }} of {{ PROVIDER_META.length }} providers connected</div>
            <div class="text-xs text-muted-foreground">
              <template v-if="settings.app?.demoMode">Demo mode is on — free local stand-ins fill in for anything not connected.</template>
              <template v-else>Connect at least one video provider (Kling or fal.ai) to generate shots.</template>
            </div>
          </div>
        </div>

        <section v-for="section in sections" :key="section.tab.id" class="grid gap-4" :data-settings-section="section.tab.id">
          <button
            v-if="searching"
            type="button"
            class="-mb-1 flex items-center gap-2 justify-self-start text-sm font-semibold tracking-tight hover:text-brand"
            :title="`Open ${section.tab.label}`"
            @click="pickTab(section.tab.id)"
          >
            {{ section.tab.label }}
            <span class="rounded-full bg-muted px-1.5 text-[10px] font-normal text-muted-foreground tabular">{{ found.counts[section.tab.id] }}</span>
          </button>
          <div v-for="g in section.groups" :key="g.group">
            <h3 v-if="!(cardsOnly(g.rows) && g.group === 'Providers')" class="mb-2 px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{{ g.group }}</h3>
            <div v-if="cardsOnly(g.rows)" class="grid gap-3">
              <SettingItem v-for="row in g.rows" :key="row.id" :row="row" />
            </div>
            <div v-else class="divide-y divide-border rounded-xl bg-card">
              <SettingItem v-for="row in g.rows" :key="row.id" :row="row" :cache-bytes="cacheBytes" @cleared-cache="(b) => (cacheBytes = b)" />
            </div>
          </div>
        </section>

        <div v-if="searching && !found.rows.length" class="flex flex-col items-center gap-1 py-14 text-center" data-settings-empty="">
          <div class="text-sm font-medium">No setting matches “{{ query.trim() }}”</div>
          <div class="text-xs text-muted-foreground">Try GPU, theme, cache, voice or a provider’s name.</div>
          <button type="button" class="mt-2 text-xs text-brand hover:underline" @click="query = ''">Clear the search</button>
        </div>

        <p v-if="!searching" class="text-[11px] leading-snug text-muted-foreground">
          Local-first: projects and media stay on this Mac unless a model needs an input.
        </p>
      </div>
    </div>
  </div>
</template>
