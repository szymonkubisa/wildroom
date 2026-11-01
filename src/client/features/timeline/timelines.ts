import {
  type TimelineSummary,
  createTimeline,
  deleteTimeline,
  duplicateTimeline,
  openTimeline,
  renameTimeline,
  timelineSummaries,
} from '@shared/timeline/timelines'
import type { ProjectSettings } from '@shared/types/project-doc'
import { useLocalStorage } from '@vueuse/core'
import { nanoid } from 'nanoid'
import { computed } from 'vue'
import { toast } from 'vue-sonner'
import { useEditorStore } from '@/stores/editor'
import { useProjectStore } from '@/stores/project'

/**
 * The project's timelines (Assets cards, the timeline switcher, the command palette). Every change is an undoable
 * project edit; opening a timeline is one too, so ⌘Z goes back to the previous timeline.
 */
export function useTimelines() {
  const project = useProjectStore()
  const editor = useEditorStore()
  /** Story's timeline drawer (StoryWorkspace keeps the same key). */
  const storyTimelineOpen = useLocalStorage('story.timelineOpen', false)

  const list = computed<TimelineSummary[]>(() => timelineSummaries(project.doc))
  const active = computed(() => list.value.find((t) => t.active) ?? list.value[0]!)

  /** Adds an empty timeline (not opened); returns its id. */
  function create(opts: { name?: string; settings?: Partial<ProjectSettings> } = {}): string | undefined {
    const id = nanoid(10)
    if (!project.apply(createTimeline({ id, ...opts }), 'New timeline')) return undefined
    editor.selectedTimelineId = id
    editor.selectedAssetIds = []
    const name = list.value.find((t) => t.id === id)?.name ?? 'Timeline'
    toast.success(`“${name}” added to Assets`, { description: 'Double-click it to open it.', action: { label: 'Open', onClick: () => open(id) } })
    return id
  }

  /**
   * Loads a timeline into the editor (the open one is kept as it is, ready to come back to). Story has a timeline of its
   * own at the bottom: there it opens that instead of leaving for the Video workspace.
   */
  function open(id: string) {
    if (editor.workspace === 'story') storyTimelineOpen.value = true
    else if (editor.workspace !== 'edit') editor.workspace = 'edit'
    if (id === active.value.id) return
    if (project.apply(openTimeline(id), 'Open timeline')) {
      // Generations that finished while this timeline was put away resolve now.
      project.resolvePendingTakes()
    }
  }

  function rename(id: string, name: string) {
    project.apply(renameTimeline(id, name), 'Rename timeline')
  }

  function duplicate(id: string): string | undefined {
    const copy = nanoid(10)
    if (!project.apply(duplicateTimeline(id, { id: copy }), 'Duplicate timeline')) return undefined
    editor.selectedTimelineId = copy
    return copy
  }

  function remove(id: string) {
    if (list.value.length < 2) {
      toast.warning('A project keeps at least one timeline')
      return
    }
    const name = list.value.find((t) => t.id === id)?.name
    if (project.apply(deleteTimeline(id), 'Delete timeline')) {
      if (editor.selectedTimelineId === id) editor.selectedTimelineId = undefined
      toast(`Deleted “${name}”`, { description: 'Undo (⌘Z) brings it back.', duration: 2500 })
    }
  }

  return { list, active, create, open, rename, duplicate, remove }
}
