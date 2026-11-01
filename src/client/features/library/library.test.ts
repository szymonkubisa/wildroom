import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorStore } from '@/stores/editor'
import { useLibrary } from './library'

// The editor store's project store listens to the server.
class FakeEventSource {
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  close() {}
}

describe('Library drawer', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
  })
  afterEach(() => vi.unstubAllGlobals())

  it('starts closed on Media', () => {
    const library = useLibrary()
    expect(library.open).toBe(false)
    expect(library.tab).toBe('media')
  })

  it('opens on a tab, and the rail button (no tab) closes it', () => {
    const library = useLibrary()
    library.show('brand')
    expect(library.open).toBe(true)
    expect(library.tab).toBe('brand')
    library.toggle()
    expect(library.open).toBe(false)
    // Reopened where it was left.
    library.toggle()
    expect(library.tab).toBe('brand')
  })

  it('asked for another tab while open, switches instead of closing', () => {
    useEditorStore().workspace = 'story'
    const library = useLibrary()
    library.show('cast')
    library.toggle('media')
    expect(library.open).toBe(true)
    expect(library.tab).toBe('media')
    library.toggle('media')
    expect(library.open).toBe(false)
  })

  it('has no Media in Edit, whose own browser is beside the viewer', () => {
    const editor = useEditorStore()
    editor.workspace = 'edit'
    const library = useLibrary()
    expect(library.tabs.map((t) => t.id)).toEqual(['cast', 'places', 'brand'])
    // Asked for Media in Edit: nothing opens.
    library.show('media')
    expect(library.open).toBe(false)
    // A remembered Media shows Cast in Edit, and Media again in Plan.
    library.toggle()
    expect(library.tab).toBe('media')
    expect(library.shown).toBe('cast')
    editor.workspace = 'story'
    expect(library.shown).toBe('media')
  })
})
