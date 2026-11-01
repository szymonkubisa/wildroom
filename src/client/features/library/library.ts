import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useEditorStore } from '@/stores/editor'

export type LibraryTab = 'media' | 'cast' | 'places' | 'brand'
export const LIBRARY_TABS: { id: LibraryTab; label: string }[] = [
  { id: 'media', label: 'Media' },
  { id: 'cast', label: 'Cast' },
  { id: 'places', label: 'Places' },
  { id: 'brand', label: 'Brand' },
]
const isTab = (v: unknown): v is LibraryTab => LIBRARY_TABS.some((t) => t.id === v)

/**
 * The project's Library: one panel docked on the left of the work area in Plan, Create and Edit — its media, its cast and
 * places (the story's characters and places), and its brand kit. Open or closed per window; the tab is remembered.
 * Edit has its own media browser beside the viewer, so there the Library is Cast, Places and Brand only.
 */
export const useLibrary = defineStore('library', () => {
  const editor = useEditorStore()
  const open = ref(false)
  const saved = useLocalStorage<LibraryTab>('library.tab', 'media')
  if (!isTab(saved.value)) saved.value = 'media'
  const tab = saved

  /** Media is a tab outside Edit (Edit's browser is already on screen). */
  const hasMedia = computed(() => editor.workspace !== 'edit')
  const tabs = computed(() => LIBRARY_TABS.filter((t) => t.id !== 'media' || hasMedia.value))
  /** The tab on screen: in Edit, a remembered Media shows Cast (Media is kept for Plan and Create). */
  const shown = computed<LibraryTab>(() => (tab.value === 'media' && !hasMedia.value ? 'cast' : tab.value))

  /** Opens the Library (on `on`, else where it was left). Media in Edit: its own browser is already there. */
  function show(on?: LibraryTab) {
    if (on === 'media' && !hasMedia.value) return
    if (on) tab.value = on
    open.value = true
  }

  /** The rail button and ⌘L: closes it, or opens it (on `on`). Asked for another tab while open, it switches. */
  function toggle(on?: LibraryTab) {
    if (open.value && (!on || on === shown.value)) open.value = false
    else show(on)
  }

  function close() {
    open.value = false
  }

  return { open, tab, tabs, shown, show, toggle, close }
})
