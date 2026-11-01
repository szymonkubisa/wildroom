import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { TOUR_STEPS } from '@/features/guide/catalog'

const SEEN_KEY = 'tour.seen'

/** The guided walkthrough (steps live in features/guide/catalog.ts; the overlay drives navigation). */
export const useTourStore = defineStore('tour', () => {
  const active = ref(false)
  const index = ref(0)
  const step = computed(() => (active.value ? TOUR_STEPS[index.value] : undefined))
  const total = TOUR_STEPS.length

  function start(stepId?: string) {
    const i = stepId ? TOUR_STEPS.findIndex((s) => s.id === stepId) : 0
    index.value = Math.max(0, i)
    active.value = true
  }

  function next() {
    if (index.value >= total - 1) return stop()
    index.value++
  }

  function prev() {
    if (index.value > 0) index.value--
  }

  function stop() {
    active.value = false
    try {
      localStorage.setItem(SEEN_KEY, '1')
    } catch {
      // storage unavailable: the tour may be offered again, which is harmless
    }
  }

  function seen(): boolean {
    try {
      return localStorage.getItem(SEEN_KEY) === '1'
    } catch {
      return true
    }
  }

  return { active, index, step, total, start, next, prev, stop, seen }
})
