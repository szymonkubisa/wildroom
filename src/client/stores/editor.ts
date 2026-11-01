import type { ClipboardEntry } from '@shared/timeline'
import { defineStore } from 'pinia'
import { ref, shallowRef, watch } from 'vue'
import { useProjectStore } from './project'

export type Tool = 'select' | 'trim' | 'blade'
/** The right panel: the Inspector, and in Edit the Transcript (generating is the Composer's, at the bottom). */
export type RightTab = 'inspector' | 'transcript'
export type FocusArea = 'browser' | 'timeline' | 'canvas'
/**
 * Left-rail workspaces of a project, in production order: Plan (`story`: script → cast → shots), Create (`canvas`: the
 * infinite board) and Edit (`edit`: the video editor). The ids are the old names on purpose: the open workspace is
 * remembered per project under them (`workspace.<id>`). The brand kit was a fourth one; it is Library › Brand now, and a
 * remembered `brand` opens Create with the Library on it (LEGACY_BRAND_WORKSPACE).
 */
export type Workspace = 'edit' | 'story' | 'canvas'
export const WORKSPACES: Workspace[] = ['story', 'canvas', 'edit']
/** The old Brand workspace's id, still found in `workspace.<id>` and `?ws=`. */
export const LEGACY_BRAND_WORKSPACE = 'brand'

/** UI state of the editor that is not part of the undoable project document. */
export const useEditorStore = defineStore('editor', () => {
  const project = useProjectStore()
  const tool = ref<Tool>('select')
  const selection = ref<string[]>([])
  /** Storyline clip whose outgoing transition badge is selected (Delete removes the transition, not the clip). */
  const selectedTransition = ref<string>()
  const snapping = ref(true)
  const skimming = ref(true)
  /** Horizontal zoom: pixels per frame. */
  const pxPerFrame = ref(4)
  /** Committed playhead (frame). The playback engine owns the live value while playing. */
  const playhead = ref(0)
  const playing = ref(false)
  const rangeIn = ref<number>()
  const rangeOut = ref<number>()
  const rightTab = ref<RightTab>('inspector')
  const focus = ref<FocusArea>('timeline')
  /** When set, the viewer previews this asset instead of the timeline (FCP browser skimming). */
  const previewAssetId = ref<string>()
  /** Asset card under the pointer in the browser (with the skim position for video), for Space-to-play. */
  const hoverAsset = ref<{ assetId: string; seconds?: number }>()
  /** Play/pause request for the asset preview; `from` starts playback there. Bumped nonce = new request. */
  const previewCommand = ref<{ assetId: string; from?: number; nonce: number }>()
  /** The asset preview is playing (skimming and leaving the card don't interrupt it). */
  const previewPlaying = ref(false)
  const selectedAssetIds = ref<string[]>([])
  /** Timeline card selected in Assets (a single click selects it; a double-click opens it). */
  const selectedTimelineId = ref<string>()
  const workspace = ref<Workspace>('edit')
  /** Copied timeline clips (⌘C / ⌘X), pasted at the playhead with ⌘V. */
  const clipboard = shallowRef<ClipboardEntry[]>([])
  /** Tool dialog open over the editor. */
  const dialog = ref<'continuity' | 'reframe' | 'edit-shot' | 'new-timeline'>()

  function select(ids: string[], additive = false) {
    selection.value = additive ? [...new Set([...selection.value, ...ids])] : ids
    selectedTransition.value = undefined
  }

  function toggleSelect(id: string) {
    selection.value = selection.value.includes(id) ? selection.value.filter((x) => x !== id) : [...selection.value, id]
    selectedTransition.value = undefined
  }

  // Clips gone after an undo, another edit or a timeline switch drop out of the selection — ⌘B, V and the Inspector
  // otherwise acted on ids that no longer exist (and did nothing).
  watch(
    () => project.layout.byId,
    (byId) => {
      if (selection.value.some((id) => !byId.has(id))) selection.value = selection.value.filter((id) => byId.has(id))
      const t = selectedTransition.value
      const owner = t ? byId.get(t) : undefined
      if (t && (owner?.type !== 'spine' || !owner.item.transitionOut)) selectedTransition.value = undefined
    },
  )

  /** Shows an asset in the viewer and plays it (from `from` seconds), or toggles it when no position is given. */
  function playPreview(assetId: string, from?: number) {
    previewAssetId.value = assetId
    previewCommand.value = { assetId, from, nonce: (previewCommand.value?.nonce ?? 0) + 1 }
  }

  function clearRange() {
    rangeIn.value = undefined
    rangeOut.value = undefined
  }

  return {
    tool,
    selection,
    selectedTransition,
    snapping,
    skimming,
    pxPerFrame,
    playhead,
    playing,
    rangeIn,
    rangeOut,
    rightTab,
    focus,
    previewAssetId,
    hoverAsset,
    previewCommand,
    previewPlaying,
    playPreview,
    selectedAssetIds,
    selectedTimelineId,
    workspace,
    clipboard,
    dialog,
    select,
    toggleSelect,
    clearRange,
  }
})
