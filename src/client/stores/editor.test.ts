import { appendToSpine, makeMediaClip, setTransition } from '@shared/timeline'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useEditorStore } from './editor'
import { useProjectStore } from './project'

class FakeEventSource {
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  close() {}
}

function addClips(count: number): string[] {
  const project = useProjectStore()
  const ctx = project.opContext()
  const clips = Array.from({ length: count }, () =>
    makeMediaClip({ assetId: 'a', media: { kind: 'video', hasVideo: true, hasAudio: false }, fps: 24, durationFrames: 48, newId: ctx.newId }),
  )
  project.apply(appendToSpine(clips), 'Append')
  return clips.map((c) => c.id)
}

describe('editor selection', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
  })
  afterEach(() => vi.unstubAllGlobals())

  it('drops clips that an undo removed', async () => {
    const editor = useEditorStore()
    const project = useProjectStore()
    const [kept] = addClips(1)
    const [dropped] = addClips(1)
    editor.select([kept!, dropped!])
    await nextTick()
    expect(editor.selection).toEqual([kept, dropped])

    project.undo()
    await nextTick()
    expect(editor.selection).toEqual([kept])
  })

  it('keeps a selected transition apart from the clip, and forgets it once the transition is gone', async () => {
    const editor = useEditorStore()
    const project = useProjectStore()
    const [first] = addClips(2)
    project.apply(setTransition(first!, 'out', { type: 'dissolve', duration: 12 }), 'Add transition')
    editor.select([first!])
    editor.selectedTransition = first
    await nextTick()
    expect(editor.selectedTransition).toBe(first)

    project.undo()
    await nextTick()
    expect(editor.selectedTransition).toBeUndefined()
    expect(editor.selection).toEqual([first])

    editor.selectedTransition = first
    editor.select([])
    expect(editor.selectedTransition).toBeUndefined()
  })
})
