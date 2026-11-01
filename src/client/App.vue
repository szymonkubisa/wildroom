<script setup lang="ts">
import { TooltipProvider } from 'reka-ui'
import { useMediaQuery } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import ConfirmHost from '@/components/app/ConfirmHost.vue'
import ServerDownNotice from '@/components/app/ServerDownNotice.vue'
import { Toaster } from '@/components/ui/sonner'
import { directorOpen } from '@/features/director/panel'
import GpuWatcher from '@/features/gpu/GpuWatcher.vue'
import TourOverlay from '@/features/guide/TourOverlay.vue'
import ProjectLockDialog from '@/features/projects/ProjectLockDialog.vue'
import SettingsSheet from '@/features/settings/SettingsSheet.vue'
import { openSettings } from '@/features/settings/settingsSheet'
import { api } from '@/lib/api'
import { type DesktopMenuCommand, desktop } from '@/lib/desktop'
import { isTyping } from '@/lib/shortcuts'
import { onServerEvent } from '@/lib/sse'
import { resolvedTheme } from '@/lib/theme'
import { useProjectStore } from '@/stores/project'
import { useProjectOpener } from '@/stores/projectOpener'
import { useSettingsStore } from '@/stores/settings'

const settings = useSettingsStore()
const opener = useProjectOpener()
const project = useProjectStore()
const router = useRouter()
const route = useRoute()
const cleanup: Array<() => void> = []

/**
 * Toasts sit top right, under the top bar — left of the Director's column while it is open beside the work (a narrow
 * window has it over the work instead, under the toasts).
 */
const wide = useMediaQuery('(min-width: 1181px)')
const toastOffset = computed(() => ({ top: 56, right: route.name === 'editor' && directorOpen.value && wide.value ? 16 + 372 : 16 }))

/**
 * Edit → Undo / Redo of the desktop app: typing in a field undoes the typing, anywhere else the project's last edit
 * (their ⌘Z / ⇧⌘Z reach the page as keys — the menu items only show them).
 */
function undoFromMenu(redo: boolean) {
  if (isTyping(document.activeElement)) return void document.execCommand(redo ? 'redo' : 'undo')
  if (route.name !== 'editor') return
  const label = redo ? project.redo() : project.undo()
  if (label) toast(`${redo ? 'Redo' : 'Undo'}: ${label}`, { duration: 1200 })
}

/** File- and Edit-menu commands of the desktop app. */
function onMenuCommand(command: DesktopMenuCommand) {
  if (command === 'undo' || command === 'redo') undoFromMenu(command === 'redo')
  else if (command === 'open-project') void opener.openWithDialog(settings.app?.projectsDir)
  else if (command === 'new-project') void router.push({ name: 'projects', query: { new: '1' } })
  else if (command === 'close-project') void router.push({ name: 'projects' })
  else if (command === 'reveal-project' && route.name === 'editor' && project.path) void api.projects.reveal(project.path)
  else if (command === 'settings') openSettings()
}

/** ⌘, opens Settings over whatever is open (in the desktop app the menu's accelerator sends 'settings' instead). */
function onKeydown(event: KeyboardEvent) {
  if (event.key === ',' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
    event.preventDefault()
    openSettings()
  }
}

/** Claude (over MCP) wants the project in the editor: the first window to claim it opens it. */
async function openForClaude(requestId: string, projectId: string) {
  try {
    if (!(await api.appRequests.claim(requestId)).granted) return
  } catch {
    return
  }
  try {
    await router.push({ name: 'editor', params: { id: projectId } })
    await api.appRequests.done(requestId, { ok: true })
  } catch (err) {
    await api.appRequests.done(requestId, { ok: false, error: err instanceof Error ? err.message : String(err) }).catch(() => {})
  }
}

onMounted(async () => {
  void settings.load()
  window.addEventListener('keydown', onKeydown)
  cleanup.push(() => window.removeEventListener('keydown', onKeydown))
  cleanup.push(
    onServerEvent((event) => {
      if (event.type === 'app.request' && event.action === 'open-project') void openForClaude(event.requestId, event.projectId)
    }),
  )
  if (!desktop) return
  // Projects opened from Finder (double-click, Open Recent, the Dock icon).
  if (desktop.onOpenPath) cleanup.push(desktop.onOpenPath((path) => void opener.openPath(path)))
  if (desktop.onMenuCommand) cleanup.push(desktop.onMenuCommand(onMenuCommand))
  for (const path of (await desktop.takePendingOpens?.()) ?? []) void opener.openPath(path)
})

onBeforeUnmount(() => cleanup.forEach((off) => off()))
</script>

<template>
  <TooltipProvider :delay-duration="350">
    <RouterView />
    <TourOverlay />
    <ProjectLockDialog />
    <GpuWatcher />
    <ConfirmHost />
    <SettingsSheet />
    <ServerDownNotice />
  </TooltipProvider>
  <!-- Top right, under the top bar: never over the action buttons at the bottom of dialogs and sheets. -->
  <Toaster position="top-right" :offset="toastOffset" :theme="resolvedTheme" :visible-toasts="4" close-button />
</template>
