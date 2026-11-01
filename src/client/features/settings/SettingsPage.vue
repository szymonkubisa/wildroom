<script setup lang="ts">
import { ArrowLeft } from '@lucide/vue'
import { watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppLogo from '@/components/app/AppLogo.vue'
import { Button } from '@/components/ui/button'
import SettingsContent from './SettingsContent.vue'
import { isSettingsTab, useSettingsSheet } from './settingsSheet'

/**
 * Settings as a page (/settings, ?tab= for a tab): the same content as the sheet. Opened from the editor it is the
 * sheet instead (see openSettings), which keeps the project open.
 */
const router = useRouter()
const route = useRoute()
const sheet = useSettingsSheet()

// The address names the tab (older links said ?tab=guide for Help).
const fromQuery = (tab: unknown) => (tab === 'guide' ? 'help' : tab)
watch(
  () => route.query.tab,
  (tab) => {
    const asked = fromQuery(tab)
    if (isSettingsTab(asked) && asked !== sheet.tab) sheet.tab = asked
  },
  { immediate: true },
)
watch(
  () => sheet.tab,
  (tab) => {
    if (route.name === 'settings' && route.query.tab !== tab) void router.replace({ query: { ...route.query, tab } })
  },
)

function goBack() {
  if (window.history.length > 1) router.back()
  else void router.push({ name: 'projects' })
}
</script>

<template>
  <div class="flex h-full flex-col bg-background">
    <header class="flex h-12 shrink-0 items-center gap-3 px-4">
      <Button variant="ghost" size="icon-sm" aria-label="Back" @click="goBack"><ArrowLeft /></Button>
      <AppLogo />
    </header>
    <main class="flex min-h-0 flex-1 px-1.5 pb-1.5">
      <!-- .panel-card clips its content: SettingsContent scrolls inside it. -->
      <div class="panel-card mx-auto flex w-full max-w-3xl min-h-0 flex-col bg-sidebar pt-4">
        <h1 class="px-5 pb-3 text-2xl font-semibold tracking-tight">Settings</h1>
        <SettingsContent />
      </div>
    </main>
  </div>
</template>
