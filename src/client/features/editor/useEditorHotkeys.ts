import { onBeforeUnmount, onMounted } from 'vue'
import { drawerActive } from '@/features/story/timelineDrawer'
import { toast } from 'vue-sonner'
import { useTimelineCommands } from '@/features/timeline/commands'
import { isTyping, ownsArrowKeys } from '@/lib/shortcuts'
import { useClipTools } from '@/features/tools/useClipTools'
import { timelineZoom } from '@/features/timeline/zoom'
import { useAssetsStore } from '@/stores/assets'
import { useEditorStore } from '@/stores/editor'
import { useGenerateStore } from '@/stores/generate'
import { useProjectStore } from '@/stores/project'
import { currentFrame, transport } from './transport'

/** Final Cut Pro–style keyboard shortcuts for the editor. */
export function useEditorHotkeys(actions: {
  openImport: () => void
  openExport: () => void
  openPalette: () => void
  toggleLibrary: () => void
  toggleDirector: () => void
}) {
  const editor = useEditorStore()
  const project = useProjectStore()
  const commands = useTimelineCommands()
  const assets = useAssetsStore()
  const clipTools = useClipTools()
  const generate = useGenerateStore()

  function onKey(e: KeyboardEvent) {
    const cmd = e.metaKey || e.ctrlKey
    // Global app shortcuts work even while typing.
    if (cmd && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      return actions.openPalette()
    }
    // The Library (media, cast, places, brand) over any workspace.
    if (cmd && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
      e.preventDefault()
      return actions.toggleLibrary()
    }
    // The Director's chat, from any workspace and while typing in it — except ⌘D on a focused timeline, which duplicates.
    const timelineFocused = editor.focus === 'timeline' && (editor.workspace === 'edit' || (editor.workspace === 'story' && drawerActive.value))
    if (cmd && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd' && !(timelineFocused && !isTyping(e.target))) {
      e.preventDefault()
      return actions.toggleDirector()
    }
    if (isTyping(e.target)) return
    // A focused slider owns the arrow keys (they nudge its value).
    if ((e.target as HTMLElement | null)?.closest?.('[role="slider"]') && /^(Arrow|Home|End|Page)/.test(e.key)) return
    // So does a focused tab, radio, select or switch (Space too), and a control that already handled the key: the arrows
    // moved between tabs and stepped the playhead at once.
    if (/^( |Arrow|Home|End|Page)/.test(e.key) && (e.defaultPrevented || ownsArrowKeys(e.target))) return
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    const run = (fn: () => void) => {
      e.preventDefault()
      fn()
    }
    // Outside the video editor only the app-wide shortcuts apply; the timeline ones would act on a timeline that isn't on
    // screen — except Story's timeline drawer once it is clicked into (Delete didn't remove a clip there).
    const timelineHere = editor.workspace === 'edit' || (editor.workspace === 'story' && drawerActive.value)
    if (!timelineHere) {
      if (!cmd) return
      if (key === 'z') return run(() => {
        const label = e.shiftKey ? project.redo() : project.undo()
        if (label) toast(`${e.shiftKey ? 'Redo' : 'Undo'}: ${label}`, { duration: 1200 })
      })
      if (key === 'e') return run(actions.openExport)
      if (key === 'i') return run(actions.openImport)
      if (key === 'g') return run(() => generate.focus())
      return
    }

    // Control-only combos first: on a Mac ⌃ isn't ⌘, and the ⌘ block below would swallow them.
    if (e.ctrlKey && !e.metaKey) {
      if (e.shiftKey && key === 's') return run(() => commands.detachAudio())
      if (key === 'ArrowLeft') return run(() => commands.cycleTake(-1))
      if (key === 'ArrowRight') return run(() => commands.cycleTake(1))
    }
    if (cmd) {
      if (key === 'z') return run(() => {
        const label = e.shiftKey ? project.redo() : project.undo()
        if (label) toast(`${e.shiftKey ? 'Redo' : 'Undo'}: ${label}`, { duration: 1200 })
      })
      if (key === 'b') return run(() => commands.bladeAtPlayhead(e.shiftKey))
      if (key === 'c' && editor.focus === 'timeline') return run(() => commands.copySelection())
      if (key === 'x' && editor.focus === 'timeline') return run(() => commands.cutSelection())
      if (key === 'v' && editor.focus === 'timeline') return run(() => commands.paste())
      if (key === 'd' && editor.focus === 'timeline') return run(() => commands.duplicateSelection())
      if (key === 't') return run(() => commands.addTransition('dissolve'))
      if (key === '=' || key === '+') return run(() => timelineZoom.in())
      if (key === '-') return run(() => timelineZoom.out())
      if (key === 'e') return run(actions.openExport)
      if (key === 'i') return run(actions.openImport)
      if (key === 'g') return run(() => generate.focus())
      if (e.altKey && key === 'ArrowUp') return run(() => commands.liftFromStoryline())
      if (e.altKey && key === 'ArrowDown') return run(() => commands.overwriteToPrimary())
      if (key === 'a') return run(() => editor.select([...project.layout.spine.filter((s) => s.item.kind !== 'gap').map((s) => s.id), ...project.layout.connected.map((c) => c.id)]))
      return
    }
    // ⌥ turns letters into symbols on a Mac (⌥X is '≈'), so the physical key decides.
    if (e.altKey && (key === 'x' || e.code === 'KeyX')) return run(() => editor.clearRange())
    if (e.altKey && (key === 'f' || e.code === 'KeyF')) return run(() => void clipTools.freezeFrame())
    // Holding a toggle mustn't fire it on every auto-repeat (L raced to 8×, M stacked markers); the arrows keep repeating.
    if (e.repeat && [' ', 'j', 'k', 'l', 'm', 'n', 's', 'v'].includes(key)) return e.preventDefault()

    switch (key) {
      case ' ':
        return run(() => {
          // Pointer over a clip in Assets: play that clip (from the skim position), not the timeline.
          const hover = editor.hoverAsset
          const hovered = hover ? assets.get(hover.assetId) : undefined
          if (hovered && hovered.kind !== 'image') {
            transport.pause()
            return editor.playPreview(hovered.id, editor.previewPlaying && editor.previewAssetId === hovered.id ? undefined : hover!.seconds)
          }
          // A clip shown from the browser that is playing, or with the browser focused: Space toggles it.
          const shown = assets.get(editor.previewAssetId)
          if (shown && shown.kind !== 'image' && (editor.previewPlaying || editor.focus === 'browser')) return editor.playPreview(shown.id)
          transport.toggle()
        })
      case 'j':
      case 'k':
      case 'l':
        return run(() => transport.shuttle(key))
      case 'ArrowLeft':
        return run(() => transport.step(e.shiftKey ? -10 : -1))
      case 'ArrowRight':
        return run(() => transport.step(e.shiftKey ? 10 : 1))
      case 'ArrowUp':
        return run(() => transport.jumpEdit(-1))
      case 'ArrowDown':
        return run(() => transport.jumpEdit(1))
      case 'Home':
        return run(() => transport.goStart())
      case 'End':
        return run(() => transport.goEnd())
      case 'i':
        return run(() => (editor.rangeIn = currentFrame()))
      case 'o':
        return run(() => (editor.rangeOut = currentFrame() + 1))
      case 'Backspace':
      case 'Delete': {
        // With the browser focused the key is about a selected card, not the clips still selected on the timeline.
        if (editor.focus === 'browser') return
        // A selected transition badge: remove the transition, not the clip it belongs to.
        const transition = editor.selectedTransition
        if (transition) return run(() => commands.removeTransition(transition))
        return run(() => commands.deleteSelection(e.shiftKey ? 'gap' : 'ripple'))
      }
      case 'v':
        return run(() => commands.toggleEnabled())
      case 'm':
        return run(() => commands.addMarker())
      case 'a':
        return run(() => (editor.tool = 'select'))
      case 't':
        return run(() => (editor.tool = 'trim'))
      case 'b':
        return run(() => (editor.tool = 'blade'))
      case 'n':
        return run(() => {
          editor.snapping = !editor.snapping
          toast(`Snapping ${editor.snapping ? 'on' : 'off'}`, { duration: 900 })
        })
      case 's':
        return run(() => {
          editor.skimming = !editor.skimming
          toast(`Skimming ${editor.skimming ? 'on' : 'off'}`, { duration: 900 })
        })
      case 'z':
        if (e.shiftKey) return run(() => timelineZoom.fit())
        return
      case 'e':
      case 'w':
      case 'q':
      case 'd': {
        const ids = editor.focus === 'browser' ? editor.selectedAssetIds : []
        if (!ids.length) return
        return run(() => {
          if (key === 'e') commands.appendAssets(ids)
          else if (key === 'w') commands.insertAssets(ids)
          else if (key === 'q') commands.connectAssets(ids)
          else commands.overwriteAssets(ids)
        })
      }
      case 'Escape':
        return run(() => {
          editor.select([])
          editor.previewAssetId = undefined
        })
    }
  }

  onMounted(() => window.addEventListener('keydown', onKey))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
}
