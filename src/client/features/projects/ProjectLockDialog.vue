<script setup lang="ts">
import { computed } from 'vue'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/lib/format'
import { useProjectOpener } from '@/stores/projectOpener'

/** Asks before opening a project that another computer (or app instance) has open. */
const opener = useProjectOpener()
const prompt = computed(() => opener.lockPrompt)
const where = computed(() => {
  const lock = prompt.value?.lockedBy
  if (!lock) return ''
  const host = lock.host?.replace(/\.local$/, '') ?? (lock.foreign ? 'another computer' : 'another Wildroom')
  return lock.since ? `${host} (opened ${relativeTime(lock.since)})` : host
})

function close() {
  opener.lockPrompt = undefined
}

function openAnyway() {
  const p = prompt.value
  if (p) void opener.openPath(p.path, { force: true, name: p.name })
}
</script>

<template>
  <AlertDialog :open="Boolean(prompt)" @update:open="(v) => !v && close()">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>“{{ prompt?.name }}” is open on {{ where }}</AlertDialogTitle>
        <AlertDialogDescription v-if="prompt?.lockedBy.foreign">
          If it is really still open there (for example in a shared iCloud or Dropbox folder), working on it in both places
          can lose changes. Close it on the other computer first — or open it anyway if that computer is off or the
          project was copied from it.
        </AlertDialogDescription>
        <AlertDialogDescription v-else>
          Another Wildroom on this Mac has the project open. Quit it, then try again.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <Button v-if="prompt?.lockedBy.foreign" :disabled="opener.opening" @click="openAnyway">Open anyway</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
