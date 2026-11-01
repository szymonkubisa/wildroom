import { useLocalStorage } from '@vueuse/core'

/**
 * The Director's panel, open or closed in this browser — on its own, so the app shell can make room for it (the
 * toasts move left of its column) without loading the Director and the storyboard it plans with.
 */
export const directorOpen = useLocalStorage('director.open', false)
