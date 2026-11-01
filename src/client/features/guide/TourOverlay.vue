<script setup lang="ts">
import { ArrowLeft, ArrowRight, ListChecks, X } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { api, errorMessage } from '@/lib/api'
import { useEditorStore } from '@/stores/editor'
import { useTourStore } from '@/stores/tour'
import type { TourStep } from './catalog'

const tour = useTourStore()
const editor = useEditorStore()
const router = useRouter()
const route = useRoute()

const rect = ref<DOMRect>()
const card = ref<HTMLDivElement>()
const cardSize = ref({ w: 360, h: 200 })
const viewport = ref({ w: window.innerWidth, h: window.innerHeight })
const navigating = ref(false)

/** Opens a project for editor steps: the current one, the most recent, or a new "Walkthrough" project. */
async function ensureRoute(step: TourStep) {
  if (step.route === 'projects' && route.name !== 'projects') return router.push({ name: 'projects' })
  if (step.route === 'settings' && route.name !== 'settings') return router.push({ name: 'settings' })
  if (step.route !== 'editor' || route.name === 'editor') return
  navigating.value = true
  try {
    const usable = (await api.projects.list()).find((p) => p.state === 'ok' && p.id)
    const id = usable ? (await api.projects.open(usable.path)).id : (await api.projects.create('Walkthrough')).id
    await router.push({ name: 'editor', params: { id } })
  } catch (err) {
    toast.error('Could not open a project for the tour', { description: errorMessage(err) })
    tour.stop()
  } finally {
    navigating.value = false
  }
}

function applyUi(step: TourStep) {
  if (step.route !== 'editor') return
  if (step.workspace) editor.workspace = step.workspace
  if (step.rightTab) editor.rightTab = step.rightTab
  editor.dialog = undefined
}

watch(
  () => tour.step,
  async (step) => {
    rect.value = undefined
    if (!step) return
    await ensureRoute(step)
    applyUi(step)
  },
  { immediate: true },
)

// Follow the target every frame (panels resize, routes load lazily) — only while the tour is on: the overlay is mounted
// for the whole session, and an idle loop would run at 60 Hz forever.
let raf = 0
function track() {
  raf = requestAnimationFrame(track)
  const step = tour.step
  if (!step) return
  viewport.value = { w: window.innerWidth, h: window.innerHeight }
  const el = step.target ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`) : null
  const r = el?.getBoundingClientRect()
  rect.value = r && r.width > 0 && r.height > 0 ? r : undefined
  if (card.value) cardSize.value = { w: card.value.offsetWidth, h: card.value.offsetHeight }
}
watch(
  () => tour.active,
  (active) => {
    cancelAnimationFrame(raf)
    raf = active ? requestAnimationFrame(track) : 0
  },
  { immediate: true },
)
onBeforeUnmount(() => cancelAnimationFrame(raf))

const PAD = 6
const GAP = 14

const spot = computed(() => {
  const r = rect.value
  if (!r) return undefined
  return { left: r.left - PAD, top: r.top - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 }
})

/** Card next to the spotlight: right, left, below or above — whichever fits; centred without a target. */
const cardPos = computed(() => {
  const { w: vw, h: vh } = viewport.value
  const { w, h } = cardSize.value
  const s = spot.value
  const clampX = (x: number) => Math.max(12, Math.min(vw - w - 12, x))
  const clampY = (y: number) => Math.max(12, Math.min(vh - h - 12, y))
  if (!s) return { left: (vw - w) / 2, top: (vh - h) / 2 }
  const midY = s.top + s.height / 2 - h / 2
  const midX = s.left + s.width / 2 - w / 2
  if (s.left + s.width + GAP + w < vw - 12) return { left: s.left + s.width + GAP, top: clampY(midY) }
  if (s.left - GAP - w > 12) return { left: s.left - GAP - w, top: clampY(midY) }
  if (s.top + s.height + GAP + h < vh - 12) return { left: clampX(midX), top: s.top + s.height + GAP }
  if (s.top - GAP - h > 12) return { left: clampX(midX), top: s.top - GAP - h }
  // Target fills the screen (e.g. a big panel): put the card inside its bottom-right corner.
  return { left: clampX(s.left + s.width - w - 16), top: clampY(s.top + s.height - h - 16) }
})

function onKey(e: KeyboardEvent) {
  if (!tour.active) return
  const handled = e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Escape' || e.key === 'Enter'
  if (!handled) return
  e.preventDefault()
  e.stopImmediatePropagation()
  if (e.key === 'Escape') tour.stop()
  else if (e.key === 'ArrowLeft') tour.prev()
  else tour.next()
}
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))

function openFeatures() {
  tour.stop()
  void router.push({ name: 'features' })
}
</script>

<template>
  <Teleport to="body">
    <div v-if="tour.active && tour.step" class="fixed inset-0 z-[100]" aria-live="polite">
      <!-- Dim everything; the spotlight is a hole made by a huge shadow around the target. -->
      <div v-if="!spot" class="absolute inset-0 bg-black/60" />
      <div
        v-else
        class="pointer-events-none absolute rounded-lg ring-2 ring-brand transition-all duration-300 ease-out"
        :style="{ left: `${spot.left}px`, top: `${spot.top}px`, width: `${spot.width}px`, height: `${spot.height}px`, boxShadow: '0 0 0 9999px rgba(0,0,0,0.6)' }"
      />
      <!-- Swallow clicks outside the card so a stray click doesn't edit the project mid-tour. -->
      <div v-if="spot" class="absolute inset-0" />

      <div
        ref="card"
        role="dialog"
        :aria-label="tour.step.title"
        class="absolute w-[360px] max-w-[calc(100vw-24px)] rounded-xl border bg-popover p-4 text-popover-foreground shadow-2xl transition-[left,top] duration-300 ease-out"
        :style="{ left: `${cardPos.left}px`, top: `${cardPos.top}px` }"
      >
        <div class="mb-1 flex items-center gap-2">
          <span class="text-[11px] font-medium text-brand tabular">{{ tour.index + 1 }} / {{ tour.total }}</span>
          <div class="h-1 flex-1 overflow-hidden rounded bg-muted">
            <div class="h-full bg-brand transition-all" :style="{ width: `${((tour.index + 1) / tour.total) * 100}%` }" />
          </div>
          <button class="rounded p-0.5 text-muted-foreground hover:text-foreground" title="End tour (Esc)" @click="tour.stop()"><X class="size-4" /></button>
        </div>
        <h3 class="text-base font-semibold">{{ tour.step.title }}</h3>
        <p class="mt-1.5 text-sm leading-relaxed text-muted-foreground">{{ tour.step.body }}</p>
        <p v-if="navigating" class="mt-2 text-xs text-muted-foreground">Opening a project…</p>
        <div class="mt-4 flex items-center gap-2">
          <Button v-if="tour.index === tour.total - 1" variant="outline" size="sm" @click="openFeatures"><ListChecks /> All features</Button>
          <Button v-else variant="ghost" size="sm" class="text-muted-foreground" @click="tour.stop()">Skip tour</Button>
          <div class="flex-1" />
          <Button v-if="tour.index > 0" variant="outline" size="sm" @click="tour.prev()"><ArrowLeft /> Back</Button>
          <Button size="sm" @click="tour.next()">
            {{ tour.index === tour.total - 1 ? 'Finish' : 'Next' }} <ArrowRight v-if="tour.index < tour.total - 1" />
          </Button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
