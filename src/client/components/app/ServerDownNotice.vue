<script setup lang="ts">
import { Loader2 } from '@lucide/vue'
import { serverDown } from '@/lib/sse'

/**
 * Shown while the local server has not answered for a few seconds: every action fails until it is back, so say it
 * once, where it is seen, instead of leaving a "Failed to fetch" on the next click. It goes away by itself.
 */
</script>

<template>
  <Transition
    enter-active-class="transition duration-200"
    enter-from-class="-translate-y-2 opacity-0"
    leave-active-class="transition duration-150"
    leave-to-class="-translate-y-2 opacity-0"
  >
    <div
      v-if="serverDown"
      role="status"
      aria-live="polite"
      class="fixed left-1/2 top-3 z-[110] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-2.5 rounded-full border border-destructive/40 bg-popover px-4 py-2 text-sm text-popover-foreground shadow-lg"
    >
      <Loader2 class="size-4 shrink-0 animate-spin text-destructive" />
      <span class="truncate">
        <span class="font-medium">Can’t reach the studio’s local server</span>
        <span class="text-muted-foreground"> — reconnecting. If this lasts, restart the app.</span>
      </span>
    </div>
  </Transition>
</template>
