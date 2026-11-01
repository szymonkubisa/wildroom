<script setup lang="ts">
import { Settings } from '@lucide/vue'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import SettingsContent from './SettingsContent.vue'
import { useSettingsSheet } from './settingsSheet'

/**
 * Settings over whatever is open (one in App.vue): the editor stays open under it, so nothing is closed or reloaded.
 * On the /settings page itself the page shows the same content, so the sheet stays shut there.
 */
const sheet = useSettingsSheet()
const route = useRoute()
const open = computed({
  get: () => sheet.open && route.name !== 'settings',
  set: (value) => (sheet.open = value),
})
</script>

<template>
  <Sheet v-model:open="open">
    <SheetContent side="right" class="w-full gap-0 bg-sidebar p-0 sm:max-w-[680px]" data-settings-sheet="">
      <SheetHeader class="px-5 pt-4 pb-3">
        <SheetTitle class="flex items-center gap-2 text-lg tracking-tight"><Settings class="size-4 text-brand" /> Settings</SheetTitle>
        <SheetDescription class="sr-only">App settings: providers and keys, models, the Director, the GPU, storage, shortcuts and help.</SheetDescription>
      </SheetHeader>
      <SettingsContent in-sheet />
    </SheetContent>
  </Sheet>
</template>
